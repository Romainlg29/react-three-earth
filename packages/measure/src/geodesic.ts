import * as geographiclibNamespace from 'geographiclib-geodesic'

import { unwrapLongitudeNear, wrapLongitude, type LongitudeLatitude } from '@earthkit/draw'

// The package is CommonJS: Node's ESM loader gives only `default`, bundlers give the names too.
const geographiclib: typeof geographiclibNamespace = (geographiclibNamespace as { default?: typeof geographiclibNamespace }).default ?? geographiclibNamespace

/** Geodesics on the WGS84 ellipsoid (Karney's algorithms, accurate to nanometres). */
const WGS84 = geographiclib.Geodesic.WGS84
const DISTANCE = geographiclib.Geodesic.DISTANCE
const LONGITUDE_UNROLLED = geographiclib.Geodesic.LATITUDE | geographiclib.Geodesic.LONGITUDE | geographiclib.Geodesic.LONG_UNROLL

/** The length of the shortest path between two positions on the WGS84 ellipsoid, in metres. */
export function geodesicDistanceMeters(from: readonly number[], to: readonly number[]): number {
  return WGS84.Inverse(from[1]!, from[0]!, to[1]!, to[0]!, DISTANCE).s12 ?? 0
}

/** The geodesic length of each segment of a path, in metres. */
export function segmentLengthsMeters(positions: readonly (readonly number[])[]): number[] {
  const lengths: number[] = []
  for (let index = 1; index < positions.length; index++) lengths.push(geodesicDistanceMeters(positions[index - 1]!, positions[index]!))
  return lengths
}

/** The geodesic length of a path through the positions, in metres. */
export function pathLengthMeters(positions: readonly (readonly number[])[]): number {
  return segmentLengthsMeters(positions).reduce((sum, length) => sum + length, 0)
}

/** The ring without its closing position (GeoJSON rings repeat the first position at the end). */
export function withoutClosingPosition<T extends readonly number[]>(ring: readonly T[]): T[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (ring.length > 1 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1)
  return [...ring]
}

/**
 * The area enclosed by a ring whose sides are geodesics on the WGS84 ellipsoid, in square metres, whatever its
 * winding. The ring may be open or closed. Fewer than three positions enclose nothing.
 */
export function ringAreaSquareMeters(ring: readonly (readonly number[])[]): number {
  const positions = withoutClosingPosition(ring)
  if (positions.length < 3) return 0
  const polygon = WGS84.Polygon(false)
  for (const position of positions) polygon.AddPoint(position[1]!, position[0]!)
  // Signed so that either winding gives the smaller of the two areas the ring splits the ellipsoid into.
  return Math.abs(polygon.Compute(false, true).area ?? 0)
}

/** The area of a polygon (its outer ring less its holes), sides along geodesics, in square metres. */
export function polygonAreaSquareMeters(rings: readonly (readonly (readonly number[])[])[]): number {
  const [outer, ...holes] = rings
  if (outer === undefined) return 0
  const area = holes.reduce((sum, hole) => sum - ringAreaSquareMeters(hole), ringAreaSquareMeters(outer))
  return Math.max(0, area)
}

/** The geodesic length around a ring, closing side included, in metres. */
export function ringPerimeterMeters(ring: readonly (readonly number[])[]): number {
  const positions = withoutClosingPosition(ring)
  if (positions.length < 2) return 0
  return pathLengthMeters([...positions, positions[0]!])
}

/**
 * The position `distanceMeters` along the geodesic from `from` to `to` (beyond `to` when longer). Its longitude is
 * unrolled from `from`'s: past 180° across the antimeridian, so a path stays continuous (`wrapLongitude` brings it back).
 */
export function geodesicPointAt(from: readonly number[], to: readonly number[], distanceMeters: number): LongitudeLatitude {
  return geodesicLine(from, to)(distanceMeters)
}

/** The geodesic from `from` to `to`, solved once: a function of the distance along it, as `geodesicPointAt`. */
export function geodesicLine(from: readonly number[], to: readonly number[]): (distanceMeters: number) => LongitudeLatitude {
  const line = WGS84.InverseLine(from[1]!, from[0]!, to[1]!, to[0]!, LONGITUDE_UNROLLED | DISTANCE | geographiclib.Geodesic.DISTANCE_IN)
  return distanceMeters => {
    const point = line.Position(distanceMeters, LONGITUDE_UNROLLED)
    return [point.lon2!, point.lat2!]
  }
}

/** The point halfway along the geodesic between two positions, longitude within ±180°: where a segment's label goes. */
export function geodesicMidpoint(from: readonly number[], to: readonly number[]): LongitudeLatitude {
  const [longitude, latitude] = geodesicPointAt(from, to, geodesicDistanceMeters(from, to) / 2)
  return [wrapLongitude(longitude), latitude]
}

/**
 * Positions along a path, `spacingMeters` apart along its geodesics or closer, every vertex kept: to draw a long
 * measurement as the geodesic it measures, rather than a straight line on the map. Longitudes are unrolled, each within
 * 180° of the one before, so a line across the antimeridian stays continuous (past 180°, as GeoJSON lines may).
 */
export function densifyPath(positions: readonly (readonly number[])[], spacingMeters: number): LongitudeLatitude[] {
  if (!(spacingMeters > 0)) throw new Error(`densifyPath: spacingMeters must be above 0, got ${spacingMeters}.`)
  const result: LongitudeLatitude[] = []
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]!
    if (index === 0) {
      result.push([position[0]!, position[1]!])
      continue
    }
    // From the previous vertex as already placed (unrolled), so the points along the segment continue from it.
    const previous = result[result.length - 1]!
    const target: LongitudeLatitude = [unwrapLongitudeNear(position[0]!, previous[0]), position[1]!]
    const length = geodesicDistanceMeters(previous, target)
    const steps = Math.ceil(length / spacingMeters)
    for (let step = 1; step < steps; step++) result.push(geodesicPointAt(previous, target, (length * step) / steps))
    result.push(target)
  }
  return result
}

/**
 * A point to label a ring at: its centroid when the ring holds it, else the middle of the widest span of the ring
 * across the centroid's latitude. Computed in longitude and latitude, so meant for rings of up to a few hundred
 * kilometres.
 */
export function ringLabelPosition(ring: readonly (readonly number[])[]): LongitudeLatitude {
  const positions = withoutClosingPosition(ring)
  if (positions.length === 0) return [0, 0]
  // Longitudes unwrapped near the first, so a ring across the antimeridian stays in one piece.
  const reference = positions[0]![0]!
  const points = positions.map(position => [reference + ((((position[0]! - reference + 180) % 360) + 360) % 360) - 180, position[1]!] as LongitudeLatitude)
  let twiceArea = 0
  let centroidX = 0
  let centroidY = 0
  for (let index = 0; index < points.length; index++) {
    const [x0, y0] = points[index]!
    const [x1, y1] = points[(index + 1) % points.length]!
    const cross = x0 * y1 - x1 * y0
    twiceArea += cross
    centroidX += (x0 + x1) * cross
    centroidY += (y0 + y1) * cross
  }
  let centroid: LongitudeLatitude
  if (Math.abs(twiceArea) < 1e-18) {
    const sum = points.reduce((total, [x, y]) => [total[0] + x, total[1] + y], [0, 0])
    centroid = [sum[0] / points.length, sum[1] / points.length]
  } else centroid = [centroidX / (3 * twiceArea), centroidY / (3 * twiceArea)]
  if (points.length < 3 || containsPoint(points, centroid)) return [wrapLongitude(centroid[0]), centroid[1]]
  // A concave ring that does not hold its centroid: the middle of the widest span inside it, at the centroid's latitude.
  const latitude = centroid[1]
  const crossings: number[] = []
  for (let index = 0; index < points.length; index++) {
    const [x0, y0] = points[index]!
    const [x1, y1] = points[(index + 1) % points.length]!
    if (y0 > latitude !== y1 > latitude) crossings.push(x0 + ((latitude - y0) / (y1 - y0)) * (x1 - x0))
  }
  crossings.sort((a, b) => a - b)
  let best: LongitudeLatitude = centroid
  let widest = -1
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const width = crossings[index + 1]! - crossings[index]!
    if (width > widest) {
      widest = width
      best = [(crossings[index]! + crossings[index + 1]!) / 2, latitude]
    }
  }
  return [wrapLongitude(best[0]), best[1]]
}

function containsPoint(ring: readonly LongitudeLatitude[], [x, y]: LongitudeLatitude): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index]!
    const [xj, yj] = ring[previous]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
