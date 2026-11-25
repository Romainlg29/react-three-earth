import { terrainAspectDegrees, terrainElevationMeters, terrainSlopeDegrees, terrainSlopePercent } from '@earthkit/globe'
import { abs, clamp, cos, float, max, min, mix, pow, select, sin, sqrt, sRGBTransferEOTF, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { parseTerrainExpression, type TerrainExpression, type TerrainExpressionNode, type TerrainInput } from './expression.js'

// TSL's typed nodes do not narrow through a recursive walk over any expression: the walk is untyped, and the two
// exported functions type their result.
type AnyNode = any

const INPUT_NODES: Record<TerrainInput, Node> = {
  elevation: terrainElevationMeters,
  slope: terrainSlopeDegrees,
  'slope-percent': terrainSlopePercent,
  aspect: terrainAspectDegrees,
}

function interpolationFactorNode(x: AnyNode, low: number, high: number, exponentialBase: number): AnyNode {
  const difference = high - low
  if (exponentialBase === 1) return clamp(x.sub(low).div(difference), 0, 1) as unknown as AnyNode
  return clamp(pow(float(exponentialBase), x.sub(low)).sub(1).div(exponentialBase ** difference - 1), 0, 1) as unknown as AnyNode
}

function toNode(node: TerrainExpressionNode): AnyNode {
  const any = (value: unknown) => value as AnyNode
  switch (node.kind) {
    case 'number':
      return any(float(node.value))
    case 'boolean':
      return any(float(node.value ? 1 : 0).greaterThan(0.5))
    case 'color':
      return any(vec3(...node.value))
    case 'input':
      return any(INPUT_NODES[node.name])
    case 'math': {
      const operands = node.operands.map(toNode)
      const [first, second] = operands as [AnyNode, AnyNode]
      switch (node.operator) {
        case '+':
          return operands.slice(1).reduce((sum, value) => sum.add(value), first)
        case '-':
          return operands.length === 1 ? first.negate() : first.sub(second)
        case '*':
          return operands.slice(1).reduce((product, value) => product.mul(value), first)
        case '/':
          return first.div(second)
        case '%':
          // Truncated like JavaScript and MapLibre, not floored like GLSL's mod.
          return first.sub(first.div(second).trunc().mul(second))
        case '^':
          return any(pow(first, second))
        case 'min':
          return operands.slice(1).reduce((least, value) => any(min(least, value)), first)
        case 'max':
          return operands.slice(1).reduce((most, value) => any(max(most, value)), first)
        case 'abs':
          return any(abs(first))
        case 'sqrt':
          return any(sqrt(first))
        case 'sin':
          return any(sin(first))
        case 'cos':
          return any(cos(first))
      }
      break
    }
    case 'compare': {
      const left = toNode(node.left)
      const right = toNode(node.right)
      const method = { '<': 'lessThan', '<=': 'lessThanEqual', '>': 'greaterThan', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual' }[node.operator]
      return left[method]!(right)
    }
    case 'logic': {
      const operands = node.operands.map(toNode)
      if (node.operator === '!') return operands[0]!.not()
      const method = node.operator === 'all' ? 'and' : 'or'
      return operands.slice(1).reduce((result, value) => result[method]!(value), operands[0]!)
    }
    case 'rgb':
      return any(clamp(vec3(...node.channels.map(toNode)).div(255), 0, 1))
    case 'case': {
      // From the fallback back to the first branch, so the first true condition wins.
      let result = toNode(node.fallback)
      for (let index = node.branches.length - 1; index >= 0; index--) {
        const [condition, output] = node.branches[index]!
        result = any(select(toNode(condition), toNode(output), result))
      }
      return result
    }
    case 'step': {
      const x = toNode(node.input)
      let result = toNode(node.base)
      for (const [stop, output] of node.stops) result = any(select(x.greaterThanEqual(stop), toNode(output), result))
      return result
    }
    case 'interpolate': {
      // Each segment's factor is 0 before it and 1 after it, so mixing segment by segment lands on the right one.
      const x = toNode(node.input)
      const { stops } = node
      let result = toNode(stops[0]![1])
      for (let index = 0; index < stops.length - 1; index++) {
        const factor = interpolationFactorNode(x, stops[index]![0], stops[index + 1]![0], node.exponentialBase)
        result = any(mix(result, toNode(stops[index + 1]![1]), factor))
      }
      return result
    }
  }
  throw new Error('TerrainStyle: unreachable expression node.')
}

/**
 * Compiles a colour expression into a TSL node for a terrain material's `colorNode`: the ground's colour per pixel,
 * in linear RGB. Colours blend in sRGB, as MapLibre does, then convert. Throws, stating the fix, on an invalid
 * expression. Compile once and share the node between every tile's material, so the shader compiles once.
 */
export function compileTerrainColor(expression: TerrainExpression | TerrainExpressionNode): Node<'vec3'> {
  const parsed = typeof expression === 'object' && expression !== null && !Array.isArray(expression) ? (expression as TerrainExpressionNode) : parseTerrainExpression(expression as TerrainExpression, 'color')
  if (parsed.type !== 'color') throw new Error(`TerrainStyle: the colour expression gives a ${parsed.type}; give colours as outputs, for example "#4f7f45".`)
  return sRGBTransferEOTF(toNode(parsed)) as unknown as Node<'vec3'>
}

/** Compiles a number expression into a TSL float node (for a material's `roughnessNode`, an opacity, a height). */
export function compileTerrainNumber(expression: TerrainExpression): Node<'float'> {
  return toNode(parseTerrainExpression(expression, 'number')) as unknown as Node<'float'>
}
