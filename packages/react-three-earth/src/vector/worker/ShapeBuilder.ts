import earcut from 'earcut'

import type { Rgba } from './styleLayers.js'
import type { DrawGroup, PatternRectangle, ShapeMesh } from './types.js'

export interface Point {
  x: number
  y: number
}

export type LineCap = 'butt' | 'round' | 'square'
/** Which edges of a stroked band fade with `line-blur`: both, or only the outer one of a casing's side. */
type FadingEdges = 'both' | 'left' | 'right'
export type LineJoin = 'miter' | 'bevel' | 'round'

export interface LineStyle {
  /** Full width, in tile units. */
  width: number
  /** Signed offset of the line's centre to the right of its direction, in tile units. Default: 0. */
  offset?: number
  /** Gap in the middle of the line (two lines of `width` either side), in tile units. Default: 0. */
  gapWidth?: number
  cap?: LineCap
  join?: LineJoin
  /** Miter length limit, in multiples of the width, beyond which a miter becomes a bevel. Default: 2. */
  miterLimit?: number
  /** Width of the fade at each edge (`line-blur`), in tile units. Default: 0 (sharp). */
  blurWidth?: number
  /** Alternating dash and gap lengths in tile units. Empty or undefined: solid. */
  dashes?: readonly number[]
  /**
   * Colours the line along its length (`line-gradient`) instead of with the current colour: the line is split into
   * pieces at most `stepUnits` long, and each vertex takes the colour at its distance from the line's start.
   */
  gradient?: LineGradient
}

/** A colour along a line, by distance from its start in tile units. */
export interface LineGradient {
  colorAt(distance: number): Rgba
  /** The longest piece between two colour samples, in tile units. */
  stepUnits: number
}

/**
 * How shapes added after `setPattern` map onto the repeated image, in image pixels. `plane`: fills, at a fixed
 * scale in tile space, with the image pixel at the tile's top-left corner given (for seamless tiles). `line`:
 * along the line and across its width, the image stretched so its height spans the line's width.
 */
export type PatternMapping =
  | { kind: 'plane'; imagePixelsPerUnit: number; originX: number; originY: number }
  | { kind: 'line' }

/** Segments per half turn for round caps, joins and circles. */
const ROUND_SEGMENTS = 8

/** A growable typed array. */
class Growable<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array> {
  array: T
  length = 0
  constructor(protected readonly create: (size: number) => T) {
    this.array = create(1024)
  }
  reserve(count: number): void {
    if (this.length + count <= this.array.length) return
    const next = this.create(Math.max(this.array.length * 2, this.length + count))
    next.set(this.array.subarray(0, this.length))
    this.array = next
  }
  push1(a: number): void {
    this.reserve(1)
    this.array[this.length++] = a
  }
  push2(a: number, b: number): void {
    this.reserve(2)
    this.array[this.length++] = a
    this.array[this.length++] = b
  }
  push3(a: number, b: number, c: number): void {
    this.reserve(3)
    this.array[this.length++] = a
    this.array[this.length++] = b
    this.array[this.length++] = c
  }
  push4(a: number, b: number, c: number, d: number): void {
    this.reserve(4)
    this.array[this.length++] = a
    this.array[this.length++] = b
    this.array[this.length++] = c
    this.array[this.length++] = d
  }
  toArray(): T {
    return this.array.slice(0, this.length) as T
  }
}

/**
 * Accumulates the fill, line and circle triangles of one tile, in draw order, with one colour per vertex.
 * Draw groups record which index ranges belong to which group of style layers.
 */
export class ShapeBuilder {
  protected readonly positions = new Growable(size => new Float32Array(size))
  protected readonly colors = new Growable(size => new Uint8Array(size))
  protected readonly indices = new Growable(size => new Uint32Array(size))
  protected readonly groups: DrawGroup[] = []
  protected color: Rgba = [0, 0, 0, 0]
  /** Created by the first non-zero colour slot; earlier vertices get slot 0. */
  protected colorSlots: Growable<Float32Array> | null = null
  protected colorSlot = 0
  /** Created on the first pattern, then filled for every vertex (zero rectangle: coloured, not patterned). */
  protected patternRectangles: Growable<Uint16Array> | null = null
  protected patternCoordinates: Growable<Float32Array> | null = null
  protected pattern: { rectangle: PatternRectangle; mapping: PatternMapping } | null = null
  /**
   * Created by the first blurred shape, then filled for every vertex: where the vertex sits across its shape (-1 and 1
   * at a line band's edges, 0 at its middle; 0 at a circle's centre, 1 on its rim) and the blur as a share of the
   * shape's half width (0: sharp).
   */
  protected edges: Growable<Float32Array> | null = null
  protected blurShare = 0
  /** The band being stroked: signed distances of its edges right of the line, and which of them fade. */
  protected band: { left: number; right: number; fadingEdges: FadingEdges } = { left: -1, right: 1, fadingEdges: 'both' }
  /** The local frame of the line being stroked with a pattern: image coordinates follow it. */
  protected lineFrame = { originX: 0, originY: 0, directionX: 1, directionY: 0, distance: 0, left: 0, right: 1, acrossScale: 1 }

  get vertexCount(): number {
    return this.positions.length / 2
  }

  /** Starts or continues the draw group of the layers about to be added. */
  setGroup(group: number): void {
    const last = this.groups.at(-1)
    if (last !== undefined && last.group === group) return
    if (last !== undefined) last.count = this.indices.length - last.start
    this.groups.push({ group, start: this.indices.length, count: 0 })
  }

  /** The colour of the vertices about to be added; resets the colour slot to none. */
  setColor(color: Rgba): void {
    this.color = color
    this.colorSlot = 0
  }

  /**
   * A feature colour slot for the vertices about to be added (after `setColor`, whose colour stays as a fallback):
   * the shader reads the colour from the slot table, so a feature-state change only redraws.
   */
  setColorSlot(slot: number): void {
    this.colorSlot = slot
    if (slot !== 0 && this.colorSlots === null) {
      this.colorSlots = new Growable(size => new Float32Array(size))
      this.colorSlots.reserve(this.vertexCount)
      this.colorSlots.length = this.vertexCount
    }
  }

  /**
   * Draws the shapes added next with a pattern image (null: with the colour again). The colour's alpha stays
   * the pattern's opacity.
   */
  setPattern(rectangle: PatternRectangle | null, mapping: PatternMapping = { kind: 'line' }): void {
    if (rectangle === null) {
      this.pattern = null
      return
    }
    if (this.patternRectangles === null) {
      const count = this.vertexCount
      this.patternRectangles = new Growable(size => new Uint16Array(size))
      this.patternCoordinates = new Growable(size => new Float32Array(size))
      this.patternRectangles.reserve(count * 4)
      this.patternCoordinates!.reserve(count * 2)
      this.patternRectangles.length = count * 4 // zero-filled: coloured
      this.patternCoordinates!.length = count * 2
    }
    this.pattern = { rectangle, mapping }
  }

  /** Adds polygons: each is an outer ring followed by its holes. */
  addPolygons(polygons: readonly (readonly (readonly Point[])[])[]): void {
    for (const polygon of polygons) {
      const coordinates: number[] = []
      const holes: number[] = []
      for (const ring of polygon) {
        if (ring.length < 3) continue
        if (coordinates.length > 0) holes.push(coordinates.length / 2)
        for (const point of ring) coordinates.push(point.x, point.y)
      }
      if (coordinates.length < 6) continue
      const first = this.vertexCount
      for (let index = 0; index < coordinates.length; index += 2) this.addVertex(coordinates[index]!, coordinates[index + 1]!)
      const triangles = earcut(coordinates, holes)
      for (let index = 0; index < triangles.length; index += 3) {
        this.indices.push3(first + triangles[index]!, first + triangles[index + 1]!, first + triangles[index + 2]!)
      }
    }
  }

  /** Adds a filled circle, fading over `blurShare` of its radius towards the rim (`circle-blur`). */
  addCircle(center: Point, radius: number, blurShare = 0): void {
    this.useBlur(blurShare)
    const segments = ROUND_SEGMENTS * 2
    const first = this.addVertex(center.x, center.y, 0)
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2
      this.addVertex(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius, 1)
    }
    for (let index = 0; index < segments; index++) this.indices.push3(first, first + 1 + index, first + 1 + ((index + 1) % segments))
    this.useBlur(0)
  }

  /**
   * The across position of a point this far right of the line, in the band being stroked: -1 and 1 at fading edges, 0
   * at a sharp edge (or at the middle when both fade).
   */
  protected edgeAt(distance: number): number {
    const { left, right, fadingEdges } = this.band
    if (fadingEdges === 'right') return (distance - left) / (right - left)
    if (fadingEdges === 'left') return (distance - right) / (right - left)
    return (distance - (left + right) / 2) / ((right - left) / 2)
  }

  /** The blur of the vertices about to be added, as a share of their shape's half width; creates the edges on first use. */
  protected useBlur(share: number): void {
    this.blurShare = share > 0 && Number.isFinite(share) ? share : 0
    if (this.blurShare > 0 && this.edges === null) {
      this.edges = new Growable(size => new Float32Array(size))
      this.edges.reserve(this.vertexCount * 2)
      this.edges.length = this.vertexCount * 2 // zero-filled: sharp
    }
  }

  /** Adds a stroked polyline. Closed rings repeat their first point at the end. */
  addLine(points: readonly Point[], style: LineStyle): void {
    let line = removeDuplicatePoints(points)
    if (line.length < 2 || style.width <= 0) return
    if (style.gradient !== undefined) line = subdivideLine(line, style.gradient.stepUnits)
    const pieces = style.dashes !== undefined && style.dashes.length >= 2 && style.gradient === undefined ? splitIntoDashes(line, style.dashes) : [line]
    const offset = style.offset ?? 0
    const gap = style.gapWidth ?? 0
    for (const dash of pieces) {
      const piece = removeDuplicatePoints(dash)
      if (piece.length < 2) {
        // A zero-length dash (`line-dasharray: [0, 2]` with round caps) is a dot.
        if (piece.length === 1 && dash.length >= 2 && style.cap === 'round') this.addCircle(piece[0]!, style.width / 2, ((style.blurWidth ?? 0) * 2) / style.width)
        continue
      }
      if (gap > 0) {
        // A casing's two sides fade only at their outer edges; the edges along the gap stay sharp.
        this.addStroke(piece, offset + gap / 2, offset + gap / 2 + style.width, style, 'right')
        this.addStroke(piece, offset - gap / 2 - style.width, offset - gap / 2, style, 'left')
      } else this.addStroke(piece, offset - style.width / 2, offset + style.width / 2, style)
    }
  }

  build(): ShapeMesh | null {
    if (this.indices.length === 0) return null
    const last = this.groups.at(-1)
    if (last !== undefined) last.count = this.indices.length - last.start
    return {
      positions: this.positions.toArray(),
      colors: this.colors.toArray(),
      colorSlots: this.colorSlots?.toArray() ?? null,
      indices: this.indices.toArray(),
      groups: this.groups.filter(group => group.count > 0),
      patterns: this.patternRectangles?.toArray() ?? null,
      patternCoordinates: this.patternCoordinates?.toArray() ?? null,
      edges: this.edges?.toArray() ?? null,
    }
  }

  /** Adds a vertex; `edge` is where it sits across its shape (see `edges`), read only by blurred shapes. */
  protected addVertex(x: number, y: number, edge = 0): number {
    const [r, g, b, a] = this.color
    this.positions.push2(x, y)
    this.colors.push4(r, g, b, a)
    this.colorSlots?.push1(this.colorSlot)
    this.edges?.push2(edge, this.blurShare)
    if (this.patternRectangles !== null) this.addPatternVertex(x, y)
    return this.vertexCount - 1
  }

  protected addPatternVertex(x: number, y: number): void {
    const pattern = this.pattern
    if (pattern === null) {
      this.patternRectangles!.push4(0, 0, 0, 0)
      this.patternCoordinates!.push2(0, 0)
      return
    }
    const { rectangle, mapping } = pattern
    this.patternRectangles!.push4(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    if (mapping.kind === 'plane') {
      this.patternCoordinates!.push2(mapping.originX + x * mapping.imagePixelsPerUnit, mapping.originY + y * mapping.imagePixelsPerUnit)
      return
    }
    // Along the line from its start, and across from its left edge, in image pixels (height = line width).
    const frame = this.lineFrame
    const dx = x - frame.originX
    const dy = y - frame.originY
    const along = frame.distance + dx * frame.directionX + dy * frame.directionY
    const across = (dx * -frame.directionY + dy * frame.directionX) / frame.acrossScale
    const imagePixelsPerUnit = rectangle.height / (frame.right - frame.left)
    this.patternCoordinates!.push2(along * imagePixelsPerUnit, (across - frame.left) * imagePixelsPerUnit)
  }

  /** Sets the frame line vertices added next map through: an origin on the line, its direction, distance so far. */
  protected setLineFrame(originX: number, originY: number, normal: Point, distance: number, acrossScale = 1): void {
    const frame = this.lineFrame
    frame.originX = originX
    frame.originY = originY
    // Normals point right of the direction in y-down space: direction = (normal.y, -normal.x).
    frame.directionX = normal.y
    frame.directionY = -normal.x
    frame.distance = distance
    frame.acrossScale = acrossScale
  }

  /**
   * Strokes the band between two signed distances right of the line (`left < right`). Joins are mitred
   * where the miter stays within the limit, beveled or rounded otherwise.
   */
  protected addStroke(line: readonly Point[], left: number, right: number, style: LineStyle, fadingEdges: FadingEdges = 'both'): void {
    const halfWidth = (right - left) / 2
    const center = (left + right) / 2
    this.band.left = left
    this.band.right = right
    this.band.fadingEdges = fadingEdges
    // One fading edge: the across position runs over the whole width, so the blur is a share of it.
    this.useBlur((style.blurWidth ?? 0) / (fadingEdges === 'both' ? halfWidth : right - left))
    const leftEdge = this.edgeAt(left)
    const rightEdge = this.edgeAt(right)
    const join = style.join ?? 'miter'
    const miterLimit = style.miterLimit ?? 2
    const closed = line.length > 2 && line[0]!.x === line.at(-1)!.x && line[0]!.y === line.at(-1)!.y
    const count = line.length

    // Unit normals (to the right in y-down tile space) of each segment.
    const normals: Point[] = []
    for (let index = 0; index < count - 1; index++) normals.push(segmentNormal(line[index]!, line[index + 1]!))
    // Distance along the line at each point, for patterns and gradients.
    const patterned = this.pattern?.mapping.kind === 'line'
    const gradient = style.gradient
    const along = patterned || gradient !== undefined ? cumulativeDistances(line) : null
    const distances = patterned ? along : null
    if (patterned) {
      this.lineFrame.left = left
      this.lineFrame.right = right
    }

    let previousLeft = -1
    let previousRight = -1
    for (let index = 0; index < count; index++) {
      const point = line[index]!
      const incoming = index > 0 ? normals[index - 1]! : closed ? normals[count - 2]! : null
      const outgoing = index < count - 1 ? normals[index]! : closed ? normals[0]! : null
      const isEndpoint = incoming === null || outgoing === null
      if (gradient !== undefined) this.color = gradient.colorAt(along![index]!)

      if (isEndpoint) {
        const normal = (incoming ?? outgoing)!
        if (distances !== null) this.setLineFrame(point.x, point.y, normal, distances[index]!)
        const leftVertex = this.addVertex(point.x + normal.x * left, point.y + normal.y * left, leftEdge)
        const rightVertex = this.addVertex(point.x + normal.x * right, point.y + normal.y * right, rightEdge)
        if (previousLeft !== -1) this.addQuad(previousLeft, previousRight, leftVertex, rightVertex)
        this.addCap(point, normal, center, halfWidth, style.cap ?? 'butt', incoming === null)
        previousLeft = leftVertex
        previousRight = rightVertex
        continue
      }

      // Miter direction: the bisector of the two normals, scaled so the band keeps its width.
      const bisector = { x: incoming.x + outgoing.x, y: incoming.y + outgoing.y }
      const bisectorLength = Math.hypot(bisector.x, bisector.y)
      const cosine = bisectorLength / 2 // cos of half the turn angle
      const miterScale = bisectorLength > 1e-6 ? 1 / cosine : Infinity
      if (join === 'miter' ? miterScale <= miterLimit : miterScale <= 1.05) {
        const miter = { x: (bisector.x / bisectorLength) * miterScale, y: (bisector.y / bisectorLength) * miterScale }
        // The mitre points along the normals' bisector: the frame of the mean direction, stretched by the mitre.
        if (distances !== null) this.setLineFrame(point.x, point.y, { x: bisector.x / bisectorLength, y: bisector.y / bisectorLength }, distances[index]!, miterScale)
        const leftVertex = this.addVertex(point.x + miter.x * left, point.y + miter.y * left, leftEdge)
        const rightVertex = this.addVertex(point.x + miter.x * right, point.y + miter.y * right, rightEdge)
        if (previousLeft !== -1) this.addQuad(previousLeft, previousRight, leftVertex, rightVertex)
        previousLeft = leftVertex
        previousRight = rightVertex
        continue
      }

      // Bevel or round: end the incoming segment, start the outgoing one, and fill the wedge between them on
      // the outer side only (the inner side is covered by both segments), around the line's own vertex.
      if (distances !== null) this.setLineFrame(point.x, point.y, incoming, distances[index]!)
      const endLeft = this.addVertex(point.x + incoming.x * left, point.y + incoming.y * left, leftEdge)
      const endRight = this.addVertex(point.x + incoming.x * right, point.y + incoming.y * right, rightEdge)
      if (previousLeft !== -1) this.addQuad(previousLeft, previousRight, endLeft, endRight)
      if (distances !== null) this.setLineFrame(point.x, point.y, outgoing, distances[index]!)
      const startLeft = this.addVertex(point.x + outgoing.x * left, point.y + outgoing.y * left, leftEdge)
      const startRight = this.addVertex(point.x + outgoing.x * right, point.y + outgoing.y * right, rightEdge)
      this.addJoinWedge(point, left, right, incoming, outgoing, join === 'round')
      previousLeft = startLeft
      previousRight = startRight
    }
    this.useBlur(0)
  }

  protected addQuad(fromLeft: number, fromRight: number, toLeft: number, toRight: number): void {
    this.indices.push3(fromLeft, fromRight, toRight)
    this.indices.push3(fromLeft, toRight, toLeft)
  }

  /** A round or square cap at a line end; `isStart` caps point backwards. */
  protected addCap(point: Point, normal: Point, center: number, halfWidth: number, cap: LineCap, isStart: boolean): void {
    if (cap === 'butt') return
    const direction = isStart ? { x: -normal.y, y: normal.x } : { x: normal.y, y: -normal.x } // along the line, outwards
    const base = { x: point.x + normal.x * center, y: point.y + normal.y * center }
    if (cap === 'square') {
      const leftEdge = this.edgeAt(center - halfWidth)
      const rightEdge = this.edgeAt(center + halfWidth)
      const a = this.addVertex(base.x - normal.x * halfWidth, base.y - normal.y * halfWidth, leftEdge)
      const b = this.addVertex(base.x + normal.x * halfWidth, base.y + normal.y * halfWidth, rightEdge)
      const c = this.addVertex(base.x + normal.x * halfWidth + direction.x * halfWidth, base.y + normal.y * halfWidth + direction.y * halfWidth, rightEdge)
      const d = this.addVertex(base.x - normal.x * halfWidth + direction.x * halfWidth, base.y - normal.y * halfWidth + direction.y * halfWidth, leftEdge)
      this.indices.push3(a, b, c)
      this.indices.push3(a, c, d)
      return
    }
    // Fades radially from the band's middle (a casing side's round cap fades all round, as its outer edge does).
    const pivot = this.addVertex(base.x, base.y, this.edgeAt(center))
    const start = Math.atan2(normal.y, normal.x)
    const sweep = isStart ? Math.PI : -Math.PI
    let previous = this.addVertex(base.x + normal.x * halfWidth, base.y + normal.y * halfWidth, 1)
    for (let step = 1; step <= ROUND_SEGMENTS; step++) {
      const angle = start + (sweep * step) / ROUND_SEGMENTS
      const next = this.addVertex(base.x + Math.cos(angle) * halfWidth, base.y + Math.sin(angle) * halfWidth, 1)
      this.indices.push3(pivot, previous, next)
      previous = next
    }
  }

  /**
   * Fills a join's outer wedge: the part of the band [left, right] on the side away from the turn, swept from
   * the incoming normal to the outgoing one around the vertex, as a bevel (one quad) or round (an arc).
   */
  protected addJoinWedge(point: Point, left: number, right: number, incoming: Point, outgoing: Point, round: boolean): void {
    // The line turns towards +normal when the outgoing direction leans that way; the outer side is then -normal.
    const outgoingDirection = { x: outgoing.y, y: -outgoing.x }
    const side = outgoingDirection.x * incoming.x + outgoingDirection.y * incoming.y > 0 ? -1 : 1
    const outerRadius = Math.max(side * left, side * right)
    if (outerRadius <= 0) return
    const innerRadius = Math.max(0, Math.min(side * left, side * right))
    const from = Math.atan2(incoming.y * side, incoming.x * side)
    let turn = Math.atan2(outgoing.y * side, outgoing.x * side) - from
    if (turn > Math.PI) turn -= Math.PI * 2
    if (turn < -Math.PI) turn += Math.PI * 2
    const steps = round ? Math.max(1, Math.ceil((Math.abs(turn) / Math.PI) * ROUND_SEGMENTS)) : 1
    // Across the band: from the ring's signed distance right of the line.
    const ring = (radius: number, angle: number) => this.addVertex(point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius, this.edgeAt(side * radius))
    let previousInner = ring(innerRadius, from)
    let previousOuter = ring(outerRadius, from)
    for (let step = 1; step <= steps; step++) {
      const angle = from + (turn * step) / steps
      const inner = ring(innerRadius, angle)
      const outer = ring(outerRadius, angle)
      this.indices.push3(previousInner, previousOuter, outer)
      if (innerRadius > 0) this.indices.push3(previousInner, outer, inner)
      previousInner = inner
      previousOuter = outer
    }
  }
}

/** Inserts points so that no segment is longer than `step` (a gradient is sampled at every point). */
export function subdivideLine(line: readonly Point[], step: number): Point[] {
  if (!(step > 0)) return line.slice()
  const result: Point[] = [line[0]!]
  for (let index = 1; index < line.length; index++) {
    const from = line[index - 1]!
    const to = line[index]!
    const pieces = Math.min(1024, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step))
    for (let piece = 1; piece < pieces; piece++) result.push({ x: from.x + ((to.x - from.x) * piece) / pieces, y: from.y + ((to.y - from.y) * piece) / pieces })
    result.push(to)
  }
  return result
}

function cumulativeDistances(line: readonly Point[]): number[] {
  const distances = [0]
  for (let index = 1; index < line.length; index++) {
    distances.push(distances[index - 1]! + Math.hypot(line[index]!.x - line[index - 1]!.x, line[index]!.y - line[index - 1]!.y))
  }
  return distances
}

function segmentNormal(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  return { x: -dy / length, y: dx / length }
}

function removeDuplicatePoints(points: readonly Point[]): Point[] {
  const result: Point[] = []
  for (const point of points) {
    const last = result.at(-1)
    if (last === undefined || last.x !== point.x || last.y !== point.y) result.push(point)
  }
  return result
}

/** Splits a polyline into its dashes. `pattern` alternates dash and gap lengths, in tile units. */
export function splitIntoDashes(line: readonly Point[], pattern: readonly number[]): Point[][] {
  const total = pattern.reduce((sum, length) => sum + length, 0)
  if (!(total > 0)) return [line.slice()]
  const dashes: Point[][] = []
  let patternIndex = 0
  let remaining = pattern[0]!
  let on = true
  let current: Point[] = [line[0]!]
  for (let index = 0; index < line.length - 1; index++) {
    const from = line[index]!
    const to = line[index + 1]!
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    let travelled = 0
    while (length - travelled > remaining) {
      travelled += remaining
      const t = travelled / length
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      if (on) {
        current.push(point)
        if (current.length >= 2) dashes.push(current)
      }
      current = [point]
      on = !on
      patternIndex = (patternIndex + 1) % pattern.length
      remaining = pattern[patternIndex]!
    }
    remaining -= length - travelled
    if (on) current.push(to)
    else current = [to]
  }
  if (on && current.length >= 2) dashes.push(current)
  return dashes
}
