import { isArabicScript, needsArabicShaping, shapeArabicCodePoints } from './arabic.js'
import { isClusterCodePoint, needsClusters, substituteClusters } from './clusters.js'
import { hasRightToLeft, mirrorCodePoint, resolveLevels, visualOrder } from './bidi.js'
import { GLYPH_BUFFER, GLYPH_EDGE, GLYPH_FONT_SIZE, type AtlasGlyph } from './glyphs.js'
import type { Point } from './ShapeBuilder.js'
import type { Rgba } from './styleLayers.js'
import type { TextMesh } from './types.js'

/** MapLibre's baseline shift of a line of glyphs (SHAPING_DEFAULT_OFFSET), in pixels of a 24 px font. */
const BASELINE_OFFSET = -17

/** A run of text with one font stack and scale. */
export interface TextSection {
  text: string
  fontStack: string
  scale: number
}

export type TextAnchor = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type TextJustify = 'auto' | 'left' | 'center' | 'right'

export interface ShapingOptions {
  /** Maximum line width in ems before wrapping; 0 or Infinity for no wrapping. */
  maximumWidthEms: number
  lineHeightEms: number
  letterSpacingEms: number
  anchor: TextAnchor
  justify: TextJustify
  /**
   * `text-writing-mode` vertical: lines become columns read top to bottom, right to left; CJK characters stand
   * upright, others turn 90° clockwise. Text with no CJK character, or with right-to-left text, stays horizontal.
   */
  vertical?: boolean
}

/** A glyph positioned in pixels of a 24 px font, relative to the label anchor (y down). */
export interface ShapedGlyph {
  glyph: AtlasGlyph
  /** The code point drawn (after Arabic shaping and bracket mirroring). */
  codePoint: number
  /** Top-left of the padded glyph bitmap. */
  x: number
  y: number
  scale: number
  /** Horizontal centre of the glyph's advance, for placing glyphs along a line. */
  centerX: number
  /**
   * Turned 90° clockwise (a Latin letter in vertical text): the bitmap's top-left corner is at `x`, `y`, its width
   * runs down and its height runs left.
   */
  rotated?: boolean
}

export interface ShapedText {
  glyphs: ShapedGlyph[]
  /** Bounds of the text block (from advances and line heights), in pixels of a 24 px font. */
  left: number
  top: number
  right: number
  bottom: number
}

export type GlyphLookup = (fontStack: string, codePoint: number) => AtlasGlyph | null

const BREAKABLE = new Set([0x20, 0x09, 0x200b])

/** Lays out text in lines (wrapping at spaces), justified and aligned to an anchor. */
export function shapeText(sections: readonly TextSection[], options: ShapingOptions, getGlyph: GlyphLookup): ShapedText | null {
  interface Character {
    codePoint: number
    section: TextSection
    glyph: AtlasGlyph | null
    advance: number
    /** Bidi embedding level: odd runs right to left. */
    level: number
  }
  // Letter spacing would open gaps between joined Arabic letters, or break the headstroke of Devanagari clusters:
  // such labels take none, as MapLibre does for Arabic.
  const joinedScript = sections.some(section =>
    Array.from(section.text).some(character => {
      const codePoint = character.codePointAt(0)!
      return isArabicScript(codePoint) || isClusterCodePoint(codePoint)
    }),
  )
  const spacing = joinedScript ? 0 : options.letterSpacingEms * GLYPH_FONT_SIZE
  const characters: Character[] = []
  for (const section of sections) {
    for (const character of section.text) {
      const codePoint = character.codePointAt(0)!
      const glyph = getGlyph(section.fontStack, codePoint)
      characters.push({ codePoint, section, glyph, advance: glyph === null ? 0 : glyph.advance * section.scale + spacing, level: 0 })
    }
  }
  const bidirectional = hasRightToLeft(characters.map(character => character.codePoint))
  if (bidirectional) resolveParagraphLevels(characters)
  const vertical = options.vertical === true && !bidirectional && characters.some(character => isUprightInVerticalText(character.codePoint))
  if (vertical) {
    // Upright characters take their vertical form (punctuation) and advance one em down the column.
    for (const character of characters) {
      if (!isUprightInVerticalText(character.codePoint)) continue
      const verticalForm = VERTICAL_FORMS.get(character.codePoint)
      const glyph = verticalForm === undefined ? null : getGlyph(character.section.fontStack, verticalForm)
      if (glyph !== null) {
        character.codePoint = verticalForm!
        character.glyph = glyph
      }
      character.advance = character.glyph === null ? 0 : GLYPH_FONT_SIZE * character.section.scale + spacing
    }
  }
  const bidirectional = hasRightToLeft(characters.map(character => character.codePoint))
  if (bidirectional) resolveParagraphLevels(characters)

  // Lines: explicit newlines, then greedy wrapping at breakable characters.
  const maximumWidth = options.maximumWidthEms > 0 ? options.maximumWidthEms * GLYPH_FONT_SIZE : Infinity
  const lines: Character[][] = []
  let line: Character[] = []
  let lineWidth = 0
  let lastBreak = -1
  for (const character of characters) {
    if (character.codePoint === 0x0a) {
      lines.push(line)
      line = []
      lineWidth = 0
      lastBreak = -1
      continue
    }
    line.push(character)
    lineWidth += character.advance
    if (BREAKABLE.has(character.codePoint)) lastBreak = line.length - 1
    if (lineWidth > maximumWidth && lastBreak > 0) {
      const rest = line.splice(lastBreak + 1)
      line.pop() // the space itself
      lines.push(line)
      line = rest
      lineWidth = rest.reduce((sum, item) => sum + item.advance, 0)
      lastBreak = -1
    }
  }
  lines.push(line)
  // Lines break in logical order, then each is drawn in visual order with brackets mirrored on right-to-left runs.
  const trimmed = lines.map(items => {
    const line = trimSpaces(items)
    if (!bidirectional) return line
    return visualOrder(line.map(item => item.level)).map(index => {
      const item = line[index]!
      const mirrored = item.level % 2 === 1 ? mirrorCodePoint(item.codePoint) : item.codePoint
      if (mirrored === item.codePoint) return item
      const glyph = getGlyph(item.section.fontStack, mirrored) ?? item.glyph
      return { ...item, codePoint: mirrored, glyph, advance: glyph === null ? 0 : glyph.advance * item.section.scale + spacing }
    })
  })
  if (trimmed.every(items => items.length === 0)) return null
  if (vertical) return layoutColumns(trimmed, options, spacing)

  const lineHeight = options.lineHeightEms * GLYPH_FONT_SIZE
  const widths = trimmed.map(items => items.reduce((sum, item) => sum + item.advance, 0) - (items.length > 0 ? spacing : 0))
  const blockWidth = Math.max(...widths)
  const [horizontalAlign, verticalAlign] = anchorAlignment(options.anchor)
  const justify = options.justify === 'auto' ? horizontalAlign : options.justify === 'left' ? 0 : options.justify === 'right' ? 1 : 0.5
  const shiftX = -horizontalAlign * blockWidth
  const shiftY = (-verticalAlign * trimmed.length + 0.5) * lineHeight

  const glyphs: ShapedGlyph[] = []
  trimmed.forEach((items, lineIndex) => {
    let penX = shiftX + (blockWidth - widths[lineIndex]!) * justify
    const baseline = lineIndex * lineHeight + shiftY + BASELINE_OFFSET
    for (const { glyph, section, advance, codePoint } of items) {
      if (glyph !== null && glyph.width > 0) {
        glyphs.push({
          glyph,
          codePoint,
          x: penX + (glyph.left - GLYPH_BUFFER) * section.scale,
          y: baseline + (-glyph.top - GLYPH_BUFFER) * section.scale,
          scale: section.scale,
          centerX: penX + (advance - spacing) / 2,
        })
      }
      penX += advance
    }
  })
  return {
    glyphs,
    left: shiftX,
    right: shiftX + blockWidth,
    top: shiftY - lineHeight / 2,
    bottom: shiftY - lineHeight / 2 + trimmed.length * lineHeight,
  }
}

/**
 * Vertical text: each line a column, the first on the right; upright characters centred on the column, one em
 * each, runs of other characters laid as horizontal text and turned 90° clockwise. The block aligns to the anchor
 * as horizontal text does, and `justify` moves short columns down their length.
 */
function layoutColumns(
  columns: ReadonlyArray<ReadonlyArray<{ codePoint: number; glyph: AtlasGlyph | null; section: TextSection; advance: number }>>,
  options: ShapingOptions,
  spacing: number,
): ShapedText {
  const columnWidth = options.lineHeightEms * GLYPH_FONT_SIZE
  const lengths = columns.map(items => items.reduce((sum, item) => sum + item.advance, 0) - (items.length > 0 ? spacing : 0))
  const blockWidth = columns.length * columnWidth
  const blockHeight = Math.max(...lengths)
  const [horizontalAlign, verticalAlign] = anchorAlignment(options.anchor)
  const justify = options.justify === 'auto' ? verticalAlign : options.justify === 'left' ? 0 : options.justify === 'right' ? 1 : 0.5
  const shiftX = -horizontalAlign * blockWidth
  const shiftY = -verticalAlign * blockHeight
  const glyphs: ShapedGlyph[] = []
  columns.forEach((items, columnIndex) => {
    const centerX = shiftX + blockWidth - (columnIndex + 0.5) * columnWidth
    let penY = shiftY + (blockHeight - lengths[columnIndex]!) * justify
    for (const { glyph, section, advance, codePoint } of items) {
      if (glyph !== null && glyph.width > 0) {
        if (isUprightInVerticalText(codePoint)) {
          // A horizontal glyph in an em square centred on the column (the baseline as horizontal text puts it).
          const centerY = penY + (GLYPH_FONT_SIZE * section.scale) / 2
          glyphs.push({
            glyph,
            codePoint,
            x: centerX - (glyph.advance * section.scale) / 2 + (glyph.left - GLYPH_BUFFER) * section.scale,
            y: centerY + BASELINE_OFFSET + (-glyph.top - GLYPH_BUFFER) * section.scale,
            scale: section.scale,
            centerX,
          })
        } else {
          // Laid out as horizontal text with its baseline row centred on y = 0, then turned clockwise onto the column.
          const unrotatedY = BASELINE_OFFSET + (-glyph.top - GLYPH_BUFFER) * section.scale
          glyphs.push({
            glyph,
            codePoint,
            x: centerX - unrotatedY,
            y: penY + (glyph.left - GLYPH_BUFFER) * section.scale,
            scale: section.scale,
            centerX,
            rotated: true,
          })
        }
      }
      penY += advance
    }
  })
  return { glyphs, left: shiftX, right: shiftX + blockWidth, top: shiftY, bottom: shiftY + blockHeight }
}

/** Code point ranges that stand upright in vertical text (UAX #50 Vertical_Orientation U or Tu, simplified). */
const UPRIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2fdf], // CJK radicals, Kangxi radicals
  [0x2ff0, 0x303f], // ideographic description, CJK symbols and punctuation
  [0x3040, 0x30fb], // Hiragana, Katakana (the prolonged sound mark U+30FC turns)
  [0x30fd, 0x312f], // Katakana, Bopomofo
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0x3190, 0x31ff], // Kanbun, Bopomofo extended, CJK strokes, Katakana extensions
  [0x3200, 0x4dbf], // enclosed CJK, compatibility, CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7ff], // Hangul syllables, Jamo extended B
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe1f], // vertical forms
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff01, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x20000, 0x3ffff], // CJK extensions B and later
]

/** Characters inside the upright ranges that turn instead (UAX #50 Tr or R): dashes, tildes, angle brackets. */
const TURNED_IN_VERTICAL_TEXT = new Set([0x301c, 0x301d, 0x301e, 0x301f, 0x3030, 0xff0d, 0xff1c, 0xff1d, 0xff1e, 0xff3f, 0xff5c, 0xff5e, 0xff5f, 0xff60, 0xffe3])

/** Whether a character stands upright in a vertical column; others turn 90° clockwise. */
export function isUprightInVerticalText(codePoint: number): boolean {
  if (codePoint < 0x1100 || TURNED_IN_VERTICAL_TEXT.has(codePoint)) return false
  for (const [start, end] of UPRIGHT_RANGES) if (codePoint >= start && codePoint <= end) return true
  return false
}

/** Punctuation that has a vertical form (Unicode Vertical Forms and CJK Compatibility Forms), as MapLibre swaps it. */
const VERTICAL_FORMS = new Map<number, number>([
  [0xff0c, 0xfe10], // fullwidth comma
  [0x3001, 0xfe11], // ideographic comma
  [0x3002, 0xfe12], // ideographic full stop
  [0xff1a, 0xfe13], // fullwidth colon
  [0xff1b, 0xfe14], // fullwidth semicolon
  [0xff01, 0xfe15], // fullwidth exclamation mark
  [0xff1f, 0xfe16], // fullwidth question mark
  [0x3016, 0xfe17], // white lenticular brackets
  [0x3017, 0xfe18],
  [0xff08, 0xfe35], // fullwidth parentheses
  [0xff09, 0xfe36],
  [0xff5b, 0xfe37], // fullwidth braces
  [0xff5d, 0xfe38],
  [0x3014, 0xfe39], // tortoise shell brackets
  [0x3015, 0xfe3a],
  [0x3010, 0xfe3b], // black lenticular brackets
  [0x3011, 0xfe3c],
  [0x300a, 0xfe3d], // double angle brackets
  [0x300b, 0xfe3e],
  [0x3008, 0xfe3f], // angle brackets
  [0x3009, 0xfe40],
  [0x300c, 0xfe41], // corner brackets
  [0x300d, 0xfe42],
  [0x300e, 0xfe43], // white corner brackets
  [0x300f, 0xfe44],
  [0xff3b, 0xfe47], // fullwidth square brackets
  [0xff3d, 0xfe48],
])

/** Code points to load glyphs for in vertical text besides a text's own: the vertical forms of its punctuation. */
export function verticalFormCodePoints(text: string): number[] {
  const extra: number[] = []
  for (const character of text) {
    const verticalForm = VERTICAL_FORMS.get(character.codePointAt(0)!)
    if (verticalForm !== undefined) extra.push(verticalForm)
  }
  return extra
}

/** Resolves bidi levels paragraph by paragraph (between explicit newlines), in place. */
function resolveParagraphLevels(characters: Array<{ codePoint: number; level: number }>): void {
  let start = 0
  for (let index = 0; index <= characters.length; index++) {
    if (index < characters.length && characters[index]!.codePoint !== 0x0a) continue
    const paragraph = characters.slice(start, index)
    const levels = resolveLevels(paragraph.map(character => character.codePoint))
    paragraph.forEach((character, offset) => (character.level = levels[offset]!))
    start = index + 1
  }
}

/**
 * Text sections ready to draw: Arabic letters in their contextual presentation forms (lam-alef ligatures too),
 * joined across section boundaries, and each grapheme cluster of a complex script (Devanagari, Thai…) as one
 * glyph drawn by the local font. Sections with neither are returned as they are.
 */
export function shapeSectionsForScripts(sections: readonly TextSection[], { clusters = true }: { clusters?: boolean } = {}): TextSection[] {
  const joined = shapeArabicSections(sections)
  // Without a local font to draw clusters with, complex scripts keep their code points (the glyph server's, unshaped).
  if (!clusters || !joined.some(section => needsClusters(section.text))) return joined
  return joined.map(section => ({ ...section, text: substituteClusters(section.text) }))
}

function shapeArabicSections(sections: readonly TextSection[]): TextSection[] {
  if (!sections.some(section => needsArabicShaping(section.text))) return [...sections]
  const codePoints: number[] = []
  const owners: number[] = []
  sections.forEach((section, sectionIndex) => {
    for (const character of section.text) {
      codePoints.push(character.codePointAt(0)!)
      owners.push(sectionIndex)
    }
  })
  const shaped = shapeArabicCodePoints(codePoints)
  const texts = sections.map(() => '')
  shaped.codePoints.forEach((codePoint, index) => (texts[owners[shaped.sources[index]!]!] += String.fromCodePoint(codePoint)))
  return sections.map((section, index) => ({ ...section, text: texts[index]! })).filter(section => section.text.length > 0)
}

/** Code points to load glyphs for besides a text's own: the mirrored brackets right-to-left runs draw. */
export function mirroredCodePoints(text: string): number[] {
  const extra: number[] = []
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    const mirrored = mirrorCodePoint(codePoint)
    if (mirrored !== codePoint) extra.push(mirrored)
  }
  return extra
}

function trimSpaces<T extends { codePoint: number }>(items: T[]): T[] {
  let start = 0
  let end = items.length
  while (start < end && BREAKABLE.has(items[start]!.codePoint)) start++
  while (end > start && BREAKABLE.has(items[end - 1]!.codePoint)) end--
  return items.slice(start, end)
}

/** Horizontal and vertical alignment (0 to 1) of the text block relative to its anchor. */
function anchorAlignment(anchor: TextAnchor): [number, number] {
  const horizontal = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5
  const vertical = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5
  return [horizontal, vertical]
}

/** An axis-aligned box in tile units. */
export interface Box {
  minimumX: number
  minimumY: number
  maximumX: number
  maximumY: number
}

/** Label boxes already placed in a tile, bucketed in a grid for fast overlap tests. */
export class CollisionGrid {
  protected readonly cells = new Map<number, Box[]>()
  protected readonly cellSize: number

  constructor(cellSize = 512) {
    this.cellSize = cellSize
  }

  overlaps(boxes: readonly Box[]): boolean {
    return boxes.some(box => this.cellsOf(box).some(key => (this.cells.get(key) ?? []).some(other => intersects(box, other))))
  }

  insert(boxes: readonly Box[]): void {
    for (const box of boxes) {
      for (const key of this.cellsOf(box)) {
        let cell = this.cells.get(key)
        if (cell === undefined) this.cells.set(key, (cell = []))
        cell.push(box)
      }
    }
  }

  protected cellsOf(box: Box): number[] {
    const keys: number[] = []
    const fromX = Math.floor(box.minimumX / this.cellSize)
    const toX = Math.floor(box.maximumX / this.cellSize)
    const fromY = Math.floor(box.minimumY / this.cellSize)
    const toY = Math.floor(box.maximumY / this.cellSize)
    for (let x = fromX; x <= toX; x++) for (let y = fromY; y <= toY; y++) keys.push((x + 1024) * 4096 + (y + 1024))
    return keys
  }
}

function intersects(a: Box, b: Box): boolean {
  return a.minimumX < b.maximumX && b.minimumX < a.maximumX && a.minimumY < b.maximumY && b.minimumY < a.maximumY
}

/** Colours of a label. */
export interface LabelPaint {
  color: Rgba
  haloColor: Rgba
  /** Halo width in pixels. */
  haloWidthPixels: number
}

/** A glyph quad ready to emit: four corners in tile units and its atlas rectangle. */
interface GlyphQuad {
  corners: [Point, Point, Point, Point]
  glyph: AtlasGlyph
}

/**
 * Places a shaped label at a point. `pixelsToUnits` converts 24 px font pixels (times the text scale) to
 * tile units. Returns the glyph quads and collision boxes, or null for an empty label.
 */
export function layoutPointLabel(
  shaped: ShapedText,
  anchor: Point,
  pixelsToUnits: number,
  offset: Point,
  rotationRadians: number,
  paddingUnits: number,
): { quads: GlyphQuad[]; boxes: Box[] } {
  const cosine = Math.cos(rotationRadians)
  const sine = Math.sin(rotationRadians)
  const transform = (x: number, y: number): Point => {
    const px = (x + offset.x) * pixelsToUnits
    const py = (y + offset.y) * pixelsToUnits
    return { x: anchor.x + px * cosine - py * sine, y: anchor.y + px * sine + py * cosine }
  }
  const quads = shaped.glyphs.map(({ glyph, x, y, scale, rotated }) => {
    const width = (glyph.width + GLYPH_BUFFER * 2) * scale
    const height = (glyph.height + GLYPH_BUFFER * 2) * scale
    // Corners in the bitmap's order (top-left, top-right, bottom-right, bottom-left); turned clockwise when rotated.
    const corners: GlyphQuad['corners'] = rotated
      ? [transform(x, y), transform(x, y + width), transform(x - height, y + width), transform(x - height, y)]
      : [transform(x, y), transform(x + width, y), transform(x + width, y + height), transform(x, y + height)]
    return { glyph, corners }
  })
  const corners = [transform(shaped.left, shaped.top), transform(shaped.right, shaped.top), transform(shaped.right, shaped.bottom), transform(shaped.left, shaped.bottom)]
  const box = boundsOf(corners, paddingUnits)
  return { quads, boxes: [box] }
}

/** Distance along a polyline and the points it passes. */
class Polyline {
  readonly points: readonly Point[]
  readonly distances: number[] = [0]
  constructor(points: readonly Point[]) {
    this.points = points
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1]!
      const b = points[index]!
      this.distances.push(this.distances[index - 1]! + Math.hypot(b.x - a.x, b.y - a.y))
    }
  }
  get length(): number {
    return this.distances.at(-1)!
  }
  /** Point and direction (radians) at a distance along the line. */
  at(distance: number): { point: Point; angle: number } {
    let index = 1
    while (index < this.distances.length - 1 && this.distances[index]! < distance) index++
    const a = this.points[index - 1]!
    const b = this.points[index]!
    const segment = this.distances[index]! - this.distances[index - 1]!
    const t = segment > 0 ? (distance - this.distances[index - 1]!) / segment : 0
    return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, angle: Math.atan2(b.y - a.y, b.x - a.x) }
  }
}

export interface LineLabelOptions {
  pixelsToUnits: number
  spacingUnits: number
  maximumAngleRadians: number
  keepUpright: boolean
  paddingUnits: number
  /** One label at the middle of the line instead of one every `spacingUnits`. */
  center: boolean
  /** Only anchors inside this square (tile units) are kept, so neighbouring tiles do not repeat labels. */
  extent: number
}

/** The stretch of a line a label facing the viewer is laid along: tile units, with the label's anchor among the points. */
export interface LineLabelPath {
  points: Point[]
  anchorIndex: number
}

export interface LineLabelPathOptions {
  spacingUnits: number
  /** One label at the middle of the line instead of one every `spacingUnits`. */
  center: boolean
  /** Only anchors inside this square (tile units) are kept, so neighbouring tiles do not repeat labels. */
  extent: number
  /** Line kept on each side of the anchor, in tile units: enough for the label at its largest. */
  windowUnits: number
}

/**
 * Where a line label goes along a line (the same anchors as `layoutLineLabels`), each with the stretch of line
 * around it: the main thread projects that stretch and lays the glyphs along it on the screen every frame.
 */
export function lineLabelPaths(line: readonly Point[], labelLengthUnits: number, options: LineLabelPathOptions): LineLabelPath[] {
  const path = new Polyline(line)
  const total = path.length
  if (labelLengthUnits <= 0 || total < labelLengthUnits) return []
  const count = options.center ? 1 : Math.max(1, Math.floor(total / Math.max(options.spacingUnits, labelLengthUnits)))
  const paths: LineLabelPath[] = []
  for (let index = 0; index < count; index++) {
    const anchorDistance = ((index + 0.5) * total) / count
    if (anchorDistance - labelLengthUnits / 2 < 0 || anchorDistance + labelLengthUnits / 2 > total) continue
    const anchor = path.at(anchorDistance).point
    if (anchor.x < 0 || anchor.y < 0 || anchor.x >= options.extent || anchor.y >= options.extent) continue
    const from = Math.max(0, anchorDistance - options.windowUnits)
    const to = Math.min(total, anchorDistance + options.windowUnits)
    const points: Point[] = [path.at(from).point]
    for (let vertex = 1; vertex < line.length - 1; vertex++) {
      const distance = path.distances[vertex]!
      if (distance > from && distance < anchorDistance) points.push(line[vertex]!)
    }
    const anchorIndex = points.length
    points.push(anchor)
    for (let vertex = 1; vertex < line.length - 1; vertex++) {
      const distance = path.distances[vertex]!
      if (distance > anchorDistance && distance < to) points.push(line[vertex]!)
    }
    points.push(path.at(to).point)
    paths.push({ points, anchorIndex })
  }
  return paths
}

/** Candidate placements of a single-line label along a line, each a set of glyph quads and boxes. */
export function layoutLineLabels(shaped: ShapedText, line: readonly Point[], options: LineLabelOptions): Array<{ quads: GlyphQuad[]; boxes: Box[] }> {
  const forward = new Polyline(line)
  const total = forward.length
  const { pixelsToUnits } = options
  const labelLength = (shaped.right - shaped.left) * pixelsToUnits
  if (labelLength <= 0 || total < labelLength) return []
  const count = options.center ? 1 : Math.max(1, Math.floor(total / Math.max(options.spacingUnits, labelLength)))
  const results: Array<{ quads: GlyphQuad[]; boxes: Box[] }> = []
  const backward = new Polyline([...line].reverse())
  const middle = (shaped.left + shaped.right) / 2
  for (let index = 0; index < count; index++) {
    const anchorDistance = ((index + 0.5) * total) / count
    if (anchorDistance - labelLength / 2 < 0 || anchorDistance + labelLength / 2 > total) continue
    const { point: anchor, angle: anchorAngle } = forward.at(anchorDistance)
    if (anchor.x < 0 || anchor.y < 0 || anchor.x >= options.extent || anchor.y >= options.extent) continue
    const upsideDown = options.keepUpright && Math.cos(anchorAngle) < 0
    const path = upsideDown ? backward : forward
    const center = upsideDown ? total - anchorDistance : anchorDistance
    const placed = placeAlong(shaped, path, center, middle, options)
    if (placed !== null) results.push(placed)
  }
  return results
}

function placeAlong(shaped: ShapedText, path: Polyline, center: number, middle: number, options: LineLabelOptions): { quads: GlyphQuad[]; boxes: Box[] } | null {
  const { pixelsToUnits } = options
  const quads: GlyphQuad[] = []
  const boxes: Box[] = []
  let previousAngle: number | null = null
  for (const shapedGlyph of shaped.glyphs) {
    const { glyph, x, y, scale, centerX } = shapedGlyph
    const { point, angle } = path.at(center + (centerX - middle) * pixelsToUnits)
    if (previousAngle !== null) {
      let turn = Math.abs(angle - previousAngle)
      if (turn > Math.PI) turn = Math.PI * 2 - turn
      if (turn > options.maximumAngleRadians) return null
    }
    previousAngle = angle
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const width = (glyph.width + GLYPH_BUFFER * 2) * scale
    const height = (glyph.height + GLYPH_BUFFER * 2) * scale
    // Glyph corners relative to its own advance centre on the baseline row, rotated onto the line.
    const transform = (gx: number, gy: number): Point => {
      const px = (gx - centerX) * pixelsToUnits
      const py = gy * pixelsToUnits
      return { x: point.x + px * cosine - py * sine, y: point.y + px * sine + py * cosine }
    }
    const corners: GlyphQuad['corners'] = [transform(x, y), transform(x + width, y), transform(x + width, y + height), transform(x, y + height)]
    quads.push({ glyph, corners })
    boxes.push(boundsOf(corners, options.paddingUnits))
  }
  return quads.length > 0 ? { quads, boxes } : null
}

function boundsOf(points: readonly Point[], padding: number): Box {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  return { minimumX: Math.min(...xs) - padding, minimumY: Math.min(...ys) - padding, maximumX: Math.max(...xs) + padding, maximumY: Math.max(...ys) + padding }
}

/** Accumulates the text quads of one tile. */
export class TextBuilder {
  protected positions: number[] = []
  protected uvs: number[] = []
  protected colors: number[] = []
  protected haloColors: number[] = []
  protected haloEdges: number[] = []
  protected indices: number[] = []

  addLabel(quads: readonly GlyphQuad[], paint: LabelPaint, textScale: number): void {
    const haloEdge = paint.haloWidthPixels > 0 && paint.haloColor[3] > 0 ? Math.max(0.05, GLYPH_EDGE - paint.haloWidthPixels / (textScale * 8)) : GLYPH_EDGE
    for (const { corners, glyph } of quads) {
      const first = this.positions.length / 2
      const width = glyph.width + GLYPH_BUFFER * 2
      const height = glyph.height + GLYPH_BUFFER * 2
      const uv = [glyph.x, glyph.y, glyph.x + width, glyph.y, glyph.x + width, glyph.y + height, glyph.x, glyph.y + height]
      corners.forEach((corner, index) => {
        this.positions.push(corner.x, corner.y)
        this.uvs.push(uv[index * 2]!, uv[index * 2 + 1]!)
        this.colors.push(...paint.color)
        this.haloColors.push(...paint.haloColor)
        this.haloEdges.push(haloEdge)
      })
      this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
    }
  }

  build(): TextMesh | null {
    if (this.indices.length === 0) return null
    return {
      positions: new Float32Array(this.positions),
      uvs: new Float32Array(this.uvs),
      colors: new Uint8Array(this.colors),
      haloColors: new Uint8Array(this.haloColors),
      haloEdges: new Float32Array(this.haloEdges),
      indices: new Uint32Array(this.indices),
    }
  }
}

/**
 * Where a label's box goes for each of its `text-variable-anchor` anchors, as (x, y) shifts from the box centred
 * on its anchor point, in the box's units: the anchor names the side of the text that touches the point ('left':
 * the text to its right), then moved by the anchor's offset. `box` is centred on the point.
 */
export function variableAnchorShifts(box: Box, anchors: readonly TextAnchor[], offsetFor: (anchor: TextAnchor) => Point): number[] {
  const shifts: number[] = []
  for (const anchor of anchors) {
    const x = anchor.endsWith('left') ? -box.minimumX : anchor.endsWith('right') ? -box.maximumX : -(box.minimumX + box.maximumX) / 2
    const y = anchor.startsWith('top') ? -box.minimumY : anchor.startsWith('bottom') ? -box.maximumY : -(box.minimumY + box.maximumY) / 2
    const offset = offsetFor(anchor)
    shifts.push(x + offset.x, y + offset.y)
  }
  return shifts
}

/** MapLibre's `text-radial-offset` for one anchor: the radius away from the point, split on a diagonal. */
export function radialAnchorOffset(anchor: TextAnchor, radius: number): Point {
  const diagonal = radius / Math.SQRT2
  let x = 0
  let y = 0
  if (anchor === 'top-left' || anchor === 'top-right') y = diagonal
  else if (anchor === 'bottom-left' || anchor === 'bottom-right') y = -diagonal
  else if (anchor === 'top') y = radius
  else if (anchor === 'bottom') y = -radius
  if (anchor === 'top-left' || anchor === 'bottom-left') x = diagonal
  else if (anchor === 'top-right' || anchor === 'bottom-right') x = -diagonal
  else if (anchor === 'left') x = radius
  else if (anchor === 'right') x = -radius
  return { x, y }
}

/** MapLibre's `text-offset` with variable anchors: its size, pointed away from the point along each anchor's sides. */
export function textOffsetForAnchor(anchor: TextAnchor, offset: Point): Point {
  const x = Math.abs(offset.x)
  const y = Math.abs(offset.y)
  return {
    x: anchor.endsWith('left') ? x : anchor.endsWith('right') ? -x : 0,
    y: anchor.startsWith('top') ? y : anchor.startsWith('bottom') ? -y : 0,
  }
}
