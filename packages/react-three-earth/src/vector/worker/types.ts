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
  /**
   * `background-pattern` per integer zoom 0 to 24, drawn over `backgroundByZoom`. Coordinates are in the
   * image atlas.
   */
  backgroundPatternByZoom: Array<BackgroundPattern | null>
  /** `background-pattern` images that neither the sprite nor `addImage` provide (`styleimagemissing`). */
  missingBackgroundImages: string[]
  /** Image ids the style's sprites provide (`sprite-id:name` for sprites other than `default`). */
  spriteImageIds: string[]
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
  /**
   * Fill and line patterns, or null when the tile has none: per vertex, the pattern image's place in the image
   * atlas (x, y, width, height in atlas pixels; width 0 for a vertex coloured by `colors`), and where the
   * vertex falls in the repeated image, in image pixels. The vertex colour's alpha is the pattern's opacity.
   */
  patterns: Uint16Array | null
  patternCoordinates: Float32Array | null
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

/** The processed tile. Null meshes when the tile has nothing of that kind. */
export interface TileBucket {
  shapes: ShapeMesh | null
  text: TextMesh | null
  atlas: AtlasUpdate | null
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
  /** Adds or replaces (`image`) or removes (`null`) a runtime image. Answers with an `ImageChange`. */
  | { type: 'image'; id: number; imageId: string; image: StyleImage | null }

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

export type WorkerResponse =
  /** `imageAtlas`: image atlas changes, applied before the result resolves (whatever request it answers). */
  | { type: 'result'; id: number; value: unknown; imageAtlas?: ImageAtlasUpdate | null }
  | { type: 'error'; id: number; name: string; message: string }

/** Typed arrays a bucket can hand over without copying. */
export function collectTransferables(bucket: TileBucket | null): Transferable[] {
  if (bucket === null) return []
  const buffers: ArrayBufferLike[] = []
  const { shapes, text, atlas } = bucket
  if (shapes !== null) buffers.push(shapes.positions.buffer, shapes.colors.buffer, shapes.indices.buffer)
  if (shapes?.patterns != null && shapes.patternCoordinates !== null) buffers.push(shapes.patterns.buffer, shapes.patternCoordinates.buffer)
  if (text !== null) buffers.push(text.positions.buffer, text.uvs.buffer, text.colors.buffer, text.haloColors.buffer, text.haloEdges.buffer, text.indices.buffer)
  if (atlas !== null) for (const glyph of atlas.glyphs) buffers.push(glyph.data.buffer)
  return [...new Set(buffers)] as Transferable[]
}

/** Typed arrays of an image atlas update, to transfer. */
export function collectImageAtlasTransferables(update: ImageAtlasUpdate | null | undefined): Transferable[] {
  return update == null ? [] : update.images.map(image => image.data.buffer as Transferable)
}
