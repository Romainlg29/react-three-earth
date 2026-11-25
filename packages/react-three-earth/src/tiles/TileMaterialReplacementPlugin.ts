// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import { Mesh, type Material, type Object3D } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'

import { attachTerrainShadings, type TerrainShadingSet } from './terrainMaterialSlots.js'

export type MaterialFactory = () => Material

const defaultMaterialFactory: MaterialFactory = () => new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })

/**
 * Replaces every tile's material with a node material, keeping its `map`. Loaders such as the
 * quantized-mesh one create classic materials; node materials are what TSL slots hang on.
 */
export class TileMaterialReplacementPlugin {
  readonly name = 'TILE_MATERIAL_REPLACEMENT_PLUGIN'
  readonly priority = -1000
  tiles: TilesRenderer | null = null

  constructor(
    protected readonly createMaterial: MaterialFactory = defaultMaterialFactory,
    /** The terrain's shadings (plugins), applied over each material's own nodes. */
    protected readonly shadings: TerrainShadingSet | null = null,
  ) {}

  init(tiles: TilesRenderer): void {
    this.tiles = tiles
    tiles.forEachLoadedModel((scene: Object3D, tile: Tile) => this.processTileModel(scene, tile))
  }

  processTileModel(scene: Object3D, _tile: Tile): void {
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      const previous = object.material as Material & { map?: unknown }
      if (Array.isArray(previous)) throw new Error('TileMaterialReplacementPlugin: multi-material meshes are not supported yet.')
      const next = this.createMaterial() as Material & { map?: unknown }
      if ('map' in previous && previous.map != null && 'map' in next) next.map = previous.map
      attachTerrainShadings(next, this.shadings)
      object.material = next
      previous.dispose()
    })
  }
}
