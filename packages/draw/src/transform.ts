import type { Position } from 'geojson'

import { translateFeature } from './editing.js'
import { distanceMeters, hasAltitude, mapGeometryPositions, storedPositions, unwrapLongitudeNear } from './geometry.js'
import { LocalFrame, type LocalPoint } from './localFrame.js'
import { isMeshGeometry, meshAltitudeRange, meshTop, newellNormal, openRing, prismMesh, setMeshTop, wallMesh } from './mesh.js'
import { bearingDegrees, destination } from './shapes.js'
import type { DrawFeature, GroundHeight, LongitudeLatitude } from './types.js'

export type { GroundHeight } from './types.js'

/** The feature with every position's longitude and latitude mapped, altitudes kept (closing positions included). */
function mapPositions(feature: DrawFeature, map: (position: Position) => LongitudeLatitude): DrawFeature {
  return {
    ...feature,
    geometry: mapGeometryPositions(feature.geometry, position => {
      const [longitude, latitude] = map(position)
      return position.length > 2 ? [longitude, latitude, position[2]!] : [longitude, latitude]
    }),
  }
}

/**
 * Each vertex of a feature once, as longitude and latitude: a polygon's exterior ring without its closing position,
 * a mesh's positions with equal longitude and latitude counted once (a prism's top corner stands over its bottom one).
 */
function footprintVertices(feature: DrawFeature): Position[] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [geometry.coordinates]
  if (geometry.type === 'LineString') return geometry.coordinates
  if (geometry.type === 'Polygon') return openRing(geometry.coordinates[0] ?? [])
  const seen = new Set<string>()
  const vertices: Position[] = []
  for (const polygon of geometry.coordinates) {
    for (const position of openRing(polygon[0] ?? [])) {
      const key = `${position[0]},${position[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      vertices.push(position)
    }
  }
  return vertices
}

/**
 * The point a feature turns and scales around: a point's position, or else the average of its vertices (each once,
 * longitudes unwrapped, so it holds over the antimeridian). Turning or scaling a feature around it leaves it in place,
 * so repeated turns keep the same pivot.
 */
export function featureCenter(feature: DrawFeature): LongitudeLatitude {
  const positions = footprintVertices(feature)
  if (positions.length === 0) return [0, 0]
  const reference = positions[0]![0]!
  let longitude = 0
  let latitude = 0
  for (const position of positions) {
    longitude += unwrapLongitudeNear(position[0]!, reference)
    latitude += position[1]!
  }
  return [longitude / positions.length, latitude / positions.length]
}

/** Relative area difference within which the gizmo keeps facing north rather than turning to a feature's edges. */
const NORTH_PREFERENCE = 3e-3

/**
 * The turn of a feature's gizmo, in degrees clockwise from north, between -45° and 45°: the turn of the smallest
 * rectangle around its footprint, so a turned box gets a box turned with it. Shapes nearly as tight facing north (a
 * circle) face north. 0 for points.
 */
export function featureRotationDegrees(feature: DrawFeature): number {
  if (feature.geometry.type === 'Point') return 0
  const center = featureCenter(feature)
  const turn = tightestRectangleTurn(footprintVertices(feature).map(position => positionInFrame(center, position, 0)))
  // Counter-clockwise from east is clockwise from north, negated (and never -0).
  return turn === 0 ? 0 : -turn
}

/**
 * The turn, in degrees counter-clockwise between -45° and 45°, of the smallest rectangle around 2D points: its first
 * axis makes this angle with the points' x axis. Rectangles nearly as tight unturned (a circle) give 0.
 */
function tightestRectangleTurn(points: Array<[number, number]>): number {
  const hull = convexHull(points)
  if (hull.length < 2) return 0
  const areaAt = (turnDegrees: number) => {
    let minimumX = Infinity
    let maximumX = -Infinity
    let minimumY = Infinity
    let maximumY = -Infinity
    for (const [px, py] of hull) {
      const [x, y] = toFrame(px, py, -turnDegrees)
      minimumX = Math.min(minimumX, x)
      maximumX = Math.max(maximumX, x)
      minimumY = Math.min(minimumY, y)
      maximumY = Math.max(maximumY, y)
    }
    const width = maximumX - minimumX
    const length = maximumY - minimumY
    // A straight line has no area: the tightest box then runs along it, the longest way.
    return width * length - 1e-9 * Math.max(width, length) ** 2
  }
  let best = 0
  let bestArea = areaAt(0)
  const unturnedArea = bestArea
  for (let index = 0; index < hull.length; index++) {
    const [ax, ay] = hull[index]!
    const [bx, by] = hull[(index + 1) % hull.length]!
    if (ax === bx && ay === by) continue
    const turn = normalizeQuarterTurn((Math.atan2(by - ay, bx - ax) * 180) / Math.PI)
    const area = areaAt(turn)
    if (area < bestArea - Math.abs(bestArea) * 1e-12) {
      best = turn
      bestArea = area
    }
  }
  if (unturnedArea > 0 && unturnedArea <= bestArea + Math.abs(bestArea) * NORTH_PREFERENCE) return 0
  return best
}

/** An angle in degrees, brought to -45° to 45° by quarter turns. */
function normalizeQuarterTurn(degrees: number): number {
  const turned = ((degrees % 90) + 90) % 90
  return turned > 45 ? turned - 90 : turned
}

/** The convex hull of points (Andrew's monotone chain), counter-clockwise. */
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (sorted.length < 3) return sorted
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Array<[number, number]> = []
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/**
 * The feature turned by `angleDegrees` clockwise around the vertical through `center`: every position keeps its
 * distance in metres from the center and its altitude, so shapes and meshes keep their size.
 */
export function rotateFeature(feature: DrawFeature, center: LongitudeLatitude, angleDegrees: number): DrawFeature {
  if (angleDegrees % 360 === 0) return feature
  return mapPositions(feature, position => {
    const distance = distanceMeters(center, position)
    return distance === 0 ? [position[0]!, position[1]!] : destination(center, distance, bearingDegrees(center, position) + angleDegrees)
  })
}

/**
 * The feature scaled by `factor` around `center`: every position's distance in metres from the center is multiplied.
 * A mesh scales in 3D, around the point on its base (its lowest altitude) under the center: its altitudes above the base
 * are multiplied too, so a sphere stays round and resting where it was. Other features keep their altitudes.
 */
export function scaleFeature(feature: DrawFeature, center: LongitudeLatitude, factor: number): DrawFeature {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`scaleFeature: factor is ${factor}; give a positive number.`)
  if (factor === 1) return feature
  const geometry = feature.geometry
  const base = isMeshGeometry(geometry) ? meshAltitudeRange(geometry).minimumMeters : null
  return {
    ...feature,
    geometry: mapGeometryPositions(geometry, position => {
      const distance = distanceMeters(center, position)
      const [longitude, latitude] = distance === 0 ? [position[0]!, position[1]!] : destination(center, distance * factor, bearingDegrees(center, position))
      if (position.length <= 2) return [longitude, latitude]
      return [longitude, latitude, base === null ? position[2]! : base + (position[2]! - base) * factor]
    }),
  }
}

/**
 * The flat polygon, multipolygon or line extruded into a mesh `heightMeters` tall: a polygon into a closed prism
 * (`prismMesh`: a level top `heightMeters` above its highest base vertex), a multipolygon into one prism per polygon
 * with one level top over them all (`heightMeters` above the highest base vertex of any), a line into a wall
 * (`wallMesh`). The base is each position's altitude, or the terrain's height under it (`groundHeightMeters`: one
 * height, or a function). Holes become inner walls. Other features (points, meshes) are returned unchanged. Properties
 * and id are kept.
 */
export function extrudeFeature(feature: DrawFeature, heightMeters: number, groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  const geometry = feature.geometry
  if (geometry.type === 'Point' || isMeshGeometry(geometry)) return feature
  const ground: GroundHeight = typeof groundHeightMeters === 'number' ? () => groundHeightMeters : groundHeightMeters
  const base = (position: Position) => (hasAltitude(position) ? position[2]! : ground(position[0]!, position[1]!))
  if (geometry.type === 'LineString') return { ...feature, geometry: wallMesh(geometry.coordinates, base, heightMeters) }
  if (geometry.type === 'Polygon') return { ...feature, geometry: prismMesh(geometry.coordinates, base, heightMeters) }
  // Each polygon's highest base (holes too, as `prismMesh` counts them), so every prism's top lands at one altitude.
  const highest = geometry.coordinates.map(polygon => Math.max(...polygon.flatMap(ring => openRing(ring).map(base))))
  const topMeters = Math.max(...highest) + heightMeters
  const coordinates = geometry.coordinates.flatMap((polygon, index) => prismMesh(polygon, base, topMeters - highest[index]!).coordinates)
  return { ...feature, geometry: { type: 'MultiPolygon', coordinates } }
}

/**
 * The top of a mesh with a level top face (a prism, a box): the top's altitude, and the highest altitude under it (the
 * base of its shortest wall). Null for other features and for meshes without one (a sphere, a wall).
 */
export function meshTopOf(feature: DrawFeature): { topMeters: number; belowMeters: number } | null {
  return isMeshGeometry(feature.geometry) ? meshTop(feature.geometry) : null
}

/** Smallest height of a mesh's top over its other vertices, in metres. */
const MINIMUM_TOP_GAP_METERS = 1

/**
 * The mesh with its top face (the vertices at its highest altitude) moved up by `deltaMeters` (down when negative),
 * never closer than 1 m above its other vertices. Features without a level top face (`meshTopOf`) are returned unchanged.
 */
export function moveMeshTop(feature: DrawFeature, deltaMeters: number): DrawFeature {
  if (!Number.isFinite(deltaMeters)) throw new Error(`moveMeshTop: deltaMeters is ${deltaMeters}; give a finite number of metres.`)
  const top = meshTopOf(feature)
  if (top === null || !isMeshGeometry(feature.geometry)) return feature
  return { ...feature, geometry: setMeshTop(feature.geometry, top.topMeters + deltaMeters, MINIMUM_TOP_GAP_METERS) }
}

/** An axis of a transform frame: `across` (x, the width of a rectangle) or `along` (y, its length, towards the rotation). */
export type TransformAxis = 'across' | 'along'

/** A side handle of the gizmo: the middle of one edge of the box, which stretches the feature along one axis. */
export interface TransformSideHandle {
  position: LongitudeLatitude
  /** The middle of the opposite edge, which stays where it is while this side is dragged. */
  oppositePosition: LongitudeLatitude
  axis: TransformAxis
  /** Where this side is on the axis, in metres from the frame's center. */
  sideMeters: number
  /** Where the opposite side is on the axis, in metres from the frame's center. */
  fixedMeters: number
}

/** The gizmo of a feature, in geographic positions: where its handles go. */
export interface TransformFrame {
  center: LongitudeLatitude
  /** The turn of the frame (see `featureRotationDegrees`), degrees clockwise from north. */
  rotationDegrees: number
  /** Corners of the box around the feature's vertices, in the frame: scale handles. Empty for points. */
  corners: LongitudeLatitude[]
  /**
   * The middles of the box's edges (bottom, right, top, left): stretch handles. None for points, nor on an axis the
   * feature does not extend along (across a straight line).
   */
  sideHandles: TransformSideHandle[]
  /** The rotation knob, beyond the box's top edge. Null for points. */
  rotationHandle: LongitudeLatitude | null
  /** The lowest altitude among the feature's positions (a mesh's base), where the gizmo is drawn; null on the terrain. */
  baseHeightMeters: number | null
  /** The highest altitude among the feature's positions; null on the terrain. */
  topHeightMeters: number | null
}

/** Turns an east, north offset (metres) into the frame turned `rotationDegrees` clockwise: x across, y along. */
function toFrame(east: number, north: number, rotationDegrees: number): [number, number] {
  const angle = (rotationDegrees * Math.PI) / 180
  return [east * Math.cos(angle) - north * Math.sin(angle), east * Math.sin(angle) + north * Math.cos(angle)]
}

/** A position `x` across and `y` along the frame from `center`. */
function fromFrame(center: LongitudeLatitude, x: number, y: number, rotationDegrees: number): LongitudeLatitude {
  const angle = (rotationDegrees * Math.PI) / 180
  const east = x * Math.cos(angle) + y * Math.sin(angle)
  const north = -x * Math.sin(angle) + y * Math.cos(angle)
  const distance = Math.hypot(east, north)
  return distance === 0 ? [center[0], center[1]] : destination(center, distance, (Math.atan2(east, north) * 180) / Math.PI)
}

/** A position in the frame turned `rotationDegrees` around `center`: metres across and along. */
function positionInFrame(center: LongitudeLatitude, position: Position, rotationDegrees: number): [number, number] {
  const distance = distanceMeters(center, position)
  if (distance === 0) return [0, 0]
  const bearing = (bearingDegrees(center, position) * Math.PI) / 180
  return toFrame(distance * Math.sin(bearing), distance * Math.cos(bearing), rotationDegrees)
}

/**
 * Box extents below this fraction of the other axis's count as none: a straight line has no width (a line along a
 * parallel bulges a few centimetres off the great circle through its center).
 */
const MINIMUM_EXTENT_FRACTION = 1e-3

/**
 * Where a feature's gizmo handles go: a box around its vertices, turned with it (`featureRotationDegrees`), with a scale
 * handle at each corner, a stretch handle in the middle of each edge, and a rotation knob a quarter of its length beyond
 * the top edge. A mesh's box is drawn at its base, its lowest altitude.
 */
export function transformFrame(feature: DrawFeature): TransformFrame {
  const center = featureCenter(feature)
  const rotationDegrees = featureRotationDegrees(feature)
  const altitudes = altitudeRangeOf(feature)
  const baseHeightMeters = altitudes?.minimumMeters ?? null
  const topHeightMeters = altitudes?.maximumMeters ?? null
  if (feature.geometry.type === 'Point') return { center, rotationDegrees, corners: [], sideHandles: [], rotationHandle: null, baseHeightMeters, topHeightMeters }
  let minimumX = Infinity
  let maximumX = -Infinity
  let minimumY = Infinity
  let maximumY = -Infinity
  for (const position of footprintVertices(feature)) {
    const [x, y] = positionInFrame(center, position, rotationDegrees)
    minimumX = Math.min(minimumX, x)
    maximumX = Math.max(maximumX, x)
    minimumY = Math.min(minimumY, y)
    maximumY = Math.max(maximumY, y)
  }
  const corners = [
    fromFrame(center, minimumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, maximumY, rotationDegrees),
    fromFrame(center, minimumX, maximumY, rotationDegrees),
  ]
  const sideHandles: TransformSideHandle[] = []
  const middleX = (minimumX + maximumX) / 2
  const middleY = (minimumY + maximumY) / 2
  const bottom = fromFrame(center, middleX, minimumY, rotationDegrees)
  const right = fromFrame(center, maximumX, middleY, rotationDegrees)
  const top = fromFrame(center, middleX, maximumY, rotationDegrees)
  const left = fromFrame(center, minimumX, middleY, rotationDegrees)
  const largest = Math.max(maximumX - minimumX, maximumY - minimumY)
  const hasLength = maximumY - minimumY > largest * MINIMUM_EXTENT_FRACTION
  const hasWidth = maximumX - minimumX > largest * MINIMUM_EXTENT_FRACTION
  if (hasLength) sideHandles.push({ position: bottom, oppositePosition: top, axis: 'along', sideMeters: minimumY, fixedMeters: maximumY })
  if (hasWidth) sideHandles.push({ position: right, oppositePosition: left, axis: 'across', sideMeters: maximumX, fixedMeters: minimumX })
  if (hasLength) sideHandles.push({ position: top, oppositePosition: bottom, axis: 'along', sideMeters: maximumY, fixedMeters: minimumY })
  if (hasWidth) sideHandles.push({ position: left, oppositePosition: right, axis: 'across', sideMeters: minimumX, fixedMeters: maximumX })
  const length = Math.max(maximumY - minimumY, maximumX - minimumX)
  const rotationHandle = fromFrame(center, middleX, maximumY + length * 0.25, rotationDegrees)
  return { center, rotationDegrees, corners, sideHandles, rotationHandle, baseHeightMeters, topHeightMeters }
}

/**
 * The feature stretched by `factor` along one horizontal axis of a frame (`frame.center`, turned
 * `frame.rotationDegrees`), keeping the line `fixedMeters` from the center on that axis where it is: each position's
 * distance from that line, in metres, is multiplied. Dragging one side of the gizmo's box this way keeps the opposite
 * side fixed. Altitudes are kept; points are returned unchanged.
 */
export function stretchFeature(feature: DrawFeature, frame: Pick<TransformFrame, 'center' | 'rotationDegrees'>, axis: TransformAxis, fixedMeters: number, factor: number): DrawFeature {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`stretchFeature: factor is ${factor}; give a positive number.`)
  if (factor === 1 || feature.geometry.type === 'Point') return feature
  const { center, rotationDegrees } = frame
  return mapPositions(feature, position => {
    const [x, y] = positionInFrame(center, position, rotationDegrees)
    return axis === 'across' ? fromFrame(center, fixedMeters + (x - fixedMeters) * factor, y, rotationDegrees) : fromFrame(center, x, fixedMeters + (y - fixedMeters) * factor, rotationDegrees)
  })
}

/**
 * The feature moved up by `deltaMeters` (down when negative): every position gets a third coordinate, its altitude
 * above the WGS84 ellipsoid, as GeoJSON allows. Positions that already have one (all of a mesh's) rise by
 * `deltaMeters`; positions on the terrain start from the terrain's height under them (`groundHeightMeters`: one height,
 * or the height under each position, so a lifted shape keeps the relief's offsets).
 */
export function liftFeature(feature: DrawFeature, deltaMeters: number, groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  if (!Number.isFinite(deltaMeters)) throw new Error(`liftFeature: deltaMeters is ${deltaMeters}; give a finite number of metres.`)
  const ground: GroundHeight = typeof groundHeightMeters === 'number' ? () => groundHeightMeters : groundHeightMeters
  return {
    ...feature,
    geometry: mapGeometryPositions(feature.geometry, position => {
      const start = hasAltitude(position) ? position[2]! : ground(position[0]!, position[1]!)
      if (!Number.isFinite(start)) throw new Error(`liftFeature: no terrain height at ${position[0]}, ${position[1]}; give groundHeightMeters a finite number of metres.`)
      return [position[0]!, position[1]!, start + deltaMeters]
    }),
  }
}

/**
 * The feature without altitudes (third coordinates): back on the terrain, where it drapes. Meshes are returned
 * unchanged: a solid needs its altitudes (lift it down with `liftFeature` instead).
 */
export function placeOnTerrain(feature: DrawFeature): DrawFeature {
  if (isMeshGeometry(feature.geometry)) return feature
  return { ...feature, geometry: mapGeometryPositions(feature.geometry, position => (position.length > 2 ? [position[0]!, position[1]!] : position)) }
}

/** The lowest and highest altitudes among a feature's positions (third coordinates), or null when none has one. */
export function altitudeRangeOf(feature: DrawFeature): { minimumMeters: number; maximumMeters: number } | null {
  let minimumMeters = Infinity
  let maximumMeters = -Infinity
  for (const position of storedPositions(feature.geometry)) {
    if (!hasAltitude(position)) continue
    minimumMeters = Math.min(minimumMeters, position[2]!)
    maximumMeters = Math.max(maximumMeters, position[2]!)
  }
  return Number.isFinite(minimumMeters) ? { minimumMeters, maximumMeters } : null
}

/**
 * The altitude of a feature's base: the lowest third coordinate among its positions (a mesh's bottom), or null for a
 * feature on the terrain. A feature with any altitude stands at it, as `isSolidFeature` says.
 */
export function baseAltitudeOf(feature: DrawFeature): number | null {
  return altitudeRangeOf(feature)?.minimumMeters ?? null
}

// ---- 3D transforms, in the east-north-up frame of a pivot ----

/** The east, north and up axes: the default gizmo axes. */
export const WORLD_AXES: readonly [LocalPoint, LocalPoint, LocalPoint] = Object.freeze([
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]) as readonly [LocalPoint, LocalPoint, LocalPoint]

/** A vector of unit length, or null for a zero vector. */
function unitVector(vector: readonly number[]): LocalPoint | null {
  const length = Math.hypot(vector[0]!, vector[1]!, vector[2]!)
  return length > 0 && Number.isFinite(length) ? [vector[0]! / length, vector[1]! / length, vector[2]! / length] : null
}

function cross(a: LocalPoint, b: LocalPoint): LocalPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

/** Below this, an axis counts as vertical (no horizontal part) or horizontal (no vertical part). */
const AXIS_EPSILON = 1e-9

/** The terrain heights as a function. */
function groundFunction(groundHeightMeters: number | GroundHeight): GroundHeight {
  return typeof groundHeightMeters === 'number' ? () => groundHeightMeters : groundHeightMeters
}

/**
 * The feature moved by an offset in metres east, north and up. The horizontal part keeps each position's distance and
 * bearing from the feature's center (`translateFeature`), and altitudes; the vertical part is `liftFeature`: positions
 * on the terrain get an altitude, the terrain's height under them (`groundHeightMeters`) plus `up`.
 */
export function offsetFeature(feature: DrawFeature, [east, north, up]: readonly [number, number, number], groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  if (!Number.isFinite(east) || !Number.isFinite(north) || !Number.isFinite(up)) throw new Error(`offsetFeature: the offset is ${east}, ${north}, ${up}; give finite metres.`)
  let result = feature
  const horizontal = Math.hypot(east, north)
  if (horizontal > 0) {
    const center = featureCenter(feature)
    result = translateFeature(result, center, destination(center, horizontal, (Math.atan2(east, north) * 180) / Math.PI))
  }
  return up === 0 ? result : liftFeature(result, up, groundHeightMeters)
}

/**
 * The feature turned by `angleDegrees` around an axis through `center` (longitude, latitude and altitude in metres),
 * the axis given in the center's east-north-up frame (`[1, 0, 0]` is east). The turn is right-handed: counter-clockwise
 * seen from the axis's tip (a turn around `[0, 0, 1]` by 30° is 30° counter-clockwise from above, the opposite of
 * `rotateFeature`'s heading).
 *
 * Around the vertical this is `rotateFeature`: altitudes are kept, and positions on the terrain stay there. Around any
 * other axis (a tilt) every position is turned in the center's east-north-up frame (`LocalFrame`), exactly, so
 * distances and flat faces are kept; every position gets an altitude, those on the terrain starting from its height
 * under them (`groundHeightMeters`: one height, or a function).
 */
export function rotateFeatureAroundAxis(feature: DrawFeature, center: readonly number[], axis: readonly [number, number, number], angleDegrees: number, groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  if (!Number.isFinite(angleDegrees)) throw new Error(`rotateFeatureAroundAxis: angleDegrees is ${angleDegrees}; give a finite number of degrees.`)
  const unit = unitVector(axis)
  if (unit === null) throw new Error(`rotateFeatureAroundAxis: the axis ${axis.join(', ')} has no length; give an east, north, up direction such as [0, 0, 1].`)
  if (angleDegrees % 360 === 0) return feature
  if (Math.hypot(unit[0], unit[1]) < AXIS_EPSILON) return rotateFeature(feature, [center[0]!, center[1]!], unit[2] > 0 ? -angleDegrees : angleDegrees)
  const frame = new LocalFrame(center[0]!, center[1]!, center[2] ?? 0)
  const ground = groundFunction(groundHeightMeters)
  // Rodrigues' rotation matrix.
  const angle = (angleDegrees * Math.PI) / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const [x, y, z] = unit
  const k = 1 - cosine
  const matrix = [
    cosine + x * x * k, x * y * k - z * sine, x * z * k + y * sine,
    y * x * k + z * sine, cosine + y * y * k, y * z * k - x * sine,
    z * x * k - y * sine, z * y * k + x * sine, cosine + z * z * k,
  ]
  return {
    ...feature,
    geometry: mapGeometryPositions(feature.geometry, position => {
      const altitude = hasAltitude(position) ? position[2]! : ground(position[0]!, position[1]!)
      const [east, north, up] = frame.toLocal(position[0]!, position[1]!, altitude)
      return frame.toGeographic(
        matrix[0]! * east + matrix[1]! * north + matrix[2]! * up,
        matrix[3]! * east + matrix[4]! * north + matrix[5]! * up,
        matrix[6]! * east + matrix[7]! * north + matrix[8]! * up,
      )
    }),
  }
}

/**
 * The feature scaled by `factor` along one axis through `center` (longitude, latitude and altitude in metres), the axis
 * in the center's east-north-up frame: each position's distance from the plane across the axis through the center is
 * multiplied; distances along the other two axes are kept.
 *
 * Along a horizontal axis this is `stretchFeature` around the center: altitudes are kept, positions on the terrain stay
 * there. Along any other axis positions move in the center's east-north-up frame and all get altitudes, those on the
 * terrain starting from its height under them (`groundHeightMeters`).
 */
export function scaleFeatureAlongAxis(feature: DrawFeature, center: readonly number[], axis: readonly [number, number, number], factor: number, groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`scaleFeatureAlongAxis: factor is ${factor}; give a positive number.`)
  const unit = unitVector(axis)
  if (unit === null) throw new Error(`scaleFeatureAlongAxis: the axis ${axis.join(', ')} has no length; give an east, north, up direction such as [1, 0, 0].`)
  if (factor === 1 || feature.geometry.type === 'Point') return feature
  if (Math.abs(unit[2]) < AXIS_EPSILON) {
    // The frame's x axis (`across`) turned clockwise from east by the axis's angle counter-clockwise, negated.
    const rotationDegrees = (-Math.atan2(unit[1], unit[0]) * 180) / Math.PI
    return stretchFeature(feature, { center: [center[0]!, center[1]!], rotationDegrees }, 'across', 0, factor)
  }
  const frame = new LocalFrame(center[0]!, center[1]!, center[2] ?? 0)
  const ground = groundFunction(groundHeightMeters)
  const grow = factor - 1
  return {
    ...feature,
    geometry: mapGeometryPositions(feature.geometry, position => {
      const altitude = hasAltitude(position) ? position[2]! : ground(position[0]!, position[1]!)
      const local = frame.toLocal(position[0]!, position[1]!, altitude)
      const along = dot(local, unit) * grow
      return frame.toGeographic(local[0] + unit[0] * along, local[1] + unit[1] * along, local[2] + unit[2] * along)
    }),
  }
}

/** A face counts for a feature's own up axis only when it faces up at least this much (the cosine of its tilt). */
const MINIMUM_UP_FACING = 0.1

/**
 * A feature's own axes, for a gizmo in local space: three unit vectors in the east-north-up frame at its center, x, y
 * and z (right-handed).
 *
 * - z: the normal of the face that faces up the most (largest area × cos² of its tilt) of a mesh or a polygon at an
 *   altitude, so a tilted box gets its tilted top's normal; straight up for everything else (features on the terrain,
 *   lines, walls).
 * - x and y: the edges of the smallest rectangle around the vertices seen along z (as `featureRotationDegrees` finds on
 *   the ground), x the one closest to east; east and north when nearly as tight (a circle).
 */
export function featureAxes(feature: DrawFeature): [LocalPoint, LocalPoint, LocalPoint] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const center = featureCenter(feature)
  const range = altitudeRangeOf(feature)
  const frame = new LocalFrame(center[0], center[1], range === null ? 0 : (range.minimumMeters + range.maximumMeters) / 2)
  const toLocal = (position: Position): LocalPoint => frame.toLocal(position[0]!, position[1]!, hasAltitude(position) ? position[2]! : (range?.minimumMeters ?? 0))
  let z: LocalPoint = [0, 0, 1]
  if (range !== null && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
    const faces = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
    let bestScore = 0
    for (const face of faces) {
      const ring = openRing(face[0] ?? [])
      if (ring.length < 3 || !ring.every(hasAltitude)) continue
      const normal = newellNormal(ring.map(toLocal))
      const area = Math.hypot(normal[0], normal[1], normal[2]) / 2
      const unit = unitVector(normal)
      if (unit === null) continue
      // Up or down alike: a flat polygon wound clockwise faces up too.
      const facing = Math.abs(unit[2])
      const score = area * facing * facing
      if (facing >= MINIMUM_UP_FACING && score > bestScore * (1 + 1e-9)) {
        bestScore = score
        z = unit[2] < 0 ? [-unit[0], -unit[1], -unit[2]] : unit
      }
    }
  }
  // A basis of the plane across z, from east (north when z lies along east).
  const eastInPlane = unitVector([1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]]) ?? unitVector([-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]])!
  const northInPlane = cross(z, eastInPlane)
  const points = footprintVertices(feature).map(position => {
    const local = toLocal(position)
    return [dot(local, eastInPlane), dot(local, northInPlane)] as [number, number]
  })
  const turn = (tightestRectangleTurn(points) * Math.PI) / 180
  const x: LocalPoint = [
    Math.cos(turn) * eastInPlane[0] + Math.sin(turn) * northInPlane[0],
    Math.cos(turn) * eastInPlane[1] + Math.sin(turn) * northInPlane[1],
    Math.cos(turn) * eastInPlane[2] + Math.sin(turn) * northInPlane[2],
  ]
  return [x, cross(z, x), z]
}
