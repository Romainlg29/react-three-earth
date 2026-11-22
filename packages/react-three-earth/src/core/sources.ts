import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'

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

/** Raster tiles from an XYZ URL template (OpenStreetMap, MapTiler raster, your own server). */
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

  createOverlay({ opacity }: { opacity: number }): XYZTilesOverlay {
    return new XYZTilesOverlay({
      url: this.url,
      levels: this.levels,
      tileDimension: this.tileDimensionPixels,
      projection: this.projection,
      opacity,
    })
  }
}
