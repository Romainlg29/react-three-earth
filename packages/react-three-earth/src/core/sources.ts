import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'

import { AttributionTracker, type AttributionProvider } from './attribution.js'
import { XYZImageryOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import type { GeographicBounds } from './camera.js'
import { MapStyleOverlay } from '../vector/MapStyleOverlay.js'
import { toStyleImage, type StyleImageInput, type StyleImageOptions } from '../vector/styleImageInput.js'
import type { StyleImage } from '../vector/worker/types.js'
import { QuantizedMeshVersionPlugin } from '../tiles/QuantizedMeshVersionPlugin.js'

/** Anything that can feed a `Terrain`: a root URL plus the 3DTilesRenderer plugins that read it. */
export interface TerrainSource extends Partial<AttributionProvider> {
  readonly kind: 'terrain'
  /** The URL the tile renderer starts from. */
  readonly url: string
  /** Plugins this source needs on the tile renderer. Called once per `Terrain`. */
  createPlugins(): object[]
}

/** Anything that can feed an `Imagery` layer. */
export interface ImagerySource extends Partial<AttributionProvider> {
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
  /**
   * Credit for the data, shown by `AttributionControl` and returned by `Earth.getAttributions()`. Plain text, or
   * HTML where only `<a href="https://…">` links are kept.
   * @example '<a href="https://reearth.io">Re:Earth</a> Terrain'
   */
  attribution?: string | readonly string[]
}

/**
 * Terrain in Cesium's quantized-mesh-1.0 format (TMS, geographic tiling), such as Re:Earth Terrain or
 * Cesium World Terrain.
 *
 * Heights must be ellipsoidal (WGS84) to sit on the globe; Re:Earth Terrain's `ellipsoid` endpoint
 * already adds the EGM2008 geoid.
 */
export class QuantizedMeshSource extends AttributionTracker implements TerrainSource {
  readonly kind = 'terrain'
  readonly url: string
  readonly skirtLengthMeters: number | undefined
  readonly smoothSkirtNormals: boolean

  constructor({ url, skirtLengthMeters, smoothSkirtNormals = true, attribution }: QuantizedMeshSourceOptions) {
    super(attribution)
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
  /**
   * Credit for the tiles, shown by `AttributionControl` and returned by `Earth.getAttributions()`. Plain text, or
   * HTML where only `<a href="https://…">` links are kept. Most tile servers require it.
   * @example '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
   */
  attribution?: string | readonly string[]
}

/**
 * Raster tiles from an XYZ URL template (OpenStreetMap, MapTiler raster, your own server).
 *
 * Tiles decode off the main thread and are composed onto terrain tiles on the GPU.
 */
export class RasterTileSource extends AttributionTracker implements ImagerySource {
  readonly kind = 'imagery'
  readonly url: string
  readonly levels: number
  readonly tileDimensionPixels: number
  readonly projection: 'EPSG:3857' | 'EPSG:4326'

  constructor({ url, levels = 20, tileDimensionPixels = 256, projection = 'EPSG:3857', attribution }: RasterTileSourceOptions) {
    super(attribution)
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
  /**
   * Credit in addition to the `attribution` the style's sources and their TileJSON or PMTiles metadata carry,
   * which is read once the style has loaded. Same format as `RasterTileSource`'s.
   */
  attribution?: string | readonly string[]
  /**
   * Sprite sheet resolution: 2 loads the style's `@2x` sprite, 1 the plain one. Default: 2 on high-density
   * screens (`devicePixelRatio` > 1), else 1.
   */
  spritePixelRatio?: number
  /**
   * Called once per image id when a tile asks for an image (a `fill-pattern`, for example) that neither the
   * style's sprite nor `addImage` provide: MapLibre's `styleimagemissing`. Call `addImage` from it to fill the
   * gap; the tiles that asked are redrawn with it.
   */
  onStyleImageMissing?: (imageId: string) => void
}

/**
 * A MapLibre style rendered onto the terrain: fills, lines, circles and text labels from vector tiles (XYZ,
 * TileJSON or PMTiles).
 *
 * Tiles are decoded and tessellated in a worker, then drawn on the GPU straight into each terrain tile's
 * texture, at that texture's resolution, with 4× multisampling. Patterns (`fill-pattern`, `line-pattern`,
 * `background-pattern`) come from the style's sprite and from `addImage`. Not supported yet: icons, raster,
 * hillshade and heatmap layers, right-to-left and complex scripts, 3D extrusion (drawn flat).
 *
 * Attribution: the style's sources and their TileJSON or PMTiles metadata name their credit; it is read when
 * the style loads and joins `attribution`, and `attributionchange` fires on the earth.
 *
 * When tile data changes on the server, `invalidate(bounds)` redraws what it covers, with no flicker.
 */
export class MapStyleSource extends AttributionTracker implements ImagerySource {
  readonly kind = 'imagery'
  readonly options: MapStyleSourceOptions
  /** Overlays created for `Imagery` layers, live until disposed. */
  protected readonly overlays = new Set<MapStyleOverlay>()
  /** Images added with `addImage`, handed to every overlay, including those created later. */
  protected readonly images = new Map<string, StyleImage>()
  /** Missing image ids reported to `onStyleImageMissing`, once across overlays until added. */
  protected readonly reportedMissingImages = new Set<string>()

  constructor(options: MapStyleSourceOptions) {
    super(options.attribution)
    if ((options.url === undefined) === (options.style === undefined)) {
      throw new Error('MapStyleSource: pass either `url` (a style URL) or `style` (a style document).')
    }
    this.options = options
  }

  createOverlay({ opacity }: { opacity: number }): MapStyleOverlay {
    const { url, style, attribution: _attribution, onStyleImageMissing: _onStyleImageMissing, ...rest } = this.options
    const overlay = new MapStyleOverlay({
      ...rest,
      style: (url ?? style)!,
      opacity,
      images: this.images,
      onLoad: summary => this.setLoadedAttributions(summary.attributions),
      onStyleImageMissing: imageId => this.reportMissingImage(imageId),
    })
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

  /**
   * Adds an image the style can use by id: as a pattern (`fill-pattern`, `line-pattern`, `background-pattern`),
   * like an image of the style's sprite. An image of the same id in the sprite is hidden by it. Tiles that use
   * the id are redrawn.
   * @example
   * const image = new Image()
   * image.src = '/stripes.png'
   * await image.decode()
   * source.addImage('stripes', image, { pixelRatio: 2 })
   */
  addImage(id: string, image: StyleImageInput, options: StyleImageOptions = {}): void {
    if (this.images.has(id)) throw new Error(`MapStyleSource.addImage: an image named "${id}" already exists; call updateImage("${id}", image) to replace it.`)
    this.setImage(id, toStyleImage(id, image, options))
  }

  /**
   * Replaces an image added with `addImage`, keeping its options unless new ones are given. Regions that use it
   * are redrawn; at the same size they are not even rebuilt (only the atlas pixels change), so it is cheap
   * enough to animate.
   */
  updateImage(id: string, image: StyleImageInput, options?: StyleImageOptions): void {
    const previous = this.images.get(id)
    if (previous === undefined) throw new Error(`MapStyleSource.updateImage: no image named "${id}"; call addImage("${id}", image) first.`)
    const { pixelRatio, sdf, stretchX, stretchY, content } = previous
    this.setImage(id, toStyleImage(id, image, options ?? { pixelRatio, sdf, ...(stretchX ? { stretchX } : {}), ...(stretchY ? { stretchY } : {}), ...(content ? { content } : {}) }))
  }

  /** Removes an image added with `addImage`; a sprite image of the same id shows again. Does nothing for other ids. */
  removeImage(id: string): void {
    if (!this.images.delete(id)) return
    this.reportedMissingImages.delete(id)
    this.pruneDisposedOverlays()
    for (const overlay of this.overlays) overlay.setImage(id, null).catch(warnUnlessAborted)
  }

  /** Whether an image of this id exists: added with `addImage`, or in the style's sprite once it has loaded. */
  hasImage(id: string): boolean {
    this.pruneDisposedOverlays()
    return this.images.has(id) || [...this.overlays].some(overlay => overlay.hasImage(id))
  }

  protected setImage(id: string, image: StyleImage): void {
    this.images.set(id, image)
    this.reportedMissingImages.delete(id)
    this.pruneDisposedOverlays()
    for (const overlay of this.overlays) overlay.setImage(id, image).catch(warnUnlessAborted)
  }

  protected reportMissingImage(imageId: string): void {
    if (this.reportedMissingImages.has(imageId) || this.images.has(imageId)) return
    this.reportedMissingImages.add(imageId)
    this.options.onStyleImageMissing?.(imageId)
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

/** Image changes cut short by `dispose` are expected; anything else is worth a warning. */
function warnUnlessAborted(error: unknown): void {
  if ((error as Error | undefined)?.name === 'AbortError') return
  console.warn(`MapStyleSource: an image change failed; call updateImage again to retry. ${(error as Error).message}`)
}
