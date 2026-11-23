import TinySDF from '@mapbox/tiny-sdf'
import Pbf from 'pbf'

import type { AtlasGlyphUpdate, AtlasUpdate } from './types.js'

/** Glyph SDFs are drawn at this font size, in pixels (MapLibre's ONE_EM). */
export const GLYPH_FONT_SIZE = 24
/** Padding around each glyph bitmap, in pixels (glyph servers and MapLibre use 3). */
export const GLYPH_BUFFER = 3
/** SDF value of the glyph edge (MapLibre: 192 / 256). */
export const GLYPH_EDGE = 0.75

/** A glyph's metrics in pixels of a 24 px font, as glyph PBFs store them. */
export interface GlyphMetrics {
  width: number
  height: number
  left: number
  top: number
  advance: number
}

/** A decoded glyph: metrics plus its SDF bitmap, (width + 6) × (height + 6) bytes. */
export interface Glyph extends GlyphMetrics {
  id: number
  bitmap: Uint8Array | null
}

/** A glyph placed in the atlas. `x`, `y` are the top-left of its padded bitmap, in atlas pixels. */
export interface AtlasGlyph extends GlyphMetrics {
  x: number
  y: number
}

/**
 * Decodes a glyph range PBF (the `glyphs` endpoint of a MapLibre style: one font stack, 256 code points).
 * Schema: glyphs { repeated fontstack stacks = 1 } fontstack { name = 1; range = 2; repeated glyph = 3 }
 * glyph { id = 1; bitmap = 2; width = 3; height = 4; left = 5 (sint); top = 6 (sint); advance = 7 }.
 */
export function parseGlyphRange(buffer: ArrayBuffer | Uint8Array): Glyph[] {
  const glyphs: Glyph[] = []
  const readGlyph = (tag: number, glyph: Glyph, pbf?: Pbf) => {
    if (pbf === undefined) return
    if (tag === 1) glyph.id = pbf.readVarint()
    else if (tag === 2) glyph.bitmap = pbf.readBytes()
    else if (tag === 3) glyph.width = pbf.readVarint()
    else if (tag === 4) glyph.height = pbf.readVarint()
    else if (tag === 5) glyph.left = pbf.readSVarint()
    else if (tag === 6) glyph.top = pbf.readSVarint()
    else if (tag === 7) glyph.advance = pbf.readVarint()
  }
  const readStack = (tag: number, _stack: object, pbf?: Pbf) => {
    if (tag === 3 && pbf !== undefined) {
      glyphs.push(pbf.readMessage(readGlyph, { id: 0, bitmap: null, width: 0, height: 0, left: 0, top: 0, advance: 0 }))
    }
  }
  new Pbf(buffer).readFields((tag, _result, pbf) => {
    if (tag === 1 && pbf !== undefined) pbf.readMessage(readStack, {})
  }, {})
  return glyphs
}

const ATLAS_WIDTH = 1024
const ATLAS_MAXIMUM_HEIGHT = 4096

/**
 * Packs glyph bitmaps into one single-channel atlas with a shelf packer, and records what changed so the
 * main thread can mirror it. The atlas only grows (in height): placed glyphs never move, so text meshes
 * made earlier stay valid.
 */
export class GlyphAtlas {
  width = ATLAS_WIDTH
  height = 256
  protected readonly shelves: Array<{ y: number; height: number; x: number }> = []
  protected readonly updates: AtlasGlyphUpdate[] = []
  protected sizeChanged = true
  protected warnedFull = false

  /** Places a bitmap; returns its top-left, or null if the atlas is full. */
  add(width: number, height: number, data: Uint8Array): { x: number; y: number } | null {
    const position = this.allocate(width + 1, height + 1) // 1 px gap against bleeding
    if (position === null) {
      if (!this.warnedFull) console.warn('MapStyleSource: the glyph atlas is full (1024 × 4096); new glyphs are skipped.')
      this.warnedFull = true
      return null
    }
    if (width > 0 && height > 0) this.updates.push({ ...position, width, height, data })
    return position
  }

  /** Changes since the last call, or null if none. */
  takeUpdate(): AtlasUpdate | null {
    if (this.updates.length === 0 && !this.sizeChanged) return null
    const update = { width: this.width, height: this.height, glyphs: this.updates.splice(0) }
    this.sizeChanged = false
    return update
  }

  protected allocate(width: number, height: number): { x: number; y: number } | null {
    if (width > this.width) return null
    let best: (typeof this.shelves)[number] | undefined
    for (const shelf of this.shelves) {
      if (shelf.height >= height && shelf.height <= height * 1.5 && this.width - shelf.x >= width) {
        if (best === undefined || shelf.height < best.height) best = shelf
      }
    }
    if (best === undefined) {
      const top = this.shelves.reduce((bottom, shelf) => Math.max(bottom, shelf.y + shelf.height), 0)
      while (top + height > this.height) {
        if (this.height * 2 > ATLAS_MAXIMUM_HEIGHT) return null
        this.height *= 2
        this.sizeChanged = true
      }
      best = { y: top, height, x: 0 }
      this.shelves.push(best)
    }
    const position = { x: best.x, y: best.y }
    best.x += width
    return position
  }
}

export interface GlyphProviderOptions {
  /** Glyph URL template with `{fontstack}` and `{range}`, absolute. Null draws every glyph locally. */
  glyphsUrl: string | null
  requestHeaders: Record<string, string>
  localFontFamily: string
  /** Replaces `fetch`, for tests. */
  fetch?: typeof fetch
  /** Replaces the local glyph renderer, for tests (no OffscreenCanvas in Node). */
  drawLocalGlyph?: (fontStack: string, codePoint: number) => Glyph | null
  /** An atlas to keep packing into (after a style reload), so glyphs already drawn keep their place. */
  atlas?: GlyphAtlas
}

/**
 * Gets glyphs for font stacks: from the style's glyph server (256 code points per request), or drawn on an
 * OffscreenCanvas with TinySDF when the server does not have them. Every glyph goes into the atlas once.
 */
export class GlyphProvider {
  readonly atlas: GlyphAtlas
  protected readonly placed = new Map<string, AtlasGlyph | null>()
  protected readonly ranges = new Map<string, Promise<Map<number, Glyph> | null>>()
  protected readonly localRenderers = new Map<string, TinySDF>()
  protected readonly options: GlyphProviderOptions

  constructor(options: GlyphProviderOptions) {
    this.options = options
    this.atlas = options.atlas ?? new GlyphAtlas()
  }

  /** Whether this provider serves the same glyphs as `options` would. */
  matches(options: Pick<GlyphProviderOptions, 'glyphsUrl' | 'localFontFamily'>): boolean {
    return options.glyphsUrl === this.options.glyphsUrl && options.localFontFamily === this.options.localFontFamily
  }

  /** Loads (if needed) and places the glyphs of these code points for a font stack. */
  async load(fontStack: string, codePoints: Iterable<number>): Promise<void> {
    const missing = new Set<number>()
    for (const codePoint of codePoints) if (!this.placed.has(glyphKey(fontStack, codePoint))) missing.add(codePoint)
    if (missing.size === 0) return
    const rangeStarts = new Set([...missing].map(codePoint => Math.floor(codePoint / 256) * 256))
    const ranges = await Promise.all([...rangeStarts].map(start => this.loadRange(fontStack, start)))
    const byRange = new Map([...rangeStarts].map((start, index) => [start, ranges[index] ?? null]))
    for (const codePoint of missing) {
      const key = glyphKey(fontStack, codePoint)
      if (this.placed.has(key)) continue // placed by a concurrent call
      const remote = byRange.get(Math.floor(codePoint / 256) * 256)?.get(codePoint)
      const glyph = remote ?? this.drawLocal(fontStack, codePoint)
      this.placed.set(key, glyph === null ? null : this.place(glyph))
    }
  }

  /** A loaded glyph, or null if neither the server nor the local font has it. */
  get(fontStack: string, codePoint: number): AtlasGlyph | null {
    return this.placed.get(glyphKey(fontStack, codePoint)) ?? null
  }

  protected place(glyph: Glyph): AtlasGlyph | null {
    const metrics = { width: glyph.width, height: glyph.height, left: glyph.left, top: glyph.top, advance: glyph.advance }
    if (glyph.bitmap === null || glyph.width === 0 || glyph.height === 0) return { ...metrics, x: 0, y: 0 } // a space
    const width = glyph.width + GLYPH_BUFFER * 2
    const height = glyph.height + GLYPH_BUFFER * 2
    if (glyph.bitmap.length < width * height) return { ...metrics, x: 0, y: 0, width: 0, height: 0 }
    const position = this.atlas.add(width, height, glyph.bitmap.slice(0, width * height))
    return position === null ? null : { ...metrics, ...position }
  }

  protected loadRange(fontStack: string, start: number): Promise<Map<number, Glyph> | null> {
    const { glyphsUrl } = this.options
    if (glyphsUrl === null) return Promise.resolve(null)
    const key = `${fontStack}/${start}`
    let range = this.ranges.get(key)
    if (range === undefined) {
      const url = glyphsUrl.replace('{fontstack}', encodeURIComponent(fontStack)).replace('{range}', `${start}-${start + 255}`)
      const fetchFunction = this.options.fetch ?? fetch
      range = fetchFunction(url, { headers: this.options.requestHeaders })
        .then(async response => {
          if (!response.ok) return null
          return new Map(parseGlyphRange(await response.arrayBuffer()).map(glyph => [glyph.id, glyph]))
        })
        .catch(() => null)
      this.ranges.set(key, range)
    }
    return range
  }

  protected drawLocal(fontStack: string, codePoint: number): Glyph | null {
    if (this.options.drawLocalGlyph !== undefined) return this.options.drawLocalGlyph(fontStack, codePoint)
    if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return null
    const { fontWeight, fontStyle } = parseFontName(fontStack)
    const rendererKey = `${fontWeight}/${fontStyle}`
    let renderer = this.localRenderers.get(rendererKey)
    if (renderer === undefined) {
      renderer = new TinySDF({
        fontSize: GLYPH_FONT_SIZE,
        buffer: GLYPH_BUFFER,
        radius: 8,
        cutoff: 0.25,
        fontFamily: this.options.localFontFamily,
        fontWeight,
        fontStyle,
      })
      this.localRenderers.set(rendererKey, renderer)
    }
    const drawn = renderer.draw(String.fromCodePoint(codePoint))
    // TinySDF measures from the em box top; glyph servers from the baseline (MapLibre's topAdjustment).
    return {
      id: codePoint,
      bitmap: new Uint8Array(drawn.data.buffer, drawn.data.byteOffset, drawn.data.length),
      width: drawn.glyphWidth,
      height: drawn.glyphHeight,
      left: drawn.glyphLeft,
      top: drawn.glyphTop - 27,
      advance: drawn.glyphAdvance,
    }
  }
}

function glyphKey(fontStack: string, codePoint: number): string {
  return `${fontStack}\u0000${codePoint}`
}

/** Guesses CSS weight and style from a font name such as "Noto Sans Bold Italic". */
export function parseFontName(fontStack: string): { fontWeight: string; fontStyle: string } {
  const name = fontStack.split(',')[0]?.toLowerCase() ?? ''
  const fontWeight = /\b(bold|black|heavy|extrabold|semibold)\b/.test(name) ? 'bold' : /\b(light|thin)\b/.test(name) ? '300' : 'normal'
  const fontStyle = /\b(italic|oblique)\b/.test(name) ? 'italic' : 'normal'
  return { fontWeight, fontStyle }
}
