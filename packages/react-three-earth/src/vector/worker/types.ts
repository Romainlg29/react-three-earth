/**
 * Data shared by the main thread and the vector tile worker. Everything here is structured-cloneable, and
 * the typed arrays are transferred, not copied.
 */

import type { GeoJSON } from 'geojson'

import type { WorkerLayerTypeDescriptor } from '../../plugins/styleLayerTypes.js'
import type { GeoJsonSourceDiff } from './geoJsonData.js'
import type { MercatorRectangle } from './rectangles.js'
import { extrusionMeshBuffers } from './extrusions.js'
import { symbolMeshBuffers } from './symbols.js'

/** Vector tile coordinates are rescaled to this extent, whatever the source layer's own extent. */
export const TILE_EXTENT = 4096

/**
 * Map pixels per tile at the tile's own zoom. Style sizes (line widths, text sizes) are in pixels of a
 * 512-pixel tile, as in MapLibre.
 */
export const TILE_SIZE_PIXELS = 512

/** Options the worker needs to load a style. All URLs are absolute. */
export interface MapStyleProcessorOptions {
  /** The style document, already fetched (the main thread resolves a URL into this). */
  style: unknown
  /** Base URL that relative URLs inside the style resolve against: the style URL, or the page. */
  baseUrl: string
  /** Headers sent with every tile, TileJSON and glyph request. */
  requestHeaders: Record<string, string>
  /**
   * CSS font family drawn locally (on an OffscreenCanvas) for glyphs the style's `glyphs` server does not
   * have, or for every glyph when the style has no `glyphs` URL.
   */
  localFontFamily: string
  /** Sprite sheet resolution to load: 2 loads the `@2x` sheet, 1 the plain one. Default: 1. */
  spritePixelRatio?: number
  /** Runtime images (`addImage`) to start with, by id. Default: none. */
  images?: Array<[string, StyleImage]>
  /** Feature-state set before the processor started, by feature key (`featureKey`). */
  featureStates?: Array<[string, FeatureState]>
  /** How many feature-state messages the main thread has sent so far: the processor counts on from there. */
  featureStateVersion?: number
  /** Values set with `setGlobalStateProperty`, over the style root `state` defaults. */
  globalState?: Record<string, unknown>
  /**
   * The main thread has a `transformRequest`: every request is sent to it first (`resolveResource`). URLs with a
   * scheme other than http(s), data and blob always are, for protocols added with `addProtocol`.
   */
  transformsRequests?: boolean
  /** Custom style layer types from plugins (`earth.styleLayerTypes`). Default: none. */
  layerTypes?: WorkerLayerTypeDescriptor[]
  /**
   * Point-placed labels face the viewer: they are laid out by `symbols` requests and left out of draped tiles.
   * Default: false (every label is draped).
   */
  screenSymbols?: boolean
  /**
   * `fill-extrusion` layers stand in 3D: they are built by `extrusions` requests and left out of draped tiles.
   * Default: false (drawn flat on the ground).
   */
  extrusions?: boolean
}

/** Feature-state of one feature: any JSON values, read by `['feature-state', name]` in paint properties. */
export type FeatureState = Record<string, unknown>

/** What a request is for, as in MapLibre's `ResourceType`; passed to `transformRequest` and protocol loaders. */
export type ResourceKind = 'Style' | 'Source' | 'Tile' | 'Glyphs' | 'SpriteJSON' | 'SpriteImage' | 'Image' | 'Unknown'

/** A request the worker asks the main thread to resolve (transformRequest, custom protocols). */
export interface ResourceRequest {
  url: string
  kind: ResourceKind
  headers: Record<string, string>
}

/**
 * The main thread's answer: either where to fetch (the worker fetches it, so the bytes never cross the main
 * thread), or the bytes themselves, from a protocol loader (null: not found).
 */
export type ResourceAnswer = { url: string; headers: Record<string, string> } | { data: Uint8Array | null }

/**
 * One change to the style. The shapes follow the style specification's `diff` (and MapLibre's `Map` methods), so
 * `setStyle` sends `diff(before, after)` as it comes; `moveLayer` and `setGlobalStateProperty` are runtime-only.
 */
export type StyleCommand =
  | { command: 'setPaintProperty'; args: [layerId: string, name: string, value: unknown] }
  | { command: 'setLayoutProperty'; args: [layerId: string, name: string, value: unknown] }
  | { command: 'setFilter'; args: [layerId: string, filter: unknown] }
  | { command: 'setLayerZoomRange'; args: [layerId: string, minimumZoom: number | undefined, maximumZoom: number | undefined] }
  | { command: 'addLayer'; args: [layer: object, beforeId: string | undefined] }
  | { command: 'removeLayer'; args: [layerId: string] }
  | { command: 'moveLayer'; args: [layerId: string, beforeId: string | undefined] }
  | { command: 'addSource'; args: [sourceId: string, source: object] }
  | { command: 'removeSource'; args: [sourceId: string] }
  /** Replaces a `geojson` source's data: GeoJSON, or a URL. The style specification's `diff` emits it. */
  | { command: 'setGeoJSONSourceData'; args: [sourceId: string, data: GeoJSON | string] }
  /** Changes a `geojson` source's features by id (MapLibre's `updateData`); runtime-only. */
  | { command: 'updateGeoJSONSourceData'; args: [sourceId: string, diff: GeoJsonSourceDiff] }
  /** Adds a source, or replaces the one of that id while layers keep reading it (`GeoJsonSource`); runtime-only. */
  | { command: 'setSource'; args: [sourceId: string, source: object] }
  /** Replaces the style root `state` (the defaults of `global-state`). */
  | { command: 'setGlobalState'; args: [state: Record<string, { default?: unknown }>] }
  /** Sets one `global-state` value at runtime; `undefined` returns it to the style's default. */
  | { command: 'setGlobalStateProperty'; args: [name: string, value: unknown] }

/** What the worker answers after applying style commands. */
export interface StyleUpdateResult {
  summary: MapStyleSummary
  /** Sources whose tiles must be processed again (from the worker's raw tiles: nothing is fetched). */
  rebuiltSources: string[]
  /** Commands the worker could not apply (an expression that does not compile, a source that does not load). */
  errors: string[]
  /**
   * Areas of sources whose tiles must be processed again (GeoJSON data changes): tiles overlapping `rectangles`
   * widened by `marginTiles` tiles at their own zoom. Null rectangles: every tile of the source.
   */
  rebuiltAreas?: SourceArea[]
}

/** An area of one source's tiles. */
export interface SourceArea {
  sourceId: string
  rectangles: MercatorRectangle[] | null
  /** How far a tile's data reaches past its edges, in tiles of its own zoom. */
  marginTiles: number
}

/** A question about a `geojson` source's clusters, answered by the worker. */
export type GeoJsonSourceQuery =
  /** Answers the zoom at which the cluster splits into several features. */
  | { kind: 'clusterExpansionZoom'; clusterId: number }
  /** Answers the cluster's children one zoom deeper (clusters and points), as GeoJSON features. */
  | { kind: 'clusterChildren'; clusterId: number }
  /** Answers the points of the cluster, `limit` of them from `offset`, as GeoJSON features. */
  | { kind: 'clusterLeaves'; clusterId: number; limit: number; offset: number }

/** A feature-state change, as the worker receives it: the feature's whole new state, null once removed. */
export interface FeatureStateChange {
  key: string
  state: FeatureState | null
}

/**
 * Colours of feature-state dependent paint (fills, lines, circles), by slot. Vertices of such features carry a
 * slot instead of a colour, so a state change redraws them without tessellating anything. Straight-alpha sRGB.
 */
export interface FeatureColorUpdate {
  /** Table size in slots: `width` per row, `height` rows. */
  width: number
  height: number
  slots: Uint32Array
  /** RGBA per entry of `slots`. */
  colors: Uint8Array
  /** Sprite sheet resolution to load: 2 loads the `@2x` sheet, 1 the plain one. Default: 1. */
  spritePixelRatio?: number
  /** Images added with `addImage` before the style loaded, by id. Default: none. */
  images?: Array<[string, StyleImage]>
}

/**
 * A style image (from the sprite or `addImage`): RGBA pixels, straight alpha, sRGB, rows from the top.
 * `pixelRatio` image pixels make one map pixel. The other fields are MapLibre's image metadata, kept for
 * icons (stretchable `icon-text-fit` and SDF icons).
 */
export interface StyleImage {
  width: number
  height: number
  data: Uint8Array
  pixelRatio: number
  sdf: boolean
  /** Stretchable horizontal ranges, in image pixels. */
  stretchX?: Array<[number, number]>
  stretchY?: Array<[number, number]>
  /** Where text goes inside the image, in image pixels: left, top, right, bottom. */
  content?: [number, number, number, number]
}

/** A pattern image's place in the image atlas, in atlas pixels. */
export interface PatternRectangle {
  x: number
  y: number
  width: number
  height: number
  pixelRatio: number
}

/** A background layer drawn with `background-pattern` at one zoom. */
export interface BackgroundPattern {
  imageId: string
  rectangle: PatternRectangle
  /** `background-opacity`, 0 to 1. */
  opacity: number
}

/** A source of the style a drawn layer reads, as the main thread sees it. */
export interface MapStyleSourceSummary {
  id: string
  /** The source's tiles: vector tiles, raster images, or elevation (`raster-dem`). Default: 'vector'. */
  type?: 'vector' | 'raster' | 'raster-dem'
  /** Zoom range of the source's tiles, in its own tile zooms. */
  minimumZoom: number
  maximumZoom: number
  /** Map pixels a raster tile covers at its own zoom (`tileSize`); vector tiles are 512. Default: 512. */
  tileSizePixels?: number
  /** Where the source has tiles, in degrees: west, south, east, north. Tiles outside are never requested. Default: the world. */
  bounds?: [number, number, number, number] | null
  /** Raster sources: changes when the source's tiles may have (another URL, encoding…), so cached tiles are fetched again. */
  contentKey?: string
}

/** What the worker reports once the style is loaded. */
export interface MapStyleSummary {
  sources: MapStyleSourceSummary[]
  /** Background colour per integer zoom 0 to 24, as straight-alpha sRGB bytes (RGBA); null for none. */
  backgroundByZoom: Array<[number, number, number, number] | null>
  /** Style layers the renderer skipped (unsupported types), for a one-time warning. */
  skippedLayers: string[]
  /** The `attribution` of the style's drawn sources, from the style, TileJSON or PMTiles metadata, in the style's source order. */
  attributions: string[]
  /**
   * `background-pattern` per integer zoom 0 to 24, drawn over `backgroundByZoom`. Coordinates are in the
   * image atlas.
   */
  backgroundPatternByZoom: Array<BackgroundPattern | null>
  /** `background-pattern` images that neither the sprite nor `addImage` provide (`styleimagemissing`). */
  missingBackgroundImages: string[]
  /** Image ids the style's sprites provide (`sprite-id:name` for sprites other than `default`). */
  spriteImageIds: string[]
  /** Custom layer types (plugins) that drawn layers use. */
  customLayerTypes: string[]
  /** Layers whose type is neither MapLibre's nor provided by an installed plugin, as [layer id, type]. */
  missingLayerTypes: Array<[string, string]>
  /** Raster, hillshade and colour relief layers in style order, with their paint per zoom. Default: none. */
  rasterLayers?: RasterLayerSummary[]
  /** `fill-extrusion` layers in style order: the main thread asks for building tiles of their sources. Default: none. */
  extrusionLayers?: Array<{ id: string; source: string; minimumZoom: number; maximumZoom: number }>
  /** Heatmap layers in style order, with what colours them. Default: none. */
  heatmapLayers?: HeatmapLayerSummary[]
}

/** A heatmap layer, evaluated in the worker: the main thread colours its density with these. */
export interface HeatmapLayerSummary {
  id: string
  /** `heatmap-color` at 256 densities from 0 to 1, as premultiplied sRGB bytes (RGBA). */
  colorRamp: Uint8Array
  /** `heatmap-opacity` per integer zoom 0 to 24. */
  opacityByZoom: number[]
  /** `heatmap-intensity` per integer zoom 0 to 24. */
  intensityByZoom: number[]
  /** How far its kernels reach past their points, in pixels, per integer zoom 0 to 24. */
  reachPixelsByZoom: number[]
}

/** The types of style layers drawn from raster tiles: images (`raster`) and elevation (`hillshade`, `color-relief`). */
export type RasterLayerType = 'raster' | 'hillshade' | 'color-relief'

/** A raster, hillshade or colour relief layer, evaluated in the worker for the main thread to draw. */
export interface RasterLayerSummary {
  id: string
  type: RasterLayerType
  source: string
  /** Its draw group: raster layers have one of their own, so they draw at their place among the vector layers. */
  group: number
  /** Paint per integer zoom 0 to 24, in the shape the type's renderer reads; null where the layer does not draw. */
  paintByZoom: Array<Record<string, unknown> | null>
}

/**
 * A raster tile, decoded in the worker. `image`: the tile as an `ImageBitmap` (decoded with `imageOrientation:
 * 'flipY'`, straight alpha, no colour conversion, as 3DTilesRenderer's raster tiles). `dem`: elevations in
 * meters, `width` × `height`, rows from the north; decoded from the tile's encoding in the worker.
 */
export type RasterTileData =
  | { kind: 'image'; width: number; height: number; image: ImageBitmap }
  | { kind: 'dem'; width: number; height: number; elevations: Float32Array }

/** One vector tile to process. */
export interface TileRequest {
  sourceId: string
  /** Tile coordinates at the data level (XYZ, y down from the north). */
  x: number
  y: number
  z: number
  /** Zoom the style is evaluated at: at least `z`, more when the tile is overzoomed. */
  zoom: number
  /**
   * Lays out only the labels that face the viewer (`SymbolMesh`), for the camera's symbol tiles, instead of the
   * draped meshes. Default: false.
   */
  symbols?: boolean
  /**
   * Builds only the buildings of `fill-extrusion` layers (`ExtrusionMesh`), for the camera's extrusion tiles, instead
   * of the draped meshes. Default: false.
   */
  extrusions?: boolean
}

/** A point in normalised Web Mercator space: x from 0 (180° W) to 1 (180° E), y from 0 (south edge) to 1 (north edge). */
export interface MercatorPoint {
  x: number
  y: number
}

/** A tile a feature query looks into: the tile a region drew there, at the zoom it drew it at. */
export interface QueryTile extends TileRequest {
  /** Unwrapped column the query geometry is measured from (outside 0 to 2^z - 1 next to the antimeridian). */
  column: number
  /** True for the ring around the tiles under the query: only their labels can reach it. */
  labelsOnly: boolean
}

/** `queryRenderedFeatures` as the worker answers it. */
export interface RenderedFeatureQuery {
  /**
   * One point, or a polygon (its ring, not closed), in normalised Web Mercator, unwrapped: x may leave 0 to 1
   * when the polygon crosses the antimeridian.
   */
  geometry: MercatorPoint[]
  tiles: QueryTile[]
  /** Only these style layers; null: every layer. */
  layers: string[] | null
  /** A MapLibre filter expression features must also pass; null: none. */
  filter: unknown
  /** Extra distance, in map pixels at each tile's zoom, within which a feature counts as hit. */
  tolerancePixels: number
  /** Labels facing the viewer that the main thread found under the query on the screen. Absent: none. */
  screenLabels?: ScreenLabelHit[]
}

/** A label facing the viewer hit on the screen: the symbol tile it came from and the feature it labels. */
export interface ScreenLabelHit {
  sourceId: string
  x: number
  y: number
  z: number
  /** The zoom the label was laid out at (past the data's maximum zoom, deeper than `z`). */
  zoom: number
  layerId: string
  sourceLayer: string
  featureIndex: number
}

/** `querySourceFeatures` as the worker answers it. */
export interface SourceFeatureQuery {
  sourceId: string
  /** Required for vector sources in MapLibre; here every source layer is read without it. */
  sourceLayer: string | null
  filter: unknown
  tiles: Array<{ x: number; y: number; z: number }>
}

/** A GeoJSON geometry, in longitude and latitude degrees. */
export type FeatureGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

/** A feature of a source, as GeoJSON with where it comes from: MapLibre's `MapGeoJSONFeature`. */
export interface SourceFeature {
  type: 'Feature'
  /** The tile's feature id, or the promoted property (`promoteId`); undefined when it has none. */
  id: string | number | undefined
  /** Clipped to the tile it was read from (with the tile's buffer), as in MapLibre. */
  geometry: FeatureGeometry
  properties: Record<string, unknown>
  /** The style's source id. */
  source: string
  sourceLayer: string
  /** The feature's state (`setFeatureState`); empty without one. */
  state: FeatureState
}

/** A feature hit by `queryRenderedFeatures`, with the style layer that drew it. */
export interface RenderedSourceFeature extends SourceFeature {
  /** The style layer, as written in the style (MapLibre gives the evaluated layer; here it is the layer specification). */
  layer: { id: string; type: string; source?: string; 'source-layer'?: string; [property: string]: unknown }
}

/** A range of indices of a bucket's shape mesh drawn for one group of consecutive style layers. */
export interface DrawGroup {
  /** Index of the layer group in the style (consecutive layers sharing a source). */
  group: number
  start: number
  count: number
}

/**
 * Fill, line and circle triangles of one tile, in style order. Positions are in tile units (0 to
 * `TILE_EXTENT`, y down); colours are straight-alpha sRGB bytes.
 */
export interface ShapeMesh {
  positions: Float32Array
  colors: Uint8Array
  /** Feature colour slot per vertex (0: use `colors`), when any feature has feature-state dependent colours. */
  colorSlots: Float32Array | null
  indices: Uint32Array
  groups: DrawGroup[]
  /**
   * Fill and line patterns, or null when the tile has none: per vertex, the pattern image's place in the image
   * atlas (x, y, width, height in atlas pixels; width 0 for a vertex coloured by `colors`), and where the
   * vertex falls in the repeated image, in image pixels. The vertex colour's alpha is the pattern's opacity.
   */
  patterns: Uint16Array | null
  patternCoordinates: Float32Array | null
  /**
   * Blurred lines and circles (`line-blur`, `circle-blur`), or null when the tile has none: per vertex, where it sits
   * across its shape (-1 to 1 across a line band, 0 to 1 from a circle's centre) and the blur as a share of the
   * shape's half width (0: sharp).
   */
  edges: Float32Array | null
}

/**
 * Text quads of one tile. `uvs` are in glyph atlas pixels; `haloEdges` is the SDF threshold of the halo
 * (0.75 is the glyph edge, lower is a wider halo).
 */
export interface TextMesh {
  positions: Float32Array
  uvs: Float32Array
  colors: Uint8Array
  haloColors: Uint8Array
  haloEdges: Float32Array
  indices: Uint32Array
}

/**
 * Labels of one tile that face the viewer. Per label: anchor in tile units, `text-size` at the tile's zoom and the
 * next, collision box (left, top, right, bottom) in pixels of a 24 px font around the anchor, padding in pixels,
 * flags (`SYMBOL_ALLOW_OVERLAP`, `SYMBOL_IGNORE_PLACEMENT`), style layer index, sort key and identity key. Per
 * vertex (4 per glyph): corner in pixels of a 24 px font around the anchor (y down), glyph atlas pixels, the
 * label it belongs to, colours (straight-alpha sRGB, `text-opacity` included) and halo width in pixels.
 */
export interface SymbolMesh {
  anchors: Float32Array
  sizes: Float32Array
  boxes: Float32Array
  paddings: Float32Array
  flags: Uint8Array
  layerIndices: Uint16Array
  sortKeys: Float32Array
  keys: string[]
  /** Per label, the feature it labels (`queryRenderedFeatures`). */
  sourceLayers: string[]
  featureIndices: Uint32Array
  /**
   * Line labels (`SYMBOL_LINE`): per label, the stretch of line they follow (`lineLengths` points from `lineStarts`
   * in `linePoints`, tile units, the anchor at `lineAnchors`), the sharpest turn between glyphs in radians, and
   * their glyphs (`glyphCounts` from `glyphStarts`): distance from the label's middle along the line and half
   * width, in pixels of a 24 px font. Zero for point labels.
   */
  lineStarts: Uint32Array
  lineLengths: Uint16Array
  lineAnchors: Uint16Array
  maximumAngles: Float32Array
  linePoints: Float32Array
  glyphStarts: Uint32Array
  glyphCounts: Uint16Array
  glyphOffsets: Float32Array
  glyphHalfWidths: Float32Array
  /**
   * `text-variable-anchor`, per label: its anchors (`anchorShiftCounts` from `anchorShiftStarts`, zero without
   * variable anchors), each an (x, y) shift of the label from its box centred on the anchor point, in pixels of a
   * 24 px font. Placement takes the first that fits.
   */
  anchorShiftStarts: Uint32Array
  anchorShiftCounts: Uint8Array
  anchorShifts: Float32Array
  /**
   * Per label with an icon (`SYMBOL_ICON`): the icon's box around the anchor (left, top, right, bottom, in image
   * pixels at icon-size 1); zeros otherwise. An icon alone has its box in `boxes` too.
   */
  iconBoxes: Float32Array
  /** Per label with an icon: 24 × `icon-size` at the tile's zoom and one deeper (the icon's own `sizes`); zeros otherwise. */
  iconSizes: Float32Array
  corners: Float32Array
  /** Per vertex, in pixels of the glyph atlas, or of the style's image atlas for an icon. */
  uvs: Float32Array
  labelIndices: Float32Array
  /**
   * Per vertex, the line label glyph it belongs to (index into `glyphOffsets`), -1 in a point label's text, -2 in
   * an icon and -3 in an SDF icon (`ICON_GLYPH_INDEX`, `SDF_ICON_GLYPH_INDEX`).
   */
  glyphIndices: Float32Array
  colors: Uint8Array
  haloColors: Uint8Array
  haloWidths: Float32Array
  indices: Uint16Array | Uint32Array
}

/** A glyph newly packed into the worker's atlas, for the main thread's copy. */
export interface AtlasGlyphUpdate {
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array
}

/** Changes to the glyph atlas since the last message. Applied before the bucket that needs them. */
export interface AtlasUpdate {
  width: number
  height: number
  glyphs: AtlasGlyphUpdate[]
}

/** An image newly packed (or rewritten) in the worker's image atlas: RGBA, premultiplied, padding included. */
export interface ImageAtlasEntryUpdate {
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array
}

/** Changes to the image atlas since the last message. Applied before the result that carries them resolves. */
export interface ImageAtlasUpdate {
  width: number
  height: number
  images: ImageAtlasEntryUpdate[]
}

/** A vertex attribute of a custom layer mesh, named for the shader (`position`, `paint0`, plugin names). */
export interface CustomLayerAttribute {
  name: string
  array: Float32Array | Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
  itemSize: 1 | 2 | 3 | 4
  normalized: boolean
}

/** One custom style layer's mesh in a tile (plugins). Positions are 2 floats per vertex in tile units. */
export interface CustomLayerMesh {
  layerId: string
  layerType: string
  /** Its draw group: custom layers have one of their own, so they draw at their place in the style. */
  group: number
  attributes: CustomLayerAttribute[]
  indices: Uint32Array | Uint16Array
}

/**
 * The buildings of one tile (`fill-extrusion` layers): walls and flat roofs, at elevation 0. The main thread lifts
 * each building onto the terrain and moves its heights between zooms.
 */
export interface ExtrusionMesh {
  /** The tile's centre on the ellipsoid: `positions` are metres in its east-north-up frame. */
  originLongitudeRadians: number
  originLatitudeRadians: number
  /** The same centre in Web Mercator metres: `flatPositions` are relative to it. */
  originMercatorXMeters: number
  originMercatorYMeters: number
  /** Three floats per vertex: east, north, up, in metres from the origin, heights evaluated at the tile's zoom. */
  positions: Float32Array
  /** Three floats per vertex: Web Mercator x and y from the origin, and the height times the local scale factor. */
  flatPositions: Float32Array
  /** Three signed bytes per vertex (127 = 1): east, north, up. Walls are horizontal, roofs face up. */
  normals: Int8Array
  /** Four bytes per vertex: `fill-extrusion-color` in sRGB, the vertical gradient applied, straight alpha. */
  colors: Uint8Array
  /** Per vertex: its height one zoom deeper minus its height at the tile's zoom, in metres along the up direction. */
  heightDeltas: Float32Array
  indices: Uint16Array | Uint32Array
  /** First vertex of each building, plus the vertex count at the end. */
  buildingVertexStarts: Uint32Array
  /** Four floats per building: its footprint's bounds in tile units (minimum x, minimum y, maximum x, maximum y). */
  buildingBounds: Float32Array
  /** Index ranges per style layer, in style order. */
  layers: Array<{ layerId: string; layerIndex: number; start: number; count: number; opacity: number; nextZoomOpacity: number }>
}

/** The processed tile. Null meshes when the tile has nothing of that kind. */
export interface TileBucket {
  shapes: ShapeMesh | null
  text: TextMesh | null
  /** Labels that face the viewer, for `symbols` requests only. */
  symbols?: SymbolMesh | null
  /** Buildings standing in 3D, for `extrusions` requests only. */
  extrusions?: ExtrusionMesh | null
  /** Custom style layers (plugins), in style order. */
  layers: CustomLayerMesh[]
  /** The tile of a raster or raster-dem source; null for vector tiles and missing raster tiles. Default: null. */
  raster?: RasterTileData | null
  atlas: AtlasUpdate | null
  /** Features drawn with colour slots: a state change redraws the regions using this bucket. */
  featureStateKeys: string[]
  /** Features whose state changes the geometry or text (widths, text colours): a change processes the tile again. */
  rebuildFeatureKeys: string[]
  /** How many feature-state messages the worker had applied when it started the tile. */
  featureStateVersion: number
  /** Image ids the tile's patterns asked for, found or not: an image change redraws the regions using it. */
  images: string[]
  /** Image ids the tile asked for that neither the sprite nor `addImage` provide (`styleimagemissing`). */
  missingImages: string[]
  /** Bytes held by the typed arrays, for cache budgets. */
  byteLength: number
}

export type WorkerRequest =
  | { type: 'init'; id: number; options: MapStyleProcessorOptions }
  | { type: 'tile'; id: number; request: TileRequest }
  | { type: 'cancel'; id: number }
  /** Forgets cached raw tiles overlapping the rectangles (`null`: all), so the next request fetches them again. */
  | { type: 'invalidate'; rectangles: MercatorRectangle[] | null }
  /** Applies style commands; answers a `StyleUpdateResult`. Tiles requested after it see the new style. */
  | { type: 'style'; id: number; commands: StyleCommand[] }
  /** Replaces the style (no diff possible); answers the new `MapStyleSummary`. Glyphs and colour slots are kept. */
  | { type: 'reload'; id: number; options: MapStyleProcessorOptions }
  /** Applies feature-state changes; answers null, with the new slot colours in `featureColors`. */
  | { type: 'featureState'; id: number; changes: FeatureStateChange[] }
  /** The main thread's answer to a `resource` request of the worker. */
  | { type: 'resource'; id: number; answer: ResourceAnswer | null; error?: string }
  /** Adds or replaces (`image`) or removes (`null`) a runtime image. Answers with an `ImageChange`. */
  | { type: 'image'; id: number; imageId: string; image: StyleImage | null }
  /**
   * Replaces the custom layer types and recompiles the layers, keeping the raw tiles; answers a
   * `StyleUpdateResult` whose `rebuiltSources` hold the layers of types that came or went.
   */
  | { type: 'layerTypes'; id: number; layerTypes: WorkerLayerTypeDescriptor[] }
  /** Asks a source a question (clusters of a `geojson` source); answers what the query says. */
  | { type: 'sourceQuery'; id: number; sourceId: string; query: GeoJsonSourceQuery }
  /** Hit-tests features under a point or polygon; answers `RenderedSourceFeature[]`, top-most first. */
  | { type: 'queryRendered'; id: number; query: RenderedFeatureQuery }
  /** Reads the features of a source's tiles; answers `SourceFeature[]`. */
  | { type: 'querySource'; id: number; query: SourceFeatureQuery }

/** What an image change did, so the main thread knows what to redraw. */
export interface ImageChange {
  /**
   * Whether meshes that use the image must be rebuilt: it appeared, disappeared or moved in the atlas. False
   * when it was rewritten in place (same size), so redrawing is enough.
   */
  rebuild: boolean
  /** The style's background patterns after the change. */
  backgroundPatternByZoom: Array<BackgroundPattern | null>
  /** Background pattern images missing after the change. */
  missingBackgroundImages: string[]
}

/**
 * `imageAtlas` (image atlas changes) and `featureColors` (slot colours) ride along with any result and are applied
 * before it resolves, in order: a bucket always arrives after the images and slot colours it uses.
 */
export type WorkerResponse =
  | { type: 'result'; id: number; value: unknown; imageAtlas?: ImageAtlasUpdate | null; featureColors?: FeatureColorUpdate | null }
  | { type: 'error'; id: number; name: string; message: string; featureColors?: FeatureColorUpdate | null }
  /** The worker asks the main thread to resolve a request (`transformRequest`, protocols); answered by `resource`. */
  | { type: 'resource'; id: number; request: ResourceRequest }
  /** The worker gave up on a `resource` request (its tile was cancelled). */
  | { type: 'resource-cancel'; id: number }

/** Typed arrays a bucket can hand over without copying. */
export function collectTransferables(bucket: TileBucket | null): Transferable[] {
  if (bucket === null) return []
  const buffers: ArrayBufferLike[] = []
  const { shapes, text, atlas, layers, raster, symbols, extrusions } = bucket
  if (raster?.kind === 'dem') buffers.push(raster.elevations.buffer)
  if (shapes !== null) buffers.push(shapes.positions.buffer, shapes.colors.buffer, shapes.indices.buffer)
  if (shapes?.colorSlots) buffers.push(shapes.colorSlots.buffer)
  if (shapes?.patterns != null && shapes.patternCoordinates !== null) buffers.push(shapes.patterns.buffer, shapes.patternCoordinates.buffer)
  if (shapes?.edges) buffers.push(shapes.edges.buffer)
  if (text !== null) buffers.push(text.positions.buffer, text.uvs.buffer, text.colors.buffer, text.haloColors.buffer, text.haloEdges.buffer, text.indices.buffer)
  if (atlas !== null) for (const glyph of atlas.glyphs) buffers.push(glyph.data.buffer)
  if (symbols != null) buffers.push(...symbolMeshBuffers(symbols))
  buffers.push(...extrusionMeshBuffers(extrusions))
  for (const layer of layers) {
    buffers.push(layer.indices.buffer)
    for (const attribute of layer.attributes) buffers.push(attribute.array.buffer)
  }
  const transferables = [...new Set(buffers)] as Transferable[]
  if (raster?.kind === 'image' && typeof ImageBitmap !== 'undefined' && raster.image instanceof ImageBitmap) transferables.push(raster.image)
  return transferables
}

/** Typed arrays of an image atlas update, to transfer. */
export function collectImageAtlasTransferables(update: ImageAtlasUpdate | null | undefined): Transferable[] {
  return update == null ? [] : update.images.map(image => image.data.buffer as Transferable)
}
