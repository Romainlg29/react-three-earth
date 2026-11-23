/**
 * Hit-testing for `queryRenderedFeatures`: which features of a vector tile a point or polygon touches, as drawn.
 * Worker-safe: no three.js. Coordinates are tile units (0 to `TILE_EXTENT` across the tile, y down).
 */
import { classifyRings } from '@maplibre/maplibre-gl-style-spec'

import type { Box } from './labels.js'
import type { Point } from './ShapeBuilder.js'
import type { VectorTileLayerLike, VectorTileLike } from './tileProviders.js'
import type { CompiledStyleLayer, StyleFeature } from './styleLayers.js'
import { TILE_EXTENT, type FeatureState } from './types.js'

/** Grid cells per side of a tile's feature index. */
const GRID_SIZE = 16
/** Features in a tile's buffer lie outside 0 to `TILE_EXTENT`: the grid covers the buffer too. */
const GRID_MARGIN = TILE_EXTENT / 8
const CELL_SIZE = (TILE_EXTENT + 2 * GRID_MARGIN) / GRID_SIZE

/**
 * Line and circle candidates are looked up this far around the query, in map pixels: a half width or radius
 * larger than this (data-driven, so not known before the feature is read) can be missed near its edge.
 */
export const MAXIMUM_QUERY_RADIUS_PIXELS = 128

/** The query: one point, or a polygon ring (not closed), in tile units. */
export type QueryGeometry = readonly Point[]

/**
 * Feature bounding boxes of one source layer, bucketed in a grid, so a query reads only the features near it.
 * Built once per tile and source layer on first query, from `feature.bbox()` (no point arrays allocated).
 */
export class TileFeatureIndex {
  protected readonly cells: number[][] = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => [])
  protected readonly marks: Uint32Array
  protected queryCount = 0

  constructor(layer: VectorTileLayerLike) {
    const factor = TILE_EXTENT / layer.extent
    this.marks = new Uint32Array(layer.length)
    for (let index = 0; index < layer.length; index++) {
      const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = layer.feature(index).bbox()
      this.forEachCell(minimumX * factor, minimumY * factor, maximumX * factor, maximumY * factor, cell => cell.push(index))
    }
  }

  /** Indices of the features whose boxes may touch the rectangle, highest index (drawn last, on top) first. */
  query(minimumX: number, minimumY: number, maximumX: number, maximumY: number): number[] {
    const found: number[] = []
    const mark = ++this.queryCount
    this.forEachCell(minimumX, minimumY, maximumX, maximumY, cell => {
      for (const index of cell) {
        if (this.marks[index] === mark) continue
        this.marks[index] = mark
        found.push(index)
      }
    })
    return found.sort((a, b) => b - a)
  }

  protected forEachCell(minimumX: number, minimumY: number, maximumX: number, maximumY: number, visit: (cell: number[]) => void): void {
    const toCell = (value: number) => Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((value + GRID_MARGIN) / CELL_SIZE)))
    const fromColumn = toCell(minimumX)
    const toColumn = toCell(maximumX)
    const fromRow = toCell(minimumY)
    const toRow = toCell(maximumY)
    for (let row = fromRow; row <= toRow; row++) for (let column = fromColumn; column <= toColumn; column++) visit(this.cells[row * GRID_SIZE + column]!)
  }
}

/** Feature indices by tile, kept as long as the worker keeps the decoded tile. */
const indices = new WeakMap<VectorTileLike, Map<string, TileFeatureIndex>>()

/** The feature index of a tile's source layer, built on first use. */
export function getTileFeatureIndex(tile: VectorTileLike, sourceLayer: string): TileFeatureIndex | null {
  const layer = tile.layers[sourceLayer]
  if (layer === undefined) return null
  let byLayer = indices.get(tile)
  if (byLayer === undefined) indices.set(tile, (byLayer = new Map()))
  let index = byLayer.get(sourceLayer)
  if (index === undefined) byLayer.set(sourceLayer, (index = new TileFeatureIndex(layer)))
  return index
}

/** What a hit test knows about the feature and the tile it is drawn in. */
export interface HitTestInput {
  layer: CompiledStyleLayer
  feature: StyleFeature
  state: FeatureState
  /** MVT geometry type: 1 point, 2 line, 3 polygon. */
  type: number
  /** In tile units. */
  geometry: Point[][]
  query: QueryGeometry
  zoom: number
  unitsPerPixel: number
  toleranceUnits: number
}

/**
 * Hit tests by style layer type: whether the feature, as that layer draws it, touches the query. A registry rather
 * than a `switch`, so custom layer types can add theirs. Only the layer types listed here can be queried.
 */
export const featureHitTesters = new Map<string, (input: HitTestInput) => boolean>([
  ['fill', hitTestFill],
  ['fill-extrusion', hitTestFill],
  ['line', hitTestLine],
  ['circle', hitTestCircle],
])

function hitTestFill({ type, geometry, query, toleranceUnits }: HitTestInput): boolean {
  if (type !== 3) return false
  return polygonIntersectsRings(query, geometry, toleranceUnits)
}

function hitTestLine({ layer, feature, state, type, geometry, query, zoom, unitsPerPixel, toleranceUnits }: HitTestInput): boolean {
  if (type !== 2 && type !== 3) return false
  const width = layer.evaluate<number>('paint', 'line-width', zoom, feature, state)
  if (width <= 0) return false
  const gap = layer.evaluate<number>('paint', 'line-gap-width', zoom, feature, state)
  // Hairlines draw one pixel wide (see `addShape`); a gap line is its two sides and the gap between them.
  const drawnWidth = Math.max(width, 1)
  const halfWidthPixels = gap > 0 ? gap / 2 + drawnWidth : drawnWidth / 2
  const offsetPixels = layer.evaluate<number>('paint', 'line-offset', zoom, feature, state)
  const lines = offsetPixels === 0 ? geometry : geometry.map(line => offsetLine(line, offsetPixels * unitsPerPixel))
  return polygonIntersectsBufferedLines(query, lines, halfWidthPixels * unitsPerPixel + toleranceUnits)
}

function hitTestCircle({ layer, feature, state, type, geometry, query, zoom, unitsPerPixel, toleranceUnits }: HitTestInput): boolean {
  if (type !== 1) return false
  const radius = layer.evaluate<number>('paint', 'circle-radius', zoom, feature, state)
  const stroke = layer.evaluate<number>('paint', 'circle-stroke-width', zoom, feature, state)
  const reach = (radius + Math.max(stroke, 0)) * unitsPerPixel + toleranceUnits
  for (const ring of geometry) for (const point of ring) if (polygonIntersectsBufferedPoint(query, point, reach)) return true
  return false
}

/** Whether the query touches a placed label: any of its boxes, widened by the tolerance. */
export function polygonIntersectsBoxes(query: QueryGeometry, boxes: readonly Box[], toleranceUnits: number): boolean {
  for (const box of boxes) {
    const minimumX = box.minimumX - toleranceUnits
    const minimumY = box.minimumY - toleranceUnits
    const maximumX = box.maximumX + toleranceUnits
    const maximumY = box.maximumY + toleranceUnits
    const ring = [
      { x: minimumX, y: minimumY },
      { x: maximumX, y: minimumY },
      { x: maximumX, y: maximumY },
      { x: minimumX, y: maximumY },
    ]
    if (polygonsIntersect(query, ring)) return true
  }
  return false
}

/**
 * Whether the query touches polygons given as MVT rings (outer rings and holes): a query point inside (even-odd,
 * so holes are holes), a ring vertex inside the query polygon, crossing edges, or an edge within the tolerance.
 */
export function polygonIntersectsRings(query: QueryGeometry, rings: readonly Point[][], toleranceUnits = 0): boolean {
  for (const polygon of classifyRings(rings as never, 0) as unknown as Point[][][]) {
    if (query.some(point => pointInRings(point, polygon))) return true
    for (const ring of polygon) {
      if (query.length >= 3 && ring.some(point => pointInRing(point, query))) return true
      if (lineIntersectsQuery(ring, query, toleranceUnits, true)) return true
    }
  }
  return false
}

/** Whether the query touches lines widened by `radius` on each side. */
export function polygonIntersectsBufferedLines(query: QueryGeometry, lines: readonly Point[][], radius: number): boolean {
  for (const line of lines) {
    if (query.length >= 3 && line.some(point => pointInRing(point, query))) return true
    if (lineIntersectsQuery(line, query, radius, false)) return true
  }
  return false
}

/** Whether the query touches a disc. */
export function polygonIntersectsBufferedPoint(query: QueryGeometry, point: Point, radius: number): boolean {
  if (query.length >= 3 && pointInRing(point, query)) return true
  const radiusSquared = radius * radius
  if (query.length === 1) return distanceSquared(point, query[0]!) <= radiusSquared
  for (let index = 0; index < query.length; index++) {
    if (pointToSegmentDistanceSquared(point, query[index]!, query[(index + 1) % query.length]!) <= radiusSquared) return true
  }
  return false
}

/** Two polygons (or a point and a polygon) overlap. */
export function polygonsIntersect(a: QueryGeometry, b: readonly Point[]): boolean {
  if (a.some(point => b.length >= 3 && pointInRing(point, b))) return true
  if (a.length >= 3 && b.some(point => pointInRing(point, a))) return true
  return lineIntersectsQuery(b, a, 0, true)
}

/** Whether a line (closed when `closed`) comes within `radius` of the query: its point, or its polygon's edges. */
function lineIntersectsQuery(line: readonly Point[], query: QueryGeometry, radius: number, closed: boolean): boolean {
  const radiusSquared = radius * radius
  const segments = closed ? line.length : line.length - 1
  if (line.length === 1) return polygonIntersectsBufferedPoint(query, line[0]!, radius)
  for (let index = 0; index < segments; index++) {
    const a = line[index]!
    const b = line[(index + 1) % line.length]!
    if (query.length === 1) {
      if (pointToSegmentDistanceSquared(query[0]!, a, b) <= radiusSquared) return true
      continue
    }
    for (let edge = 0; edge < query.length; edge++) {
      const c = query[edge]!
      const d = query[(edge + 1) % query.length]!
      if (segmentsIntersect(a, b, c, d)) return true
      if (radius > 0 && segmentToSegmentDistanceSquared(a, b, c, d) <= radiusSquared) return true
    }
  }
  return false
}

/** Even-odd test over every ring of a polygon, so a point in a hole is outside. */
export function pointInRings(point: Point, rings: readonly Point[][]): boolean {
  let inside = false
  for (const ring of rings) if (pointInRing(point, ring)) inside = !inside
  return inside
}

export function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!
    const b = ring[previous]!
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function distanceSquared(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function pointToSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2
}

function segmentToSegmentDistanceSquared(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(pointToSegmentDistanceSquared(a, c, d), pointToSegmentDistanceSquared(b, c, d), pointToSegmentDistanceSquared(c, a, b), pointToSegmentDistanceSquared(d, a, b))
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  const onSegment = (p: Point, q: Point, r: Point) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y)
  return (d1 === 0 && onSegment(c, d, a)) || (d2 === 0 && onSegment(c, d, b)) || (d3 === 0 && onSegment(a, b, c)) || (d4 === 0 && onSegment(a, b, d))
}

/**
 * The line shifted sideways by `offset` (positive: to the right of its direction, as `line-offset`), with mitred
 * corners, as MapLibre's query code does.
 */
export function offsetLine(line: readonly Point[], offset: number): Point[] {
  const result: Point[] = []
  for (let index = 0; index < line.length; index++) {
    const point = line[index]!
    const previous = line[index - 1]
    const next = line[index + 1]
    const normal = (a: Point, b: Point) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy) || 1
      // Right of the direction, with y down
      return { x: -dy / length, y: dx / length }
    }
    const before = previous === undefined ? null : normal(previous, point)
    const after = next === undefined ? null : normal(point, next)
    let x = (before?.x ?? 0) + (after?.x ?? 0)
    let y = (before?.y ?? 0) + (after?.y ?? 0)
    const length = Math.hypot(x, y)
    if (length === 0) {
      result.push({ ...point })
      continue
    }
    x /= length
    y /= length
    // Mitre: the offset along the averaged normal that keeps both sides `offset` away.
    const cosine = before === null || after === null ? 1 : Math.max(0.1, x * before.x + y * before.y)
    result.push({ x: point.x + (x * offset) / cosine, y: point.y + (y * offset) / cosine })
  }
  return result
}

/**
 * Clips a query polygon to the tile square (Sutherland–Hodgman): a tile draws nothing outside it, so its buffer
 * features must not answer for what a neighbour draws. A point is kept or dropped (edges belong to the tile right
 * and below).
 */
export function clipQueryToTile(query: QueryGeometry): Point[] {
  if (query.length === 1) {
    const [point] = query
    // Half-open, so a point on an edge belongs to one tile only
    return point!.x >= 0 && point!.x < TILE_EXTENT && point!.y >= 0 && point!.y < TILE_EXTENT ? [point!] : []
  }
  let output: Point[] = [...query]
  const edges: Array<[(point: Point) => boolean, (a: Point, b: Point) => Point]> = [
    [point => point.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [point => point.x <= TILE_EXTENT, (a, b) => ({ x: TILE_EXTENT, y: a.y + ((b.y - a.y) * (TILE_EXTENT - a.x)) / (b.x - a.x) })],
    [point => point.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [point => point.y <= TILE_EXTENT, (a, b) => ({ x: a.x + ((b.x - a.x) * (TILE_EXTENT - a.y)) / (b.y - a.y), y: TILE_EXTENT })],
  ]
  for (const [inside, intersect] of edges) {
    const input = output
    output = []
    for (let index = 0; index < input.length; index++) {
      const current = input[index]!
      const previous = input[(index + input.length - 1) % input.length]!
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect(previous, current))
        output.push(current)
      } else if (inside(previous)) output.push(intersect(previous, current))
    }
    if (output.length === 0) return []
  }
  return output
}

/** The query's bounding box, widened by `margin`. */
export function queryBounds(query: QueryGeometry, margin: number): [number, number, number, number] {
  let minimumX = Infinity
  let minimumY = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  for (const { x, y } of query) {
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x)
    maximumY = Math.max(maximumY, y)
  }
  return [minimumX - margin, minimumY - margin, maximumX + margin, maximumY + margin]
}
