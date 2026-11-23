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
}

/** A glyph positioned in pixels of a 24 px font, relative to the label anchor (y down). */
export interface ShapedGlyph {
  glyph: AtlasGlyph
  /** Top-left of the padded glyph bitmap. */
  x: number
  y: number
  scale: number
  /** Horizontal centre of the glyph's advance, for placing glyphs along a line. */
  centerX: number
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
  }
  const spacing = options.letterSpacingEms * GLYPH_FONT_SIZE
  const characters: Character[] = []
  for (const section of sections) {
    for (const character of section.text) {
      const codePoint = character.codePointAt(0)!
      const glyph = getGlyph(section.fontStack, codePoint)
      characters.push({ codePoint, section, glyph, advance: glyph === null ? 0 : glyph.advance * section.scale + spacing })
    }
  }

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
  const trimmed = lines.map(items => trimSpaces(items))
  if (trimmed.every(items => items.length === 0)) return null

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
    for (const { glyph, section, advance } of items) {
      if (glyph !== null && glyph.width > 0) {
        glyphs.push({
          glyph,
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
  const quads = shaped.glyphs.map(({ glyph, x, y, scale }) => {
    const width = (glyph.width + GLYPH_BUFFER * 2) * scale
    const height = (glyph.height + GLYPH_BUFFER * 2) * scale
    return { glyph, corners: [transform(x, y), transform(x + width, y), transform(x + width, y + height), transform(x, y + height)] } as GlyphQuad
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
