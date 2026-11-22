import type { Camera, Object3D } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { EarthTilesRenderer } from '../tiles/EarthTilesRenderer.js'
import { FlatMapPlugin } from '../tiles/FlatMapPlugin.js'
import { ImageOverlayPlugin } from '../tiles/ImageOverlayPlugin.js'
import { TileMaterialReplacementPlugin, type MaterialFactory } from '../tiles/TileMaterialReplacementPlugin.js'
import { TilesFadePlugin } from '../tiles/TilesFadePlugin.js'
import type { ImageryFrameStatistics } from '../tiles/imagery/ImageryStatistics.js'
import type { ViewMorph } from '../view/ViewMorph.js'
import type { AttributionProvider } from './attribution.js'
import type { Imagery } from './Imagery.js'
import type { TerrainSource } from './sources.js'

export interface TerrainOptions {
  /** The terrain source. Only the first one is used for now. */
  sources: TerrainSource[]
  /** Screen-space error target in pixels: lower is sharper and loads more. Default: 2 (QuantizedMeshPlugin's recommended setting). */
  errorTargetPixels?: number
  /** GPU memory budget for terrain geometry and imagery, in bytes. Default: 300 MB, sized for phones. */
  memoryBudgetBytes?: number
  /** Cross-fade tiles as they swap level of detail. Default: true. */
  fade?: boolean
  /** Builds each tile's material. Default: an untextured `MeshStandardNodeMaterial`. */
  createMaterial?: MaterialFactory
  /**
   * Main-thread time per frame for composing imagery onto terrain tiles on the GPU, in milliseconds. At
   * least one terrain tile is composed per frame regardless. Default: 2.
   */
  imageryCompositionBudgetMilliseconds?: number
}

const MEGABYTE_BYTES = 2 ** 20
/** 3DTilesRenderer's `rootLoadingState` values (its `UNLOADED` and `LOADING` constants). */
const ROOT_UNLOADED = 0
const ROOT_LOADING = 2

/** 3DTilesRenderer events asking for another `update` or render. */
const FRAME_REQUEST_EVENTS = ['needs-update', 'needs-render', 'load-error'] as const

interface FrameRequestDispatcher {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** The ground: a terrain tile pyramid with imagery layers draped on it. */
export class Terrain implements AttributionProvider {
  readonly tiles: EarthTilesRenderer
  readonly overlays: ImageOverlayPlugin
  /** Lays the tiles on the flat map and morphs them (see `setView`). */
  readonly flatMap: FlatMapPlugin
  protected readonly imagery = new Set<Imagery>()
  protected readonly source: TerrainSource
  /** Set when the tiles ask for another `update` (a tile finished loading), cleared by `update`. */
  protected updateRequested = false

  constructor({
    sources,
    errorTargetPixels,
    memoryBudgetBytes = 300 * MEGABYTE_BYTES,
    fade = true,
    createMaterial,
    imageryCompositionBudgetMilliseconds,
  }: TerrainOptions) {
    const [source, ...ignored] = sources
    if (source === undefined) throw new Error('Terrain: needs one source, for example new QuantizedMeshSource({ url }).')
    if (ignored.length > 0) console.warn('Terrain: only the first source is used for now; stacking terrain sources is planned.')

    this.source = source
    this.tiles = new EarthTilesRenderer(source.url)
    for (const plugin of source.createPlugins()) this.tiles.registerPlugin(plugin)
    this.tiles.registerPlugin(new TileMaterialReplacementPlugin(createMaterial))
    this.overlays = new ImageOverlayPlugin({ compositionBudgetMilliseconds: imageryCompositionBudgetMilliseconds })
    this.tiles.registerPlugin(this.overlays)
    if (fade) this.tiles.registerPlugin(new TilesFadePlugin())
    this.flatMap = new FlatMapPlugin()
    this.tiles.registerPlugin(this.flatMap)

    // A failed load needs an update too, to see that nothing is loading any more.
    for (const type of ['needs-update', 'load-error']) {
      ;(this.tiles as unknown as FrameRequestDispatcher).addEventListener(type, () => {
        this.updateRequested = true
      })
    }

    if (errorTargetPixels !== undefined) this.tiles.errorTarget = errorTargetPixels
    this.tiles.lruCache.maxBytesSize = memoryBudgetBytes
    this.tiles.lruCache.minBytesSize = memoryBudgetBytes * 0.75
  }

  /** The credits of the terrain source. */
  getAttributions(): readonly string[] {
    return this.source.getAttributions?.() ?? []
  }

  /** Calls `listener` when `getAttributions()` changes. Returns a function that removes it. */
  addAttributionListener(listener: () => void): () => void {
    return this.source.addAttributionListener?.(listener) ?? (() => {})
  }

  /** The object to add to the scene. */
  get object(): Object3D {
    return this.tiles.group
  }

  /** Follows a globe-to-map morph: tiles are selected and drawn for it. `Earth.setTerrain` calls it. */
  setView(view: ViewMorph | null): void {
    this.tiles.view = view
    this.flatMap.view = view
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

  /**
   * Main-thread imagery work over the last frame: terrain tiles composed and milliseconds spent, with a
   * breakdown. For on-device profiling; `Earth.inspect()` reports the main figures. The object is reused
   * every frame: copy it to keep it.
   */
  get imageryStatistics(): ImageryFrameStatistics {
    return this.overlays.statistics.lastFrame
  }

  /** Imagery compositions waiting for a later frame's budget. */
  get imageryCompositionsPending(): number {
    return this.overlays.compositor.pendingCount
  }

  /**
   * True while the tileset's root or terrain tiles are queued, downloading or parsing, a loaded tile still waits for the next
   * `update` to be shown, or imagery waits to be composed. `Earth` reads it for the `idle` event.
   */
  get loading(): boolean {
    const { stats, rootLoadingState, isLoading } = this.tiles as unknown as {
      stats: { queued: number; downloading: number; parsing: number }
      rootLoadingState: number
      /** Download, parse or child-preparation tasks still running (3DTilesRenderer's own `tiles-load-end` test). */
      isLoading: boolean
    }
    if (rootLoadingState === ROOT_UNLOADED || rootLoadingState === ROOT_LOADING || isLoading) return true
    const { queued, downloading, parsing } = stats
    return this.updateRequested || queued + downloading + parsing > 0 || this.imageryCompositionsPending > 0
  }

  /**
   * Calls `listener` whenever the terrain needs another frame: tiles finished loading, or imagery is still
   * waiting to be composed. Hosts that render on demand (R3F `frameloop="demand"`) forward it to their
   * invalidate. Returns a function that removes the listener.
   */
  addFrameRequestListener(listener: () => void): () => void {
    const tiles = this.tiles as unknown as FrameRequestDispatcher
    for (const type of FRAME_REQUEST_EVENTS) tiles.addEventListener(type, listener)
    return () => {
      for (const type of FRAME_REQUEST_EVENTS) tiles.removeEventListener(type, listener)
    }
  }

  /**
   * Selects and loads tiles for this camera, and composes imagery that finished loading. Call once per
   * frame before rendering.
   */
  update(camera: Camera, renderer: WebGPURenderer): void {
    this.updateRequested = false
    this.tiles.setCamera(camera)
    this.tiles.setResolutionFromRenderer(camera, renderer as never)
    this.tiles.update()
    this.overlays.composeImagery(renderer)
  }

  dispose(): void {
    this.tiles.dispose()
  }
}
