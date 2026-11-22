/**
 * Data shared by the main thread and the vector tile worker. Everything here is structured-cloneable, and
 * the typed arrays are transferred, not copied.
 */

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
  /** Bytes held by the typed arrays, for cache budgets. */
  byteLength: number
}

export type WorkerRequest =
  | { type: 'init'; id: number; options: MapStyleProcessorOptions }
  | { type: 'tile'; id: number; request: TileRequest }
  | { type: 'cancel'; id: number }

export type WorkerResponse =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; name: string; message: string }

/** Typed arrays a bucket can hand over without copying. */
export function collectTransferables(bucket: TileBucket | null): Transferable[] {
  if (bucket === null) return []
  const buffers: ArrayBufferLike[] = []
  const { shapes, text, atlas } = bucket
  if (shapes !== null) buffers.push(shapes.positions.buffer, shapes.colors.buffer, shapes.indices.buffer)
  if (text !== null) buffers.push(text.positions.buffer, text.uvs.buffer, text.colors.buffer, text.haloColors.buffer, text.haloEdges.buffer, text.indices.buffer)
  if (atlas !== null) for (const glyph of atlas.glyphs) buffers.push(glyph.data.buffer)
  return [...new Set(buffers)] as Transferable[]
}
