import { describe, expect, it } from 'vitest'

import { compileTerrainColor, compileTerrainNumber, evaluateTerrainExpression, parseTerrainExpression, TERRAIN_STYLE_PRESETS, TerrainStyle, type TerrainExpression } from '../src/index.js'

const hex = (color: unknown) =>
  `#${(color as number[]).map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`

describe('evaluateTerrainExpression', () => {
  it('colours by slope then elevation with case, as the shader does', () => {
    const expression: TerrainExpression = ['case', ['>', ['slope'], 20], '#cccccc', ['>=', ['elevation'], 2000], '#ffffff', '#336633']
    expect(hex(evaluateTerrainExpression(expression, { slope: 25, elevation: 500 }))).toBe('#cccccc')
    expect(hex(evaluateTerrainExpression(expression, { slope: 10, elevation: 2000 }))).toBe('#ffffff')
    expect(hex(evaluateTerrainExpression(expression, { slope: 10, elevation: 1999 }))).toBe('#336633')
  })

  it('steps at each stop and before the first', () => {
    const expression: TerrainExpression = ['step', ['elevation'], 1, 1000, 2, 2000, 3]
    expect(evaluateTerrainExpression(expression, { elevation: -50 })).toBe(1)
    expect(evaluateTerrainExpression(expression, { elevation: 1000 })).toBe(2)
    expect(evaluateTerrainExpression(expression, { elevation: 5000 })).toBe(3)
  })

  it('interpolates linearly and exponentially, clamped outside the stops, colours in sRGB', () => {
    expect(evaluateTerrainExpression(['interpolate', ['linear'], ['elevation'], 0, 0, 100, 10], { elevation: 25 })).toBeCloseTo(2.5)
    expect(evaluateTerrainExpression(['interpolate', ['linear'], ['elevation'], 0, 0, 100, 10], { elevation: 500 })).toBe(10)
    // MapLibre's exponential factor: (2^25 - 1) / (2^100 - 1) is nearly 0
    expect(evaluateTerrainExpression(['interpolate', ['exponential', 2], ['elevation'], 0, 0, 100, 10], { elevation: 25 })).toBeCloseTo(0, 6)
    // A base meant for zoom levels, over metres: 1.5^1000 overflows the naive formula
    const wide: TerrainExpression = ['interpolate', ['exponential', 1.5], ['elevation'], 0, 0, 1000, 10]
    expect(evaluateTerrainExpression(wide, { elevation: 999 })).toBeCloseTo(10 / 1.5, 6)
    expect(evaluateTerrainExpression(wide, { elevation: 2000 })).toBe(10)
    expect(evaluateTerrainExpression(wide, { elevation: 500 })).toBeCloseTo(0, 6)
    expect(evaluateTerrainExpression(['interpolate', ['exponential', 0.5], ['elevation'], 0, 0, 10, 10], { elevation: 1 })).toBeCloseTo((10 * (0.5 - 1)) / (0.5 ** 10 - 1), 6)
    expect(hex(evaluateTerrainExpression(['interpolate', ['linear'], ['slope'], 0, '#000000', 90, '#ffffff'], { slope: 45 }))).toMatch(/^#(7f7f7f|808080)$/)
  })

  it('reads slope-percent and aspect, with maths and logic', () => {
    expect(evaluateTerrainExpression(['slope-percent'], { slope: 45 })).toBeCloseTo(100)
    const southFacingSteep: TerrainExpression = ['all', ['>', ['aspect'], 135], ['<', ['aspect'], 225], ['>=', ['slope'], 30]]
    expect(evaluateTerrainExpression(southFacingSteep, { aspect: 180, slope: 35 })).toBe(true)
    expect(evaluateTerrainExpression(['!', southFacingSteep], { aspect: 0, slope: 35 })).toBe(true)
    expect(evaluateTerrainExpression(['+', ['*', ['elevation'], 2], ['%', 7, 4], ['-', 1]], { elevation: 10 })).toBe(22)
    expect(hex(evaluateTerrainExpression(['rgb', 255, ['/', ['elevation'], 10], 0], { elevation: 1280 }))).toBe('#ff8000')
  })
})

describe('parseTerrainExpression', () => {
  it('states the fix for mistakes', () => {
    expect(() => parseTerrainExpression(['get', 'height'])).toThrow(/unknown operator "get".*\["elevation"\]/)
    expect(() => parseTerrainExpression(['step', ['elevation'], '#000', 2000, '#fff', 1000, '#888'])).toThrow(/must increase: 1000 follows 2000 \(at \[5\]\)/)
    expect(() => parseTerrainExpression(['case', ['>', ['slope'], 20], '#ccc', 3])).toThrow(/outputs of "case" must all be colors/)
    expect(() => parseTerrainExpression('#zzzzzz')).toThrow(/not a colour/)
    expect(() => new TerrainStyle({ color: 'alpin' })).toThrow(/or a preset name \(alpine/)
    expect(() => new TerrainStyle({ color: 'constructor' })).toThrow(/not a colour/)
    expect(() => parseTerrainExpression(['elevation'])).toThrow(/must give a color, but it gives a number/)
    expect(() => parseTerrainExpression(['interpolate', ['cubic-bezier', 0, 0, 1, 1], ['slope'], 0, '#000', 1, '#fff'])).toThrow(/cubic-bezier is not supported/)
    expect(() => parseTerrainExpression(['case', ['slope'], '#000', '#fff'])).toThrow(/condition of "case" must be boolean/)
  })

  it('accepts every preset', () => {
    for (const [name, expression] of Object.entries(TERRAIN_STYLE_PRESETS)) {
      expect(() => parseTerrainExpression(expression), name).not.toThrow()
    }
  })

  it('gives the alpine preset its bands', () => {
    const alpine = TERRAIN_STYLE_PRESETS.alpine
    expect(hex(evaluateTerrainExpression(alpine, { elevation: 0, slope: 5 }))).toBe('#4f7f45')
    expect(hex(evaluateTerrainExpression(alpine, { elevation: 1000, slope: 40 }))).toBe('#8a8580')
    expect(hex(evaluateTerrainExpression(alpine, { elevation: 3500, slope: 10 }))).toBe('#f4f6fa')
    expect(hex(evaluateTerrainExpression(alpine, { elevation: 3500, slope: 60 }))).toBe('#8a8580')
  })
})

describe('compiling to TSL', () => {
  it('builds one node per expression and refuses a number where a colour belongs', () => {
    expect(compileTerrainColor(TERRAIN_STYLE_PRESETS.atlas)).toBeDefined()
    expect(compileTerrainNumber(['interpolate', ['linear'], ['slope'], 0, 1, 90, 0.4])).toBeDefined()
    expect(() => compileTerrainColor(['slope'])).toThrow(/must give a color/)
  })

  it('shares one colour node between every tile material', () => {
    const style = new TerrainStyle({ color: 'alpine' })
    const first = style.createMaterial() as unknown as { colorNode: unknown; roughness: number }
    const second = style.createMaterial() as unknown as { colorNode: unknown }
    expect(first.colorNode).toBe(style.colorNode)
    expect(second.colorNode).toBe(first.colorNode)
    expect(first.roughness).toBe(1)
    expect(() => new TerrainStyle({ color: 'alpine', roughness: 2 })).toThrow(/between 0 and 1/)
  })
})
