import type { TerrainExpression } from './expression.js'

const lowland: TerrainExpression = ['interpolate', ['linear'], ['elevation'], 0, '#4f7f45', 1200, '#9fb46a', 2400, '#c4ad7e']
const rocky: TerrainExpression = ['interpolate', ['linear'], ['slope'], 28, lowland, 38, '#8a8580']

/**
 * Ready-made looks, as plain expressions: read them to learn the syntax, or start from one. Each needs only the
 * terrain, no imagery.
 */
export const TERRAIN_STYLE_PRESETS = {
  /** Green valleys, dry grass and earth higher up, bare rock on slopes over about 30°, snow above 3000 m except on cliffs. */
  alpine: ['interpolate', ['linear'], ['elevation'], 2800, rocky, 3200, ['step', ['slope'], '#f4f6fa', 45, rocky]],
  /** Classic atlas tints by elevation, from lowland green through tan and brown to white summits. */
  atlas: [
    'interpolate',
    ['linear'],
    ['elevation'],
    0, '#a6c58f',
    200, '#c6d79c',
    500, '#e8e3a6',
    1000, '#e9c98e',
    2000, '#d29a6c',
    3000, '#b98a74',
    4000, '#e6e1dc',
    5000, '#ffffff',
  ],
  /** Sand to red rock by elevation, darker cliffs. */
  desert: [
    'interpolate',
    ['linear'],
    ['slope'],
    30, ['interpolate', ['linear'], ['elevation'], 0, '#e4c99a', 800, '#d4a56a', 1600, '#b97a4a', 2600, '#8f5a3c'],
    40, '#7a4b35',
  ],
  /** Grey by steepness only: a clean base for data drawn on top. */
  monochrome: ['interpolate', ['linear'], ['slope'], 0, '#f2f2f0', 45, '#6d6d6d'],
  /** Avalanche slope classes: 30–35° yellow, 35–40° orange, 40–45° red, steeper purple. */
  'slope-classes': ['step', ['slope'], '#ecebe6', 30, '#f5e33b', 35, '#f39c2c', 40, '#e0412b', 45, '#8e3a8f'],
} as const satisfies Record<string, TerrainExpression>

export type TerrainStylePreset = keyof typeof TERRAIN_STYLE_PRESETS
