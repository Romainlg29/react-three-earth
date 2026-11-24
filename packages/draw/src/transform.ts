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

/** The gizmo of a feature, in geographic positions: where its handles go. */
export interface TransformFrame {
  center: LongitudeLatitude
  /** The turn of the frame (the shape's rotation), degrees clockwise from north. */
  rotationDegrees: number
  /** Corners of the box around the feature, in the frame: scale handles. Empty for points. */
  corners: LongitudeLatitude[]
  /** The rotation knob, beyond the box's top edge. Null for points and spheres (which do not turn). */
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

/**
 * Where a feature's gizmo handles go: a box around it, turned with its shape, with a scale handle at each corner and a
 * rotation knob a quarter of its length beyond the top edge.
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
    if (shape?.type !== 'sphere') return { center, rotationDegrees, corners: [], rotationHandle: null, extrusionHeightMeters }
    include(-shape.radiusMeters, -shape.radiusMeters)
    include(shape.radiusMeters, shape.radiusMeters)
  } else {
    for (const position of allPositions(feature)) {
      const distance = distanceMeters(center, position)
      const bearing = (bearingDegrees(center, position) * Math.PI) / 180
      include(...toFrame(distance * Math.sin(bearing), distance * Math.cos(bearing), rotationDegrees))
    }
  }
  const corners = [
    fromFrame(center, minimumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, minimumY, rotationDegrees),
    fromFrame(center, maximumX, maximumY, rotationDegrees),
    fromFrame(center, minimumX, maximumY, rotationDegrees),
  ]
  const length = Math.max(maximumY - minimumY, maximumX - minimumX)
  const rotationHandle = shape?.type === 'sphere' || shape?.type === 'circle' ? null : fromFrame(center, (minimumX + maximumX) / 2, maximumY + length * 0.25, rotationDegrees)
  return { center, rotationDegrees, corners, rotationHandle, extrusionHeightMeters }
}
