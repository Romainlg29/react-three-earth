import { TilesRenderer } from '3d-tiles-renderer'
import type { Camera, Object3D } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { ImageOverlayPlugin } from '../tiles/ImageOverlayPlugin.js'
import { TileMaterialReplacementPlugin, type MaterialFactory } from '../tiles/TileMaterialReplacementPlugin.js'
import { TilesFadePlugin } from '../tiles/TilesFadePlugin.js'
import type { Imagery } from './Imagery.js'
import type { TerrainSource } from './sources.js'

export interface TerrainOptions {
  /** The terrain source. Only the first one is used for now. */
  sources: TerrainSource[]
  /** Screen-space error target in pixels: lower is sharper and loads more. Default: 6 (3DTilesRenderer's terrain setting). */
  errorTargetPixels?: number
  /** GPU memory budget for terrain geometry and imagery, in bytes. Default: 300 MB, sized for phones. */
  memoryBudgetBytes?: number
  /** Cross-fade tiles as they swap level of detail. Default: true. */
  fade?: boolean
  /** Builds each tile's material. Default: an untextured `MeshStandardNodeMaterial`. */
  createMaterial?: MaterialFactory
}

const MEGABYTE_BYTES = 2 ** 20

/** The ground: a terrain tile pyramid with imagery layers draped on it. */
export class Terrain {
  readonly tiles: TilesRenderer
  readonly overlays: ImageOverlayPlugin
  protected readonly imagery = new Set<Imagery>()

  constructor({ sources, errorTargetPixels, memoryBudgetBytes = 300 * MEGABYTE_BYTES, fade = true, createMaterial }: TerrainOptions) {
    const [source, ...ignored] = sources
    if (source === undefined) throw new Error('Terrain: needs one source, for example new QuantizedMeshSource({ url }).')
    if (ignored.length > 0) console.warn('Terrain: only the first source is used for now; stacking terrain sources is planned.')

    this.tiles = new TilesRenderer(source.url)
    for (const plugin of source.createPlugins()) this.tiles.registerPlugin(plugin)
    this.tiles.registerPlugin(new TileMaterialReplacementPlugin(createMaterial))
    this.overlays = new ImageOverlayPlugin({ overlays: [], renderer: null as never })
    this.tiles.registerPlugin(this.overlays)
    if (fade) this.tiles.registerPlugin(new TilesFadePlugin())

    if (errorTargetPixels !== undefined) this.tiles.errorTarget = errorTargetPixels
    this.tiles.lruCache.maxBytesSize = memoryBudgetBytes
    this.tiles.lruCache.minBytesSize = memoryBudgetBytes * 0.75
  }

  /** The object to add to the scene. */
  get object(): Object3D {
    return this.tiles.group
  }

  addImagery(imagery: Imagery): void {
    if (this.imagery.has(imagery)) return
    this.imagery.add(imagery)
    for (const overlay of imagery.overlays) this.overlays.addOverlay(overlay as never)
  }

  removeImagery(imagery: Imagery): void {
    if (!this.imagery.delete(imagery)) return
    for (const overlay of imagery.overlays) this.overlays.deleteOverlay(overlay as never)
  }

  /** Selects and loads tiles for this camera. Call once per frame before rendering. */
  update(camera: Camera, renderer: WebGPURenderer): void {
    this.tiles.setCamera(camera)
    this.tiles.setResolutionFromRenderer(camera, renderer as never)
    this.tiles.update()
  }

  dispose(): void {
    this.tiles.dispose()
  }
}
