import { Group, type Camera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { Atmosphere } from './Atmosphere.js'
import type { Imagery } from './Imagery.js'
import type { Terrain } from './Terrain.js'

export interface EarthOptions {
  /** Drives the sun's position. Default: now. */
  date?: Date
}

/** A JSON snapshot of what the Earth is doing, for agents and devtools. */
export interface EarthInspection {
  date: string
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
  /** Null without an atmosphere. */
  atmosphere: {
    /** True once the lookup textures are generated; until then the scene renders without haze or sky. */
    ready: boolean
    /** True once the skylight is copied to the CPU too (`Atmosphere.getSunAndSkyIlluminance`), shortly after `ready`. */
    skylightOnCpu: boolean
    generationTimeMilliseconds: number | null
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
  protected readonly imagery = new Set<Imagery>()

  constructor({ date = new Date() }: EarthOptions = {}) {
    super()
    this.name = 'Earth'
    this.date = date
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
      for (const imagery of this.imagery) this.terrain.removeImagery(imagery)
      this.remove(this.terrain.object)
    }
    this.terrain = terrain
    if (terrain !== null) {
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

  /** Loads tiles for the camera and moves the sun. Call once per frame, before rendering. */
  update(camera: Camera, renderer: WebGPURenderer): void {
    this.terrain?.update(camera, renderer)
    this.atmosphere?.update(camera, this.date)
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
      atmosphere:
        this.atmosphere === null
          ? null
          : {
              ready: this.atmosphere.context.texturesReady.value === 1,
              skylightOnCpu: this.atmosphere.illuminance.skyAvailable,
              generationTimeMilliseconds: this.atmosphere.generationTimeMilliseconds,
            },
    }
  }

  override dispose(): void {
    this.terrain?.dispose()
    this.atmosphere?.dispose()
  }
}
