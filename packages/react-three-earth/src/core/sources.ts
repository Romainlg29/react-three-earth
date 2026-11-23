import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'
import type { Feature, GeoJSON, Point } from 'geojson'

import { AttributionTracker, type AttributionProvider } from './attribution.js'
import { XYZImageryOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import type { GeographicBounds } from './camera.js'
import { MapStyle, type MapStyleEventMap, type ProtocolLoader, type TransformRequest } from '../vector/MapStyle.js'
import { MapStyleOverlay, type SourceFeatureQueryOptions } from '../vector/MapStyleOverlay.js'
import type { StyleLayer } from '../vector/StyleLayer.js'
import type { GeoJsonSource } from '../vector/GeoJsonSource.js'
import type { GeoJsonSourceDiff } from '../vector/worker/geoJsonData.js'
import type { FeatureIdentifier } from '../vector/worker/featureState.js'
import type { StyleDocument, StyleDocumentLayer } from '../vector/worker/styleDocument.js'
import type { FeatureState, SourceFeature } from '../vector/worker/types.js'
import { toStyleImage, type StyleImageInput, type StyleImageOptions } from '../vector/styleImageInput.js'
import type { StyleImage } from '../vector/worker/types.js'
import { QuantizedMeshVersionPlugin } from '../tiles/QuantizedMeshVersionPlugin.js'
import { RasterDemTerrainPlugin } from '../tiles/RasterDemTerrainPlugin.js'
import { demUnpackFactors, type DemEncoding, type DemUnpackFactors } from '../vector/raster/rasterTiles.js'

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

export interface RasterDemSourceOptions {
  /**
   * URL template of elevation tiles (PNG or WebP, Web Mercator XYZ) with `{z}`, `{x}` and `{y}` (or `{-y}` for TMS
   * rows). Pass this or `tileJsonUrl`.
   * @example 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
   */
  url?: string
  /** A TileJSON document describing the tiles, instead of `url`: its `tiles`, `maxzoom`, `scheme` and `attribution` are read. */
  tileJsonUrl?: string
  /**
   * How heights are packed into the tiles' colours, as MapLibre's `raster-dem` source: `'terrarium'`
   * (`R × 256 + G + B / 256 − 32768`), `'mapbox'` (Terrain-RGB, `(R × 65536 + G × 256 + B) × 0.1 − 10000`) or
   * `'custom'` (`redFactor`, `greenFactor`, `blueFactor`, `baseShift`). Default: 'mapbox', as in MapLibre.
   */
  encoding?: DemEncoding
  /** `custom` encoding: elevation = R × redFactor + G × greenFactor + B × blueFactor − baseShift. Default: 1. */
  redFactor?: number
  greenFactor?: number
  blueFactor?: number
  /** Default: 0. */
  baseShift?: number
  /**
   * The deepest zoom the server has. Deeper tiles reuse its rasters (no request) until a mesh cell spans a pixel.
   * Default: the TileJSON's `maxzoom`, or 15 (Terrarium's and most Terrain-RGB servers' last level is 12 to 15).
   */
  maximumZoom?: number
  /**
   * Starts the terrain worker, which decodes tiles and builds their meshes. Default: the worker shipped with the
   * library. Pass your bundler's worker if it cannot follow `new URL(…, import.meta.url)`, or `null` to build on the
   * main thread.
   */
  createWorker?: (() => Worker) | null
  /**
   * Credit for the data, as `RasterTileSource`'s. Most elevation tiles require it.
   * @example 'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen, AWS Terrain Tiles</a>'
   */
  attribution?: string | readonly string[]
}

/**
 * Terrain from elevation tiles: the `raster-dem` tiles MapLibre users have (Terrarium, Mapbox Terrain-RGB, MapTiler
 * Terrain), in Web Mercator XYZ tiling.
 *
 * Heights are taken as they are, above the WGS84 ellipsoid, while these tiles hold heights above sea level: the
 * terrain sits up to about 100 m off where quantized-mesh terrain with ellipsoidal heights puts it, which only shows
 * next to other geo-referenced 3D content. Web Mercator stops at about ±85.05°: caps built from the zoom 0 tile
 * close the globe at the poles. Not supported yet: TileJSON `bounds` and `minzoom` (tiles outside them fail to load).
 */
export class RasterDemSource extends AttributionTracker implements TerrainSource {
  readonly kind = 'terrain'
  /** The URL template, or the TileJSON URL. */
  readonly url: string
  readonly options: RasterDemSourceOptions
  readonly factors: DemUnpackFactors

  constructor(options: RasterDemSourceOptions) {
    super(options.attribution)
    const { url, tileJsonUrl } = options
    if ((url === undefined) === (tileJsonUrl === undefined)) {
      throw new Error('RasterDemSource: pass either `url` (an elevation tile URL template) or `tileJsonUrl` (a TileJSON document).')
    }
    if (url !== undefined && (!url.includes('{z}') || !url.includes('{x}') || !/{-?y}/.test(url))) {
      throw new Error(`RasterDemSource: the url needs {z}, {x} and {y} (or {-y}) placeholders, got "${url}". For a TileJSON document, pass it as \`tileJsonUrl\`.`)
    }
    this.url = (url ?? tileJsonUrl)!
    this.options = options
    this.factors = demUnpackFactors(options)
  }

  createPlugins(): object[] {
    const { url, tileJsonUrl, maximumZoom, createWorker } = this.options
    return [
      new RasterDemTerrainPlugin({
        factors: this.factors,
        ...(url !== undefined ? { url } : {}),
        ...(tileJsonUrl !== undefined ? { tileJsonUrl, onTileJson: info => this.setLoadedAttributions(info.attribution) } : {}),
        ...(maximumZoom !== undefined ? { maximumZoom } : {}),
        ...(createWorker !== undefined ? { createWorker } : {}),
      }),
    ]
  }
}

export interface RasterTileSourceOptions {
  /**
   * URL template with `{z}`, `{x}` and `{y}` (or `{-y}` for TMS rows, counted from the south). Pass this or
   * `tileJsonUrl`.
   * @example 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
   */
  url?: string
  /**
   * A TileJSON document describing the tiles, instead of `url`: its `tiles` template, `maxzoom` (as `levels`, unless
   * given), `scheme` and `attribution` are read when the layer starts.
   * @example 'https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=…'
   */
  tileJsonUrl?: string
  /** Number of zoom levels the server has. Default: 20, or the TileJSON's `maxzoom` + 1. */
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
 * Raster tiles from an XYZ URL template (OpenStreetMap, MapTiler raster, your own server), or from a TileJSON
 * document (`tileJsonUrl`).
 *
 * Tiles decode off the main thread and are composed onto terrain tiles on the GPU.
 */
export class RasterTileSource extends AttributionTracker implements ImagerySource {
  readonly kind = 'imagery'
  /** The URL template; empty when the tiles come from `tileJsonUrl`. */
  readonly url: string
  readonly tileJsonUrl: string | undefined
  readonly levels: number
  readonly tileDimensionPixels: number
  readonly projection: 'EPSG:3857' | 'EPSG:4326'
  /** Whether the app gave `levels` (else a TileJSON's `maxzoom` sets them). */
  protected readonly levelsGiven: boolean

  constructor({ url, tileJsonUrl, levels, tileDimensionPixels = 256, projection = 'EPSG:3857', attribution }: RasterTileSourceOptions) {
    super(attribution)
    if ((url === undefined) === (tileJsonUrl === undefined)) {
      throw new Error('RasterTileSource: pass either `url` (a tile URL template) or `tileJsonUrl` (a TileJSON document).')
    }
    if (url !== undefined && (!url.includes('{z}') || !url.includes('{x}') || !/{-?y}/.test(url))) {
      throw new Error(
        `RasterTileSource: the url needs {z}, {x} and {y} (or {-y}) placeholders, got "${url}". ` +
          `For a TileJSON document, pass it as \`tileJsonUrl\`; for a WMTS capabilities URL, use a WMTS source instead.`,
      )
    }
    this.url = url ?? ''
    this.tileJsonUrl = tileJsonUrl
    this.levels = levels ?? 20
    this.levelsGiven = levels !== undefined
    this.tileDimensionPixels = tileDimensionPixels
    this.projection = projection
  }

  createOverlay({ opacity }: { opacity: number }): XYZImageryOverlay {
    return new XYZImageryOverlay({
      // Replaced by the TileJSON's template before any tile loads.
      url: this.tileJsonUrl === undefined ? this.url : '{z}/{x}/{y}',
      ...(this.levelsGiven || this.tileJsonUrl === undefined ? { levels: this.levels } : {}),
      tileDimension: this.tileDimensionPixels,
      projection: this.projection,
      opacity,
      ...(this.tileJsonUrl !== undefined ? { tileJsonUrl: this.tileJsonUrl, onTileJson: info => this.setLoadedAttributions(info.attribution) } : {}),
    })
  }
}

export interface MapStyleSourceOptions {
  /**
   * A MapLibre style (version 8): its URL, or the style document. Vector sources can be XYZ `tiles`, a
   * TileJSON `url`, or a PMTiles archive (`pmtiles://https://…`); `geojson` sources hold GeoJSON or its URL.
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
   * Rewrites requests (style, TileJSON, tiles, glyphs) before they are made: another URL, extra headers. Runs on the
   * main thread; when set, the worker asks it about every request. `requestHeaders` stays the shortcut for fixed headers.
   */
  transformRequest?: TransformRequest
  /** Loaders for custom URL schemes, by scheme: `{ offline: loader }` serves `offline://…`. More with `addProtocol`. */
  protocols?: Record<string, ProtocolLoader>
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
  /**
   * Where point-placed labels go. `'screen'` (default): they face the viewer at a constant size, collide across the
   * whole screen and fade in and out, as in MapLibre; line-placed labels (road names) stay draped for now.
   * `'draped'`: every label lies on the ground, drawn into the terrain's textures.
   */
  symbols?: 'screen' | 'draped'
  /** Seconds labels facing the viewer take to fade in or out (MapLibre's `fadeDuration`). 0 switches at once. Default: 0.3. */
  symbolFadeDurationSeconds?: number
}

/**
 * A MapLibre style rendered onto the terrain: fills, lines, circles and text labels from vector tiles (XYZ,
 * TileJSON or PMTiles) and GeoJSON (tiled in the worker, points optionally clustered, `line-gradient` with
 * `lineMetrics`), and raster, hillshade and colour relief layers from raster and raster-dem tiles. App data goes
 * in with `addGeoJsonSource` (`<GeoJsonSource>` in React) and changes with `setGeoJsonSourceData` /
 * `updateGeoJsonSourceData`, redrawing only where it changed. Point labels face the viewer by
 * default (`symbols`).
 *
 * Tiles are decoded and tessellated in a worker, then drawn on the GPU straight into each terrain tile's
 * texture, at that texture's resolution, with 4× multisampling. Patterns (`fill-pattern`, `line-pattern`,
 * `background-pattern`) come from the style's sprite and from `addImage`. Heatmap layers sum their kernels
 * in a half-float target, then colour it with `heatmap-color`. Not supported yet: icons, right-to-left and
 * complex scripts, 3D extrusion (drawn flat). A raster-dem source in a style shades the drape; for terrain from
 * it, put a `RasterDemSource` in the `Terrain`.
 *
 * Attribution: the style's sources and their TileJSON or PMTiles metadata name their credit; it is read when
 * the style loads and joins `attribution`, and `attributionchange` fires on the earth.
 *
 * When tile data changes on the server, `invalidate(bounds)` redraws what it covers, with no flicker.
 *
 * The style can change at runtime, as in MapLibre: `setPaintProperty`, `setLayoutProperty`, `setFilter`,
 * `setLayerZoomRange`, `setLayerVisibility`, `addLayer`, `removeLayer`, `moveLayer`, `addSource`, `removeSource`,
 * `setStyle` (diffed), `setGlobalStateProperty`, and `setFeatureState` for paint driven by app state (hover,
 * selection). Only the tiles a change touches are processed again; feature-state colour changes only redraw.
 * Changes made before the style has loaded apply once it has. Events: `styledata`, `sourcedata`, `error`.
 *
 * `querySourceFeatures` reads the features of the tiles drawn now; `earth.queryRenderedFeatures` and
 * `earth.layerEvents` find what is under the pointer.
 */
export class MapStyleSource extends AttributionTracker implements ImagerySource {
  readonly kind = 'imagery'
  readonly options: MapStyleSourceOptions
  /** The style model every `Imagery` layer using this source draws. */
  protected readonly mapStyle: MapStyle
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
    const { url, style, baseUrl, requestHeaders, transformRequest, protocols } = options
    this.mapStyle = new MapStyle({
      style: (url ?? style)!,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(requestHeaders !== undefined ? { requestHeaders } : {}),
      ...(transformRequest !== undefined ? { transformRequest } : {}),
      ...(protocols !== undefined ? { protocols } : {}),
    })
  }

  createOverlay({ opacity }: { opacity: number }): MapStyleOverlay {
    const { url: _url, style: _style, attribution: _attribution, transformRequest: _transformRequest, protocols: _protocols, onStyleImageMissing: _onStyleImageMissing, ...rest } = this.options
    const overlay = new MapStyleOverlay({
      ...rest,
      style: this.mapStyle,
      opacity,
      images: this.images,
      onSummaryChange: summary => this.setLoadedAttributions(summary.attributions),
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

  /**
   * Every feature of one of the style's sources in the tiles drawn now, whether a layer draws it or not:
   * MapLibre's `querySourceFeatures`. A feature crossing tiles is listed once per tile, clipped to each. Resolves to
   * no features before the style has loaded. For what is drawn under the pointer, use `earth.queryRenderedFeatures`.
   * @example const lakes = await source.querySourceFeatures('base', { sourceLayer: 'water', filter: ['>', ['get', 'area'], 1e6] })
   */
  async querySourceFeatures(sourceId: string, options?: SourceFeatureQueryOptions): Promise<SourceFeature[]> {
    this.pruneDisposedOverlays()
    const overlay = [...this.overlays].find(candidate => candidate.summary !== null) ?? [...this.overlays][0]
    return overlay === undefined ? [] : overlay.querySourceFeatures(sourceId, options)
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

  // Runtime style API (MapLibre's names). Each checks its arguments against the loaded style and throws an error
  // that states the fix; changes made before the style has loaded are checked when it loads (`error` event).

  /** A copy of the style as it is now, with every change applied; null before it has loaded. */
  getStyle(): StyleDocument | null {
    return this.mapStyle.getStyle()
  }

  /** A copy of a layer, or undefined. */
  getLayer(layerId: string): StyleDocumentLayer | undefined {
    return this.mapStyle.getLayer(layerId)
  }

  /** Layer ids, bottom first. */
  getLayerIds(): string[] {
    return this.mapStyle.getLayerIds()
  }

  getSource(sourceId: string): object | undefined {
    return this.mapStyle.getSource(sourceId)
  }

  getPaintProperty(layerId: string, name: string): unknown {
    return this.mapStyle.getPaintProperty(layerId, name)
  }

  getLayoutProperty(layerId: string, name: string): unknown {
    return this.mapStyle.getLayoutProperty(layerId, name)
  }

  getFilter(layerId: string): unknown {
    return this.mapStyle.getFilter(layerId)
  }

  /** @example source.setPaintProperty('water', 'fill-color', '#2a6fdb') */
  setPaintProperty(layerId: string, name: string, value: unknown): void {
    this.mapStyle.setPaintProperty(layerId, name, value)
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    this.mapStyle.setLayoutProperty(layerId, name, value)
  }

  /** `null` removes the filter. @example source.setFilter('roads', ['==', ['get', 'class'], 'motorway']) */
  setFilter(layerId: string, filter: unknown): void {
    this.mapStyle.setFilter(layerId, filter)
  }

  /** Minimum inclusive, maximum exclusive, as in MapLibre; `undefined` removes a bound. */
  setLayerZoomRange(layerId: string, minimumZoom: number | undefined, maximumZoom: number | undefined): void {
    this.mapStyle.setLayerZoomRange(layerId, minimumZoom, maximumZoom)
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    this.mapStyle.setLayerVisibility(layerId, visible)
  }

  /**
   * Adds a layer below `beforeId` (on top without it): a MapLibre layer object, or a `StyleLayer` (which then
   * forwards its updates).
   */
  addLayer(layer: object | StyleLayer, beforeId?: string): void {
    if (isStyleLayer(layer)) layer.addTo(this, beforeId)
    else this.mapStyle.addLayer(layer, beforeId)
  }

  removeLayer(layerId: string): void {
    this.mapStyle.removeLayer(layerId)
  }

  /** Moves a layer below `beforeId`, or on top. */
  moveLayer(layerId: string, beforeId?: string): void {
    this.mapStyle.moveLayer(layerId, beforeId)
  }

  /**
   * Adds a source: a MapLibre source object (`vector` and `geojson` sources draw, with `promoteId` for feature-state
   * ids). A `geojson` source's `data` object is kept, not copied.
   */
  addSource(sourceId: string, source: object): void {
    this.mapStyle.addSource(sourceId, source)
  }

  /**
   * Adds a `GeoJsonSource` (app data that forwards its `setData` and `updateData`), replacing a source of the same id;
   * it survives `setStyle`.
   * @example source.addGeoJsonSource(new GeoJsonSource({ id: 'route', data: route, lineMetrics: true }))
   */
  addGeoJsonSource(source: GeoJsonSource): void {
    source.addTo(this)
  }

  /**
   * Replaces a `geojson` source's data (GeoJSON, or a URL). Keep the object unchanged afterwards. Only the regions where
   * the old or the new data lie are redrawn.
   */
  setGeoJsonSourceData(sourceId: string, data: GeoJSON | string): void {
    this.mapStyle.setGeoJsonSourceData(sourceId, data)
  }

  /**
   * Changes a `geojson` source's features by id (MapLibre's `updateData`); every feature needs an id. Only the regions
   * around the changed features are redrawn.
   * @example source.updateGeoJsonSourceData('buses', { update: [{ id: 12, newGeometry: { type: 'Point', coordinates: [2.35, 48.86] } }] })
   */
  updateGeoJsonSourceData(sourceId: string, diff: GeoJsonSourceDiff): void {
    this.mapStyle.updateGeoJsonSourceData(sourceId, diff)
  }

  /** The zoom at which a cluster of a clustered `geojson` source splits (`cluster_id` from a drawn cluster). */
  async getClusterExpansionZoom(sourceId: string, clusterId: number): Promise<number> {
    return (await this.mapStyle.querySource(sourceId, { kind: 'clusterExpansionZoom', clusterId })) as number
  }

  /** A cluster's children one zoom deeper (clusters and points), as GeoJSON features. */
  async getClusterChildren(sourceId: string, clusterId: number): Promise<Array<Feature<Point>>> {
    return (await this.mapStyle.querySource(sourceId, { kind: 'clusterChildren', clusterId })) as Array<Feature<Point>>
  }

  /** A cluster's points, `limit` of them (default 10; `Infinity` for all) from `offset`, as GeoJSON features. */
  async getClusterLeaves(sourceId: string, clusterId: number, limit = 10, offset = 0): Promise<Array<Feature<Point>>> {
    return (await this.mapStyle.querySource(sourceId, { kind: 'clusterLeaves', clusterId, limit, offset })) as Array<Feature<Point>>
  }

  /** Removes a source; remove the layers reading it first. */
  removeSource(sourceId: string): void {
    this.mapStyle.removeSource(sourceId)
  }

  /**
   * Replaces the style: a URL or a document. With `diff` (the default) only what differs is applied, as in MapLibre;
   * layers added with `StyleLayer` are kept. Resolves once the change is handed to the renderer.
   */
  setStyle(style: string | object, options?: { diff?: boolean }): Promise<void> {
    return this.mapStyle.setStyle(style, options)
  }

  /** Sets a value read by `['global-state', name]`; `undefined` returns it to the style root `state` default. */
  setGlobalStateProperty(name: string, value: unknown): void {
    this.mapStyle.setGlobalStateProperty(name, value)
  }

  getGlobalState(): Record<string, unknown> {
    return this.mapStyle.getGlobalState()
  }

  /**
   * Merges `state` into a feature's state; paint properties read it with `['feature-state', name]`. Colour and opacity
   * changes of fills, lines and circles only redraw (fast enough for hover); other paint processes the feature's tiles.
   * @example source.setFeatureState({ source: 'base', sourceLayer: 'buildings', id: 42 }, { hover: true })
   */
  setFeatureState(feature: FeatureIdentifier, state: FeatureState): void {
    this.mapStyle.setFeatureState(feature, state)
  }

  /** Removes one key, a feature's whole state (no `key`), or every state of the source (no `id`). */
  removeFeatureState(feature: Omit<FeatureIdentifier, 'id'> & { id?: string | number }, key?: string): void {
    this.mapStyle.removeFeatureState(feature, key)
  }

  getFeatureState(feature: FeatureIdentifier): FeatureState {
    return this.mapStyle.getFeatureState(feature)
  }

  /** Serves `scheme://…` URLs of this style with `loader` (offline packs, custom stores). */
  addProtocol(scheme: string, loader: ProtocolLoader): void {
    this.mapStyle.addProtocol(scheme, loader)
  }

  removeProtocol(scheme: string): void {
    this.mapStyle.removeProtocol(scheme)
  }

  addEventListener<T extends keyof MapStyleEventMap>(type: T, listener: (event: MapStyleEventMap[T] & { type: T }) => void): void {
    this.mapStyle.addEventListener(type, listener as never)
  }

  removeEventListener<T extends keyof MapStyleEventMap>(type: T, listener: (event: MapStyleEventMap[T] & { type: T }) => void): void {
    this.mapStyle.removeEventListener(type, listener as never)
  }

  /** The style model, for `StyleLayer` and `GeoJsonSource`. */
  getMapStyle(): MapStyle {
    return this.mapStyle
  }
}

function isStyleLayer(layer: object): layer is StyleLayer {
  return typeof (layer as Partial<StyleLayer>).addTo === 'function' && typeof (layer as Partial<StyleLayer>).toSpecification === 'function'
}

/** Image changes cut short by `dispose` are expected; anything else is worth a warning. */
function warnUnlessAborted(error: unknown): void {
  if ((error as Error | undefined)?.name === 'AbortError') return
  console.warn(`MapStyleSource: an image change failed; call updateImage again to retry. ${(error as Error).message}`)
}
