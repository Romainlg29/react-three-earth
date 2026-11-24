import type { Position } from 'geojson'

import { distanceMeters, hasAltitude, mapGeometryPositions, storedPositions, unwrapLongitudeNear } from './geometry.js'
import { isMeshGeometry, meshAltitudeRange, meshTop, openRing, prismMesh, setMeshTop, wallMesh } from './mesh.js'
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
  const hull = convexHull(footprintVertices(feature).map(position => positionInFrame(center, position, 0)))
  if (hull.length < 2) return 0
  const areaAt = (rotationDegrees: number) => {
    let minimumX = Infinity
    let maximumX = -Infinity
    let minimumY = Infinity
    let maximumY = -Infinity
    for (const [east, north] of hull) {
      const [x, y] = toFrame(east, north, rotationDegrees)
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
  const northArea = bestArea
  for (let index = 0; index < hull.length; index++) {
    const [ax, ay] = hull[index]!
    const [bx, by] = hull[(index + 1) % hull.length]!
    if (ax === bx && ay === by) continue
    // The frame's x axis along the edge: its angle from east, counter-clockwise, is minus the turn.
    const rotation = normalizeQuarterTurn((-Math.atan2(by - ay, bx - ax) * 180) / Math.PI)
    const area = areaAt(rotation)
    if (area < bestArea - Math.abs(bestArea) * 1e-12) {
      best = rotation
      bestArea = area
    }
  }
  if (northArea > 0 && northArea <= bestArea + Math.abs(bestArea) * NORTH_PREFERENCE) return 0
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
  // Each polygon's highest base, so every prism's top lands at one altitude.
  const highest = geometry.coordinates.map(polygon => Math.max(...openRing(polygon[0] ?? []).map(base)))
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
  const altitudes = altitudeRange(feature)
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

/** The lowest and highest altitudes among a feature's positions, or null when none has one. */
function altitudeRange(feature: DrawFeature): { minimumMeters: number; maximumMeters: number } | null {
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
  return altitudeRange(feature)?.minimumMeters ?? null
}
