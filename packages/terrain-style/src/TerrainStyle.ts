import type { MaterialFactory } from '@earthkit/globe'
import type { Material } from 'three'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'

import { compileTerrainColor } from './compile.js'
import { parseTerrainExpression, type TerrainExpression, type TerrainExpressionNode } from './expression.js'
import { TERRAIN_STYLE_PRESETS, type TerrainStylePreset } from './presets.js'

export interface TerrainStyleOptions {
  /**
   * The ground's colour: a preset name (`'alpine'`, `'atlas'`, `'desert'`, `'monochrome'`, `'slope-classes'`) or a
   * colour expression over `['elevation']`, `['slope']`, `['slope-percent']` and `['aspect']`.
   */
  color: TerrainStylePreset | TerrainExpression
  /** The material's roughness, 0 to 1. Default: 1 (matte ground). */
  roughness?: number
}

/**
 * A stylised look for the terrain: colours the ground per pixel by elevation, slope and aspect, with no imagery.
 * Pass `createMaterial` to `<Terrain createMaterial>` (or `new Terrain({ createMaterial })`); imagery layers, when
 * there are some, blend over the colour. The expression is compiled once, so every tile shares one shader.
 *
 * Changing the style means a new `TerrainStyle` and so a new `createMaterial`, which reloads the terrain's tiles.
 */
export class TerrainStyle {
  /** The parsed, type-checked colour expression. */
  readonly expression: TerrainExpressionNode
  /** The ground's colour per pixel, in linear RGB: for a material of your own. */
  readonly colorNode: Node<'vec3'>
  readonly roughness: number

  constructor({ color, roughness = 1 }: TerrainStyleOptions) {
    if (!Number.isFinite(roughness) || roughness < 0 || roughness > 1) throw new Error(`TerrainStyle: roughness must be between 0 and 1, got ${roughness}.`)
    const expression = typeof color === 'string' && Object.hasOwn(TERRAIN_STYLE_PRESETS, color) ? TERRAIN_STYLE_PRESETS[color as TerrainStylePreset] : color
    this.expression = parseTerrainExpression(expression, 'color')
    this.colorNode = compileTerrainColor(this.expression)
    this.roughness = roughness
  }

  /** Builds one terrain tile's material. Bound, so it can be passed on as is. */
  readonly createMaterial: MaterialFactory = (): Material => {
    const material = new MeshStandardNodeMaterial({ roughness: this.roughness, metalness: 0 })
    material.colorNode = this.colorNode
    return material
  }
}
