import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'

import { XYZImageryOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import type { GeographicBounds } from './camera.js'
import { MapStyleOverlay } from '../vector/MapStyleOverlay.js'
import { QuantizedMeshVersionPlugin } from '../tiles/QuantizedMeshVersionPlugin.js'

/** Anything that can feed a `Terrain`: a root URL plus the 3DTilesRenderer plugins that read it. */
export interface TerrainSource {
  readonly kind: 'terrain'
  /** The URL the tile renderer starts from. */
  readonly url: string
  /** Plugins this source needs on the tile renderer. Called once per `Terrain`. */
  createPlugins(): object[]
}

/** Anything that can feed an `Imagery` layer. */
export interface ImagerySource {
  readonly kind: 'imagery'
  /** Creates the overlay draped on terrain tiles. Called once per `Imagery`. */
  createOverlay(options: { opacity: number }): unknown
}

export interface QuantizedMeshSourceOptions {
  /**
   * The tileset root, the folder that holds `layer.json`.
   * @example 'https://terrain.reearth.land/cesium-mesh/ellipsoid/'
   */
  url: string
  /** Skirt length hiding cracks between tiles of different levels. Default: chosen per tile by 3DTilesRenderer. */
  skirtLengthMeters?: number
  /** Smooths normals along skirts. Default: true. */
  smoothSkirtNormals?: boolean
}

/**
 * Terrain in Cesium's quantized-mesh-1.0 format (TMS, geographic tiling), such as Re:Earth Terrain or
 * Cesium World Terrain.
 *
 * Heights must be ellipsoidal (WGS84) to sit on the globe; Re:Earth Terrain's `ellipsoid` endpoint
 * already adds the EGM2008 geoid.
 */
export class QuantizedMeshSource implements TerrainSource {
  readonly kind = 'terrain'
  readonly url: string
  readonly skirtLengthMeters: number | undefined
  readonly smoothSkirtNormals: boolean

  constructor({ url, skirtLengthMeters, smoothSkirtNormals = true }: QuantizedMeshSourceOptions) {
    this.url = url.endsWith('/') ? url : `${url}/`
    this.skirtLengthMeters = skirtLengthMeters
    this.smoothSkirtNormals = smoothSkirtNormals
  }

  createPlugins(): object[] {
    return [
      new QuantizedMeshPlugin({
        useRecommendedSettings: true,
        smoothSkirtNormals: this.smoothSkirtNormals,
        ...(this.skirtLengthMeters !== undefined ? { skirtLength: this.skirtLengthMeters } : {}),
      }),
      new QuantizedMeshVersionPlugin(),
    ]
  }
}

export interface RasterTileSourceOptions {
  /**
   * URL template with `{z}`, `{x}` and `{y}`.
   * @example 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
   */
  url: string
  /** Number of zoom levels the server has. Default: 20. */
  levels?: number
  /** Tile size in pixels. Default: 256. */
  tileDimensionPixels?: number
  /** Tiling projection. Default: 'EPSG:3857' (Web Mercator, what XYZ servers use). */
  projection?: 'EPSG:3857' | 'EPSG:4326'
}

/**
 * Raster tiles from an XYZ URL template (OpenStreetMap, MapTiler raster, your own server).
 *
 * Tiles decode off the main thread and are composed onto terrain tiles on the GPU.
 */
export class RasterTileSource implements ImagerySource {
  readonly kind = 'imagery'
  readonly url: string
  readonly levels: number
  readonly tileDimensionPixels: number
  readonly projection: 'EPSG:3857' | 'EPSG:4326'

  constructor({ url, levels = 20, tileDimensionPixels = 256, projection = 'EPSG:3857' }: RasterTileSourceOptions) {
    if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
      throw new Error(
        `RasterTileSource: the url needs {z}, {x} and {y} placeholders, got "${url}". ` +
          `For a WMTS capabilities URL, use a WMTS source instead.`,
      )
    }
    this.url = url
    this.levels = levels
    this.tileDimensionPixels = tileDimensionPixels
    this.projection = projection
  }

  createOverlay({ opacity }: { opacity: number }): XYZImageryOverlay {
    return new XYZImageryOverlay({
      url: this.url,
      levels: this.levels,
      tileDimension: this.tileDimensionPixels,
      projection: this.projection,
      opacity,
    })
  }
}

export interface MapStyleSourceOptions {
  /**
   * A MapLibre style (version 8): its URL, or the style document. Vector sources can be XYZ `tiles`, a
   * TileJSON `url`, or a PMTiles archive (`pmtiles://https://…`).
   * @example 'https://demotiles.maplibre.org/style.json'
   */
  url?: string
  /** The style document itself, instead of `url`. */
  style?: object
  /** Base URL for relative URLs inside `style`. Default: the page's URL. */
  baseUrl?: string
  /** Headers sent with every request (style, TileJSON, tiles, glyphs). Default: none. */
  requestHeaders?: Record<string, string>
  /** CSS font family for glyphs drawn locally, when the style has no `glyphs` URL or lacks a glyph. Default: 'sans-serif'. */
  localFontFamily?: string
  /** Deepest zoom the terrain is textured at; beyond the data's maximum zoom, tiles are overzoomed. Default: 20. */
  maximumZoom?: number
  /**
   * Starts the vector tile worker. Default: the worker shipped with the library. Pass your bundler's worker
   * (for example Vite's `?worker` import) if it cannot follow `new URL(…, import.meta.url)`, or `null` to
   * process tiles on the main thread.
   */
  createWorker?: (() => Worker) | null
}

/**
 * A MapLibre style rendered onto the terrain: fills, lines, circles and text labels from vector tiles (XYZ,
 * TileJSON or PMTiles).
 *
 * Tiles are decoded and tessellated in a worker, then drawn on the GPU straight into each terrain tile's
 * texture, at that texture's resolution, with 4× multisampling. Not supported yet: icons and patterns
 * (sprites), raster, hillshade and heatmap layers, right-to-left and complex scripts, 3D extrusion (drawn
 * flat).
 *
 * When tile data changes on the server, `invalidate(bounds)` redraws what it covers, with no flicker.
 */
export class MapStyleSource implements ImagerySource {
  readonly kind = 'imagery'
  readonly options: MapStyleSourceOptions
  /** Overlays created for `Imagery` layers, live until disposed. */
  protected readonly overlays = new Set<MapStyleOverlay>()

  constructor(options: MapStyleSourceOptions) {
    if ((options.url === undefined) === (options.style === undefined)) {
      throw new Error('MapStyleSource: pass either `url` (a style URL) or `style` (a style document).')
    }
    this.options = options
  }

  createOverlay({ opacity }: { opacity: number }): MapStyleOverlay {
    const { url, style, ...rest } = this.options
    const overlay = new MapStyleOverlay({ ...rest, style: (url ?? style)!, opacity })
    this.pruneDisposedOverlays()
    this.overlays.add(overlay)
    return overlay
  }

  /**
   * Redraws what changed within `bounds` (no argument: everywhere) in every `Imagery` layer using this source:
   * cached tiles there are fetched and processed again, and terrain textures that draw them (labels crossing
   * in from neighbours included) are redrawn in place. Each texture keeps its old content until the new one is
   * ready. Calls within a frame are coalesced.
   * @example source.invalidate({ westDegrees: 138, southDegrees: 35, eastDegrees: 139, northDegrees: 36 })
   */
  invalidate(bounds?: GeographicBounds): void {
    this.pruneDisposedOverlays()
    for (const overlay of this.overlays) overlay.invalidate(bounds)
  }

  /** Regions waiting to be redrawn after `invalidate`, over every layer using this source. */
  get recompositionsPending(): number {
    let count = 0
    for (const overlay of this.overlays) if (!overlay.isDisposed) count += overlay.recompositionsPending
    return count
  }

  protected pruneDisposedOverlays(): void {
    for (const overlay of this.overlays) if (overlay.isDisposed) this.overlays.delete(overlay)
  }
}
