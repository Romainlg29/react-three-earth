import earcut from 'earcut'
import type { Position } from 'geojson'
import type { GeographicBounds } from 'react-three-earth'

import type { DrawFeature, DrawGeometry, LongitudeLatitude } from './types.js'

/** Mean Earth radius, for distances along the ground. */
export const EARTH_RADIUS_METERS = 6_371_008.8
const MAXIMUM_MERCATOR_LATITUDE_DEGREES = 85.051129
const DEGREES = Math.PI / 180

/** A point in normalised Web Mercator: x from 0 (180° W) to 1 (180° E), y from 0 (south) to 1 (north). */
export interface MercatorCoordinate {
  x: number
  y: number
}

/** Normalised Web Mercator of a position. Longitudes outside ±180° give x outside 0 to 1 (kept unwrapped). */
export function toMercator([longitudeDegrees, latitudeDegrees]: readonly number[] | LongitudeLatitude): MercatorCoordinate {
  const latitude = Math.min(Math.max(latitudeDegrees!, -MAXIMUM_MERCATOR_LATITUDE_DEGREES), MAXIMUM_MERCATOR_LATITUDE_DEGREES) * DEGREES
  return { x: (longitudeDegrees! + 180) / 360, y: 0.5 + Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI) }
}

/** The position of a normalised Web Mercator point. */
export function fromMercator({ x, y }: MercatorCoordinate): LongitudeLatitude {
  return [x * 360 - 180, (2 * Math.atan(Math.exp((y - 0.5) * 2 * Math.PI)) - Math.PI / 2) / DEGREES]
}

/** `longitude` moved by whole turns to within 180° of `reference`. */
export function unwrapLongitudeNear(longitude: number, reference: number): number {
  return longitude - Math.round((longitude - reference) / 360) * 360
}

/** Longitude back in -180° to 180°. */
export function wrapLongitude(longitude: number): number {
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 && longitude > 0 ? 180 : wrapped
}

/** The positions with each longitude within 180° of the one before, so a line over the antimeridian stays continuous. */
export function unwrapPositions(positions: readonly (readonly number[])[]): LongitudeLatitude[] {
  const result: LongitudeLatitude[] = []
  let previous: number | null = null
  for (const position of positions) {
    const longitude: number = previous === null ? position[0]! : unwrapLongitudeNear(position[0]!, previous)
    result.push([longitude, position[1]!])
    previous = longitude
  }
  return result
}

/** Great-circle distance between two positions, in metres. */
export function distanceMeters(from: readonly number[], to: readonly number[]): number {
  const latitude1 = from[1]! * DEGREES
  const latitude2 = to[1]! * DEGREES
  const sinLatitude = Math.sin((latitude2 - latitude1) / 2)
  const sinLongitude = Math.sin(((to[0]! - from[0]!) * DEGREES) / 2)
  const a = sinLatitude * sinLatitude + Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** The lines of a geometry: a line string's coordinates, or the rings (closed) of its polygons. Points have none. */
export function geometryLines(geometry: DrawGeometry): LongitudeLatitude[][] {
  if (geometry.type === 'LineString') return [unwrapPositions(geometry.coordinates)]
  if (geometry.type === 'Polygon') return geometry.coordinates.map(ring => unwrapPositions(ring))
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flatMap(polygon => polygon.map(ring => unwrapPositions(ring)))
  return []
}

/** The polygons of a geometry, each as its rings (closed, longitudes unwrapped): one for a polygon, none for points and lines. */
export function geometryPolygons(geometry: DrawGeometry): LongitudeLatitude[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates.map(ring => unwrapPositions(ring))]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon.map(ring => unwrapPositions(ring)))
  return []
}

/** Every position of a geometry, as stored (altitudes and the closing positions of rings included). */
export function storedPositions(geometry: DrawGeometry): Position[] {
  if (geometry.type === 'Point') return [geometry.coordinates]
  if (geometry.type === 'LineString') return geometry.coordinates
  if (geometry.type === 'Polygon') return geometry.coordinates.flat()
  return geometry.coordinates.flat(2)
}

/** The geometry with every position mapped (closing positions too: they map like the first, so rings stay closed). */
export function mapGeometryPositions<G extends DrawGeometry>(geometry: G, map: (position: Position) => Position): G {
  const mapped: DrawGeometry =
    geometry.type === 'Point'
      ? { type: 'Point', coordinates: map(geometry.coordinates) }
      : geometry.type === 'LineString'
        ? { type: 'LineString', coordinates: geometry.coordinates.map(map) }
        : geometry.type === 'Polygon'
          ? { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(map)) }
          : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(map))) }
  return mapped as G
}

/** Whether a position has an altitude: a finite third coordinate. */
export function hasAltitude(position: Position): boolean {
  return position.length > 2 && Number.isFinite(position[2])
}

/** Every position of a geometry, flattened. */
export function geometryPositions(geometry: DrawGeometry): LongitudeLatitude[] {
  if (geometry.type === 'Point') return [[geometry.coordinates[0]!, geometry.coordinates[1]!]]
  return geometryLines(geometry).flat()
}

/** The bounds of a geometry, in degrees. East may pass 180° for a geometry over the antimeridian. */
export function geometryBounds(geometry: DrawGeometry): GeographicBounds {
  let westDegrees = Infinity
  let southDegrees = Infinity
  let eastDegrees = -Infinity
  let northDegrees = -Infinity
  for (const [longitude, latitude] of geometryPositions(geometry)) {
    westDegrees = Math.min(westDegrees, longitude)
    eastDegrees = Math.max(eastDegrees, longitude)
    southDegrees = Math.min(southDegrees, latitude)
    northDegrees = Math.max(northDegrees, latitude)
  }
  return { westDegrees, southDegrees, eastDegrees, northDegrees }
}

/** `bounds` grown on every side by `fraction` of its size, and at least `minimumDegrees`. */
export function padBounds(bounds: GeographicBounds, fraction: number, minimumDegrees: number): GeographicBounds {
  const longitudePad = Math.max((bounds.eastDegrees - bounds.westDegrees) * fraction, minimumDegrees)
  const latitudePad = Math.max((bounds.northDegrees - bounds.southDegrees) * fraction, minimumDegrees)
  return {
    westDegrees: bounds.westDegrees - longitudePad,
    eastDegrees: bounds.eastDegrees + longitudePad,
    southDegrees: Math.max(bounds.southDegrees - latitudePad, -90),
    northDegrees: Math.min(bounds.northDegrees + latitudePad, 90),
  }
}

/** The smallest bounds holding both. */
export function unionBounds(a: GeographicBounds | null, b: GeographicBounds | null): GeographicBounds | null {
  if (a === null) return b
  if (b === null) return a
  return {
    westDegrees: Math.min(a.westDegrees, b.westDegrees),
    southDegrees: Math.min(a.southDegrees, b.southDegrees),
    eastDegrees: Math.max(a.eastDegrees, b.eastDegrees),
    northDegrees: Math.max(a.northDegrees, b.northDegrees),
  }
}

/**
 * Triangles of a polygon in normalised Web Mercator: flat x, y pairs and their indices. Straight edges on the map, as
 * GeoJSON draws them.
 */
export function triangulatePolygon(rings: readonly LongitudeLatitude[][]): { vertices: number[]; indices: number[] } {
  const vertices: number[] = []
  const holes: number[] = []
  const reference = rings[0]?.[0]?.[0] ?? 0
  for (const [ringIndex, ring] of rings.entries()) {
    if (ringIndex > 0) holes.push(vertices.length / 2)
    // Rings are closed in GeoJSON: the last position repeats the first.
    const open = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring
    for (const position of open) {
      const { x, y } = toMercator([unwrapLongitudeNear(position[0], reference), position[1]])
      vertices.push(x, y)
    }
  }
  return { vertices, indices: earcut(vertices, holes.length > 0 ? holes : undefined, 2) }
}

/** Whether a point lies inside a polygon (its outer ring, outside its holes), in plain longitude-latitude. */
export function pointInPolygon(point: readonly number[], rings: readonly LongitudeLatitude[][]): boolean {
  let inside = false
  const reference = rings[0]?.[0]?.[0] ?? point[0]!
  const x = unwrapLongitudeNear(point[0]!, reference)
  const y = point[1]!
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [xi, yi] = ring[index]!
      const [xj, yj] = ring[previous]!
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Distance from a point to a segment, in the same units (screen pixels). */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** A closed ring: the positions with the first repeated at the end. */
export function closeRing(positions: readonly LongitudeLatitude[]): LongitudeLatitude[] {
  if (positions.length === 0) return []
  const first = positions[0]!
  const last = positions.at(-1)!
  return first[0] === last[0] && first[1] === last[1] ? [...positions] : [...positions, [first[0], first[1]]]
}

/** A copy of a feature's geometry, deep enough to change its coordinates. */
export function cloneFeature<F extends DrawFeature>(feature: F): F {
  return structuredClone(feature)
}
