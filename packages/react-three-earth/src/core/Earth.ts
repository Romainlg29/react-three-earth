import { Group, type Camera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { ViewMorph, type ViewMode, type ViewTransitionOptions } from '../view/ViewMorph.js'
import type { Atmosphere } from './Atmosphere.js'
import type { Imagery } from './Imagery.js'
import type { Terrain } from './Terrain.js'

export interface EarthOptions {
  /** Drives the sun's position. Default: now. */
  date?: Date
  /** The view to start in: `'3d'` (globe) or `'2d'` (flat Web Mercator map). Default: '3d'. */
  view?: ViewMode
}

/** A JSON snapshot of what the Earth is doing, for agents and devtools. */
export interface EarthInspection {
  date: string
  /** Main-thread time of the last `update()`: tile traversal, imagery composition and the sun. */
  updateMilliseconds: number
  terrain: null | {
    url: string
    tilesLoaded: number
    tilesVisible: number
    tilesDownloading: number
    tilesParsing: number
    memoryUsedBytes: number
    memoryBudgetBytes: number
    /** Terrain-tile imagery textures composed on the GPU over the last frame. */
    imageryTilesComposited: number
    /** Main-thread milliseconds spent on imagery over the last frame (composition, layer setup, tile splitting). */
    imageryMainThreadMilliseconds: number
    /** Imagery compositions waiting for a later frame's budget. */
    imageryCompositionsPending: number
    /** Terrain-tile imagery textures composed since the terrain was created. */
    imageryTilesCompositedTotal: number
    /** Main-thread milliseconds spent on imagery since the terrain was created. */
    imageryMainThreadMillisecondsTotal: number
  }
  imageryLayers: number
  /** The globe-to-map morph: `morph` is 0 on the globe and 1 on the flat map. */
  view: { mode: ViewMode; morph: number; anchorLongitudeDegrees: number; anchorLatitudeDegrees: number }
  /** Null without an atmosphere. */
  atmosphere: {
    /** True once the lookup textures are generated; until then the scene renders without haze or sky. */
    ready: boolean
    /** True once the skylight is copied to the CPU too (`Atmosphere.getSunAndSkyIlluminance`), shortly after `ready`. */
    skylightOnCpu: boolean
    /** Time the lookup textures took to generate, or to load from the cache. */
    generationTimeMilliseconds: number | null
    /** Animation frames they took. */
    generationFrames: number | null
    loadedFromCache: boolean
  } | null
}

function inspectImagery(terrain: Terrain) {
  const { lastFrame, total } = terrain.overlays.statistics
  return {
    imageryTilesComposited: lastFrame.tilesComposited,
    imageryMainThreadMilliseconds: lastFrame.mainThreadMilliseconds,
    imageryCompositionsPending: terrain.imageryCompositionsPending,
    imageryTilesCompositedTotal: total.tilesComposited,
    imageryMainThreadMillisecondsTotal: total.mainThreadMilliseconds,
  }
}

/**
 * The root of a map: holds the terrain, imagery and atmosphere, all in Earth-centred, Earth-fixed
 * (ECEF, WGS84) metres. Add it to the scene and call `update` once per frame.
 */
export class Earth extends Group {
  date: Date
  terrain: Terrain | null = null
  atmosphere: Atmosphere | null = null
  /** The globe-to-map morph, shared with the terrain, atmosphere and controls. Change it with `setView`. */
  readonly view = new ViewMorph()
  /** Main-thread time of the last `update()`, in milliseconds. */
  lastUpdateMilliseconds = 0
  protected readonly imagery = new Set<Imagery>()
  /** `performance.now()` at the last `update()`, for the morph's clock. */
  protected lastUpdateTimestamp: number | null = null

  constructor({ date = new Date(), view = '3d' }: EarthOptions = {}) {
    super()
    this.name = 'Earth'
    this.date = date
    if (view === '2d') this.view.setMode('2d', { durationSeconds: 0 })
  }

  /**
   * Morphs to the globe (`'3d'`) or the flat Web Mercator map (`'2d'`), over `durationSeconds` (default
   * 1.5, 0 switches at once). The map is anchored where the camera looks, and on the way to 2D the camera
   * turns to look straight down. The morph runs in `update`; `view.transitioning` tells when it is done.
   */
  setView(mode: ViewMode, options?: ViewTransitionOptions): void {
    this.view.setMode(mode, options)
  }

  /**
   * Prepares the renderer for planet-scale coordinates: model-view matrices are computed in 64-bit on
   * the CPU (relative to the camera), so vertices stay stable at centimetre scale anywhere on Earth.
   */
  connect(renderer: WebGPURenderer): void {
    renderer.highPrecision = true
  }

  setTerrain(terrain: Terrain | null): void {
    if (this.terrain === terrain) return
    if (this.terrain !== null) {
      this.terrain.setView(null)
      for (const imagery of this.imagery) this.terrain.removeImagery(imagery)
      this.remove(this.terrain.object)
    }
    this.terrain = terrain
    if (terrain !== null) {
      terrain.setView(this.view)
      this.add(terrain.object)
      for (const imagery of this.imagery) terrain.addImagery(imagery)
    }
  }

  addImagery(imagery: Imagery): void {
    this.imagery.add(imagery)
    this.terrain?.addImagery(imagery)
  }

  removeImagery(imagery: Imagery): void {
    this.imagery.delete(imagery)
    this.terrain?.removeImagery(imagery)
  }

  setAtmosphere(atmosphere: Atmosphere | null): void {
    if (this.atmosphere !== null) this.remove(this.atmosphere.light)
    this.atmosphere = atmosphere
    if (atmosphere !== null) this.add(atmosphere.light)
  }

  /**
   * Advances the view morph, loads tiles for the camera and moves the sun. Call once per frame, before
   * rendering. `deltaSeconds` (time since the last frame) drives the morph; without it the clock is used.
   * Returns true while the view is morphing, so hosts that render on demand can ask for another frame.
   */
  update(camera: Camera, renderer: WebGPURenderer, deltaSeconds?: number): boolean {
    const now = performance.now()
    const delta = deltaSeconds ?? (this.lastUpdateTimestamp === null ? 0 : (now - this.lastUpdateTimestamp) / 1000)
    this.lastUpdateTimestamp = now
    const morphing = this.view.update(camera, Math.min(delta, 0.1))
    this.terrain?.update(camera, renderer)
    if (this.atmosphere !== null) {
      // The sky, haze and sunlight belong to the globe: they fade out on the flat map.
      this.atmosphere.opacity = 1 - this.view.morph
      this.atmosphere.update(camera, this.date)
    }
    this.lastUpdateMilliseconds = performance.now() - now
    return morphing || this.view.transitioning
  }

  inspect(): EarthInspection {
    // Runtime fields 3DTilesRenderer's typings leave out:
    const terrain = this.terrain
    const tiles = terrain?.tiles as
      | (Terrain['tiles'] & {
          rootURL: string
          stats: { loaded: number; downloading: number; parsing: number }
          lruCache: { cachedBytes: number; maxBytesSize: number }
        })
      | undefined
    return {
      date: this.date.toISOString(),
      updateMilliseconds: this.lastUpdateMilliseconds,
      terrain:
        tiles === undefined || terrain === null
          ? null
          : {
              url: tiles.rootURL ?? '',
              tilesLoaded: tiles.stats.loaded,
              tilesVisible: tiles.visibleTiles.size,
              tilesDownloading: tiles.stats.downloading,
              tilesParsing: tiles.stats.parsing,
              memoryUsedBytes: tiles.lruCache.cachedBytes,
              memoryBudgetBytes: tiles.lruCache.maxBytesSize,
              ...inspectImagery(terrain),
            },
      imageryLayers: this.imagery.size,
      view: this.view.inspect(),
      atmosphere:
        this.atmosphere === null
          ? null
          : {
              ready: this.atmosphere.context.texturesReady.value === 1,
              skylightOnCpu: this.atmosphere.illuminance.skyAvailable,
              generationTimeMilliseconds: this.atmosphere.generationTimeMilliseconds,
              generationFrames: this.atmosphere.generationFrames,
              loadedFromCache: this.atmosphere.loadedFromCache,
            },
    }
  }

  override dispose(): void {
    this.terrain?.dispose()
    this.atmosphere?.dispose()
  }
}
