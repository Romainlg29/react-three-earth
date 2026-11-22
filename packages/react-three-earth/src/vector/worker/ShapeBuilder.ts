import earcut from 'earcut'

import type { Rgba } from './styleLayers.js'
import type { DrawGroup, ShapeMesh } from './types.js'

export interface Point {
  x: number
  y: number
}

export type LineCap = 'butt' | 'round' | 'square'
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
  /** Alternating dash and gap lengths in tile units. Empty or undefined: solid. */
  dashes?: readonly number[]
}

/** Segments per half turn for round caps, joins and circles. */
const ROUND_SEGMENTS = 8

/** A growable typed array. */
class Growable<T extends Float32Array | Uint8Array | Uint32Array> {
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

  setColor(color: Rgba): void {
    this.color = color
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

  /** Adds a filled circle. */
  addCircle(center: Point, radius: number): void {
    const segments = ROUND_SEGMENTS * 2
    const first = this.addVertex(center.x, center.y)
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2
      this.addVertex(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius)
    }
    for (let index = 0; index < segments; index++) this.indices.push3(first, first + 1 + index, first + 1 + ((index + 1) % segments))
  }

  /** Adds a stroked polyline. Closed rings repeat their first point at the end. */
  addLine(points: readonly Point[], style: LineStyle): void {
    const line = removeDuplicatePoints(points)
    if (line.length < 2 || style.width <= 0) return
    const pieces = style.dashes !== undefined && style.dashes.length >= 2 ? splitIntoDashes(line, style.dashes) : [line]
    const offset = style.offset ?? 0
    const gap = style.gapWidth ?? 0
    for (const dash of pieces) {
      const piece = removeDuplicatePoints(dash)
      if (piece.length < 2) continue
      if (gap > 0) {
        this.addStroke(piece, offset + gap / 2, offset + gap / 2 + style.width, style)
        this.addStroke(piece, offset - gap / 2 - style.width, offset - gap / 2, style)
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
      indices: this.indices.toArray(),
      groups: this.groups.filter(group => group.count > 0),
    }
  }

  protected addVertex(x: number, y: number): number {
    const [r, g, b, a] = this.color
    this.positions.push2(x, y)
    this.colors.push4(r, g, b, a)
    return this.vertexCount - 1
  }

  /**
   * Strokes the band between two signed distances right of the line (`left < right`). Joins are mitred
   * where the miter stays within the limit, beveled or rounded otherwise.
   */
  protected addStroke(line: readonly Point[], left: number, right: number, style: LineStyle): void {
    const halfWidth = (right - left) / 2
    const center = (left + right) / 2
    const join = style.join ?? 'miter'
    const miterLimit = style.miterLimit ?? 2
    const closed = line.length > 2 && line[0]!.x === line.at(-1)!.x && line[0]!.y === line.at(-1)!.y
    const count = line.length

    // Unit normals (to the right in y-down tile space) of each segment.
    const normals: Point[] = []
    for (let index = 0; index < count - 1; index++) normals.push(segmentNormal(line[index]!, line[index + 1]!))

    let previousLeft = -1
    let previousRight = -1
    for (let index = 0; index < count; index++) {
      const point = line[index]!
      const incoming = index > 0 ? normals[index - 1]! : closed ? normals[count - 2]! : null
      const outgoing = index < count - 1 ? normals[index]! : closed ? normals[0]! : null
      const isEndpoint = incoming === null || outgoing === null

      if (isEndpoint) {
        const normal = (incoming ?? outgoing)!
        const leftVertex = this.addVertex(point.x + normal.x * left, point.y + normal.y * left)
        const rightVertex = this.addVertex(point.x + normal.x * right, point.y + normal.y * right)
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
        const leftVertex = this.addVertex(point.x + miter.x * left, point.y + miter.y * left)
        const rightVertex = this.addVertex(point.x + miter.x * right, point.y + miter.y * right)
        if (previousLeft !== -1) this.addQuad(previousLeft, previousRight, leftVertex, rightVertex)
        previousLeft = leftVertex
        previousRight = rightVertex
        continue
      }

      // Bevel or round: end the incoming segment, fill the outer wedge, start the outgoing one.
      const endLeft = this.addVertex(point.x + incoming.x * left, point.y + incoming.y * left)
      const endRight = this.addVertex(point.x + incoming.x * right, point.y + incoming.y * right)
      if (previousLeft !== -1) this.addQuad(previousLeft, previousRight, endLeft, endRight)
      const startLeft = this.addVertex(point.x + outgoing.x * left, point.y + outgoing.y * left)
      const startRight = this.addVertex(point.x + outgoing.x * right, point.y + outgoing.y * right)
      const pivot = this.addVertex(point.x + incoming.x * center, point.y + incoming.y * center)
      if (join === 'round') this.addFan(point, center, halfWidth, incoming, outgoing, pivot)
      else {
        this.indices.push3(pivot, endLeft, startLeft)
        this.indices.push3(pivot, endRight, startRight)
      }
      previousLeft = startLeft
      previousRight = startRight
    }
  }

  protected addQuad(fromLeft: number, fromRight: number, toLeft: number, toRight: number): void {
    this.indices.push3(fromLeft, fromRight, toRight)
    this.indices.push3(fromLeft, toRight, toLeft)
  }

  /** A round or square cap at a line end; `isStart` caps point backwards. */
  protected addCap(point: Point, normal: Point, center: number, halfWidth: number, cap: LineCap, isStart: boolean): void {
    if (cap === 'butt') return
    const direction = isStart ? { x: normal.y, y: -normal.x } : { x: -normal.y, y: normal.x } // along the line, outwards
    const base = { x: point.x + normal.x * center, y: point.y + normal.y * center }
    if (cap === 'square') {
      const a = this.addVertex(base.x - normal.x * halfWidth, base.y - normal.y * halfWidth)
      const b = this.addVertex(base.x + normal.x * halfWidth, base.y + normal.y * halfWidth)
      const c = this.addVertex(base.x + normal.x * halfWidth + direction.x * halfWidth, base.y + normal.y * halfWidth + direction.y * halfWidth)
      const d = this.addVertex(base.x - normal.x * halfWidth + direction.x * halfWidth, base.y - normal.y * halfWidth + direction.y * halfWidth)
      this.indices.push3(a, b, c)
      this.indices.push3(a, c, d)
      return
    }
    const pivot = this.addVertex(base.x, base.y)
    const start = Math.atan2(normal.y, normal.x)
    const sweep = isStart ? Math.PI : -Math.PI
    let previous = this.addVertex(base.x + normal.x * halfWidth, base.y + normal.y * halfWidth)
    for (let step = 1; step <= ROUND_SEGMENTS; step++) {
      const angle = start + (sweep * step) / ROUND_SEGMENTS
      const next = this.addVertex(base.x + Math.cos(angle) * halfWidth, base.y + Math.sin(angle) * halfWidth)
      this.indices.push3(pivot, previous, next)
      previous = next
    }
  }

  /** A round join: a fan around the band centre from the incoming to the outgoing normal, on the outer side. */
  protected addFan(point: Point, center: number, halfWidth: number, incoming: Point, outgoing: Point, pivot: number): void {
    const base = { x: point.x + incoming.x * center, y: point.y + incoming.y * center }
    const from = Math.atan2(incoming.y, incoming.x)
    let turn = Math.atan2(outgoing.y, outgoing.x) - from
    if (turn > Math.PI) turn -= Math.PI * 2
    if (turn < -Math.PI) turn += Math.PI * 2
    // Fan both sides: the inner side is covered by the segments anyway.
    for (const side of [1, -1]) {
      const steps = Math.max(1, Math.ceil((Math.abs(turn) / Math.PI) * ROUND_SEGMENTS))
      let previous = this.addVertex(base.x + Math.cos(from) * halfWidth * side, base.y + Math.sin(from) * halfWidth * side)
      for (let step = 1; step <= steps; step++) {
        const angle = from + (turn * step) / steps
        const next = this.addVertex(base.x + Math.cos(angle) * halfWidth * side, base.y + Math.sin(angle) * halfWidth * side)
        this.indices.push3(pivot, previous, next)
        previous = next
      }
    }
  }
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
