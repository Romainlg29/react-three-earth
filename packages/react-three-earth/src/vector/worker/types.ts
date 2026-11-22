/**
 * Data shared by the main thread and the vector tile worker. Everything here is structured-cloneable, and
 * the typed arrays are transferred, not copied.
 */

import type { MercatorRectangle } from './rectangles.js'

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
  /** Feature-state set before the processor started, by feature key (`featureKey`). */
  featureStates?: Array<[string, FeatureState]>
  /** Values set with `setGlobalStateProperty`, over the style root `state` defaults. */
  globalState?: Record<string, unknown>
  /**
   * The main thread has a `transformRequest`: every request is sent to it first (`resolveResource`). URLs with a
   * scheme other than http(s), data and blob always are, for protocols added with `addProtocol`.
   */
  transformsRequests?: boolean
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
}

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
}

/** A vector source of the style, as the main thread sees it. */
export interface MapStyleSourceSummary {
  id: string
  minimumZoom: number
  maximumZoom: number
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
}

/** One vector tile to process. */
export interface TileRequest {
  sourceId: string
  /** Tile coordinates at the data level (XYZ, y down from the north). */
  x: number
  y: number
  z: number
  /** Zoom the style is evaluated at: at least `z`, more when the tile is overzoomed. */
  zoom: number
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

/** The processed tile. Null meshes when the tile has nothing of that kind. */
export interface TileBucket {
  shapes: ShapeMesh | null
  text: TextMesh | null
  atlas: AtlasUpdate | null
  /** Features drawn with colour slots: a state change redraws the regions using this bucket. */
  featureStateKeys: string[]
  /** Features whose state changes the geometry or text (widths, text colours): a change processes the tile again. */
  rebuildFeatureKeys: string[]
  /** How many feature-state messages the worker had applied when it started the tile. */
  featureStateVersion: number
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

/**
 * `featureColors` rides along with any result and is applied before it resolves, in order: a bucket always
 * arrives after the slot colours it uses.
 */
export type WorkerResponse =
  | { type: 'result'; id: number; value: unknown; featureColors?: FeatureColorUpdate | null }
  | { type: 'error'; id: number; name: string; message: string; featureColors?: FeatureColorUpdate | null }
  /** The worker asks the main thread to resolve a request (`transformRequest`, protocols); answered by `resource`. */
  | { type: 'resource'; id: number; request: ResourceRequest }
  /** The worker gave up on a `resource` request (its tile was cancelled). */
  | { type: 'resource-cancel'; id: number }

/** Typed arrays a bucket can hand over without copying. */
export function collectTransferables(bucket: TileBucket | null): Transferable[] {
  if (bucket === null) return []
  const buffers: ArrayBufferLike[] = []
  const { shapes, text, atlas } = bucket
  if (shapes !== null) buffers.push(shapes.positions.buffer, shapes.colors.buffer, shapes.indices.buffer)
  if (shapes?.colorSlots) buffers.push(shapes.colorSlots.buffer)
  if (text !== null) buffers.push(text.positions.buffer, text.uvs.buffer, text.colors.buffer, text.haloColors.buffer, text.haloEdges.buffer, text.indices.buffer)
  if (atlas !== null) for (const glyph of atlas.glyphs) buffers.push(glyph.data.buffer)
  return [...new Set(buffers)] as Transferable[]
}
