import type { Position } from 'geojson'

import { distanceMeters, unwrapLongitudeNear } from './geometry.js'
import { bearingDegrees, destination, extrusionHeightOf, shapeOf, type ShapeDescription } from './shapes.js'
import type { DrawFeature, LongitudeLatitude } from './types.js'

/** Every position of a feature, closing positions included. */
function allPositions(feature: DrawFeature): Position[] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [geometry.coordinates]
  if (geometry.type === 'LineString') return geometry.coordinates
  return geometry.coordinates.flat()
}

/** The feature with every position mapped (altitudes kept), closing positions included. */
function mapPositions(feature: DrawFeature, map: (position: Position) => LongitudeLatitude): DrawFeature {
  const move = (position: Position): Position => {
    const [longitude, latitude] = map(position)
    return position.length > 2 ? [longitude, latitude, position[2]!] : [longitude, latitude]
  }
  const geometry = feature.geometry
  if (geometry.type === 'Point') return { ...feature, geometry: { type: 'Point', coordinates: move(geometry.coordinates) } }
  if (geometry.type === 'LineString') return { ...feature, geometry: { type: 'LineString', coordinates: geometry.coordinates.map(move) } }
  return { ...feature, geometry: { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(move)) } }
}

function withShape(feature: DrawFeature, shape: ShapeDescription): DrawFeature {
  return { ...feature, properties: { ...feature.properties, shape } }
}

/**
 * The point a feature turns and scales around: a shape's center, a point's position, or else the average of its
 * vertices (longitudes unwrapped, so it holds over the antimeridian). Turning or scaling a feature around it leaves
 * it in place, so repeated turns keep the same pivot.
 */
export function featureCenter(feature: DrawFeature): LongitudeLatitude {
  const shape = shapeOf(feature)
  if (shape !== null) return [shape.center[0], shape.center[1]]
  const geometry = feature.geometry
  // Each vertex once: a polygon ring's closing position repeats its first.
  const positions = geometry.type === 'Polygon' ? (geometry.coordinates[0] ?? []).slice(0, -1) : allPositions(feature)
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

/** The turn a feature's shape already has (rectangles, ellipses, regular polygons), in degrees clockwise from north; else 0. */
export function featureRotationDegrees(feature: DrawFeature): number {
  const shape = shapeOf(feature)
  return shape !== null && 'rotationDegrees' in shape ? shape.rotationDegrees : 0
}

/**
 * The feature turned by `angleDegrees` clockwise around `center`: every position keeps its distance in metres from
 * the center, so shapes keep their size. A shape's `rotationDegrees` turns with it.
 */
export function rotateFeature(feature: DrawFeature, center: LongitudeLatitude, angleDegrees: number): DrawFeature {
  if (angleDegrees % 360 === 0) return feature
  const rotated = mapPositions(feature, position => {
    const distance = distanceMeters(center, position)
    return distance === 0 ? [position[0]!, position[1]!] : destination(center, distance, bearingDegrees(center, position) + angleDegrees)
  })
  const shape = shapeOf(feature)
  if (shape === null) return rotated
  const centerMoved = distanceMeters(center, shape.center) > 0
  const newCenter: LongitudeLatitude = centerMoved ? destination(center, distanceMeters(center, shape.center), bearingDegrees(center, shape.center) + angleDegrees) : [shape.center[0], shape.center[1]]
  const turned = 'rotationDegrees' in shape ? { ...shape, center: newCenter, rotationDegrees: (((shape.rotationDegrees + angleDegrees) % 360) + 360) % 360 } : { ...shape, center: newCenter }
  return withShape(rotated, turned)
}

/**
 * The feature scaled by `factor` around `center`: every position's distance in metres from the center is multiplied.
 * A shape's measurements (radius, width, length, axes) scale with it; a sphere's radius too. Heights are kept.
 */
export function scaleFeature(feature: DrawFeature, center: LongitudeLatitude, factor: number): DrawFeature {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`scaleFeature: factor is ${factor}; give a positive number.`)
  if (factor === 1) return feature
  const scaled = mapPositions(feature, position => {
    const distance = distanceMeters(center, position)
    return distance === 0 ? [position[0]!, position[1]!] : destination(center, distance * factor, bearingDegrees(center, position))
  })
  const shape = shapeOf(feature)
  if (shape === null) return scaled
  const shapeDistance = distanceMeters(center, shape.center)
  const newCenter: LongitudeLatitude = shapeDistance > 0 ? destination(center, shapeDistance * factor, bearingDegrees(center, shape.center)) : [shape.center[0], shape.center[1]]
  let next: ShapeDescription
  switch (shape.type) {
    case 'circle':
    case 'sphere':
    case 'regular-polygon':
      next = { ...shape, center: newCenter, radiusMeters: shape.radiusMeters * factor }
      break
    case 'rectangle':
      next = { ...shape, center: newCenter, widthMeters: shape.widthMeters * factor, lengthMeters: shape.lengthMeters * factor }
      break
    case 'ellipse':
      next = { ...shape, center: newCenter, semiMajorAxisMeters: shape.semiMajorAxisMeters * factor, semiMinorAxisMeters: shape.semiMinorAxisMeters * factor }
      break
  }
  return withShape(scaled, next)
}

/** The feature extruded `heightMeters` tall (`properties.extrusionHeightMeters`); 0 or less removes the extrusion. */
export function setExtrusionHeight(feature: DrawFeature, heightMeters: number): DrawFeature {
  const { extrusionHeightMeters: _previous, ...rest } = feature.properties ?? {}
  return { ...feature, properties: heightMeters > 0 ? { ...rest, extrusionHeightMeters: heightMeters } : rest }
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
  /** The turn of the frame (the shape's rotation), degrees clockwise from north. */
  rotationDegrees: number
  /** Corners of the box around the feature, in the frame: scale handles. Empty for points. */
  corners: LongitudeLatitude[]
  /**
   * The middles of the box's edges (bottom, right, top, left): stretch handles. None for points and spheres, nor on an
   * axis the feature does not extend along (across a straight line).
   */
  sideHandles: TransformSideHandle[]
  /** The rotation knob, beyond the box's top edge. Null for points, circles and spheres (which do not turn). */
  rotationHandle: LongitudeLatitude | null
  /** The feature's extrusion height (0 when it has none). */
  extrusionHeightMeters: number
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
 * Where a feature's gizmo handles go: a box around it, turned with its shape, with a scale handle at each corner, a
 * stretch handle in the middle of each edge, and a rotation knob a quarter of its length beyond the top edge.
 */
export function transformFrame(feature: DrawFeature): TransformFrame {
  const center = featureCenter(feature)
  const rotationDegrees = featureRotationDegrees(feature)
  const extrusionHeightMeters = extrusionHeightOf(feature)
  const shape = shapeOf(feature)
  let minimumX = Infinity
  let maximumX = -Infinity
  let minimumY = Infinity
  let maximumY = -Infinity
  const include = (x: number, y: number) => {
    minimumX = Math.min(minimumX, x)
    maximumX = Math.max(maximumX, x)
    minimumY = Math.min(minimumY, y)
    maximumY = Math.max(maximumY, y)
  }
  if (feature.geometry.type === 'Point') {
    if (shape?.type !== 'sphere') return { center, rotationDegrees, corners: [], sideHandles: [], rotationHandle: null, extrusionHeightMeters }
    include(-shape.radiusMeters, -shape.radiusMeters)
    include(shape.radiusMeters, shape.radiusMeters)
  } else {
    for (const position of allPositions(feature)) include(...positionInFrame(center, position, rotationDegrees))
  }
  const corners = [
    fromFrame(center, minimumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, maximumY, rotationDegrees),
    fromFrame(center, minimumX, maximumY, rotationDegrees),
  ]
  const sideHandles: TransformSideHandle[] = []
  // Spheres stay round: they scale, but do not stretch.
  if (feature.geometry.type !== 'Point') {
    const middleX = (minimumX + maximumX) / 2
    const middleY = (minimumY + maximumY) / 2
    const bottom = fromFrame(center, middleX, minimumY, rotationDegrees)
    const right = fromFrame(center, maximumX, middleY, rotationDegrees)
    const top = fromFrame(center, middleX, maximumY, rotationDegrees)
    const left = fromFrame(center, minimumX, middleY, rotationDegrees)
    const largest = Math.max(maximumX - minimumX, maximumY - minimumY)
    const hasLength = maximumY - minimumY > largest * MINIMUM_EXTENT_FRACTION
    const hasWidth = maximumX - minimumX > largest * MINIMUM_EXTENT_FRACTION
    if (hasLength) {
      sideHandles.push({ position: bottom, oppositePosition: top, axis: 'along', sideMeters: minimumY, fixedMeters: maximumY })
    }
    if (hasWidth) {
      sideHandles.push({ position: right, oppositePosition: left, axis: 'across', sideMeters: maximumX, fixedMeters: minimumX })
    }
    if (hasLength) {
      sideHandles.push({ position: top, oppositePosition: bottom, axis: 'along', sideMeters: maximumY, fixedMeters: minimumY })
    }
    if (hasWidth) {
      sideHandles.push({ position: left, oppositePosition: right, axis: 'across', sideMeters: minimumX, fixedMeters: maximumX })
    }
  }
  const length = Math.max(maximumY - minimumY, maximumX - minimumX)
  const rotationHandle = shape?.type === 'sphere' || shape?.type === 'circle' ? null : fromFrame(center, (minimumX + maximumX) / 2, maximumY + length * 0.25, rotationDegrees)
  return { center, rotationDegrees, corners, sideHandles, rotationHandle, extrusionHeightMeters }
}

/**
 * The feature stretched by `factor` along one axis of a frame (`frame.center`, turned `frame.rotationDegrees`), keeping
 * the line `fixedMeters` from the center on that axis where it is: each position's distance from that line, in metres,
 * is multiplied. Dragging one side of the gizmo's box this way keeps the opposite side fixed.
 *
 * Shapes stay what they can: a rectangle gets a new width (across) or length (along) and center; a circle becomes an
 * ellipse, and an ellipse keeps being one, with new semi-axes (`semiMajorAxisMeters` is the one along the rotation). A
 * regular polygon is no longer regular: it loses `properties.shape`. Points and spheres are returned unchanged.
 * Altitudes and the extrusion are kept.
 */
export function stretchFeature(feature: DrawFeature, frame: Pick<TransformFrame, 'center' | 'rotationDegrees'>, axis: TransformAxis, fixedMeters: number, factor: number): DrawFeature {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`stretchFeature: factor is ${factor}; give a positive number.`)
  if (factor === 1 || feature.geometry.type === 'Point') return feature
  const { center, rotationDegrees } = frame
  const stretch = (x: number, y: number): LongitudeLatitude =>
    axis === 'across' ? fromFrame(center, fixedMeters + (x - fixedMeters) * factor, y, rotationDegrees) : fromFrame(center, x, fixedMeters + (y - fixedMeters) * factor, rotationDegrees)
  const stretched = mapPositions(feature, position => stretch(...positionInFrame(center, position, rotationDegrees)))
  const shape = shapeOf(feature)
  if (shape === null) return stretched
  const newCenter = stretch(...positionInFrame(center, shape.center, rotationDegrees))
  // The frame is turned with the shape, so its axes are the shape's.
  const turn = (((featureRotationDegrees(feature) - rotationDegrees) % 180) + 180) % 180
  const aligned = Math.min(turn, 180 - turn) < 1e-9
  switch (shape.type) {
    case 'rectangle':
      if (!aligned) break
      return withShape(stretched, axis === 'across' ? { ...shape, center: newCenter, widthMeters: shape.widthMeters * factor } : { ...shape, center: newCenter, lengthMeters: shape.lengthMeters * factor })
    case 'circle': {
      const across = axis === 'across' ? shape.radiusMeters * factor : shape.radiusMeters
      const along = axis === 'along' ? shape.radiusMeters * factor : shape.radiusMeters
      return withShape(stretched, { type: 'ellipse', center: newCenter, semiMajorAxisMeters: along, semiMinorAxisMeters: across, rotationDegrees: ((rotationDegrees % 360) + 360) % 360 })
    }
    case 'ellipse':
      if (!aligned) break
      return withShape(stretched, axis === 'across' ? { ...shape, center: newCenter, semiMinorAxisMeters: shape.semiMinorAxisMeters * factor } : { ...shape, center: newCenter, semiMajorAxisMeters: shape.semiMajorAxisMeters * factor })
    default:
      break
  }
  // No longer that shape: a plain polygon.
  const { shape: _shape, ...properties } = stretched.properties ?? {}
  return { ...stretched, properties }
}

/** The terrain's height under a position, in metres above the WGS84 ellipsoid. */
export type GroundHeight = (longitudeDegrees: number, latitudeDegrees: number) => number

/**
 * The feature moved up by `deltaMeters` (down when negative): every position gets a third coordinate, its altitude
 * above the WGS84 ellipsoid, as GeoJSON allows. Positions that already have one rise by `deltaMeters`; positions on the
 * terrain start from the terrain's height under them (`groundHeightMeters`: one height, or the height under each
 * position, so a lifted shape keeps the relief's offsets), and a sphere resting on the terrain from there plus its
 * radius (an altitude is a sphere's center). The extrusion is kept: a solid floats up whole.
 */
export function liftFeature(feature: DrawFeature, deltaMeters: number, groundHeightMeters: number | GroundHeight = 0): DrawFeature {
  if (!Number.isFinite(deltaMeters)) throw new Error(`liftFeature: deltaMeters is ${deltaMeters}; give a finite number of metres.`)
  const ground: GroundHeight = typeof groundHeightMeters === 'number' ? () => groundHeightMeters : groundHeightMeters
  const shape = shapeOf(feature)
  const above = shape?.type === 'sphere' ? shape.radiusMeters : 0
  const lift = (position: Position): Position => {
    const start = position.length > 2 && Number.isFinite(position[2]) ? position[2]! : ground(position[0]!, position[1]!) + above
    if (!Number.isFinite(start)) throw new Error(`liftFeature: no terrain height at ${position[0]}, ${position[1]}; give groundHeightMeters a finite number of metres.`)
    return [position[0]!, position[1]!, start + deltaMeters]
  }
  const geometry = feature.geometry
  if (geometry.type === 'Point') return { ...feature, geometry: { type: 'Point', coordinates: lift(geometry.coordinates) } }
  if (geometry.type === 'LineString') return { ...feature, geometry: { type: 'LineString', coordinates: geometry.coordinates.map(lift) } }
  return { ...feature, geometry: { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(lift)) } }
}

/** The feature without altitudes (third coordinates): back on the terrain, where it drapes or stands. */
export function placeOnTerrain(feature: DrawFeature): DrawFeature {
  const flat = (position: Position): Position => (position.length > 2 ? [position[0]!, position[1]!] : position)
  const geometry = feature.geometry
  if (geometry.type === 'Point') return { ...feature, geometry: { type: 'Point', coordinates: flat(geometry.coordinates) } }
  if (geometry.type === 'LineString') return { ...feature, geometry: { type: 'LineString', coordinates: geometry.coordinates.map(flat) } }
  return { ...feature, geometry: { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(flat)) } }
}

/**
 * The altitude of a feature's base: the first third coordinate among its positions (for a sphere, its center less its
 * radius), or null for a feature on the terrain. A feature with any altitude stands at it, as `isSolidFeature` says.
 */
export function baseAltitudeOf(feature: DrawFeature): number | null {
  const altitude = firstAltitudeOf(feature)
  if (altitude === null) return null
  const shape = shapeOf(feature)
  return altitude - (shape?.type === 'sphere' ? shape.radiusMeters : 0)
}

/** The first third coordinate among a feature's positions (a sphere's center), or null when none has one. */
export function firstAltitudeOf(feature: DrawFeature): number | null {
  const geometry = feature.geometry
  if (geometry.type === 'Point') {
    const position = geometry.coordinates
    return position.length > 2 && Number.isFinite(position[2]) ? position[2]! : null
  }
  const rings = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
  for (const ring of rings) for (const position of ring) if (position.length > 2 && Number.isFinite(position[2])) return position[2]!
  return null
}
