import { Color } from 'three'

/**
 * A MapLibre-style expression over the ground's elevation, slope and aspect, as JSON: a number, a CSS colour string,
 * or an array whose first item names the operator. For example
 * `['case', ['>', ['slope'], 30], '#8a8580', ['>=', ['elevation'], 3000], '#ffffff', '#4f7f45']`.
 */
export type TerrainExpression = number | string | boolean | readonly TerrainExpression[]

/**
 * The inputs an expression reads, per pixel of the terrain:
 * - `['elevation']`: metres above the WGS84 ellipsoid, as loaded (the terrain's exaggeration does not scale it).
 * - `['slope']`: degrees, 0 flat to 90 vertical. `['slope-percent']`: the grade, 100 at 45°.
 * - `['aspect']`: the compass direction the ground faces downhill, in degrees clockwise from north (0 to 360); 0 on
 *   flat ground.
 * - `['water']`: 1 on sea and lakes, 0 on land, between along coasts (`terrainWaterMask`: from the terrain source).
 */
export const TERRAIN_INPUTS = ['elevation', 'slope', 'slope-percent', 'aspect', 'water'] as const
export type TerrainInput = (typeof TERRAIN_INPUTS)[number]

/** Values of the inputs, for `evaluateTerrainExpression`. */
export type TerrainInputValues = Readonly<Record<TerrainInput, number>>

export type TerrainValueType = 'number' | 'color' | 'boolean'

/** An sRGB colour, each channel from 0 to 1. */
export type TerrainColor = readonly [red: number, green: number, blue: number]

const MATH_OPERATORS = ['+', '-', '*', '/', '%', 'min', 'max', 'abs', '^', 'sqrt', 'sin', 'cos'] as const
const COMPARISON_OPERATORS = ['<', '<=', '>', '>=', '==', '!='] as const
type MathOperator = (typeof MATH_OPERATORS)[number]
type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]

/** A parsed, type-checked expression: what `compileTerrainExpression` and `evaluateTerrainExpression` walk. */
export type TerrainExpressionNode =
  | { readonly kind: 'number'; readonly type: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly type: 'boolean'; readonly value: boolean }
  | { readonly kind: 'color'; readonly type: 'color'; readonly value: TerrainColor }
  | { readonly kind: 'input'; readonly type: 'number'; readonly name: TerrainInput }
  | { readonly kind: 'math'; readonly type: 'number'; readonly operator: MathOperator; readonly operands: readonly TerrainExpressionNode[] }
  | { readonly kind: 'compare'; readonly type: 'boolean'; readonly operator: ComparisonOperator; readonly left: TerrainExpressionNode; readonly right: TerrainExpressionNode }
  | { readonly kind: 'logic'; readonly type: 'boolean'; readonly operator: 'all' | 'any' | '!'; readonly operands: readonly TerrainExpressionNode[] }
  | { readonly kind: 'rgb'; readonly type: 'color'; readonly channels: readonly [TerrainExpressionNode, TerrainExpressionNode, TerrainExpressionNode] }
  | { readonly kind: 'case'; readonly type: 'number' | 'color'; readonly branches: readonly (readonly [TerrainExpressionNode, TerrainExpressionNode])[]; readonly fallback: TerrainExpressionNode }
  | { readonly kind: 'step'; readonly type: 'number' | 'color'; readonly input: TerrainExpressionNode; readonly base: TerrainExpressionNode; readonly stops: readonly (readonly [number, TerrainExpressionNode])[] }
  | {
      readonly kind: 'interpolate'
      readonly type: 'number' | 'color'
      /** 1 for `['linear']`, the base of `['exponential', base]` otherwise. */
      readonly exponentialBase: number
      readonly input: TerrainExpressionNode
      readonly stops: readonly (readonly [number, TerrainExpressionNode])[]
    }

const SUPPORTED = `inputs ${TERRAIN_INPUTS.map(name => `["${name}"]`).join(', ')}; operators step, interpolate, case, all, any, !, ${COMPARISON_OPERATORS.join(' ')}, ${MATH_OPERATORS.join(' ')}, rgb`

class TerrainExpressionError extends Error {
  constructor(message: string, path: string) {
    super(`TerrainStyle: ${message} (at ${path === '' ? 'the root' : path}).`)
    this.name = 'TerrainExpressionError'
  }
}

const scratchColor = new Color()

function parseColor(text: string, path: string): TerrainColor {
  // three's parser warns and leaves the colour unchanged on an unknown string: detect that with two starting values.
  // A bare word must be a CSS colour name, not an inherited property of three's name table ("constructor").
  const isName = /^[a-z]+$/i.test(text)
  const warn = console.warn
  console.warn = () => {}
  try {
    const first = scratchColor.setRGB(0, 0, 0).setStyle(text, 'srgb').getHex()
    const second = scratchColor.setRGB(1, 1, 1).setStyle(text, 'srgb').getHex()
    if (first !== second || (isName && !Object.hasOwn(Color.NAMES, text.toLowerCase()))) {
      throw new TerrainExpressionError(
        `"${text}" is not a colour: use a CSS colour such as "#4f7f45", "rgb(79, 127, 69)" or "white"${path === '' ? ', or a preset name (alpine, atlas, desert, monochrome, slope-classes)' : ''}`,
        path,
      )
    }
  } finally {
    console.warn = warn
  }
  scratchColor.setStyle(text, 'srgb')
  // getRGB in sRGB, since setStyle converted to linear working space.
  const rgb = { r: 0, g: 0, b: 0 }
  scratchColor.getRGB(rgb, 'srgb')
  return [rgb.r, rgb.g, rgb.b]
}

function expectType(node: TerrainExpressionNode, types: readonly TerrainValueType[], path: string, what: string): void {
  if (!types.includes(node.type)) throw new TerrainExpressionError(`${what} must be ${types.join(' or ')}, got ${node.type}`, path)
}

/** The outputs of a `case`, `step` or `interpolate` must share one type: number or colour. */
function outputType(nodes: readonly TerrainExpressionNode[], path: string, operator: string): 'number' | 'color' {
  const first = nodes[0]!
  if (first.type === 'boolean') throw new TerrainExpressionError(`the outputs of "${operator}" must be numbers or colours, got a boolean`, path)
  for (const node of nodes) {
    if (node.type !== first.type) throw new TerrainExpressionError(`the outputs of "${operator}" must all be ${first.type}s, got a ${node.type} too`, path)
  }
  return first.type
}

/** `items` are the operator's operands: the expression's items from index 1, so a path adds one. */
function parseStops(items: readonly TerrainExpression[], start: number, path: string, operator: string): [number, TerrainExpressionNode][] {
  const stops: [number, TerrainExpressionNode][] = []
  for (let index = start; index < items.length; index += 2) {
    const stop = items[index]
    if (typeof stop !== 'number' || !Number.isFinite(stop)) throw new TerrainExpressionError(`the stops of "${operator}" must be literal numbers`, `${path}[${index + 1}]`)
    if (stops.length > 0 && stop <= stops.at(-1)![0]) throw new TerrainExpressionError(`the stops of "${operator}" must increase: ${stop} follows ${stops.at(-1)![0]}`, `${path}[${index + 1}]`)
    if (index + 1 >= items.length) throw new TerrainExpressionError(`stop ${stop} of "${operator}" has no output after it`, path)
    stops.push([stop, parseAt(items[index + 1]!, `${path}[${index + 2}]`)])
  }
  return stops
}

function parseAt(expression: TerrainExpression, path: string): TerrainExpressionNode {
  if (typeof expression === 'number') {
    if (!Number.isFinite(expression)) throw new TerrainExpressionError(`${expression} is not a finite number`, path)
    return { kind: 'number', type: 'number', value: expression }
  }
  if (typeof expression === 'boolean') return { kind: 'boolean', type: 'boolean', value: expression }
  if (typeof expression === 'string') return { kind: 'color', type: 'color', value: parseColor(expression, path) }
  if (!Array.isArray(expression) || expression.length === 0 || typeof expression[0] !== 'string') {
    throw new TerrainExpressionError(`expected a number, a colour string or an expression array such as ["elevation"]; supported: ${SUPPORTED}`, path)
  }
  const [operator, ...operands] = expression as [string, ...TerrainExpression[]]
  const child = (index: number) => parseAt(operands[index]!, `${path}[${index + 1}]`)
  const arity = (count: number) => {
    if (operands.length !== count) throw new TerrainExpressionError(`"${operator}" takes ${count} argument${count === 1 ? '' : 's'}, got ${operands.length}`, path)
  }

  if ((TERRAIN_INPUTS as readonly string[]).includes(operator)) {
    arity(0)
    return { kind: 'input', type: 'number', name: operator as TerrainInput }
  }
  if ((MATH_OPERATORS as readonly string[]).includes(operator)) {
    const unary = operator === 'abs' || operator === 'sqrt' || operator === 'sin' || operator === 'cos'
    if (unary) arity(1)
    else if (operator === '-' && operands.length === 1) {
      // Negation
    } else if (operator === '+' || operator === '*' || operator === 'min' || operator === 'max') {
      if (operands.length < 2) throw new TerrainExpressionError(`"${operator}" takes 2 or more arguments, got ${operands.length}`, path)
    } else arity(2)
    const parsed = operands.map((_, index) => child(index))
    parsed.forEach((node, index) => expectType(node, ['number'], `${path}[${index + 1}]`, `an argument of "${operator}"`))
    return { kind: 'math', type: 'number', operator: operator as MathOperator, operands: parsed }
  }
  if ((COMPARISON_OPERATORS as readonly string[]).includes(operator)) {
    arity(2)
    const left = child(0)
    const right = child(1)
    expectType(left, ['number'], `${path}[1]`, `the left side of "${operator}"`)
    expectType(right, ['number'], `${path}[2]`, `the right side of "${operator}"`)
    return { kind: 'compare', type: 'boolean', operator: operator as ComparisonOperator, left, right }
  }
  switch (operator) {
    case 'all':
    case 'any':
    case '!': {
      if (operator === '!') arity(1)
      else if (operands.length === 0) throw new TerrainExpressionError(`"${operator}" takes 1 or more conditions`, path)
      const parsed = operands.map((_, index) => child(index))
      parsed.forEach((node, index) => expectType(node, ['boolean'], `${path}[${index + 1}]`, `a condition of "${operator}"`))
      return { kind: 'logic', type: 'boolean', operator, operands: parsed }
    }
    case 'rgb': {
      arity(3)
      const channels = [child(0), child(1), child(2)] as const
      channels.forEach((node, index) => expectType(node, ['number'], `${path}[${index + 1}]`, 'a channel of "rgb" (0 to 255)'))
      return { kind: 'rgb', type: 'color', channels }
    }
    case 'case': {
      if (operands.length < 3 || operands.length % 2 === 0) {
        throw new TerrainExpressionError('"case" takes condition, output pairs and a fallback: ["case", condition, output, …, fallback]', path)
      }
      const branches: [TerrainExpressionNode, TerrainExpressionNode][] = []
      for (let index = 0; index < operands.length - 1; index += 2) {
        const condition = child(index)
        expectType(condition, ['boolean'], `${path}[${index + 1}]`, 'a condition of "case"')
        branches.push([condition, child(index + 1)])
      }
      const fallback = child(operands.length - 1)
      const type = outputType([...branches.map(([, output]) => output), fallback], path, 'case')
      return { kind: 'case', type, branches, fallback }
    }
    case 'step': {
      if (operands.length < 2 || operands.length % 2 !== 0) {
        throw new TerrainExpressionError('"step" takes an input, a base output, then stop, output pairs: ["step", ["elevation"], base, 1000, output, …]', path)
      }
      const input = child(0)
      expectType(input, ['number'], `${path}[1]`, 'the input of "step"')
      const base = child(1)
      const stops = parseStops(operands, 2, path, 'step')
      const type = outputType([base, ...stops.map(([, output]) => output)], path, 'step')
      return { kind: 'step', type, input, base, stops }
    }
    case 'interpolate': {
      const interpolation = operands[0]
      let exponentialBase = 1
      if (Array.isArray(interpolation) && interpolation[0] === 'linear' && interpolation.length === 1) exponentialBase = 1
      else if (Array.isArray(interpolation) && interpolation[0] === 'exponential' && interpolation.length === 2 && typeof interpolation[1] === 'number' && interpolation[1] > 0) {
        exponentialBase = interpolation[1]
      } else throw new TerrainExpressionError('"interpolate" takes ["linear"] or ["exponential", base] first (cubic-bezier is not supported)', `${path}[1]`)
      if (operands.length < 4 || operands.length % 2 !== 0) {
        throw new TerrainExpressionError('"interpolate" takes an interpolation, an input, then stop, output pairs: ["interpolate", ["linear"], ["elevation"], 0, output, 3000, output]', path)
      }
      const input = child(1)
      expectType(input, ['number'], `${path}[2]`, 'the input of "interpolate"')
      const stops = parseStops(operands, 2, path, 'interpolate')
      const type = outputType(stops.map(([, output]) => output), path, 'interpolate')
      return { kind: 'interpolate', type, exponentialBase, input, stops }
    }
    default:
      throw new TerrainExpressionError(`unknown operator "${operator}"; supported: ${SUPPORTED}`, path)
  }
}

/**
 * Parses and type-checks an expression. Throws, stating the fix, on an unknown operator, a wrong argument count or
 * type, stops that do not increase, or a string that is not a colour. `expectedType` is the type the result must have.
 */
export function parseTerrainExpression(expression: TerrainExpression, expectedType: 'number' | 'color' = 'color'): TerrainExpressionNode {
  const node = parseAt(expression, '')
  if (node.type !== expectedType) {
    throw new TerrainExpressionError(`the expression must give a ${expectedType}, but it gives a ${node.type}`, '')
  }
  return node
}

/** Where `x` lies between two interpolation stops: 0 at `low`, 1 at `high`, as MapLibre computes it. */
export function interpolationFactor(x: number, low: number, high: number, exponentialBase: number): number {
  const difference = high - low
  const progress = x - low
  if (difference === 0) return 0
  if (exponentialBase === 1) return Math.min(Math.max(progress / difference, 0), 1)
  if (exponentialBase > 1) {
    // (b^progress - 1) / (b^difference - 1), divided through by b^difference: b^difference overflows over metres
    // (1.5^1000), its inverse only underflows to 0.
    const inverse = exponentialBase ** -difference
    return Math.min(Math.max((exponentialBase ** (x - high) - inverse) / (1 - inverse), 0), 1)
  }
  return Math.min(Math.max((exponentialBase ** progress - 1) / (exponentialBase ** difference - 1), 0), 1)
}

type Value = number | boolean | TerrainColor

function mixValues(a: Value, b: Value, t: number): Value {
  if (typeof a === 'number') return a + ((b as number) - a) * t
  const colorA = a as TerrainColor
  const colorB = b as TerrainColor
  return [colorA[0] + (colorB[0] - colorA[0]) * t, colorA[1] + (colorB[1] - colorA[1]) * t, colorA[2] + (colorB[2] - colorA[2]) * t]
}

function evaluateNode(node: TerrainExpressionNode, inputs: TerrainInputValues): Value {
  switch (node.kind) {
    case 'number':
    case 'boolean':
    case 'color':
      return node.value
    case 'input':
      return inputs[node.name]
    case 'math': {
      const values = node.operands.map(operand => evaluateNode(operand, inputs) as number)
      switch (node.operator) {
        case '+':
          return values.reduce((sum, value) => sum + value, 0)
        case '-':
          return values.length === 1 ? -values[0]! : values[0]! - values[1]!
        case '*':
          return values.reduce((product, value) => product * value, 1)
        case '/':
          return values[0]! / values[1]!
        case '%':
          return values[0]! % values[1]!
        case '^':
          return values[0]! ** values[1]!
        case 'min':
          return Math.min(...values)
        case 'max':
          return Math.max(...values)
        case 'abs':
          return Math.abs(values[0]!)
        case 'sqrt':
          return Math.sqrt(values[0]!)
        case 'sin':
          return Math.sin(values[0]!)
        case 'cos':
          return Math.cos(values[0]!)
      }
      break
    }
    case 'compare': {
      const left = evaluateNode(node.left, inputs) as number
      const right = evaluateNode(node.right, inputs) as number
      switch (node.operator) {
        case '<':
          return left < right
        case '<=':
          return left <= right
        case '>':
          return left > right
        case '>=':
          return left >= right
        case '==':
          return left === right
        case '!=':
          return left !== right
      }
      break
    }
    case 'logic': {
      const values = node.operands.map(operand => evaluateNode(operand, inputs) as boolean)
      if (node.operator === '!') return !values[0]
      return node.operator === 'all' ? values.every(Boolean) : values.some(Boolean)
    }
    case 'rgb': {
      const [red, green, blue] = node.channels.map(channel => Math.min(Math.max((evaluateNode(channel, inputs) as number) / 255, 0), 1))
      return [red!, green!, blue!]
    }
    case 'case': {
      for (const [condition, output] of node.branches) if (evaluateNode(condition, inputs) as boolean) return evaluateNode(output, inputs)
      return evaluateNode(node.fallback, inputs)
    }
    case 'step': {
      const x = evaluateNode(node.input, inputs) as number
      let result = node.base
      for (const [stop, output] of node.stops) if (x >= stop) result = output
      return evaluateNode(result, inputs)
    }
    case 'interpolate': {
      const x = evaluateNode(node.input, inputs) as number
      const { stops } = node
      if (x <= stops[0]![0]) return evaluateNode(stops[0]![1], inputs)
      for (let index = 0; index < stops.length - 1; index++) {
        const [low, lowOutput] = stops[index]!
        const [high, highOutput] = stops[index + 1]!
        if (x <= high) return mixValues(evaluateNode(lowOutput, inputs), evaluateNode(highOutput, inputs), interpolationFactor(x, low, high, node.exponentialBase))
      }
      return evaluateNode(stops.at(-1)![1], inputs)
    }
  }
  throw new Error('TerrainStyle: unreachable expression node.')
}

/**
 * The value of an expression at given inputs, on the CPU, exactly as the terrain shader computes it: for legends,
 * tooltips ("what colour is 2500 m at 35°?") and tests. Colours come back as sRGB channels from 0 to 1.
 */
export function evaluateTerrainExpression(expression: TerrainExpression | TerrainExpressionNode, inputs: Partial<TerrainInputValues>): number | boolean | TerrainColor {
  const node = isParsedTerrainExpression(expression) ? expression : parseAt(expression, '')
  const values: TerrainInputValues = { elevation: 0, slope: 0, 'slope-percent': Math.tan(((inputs.slope ?? 0) * Math.PI) / 180) * 100, aspect: 0, water: 0, ...inputs }
  return evaluateNode(node, values)
}

export function isParsedTerrainExpression(expression: TerrainExpression | TerrainExpressionNode): expression is TerrainExpressionNode {
  return typeof expression === 'object' && expression !== null && !Array.isArray(expression) && 'kind' in expression
}
