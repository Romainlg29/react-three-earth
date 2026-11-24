import type { Point, Polygon, Position } from 'geojson'

import { closeRing, EARTH_RADIUS_METERS } from './geometry.js'
import type { DrawFeature, LongitudeLatitude } from './types.js'

const DEGREES = Math.PI / 180

/**
 * What a shape was made from, kept in `feature.properties.shape` so a shape can be rebuilt (resized, edited) from its
 * measurements rather than from its outline. Lengths are metres on the ground, angles degrees clockwise from north.
 */
export type ShapeDescription =
  | { type: 'circle'; center: LongitudeLatitude; radiusMeters: number }
  | { type: 'ellipse'; center: LongitudeLatitude; semiMajorAxisMeters: number; semiMinorAxisMeters: number; rotationDegrees: number }
  | { type: 'rectangle'; center: LongitudeLatitude; widthMeters: number; lengthMeters: number; rotationDegrees: number }
  | { type: 'regular-polygon'; center: LongitudeLatitude; radiusMeters: number; sides: number; rotationDegrees: number }
  | { type: 'sphere'; center: LongitudeLatitude; radiusMeters: number }

/** A feature made by a shape builder, ready for `draw.addFeatures`: its id is optional. */
export type ShapeFeature<G extends Polygon | Point = Polygon> = Omit<DrawFeature<G>, 'id'> & { id?: string }

/** Options shared by the shape builders. */
export interface ShapeOptions {
  /**
   * Height of the shape's base above the WGS84 ellipsoid, in metres: written as the third coordinate of every position
   * (GeoJSON altitude). Default: none, so the shape sits on the terrain.
   */
  baseHeightMeters?: number
  /** Extrudes the shape into a solid this many metres tall (a circle into a cylinder, a rectangle into a box). Default: none. */
  extrusionHeightMeters?: number
  /** Other properties of the feature. */
  properties?: Record<string, unknown>
  /** The feature's id. Default: none (`draw.addFeatures` gives one). */
  id?: string
}

/** Options of round shapes. */
export interface RoundShapeOptions extends ShapeOptions {
  /** Vertices around the outline. Default: 64. */
  steps?: number
}

/** The position `distanceMeters` along the ground from `origin`, towards `bearingDegrees` (clockwise from north). */
export function destination(origin: readonly number[], distanceMeters: number, bearingDegrees: number): LongitudeLatitude {
  const angular = distanceMeters / EARTH_RADIUS_METERS
  const bearing = bearingDegrees * DEGREES
  const latitude1 = origin[1]! * DEGREES
  const longitude1 = origin[0]! * DEGREES
  const latitude2 = Math.asin(Math.sin(latitude1) * Math.cos(angular) + Math.cos(latitude1) * Math.sin(angular) * Math.cos(bearing))
  const longitude2 = longitude1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude1), Math.cos(angular) - Math.sin(latitude1) * Math.sin(latitude2))
  // Unwrapped: a shape over the antimeridian keeps continuous longitudes, as drawn.
  return [longitude2 / DEGREES, latitude2 / DEGREES]
}

/** Initial bearing from one position to another, in degrees clockwise from north. */
export function bearingDegrees(from: readonly number[], to: readonly number[]): number {
  const latitude1 = from[1]! * DEGREES
  const latitude2 = to[1]! * DEGREES
  const deltaLongitude = (to[0]! - from[0]!) * DEGREES
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2)
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude)
  return ((Math.atan2(y, x) / DEGREES) % 360 + 360) % 360
}

/** The position `eastMeters` east and `northMeters` north of `center`, on the ground. */
function offset(center: LongitudeLatitude, eastMeters: number, northMeters: number): LongitudeLatitude {
  const distance = Math.hypot(eastMeters, northMeters)
  return distance === 0 ? [center[0], center[1]] : destination(center, distance, Math.atan2(eastMeters, northMeters) / DEGREES)
}

/** Turns a point in the shape's frame (x across, y along) by `rotationDegrees` clockwise. */
function rotate(x: number, y: number, rotationDegrees: number): [east: number, north: number] {
  const angle = rotationDegrees * DEGREES
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [x * cos + y * sin, -x * sin + y * cos]
}

function withHeight(ring: LongitudeLatitude[], baseHeightMeters: number | undefined): Position[] {
  return baseHeightMeters === undefined ? ring : ring.map(([longitude, latitude]) => [longitude, latitude, baseHeightMeters])
}

function polygonFeature(ring: LongitudeLatitude[], shape: ShapeDescription, options: ShapeOptions): ShapeFeature {
  const properties: Record<string, unknown> = { ...options.properties, shape }
  if (options.extrusionHeightMeters !== undefined) properties.extrusionHeightMeters = options.extrusionHeightMeters
  const feature = { type: 'Feature' as const, properties, geometry: { type: 'Polygon' as const, coordinates: [withHeight(closeRing(ring), options.baseHeightMeters)] } }
  return options.id === undefined ? feature : { ...feature, id: options.id }
}

/** The outline of an ellipse, counter-clockwise (as GeoJSON exterior rings should be), not closed. */
export function ellipseRing(center: LongitudeLatitude, semiMajorAxisMeters: number, semiMinorAxisMeters: number, rotationDegrees = 0, steps = 64): LongitudeLatitude[] {
  const ring: LongitudeLatitude[] = []
  for (let step = 0; step < steps; step++) {
    const angle = (step / steps) * 2 * Math.PI
    // x across (minor axis), y along (major axis, towards the rotation).
    const [east, north] = rotate(semiMinorAxisMeters * Math.cos(angle), semiMajorAxisMeters * Math.sin(angle), rotationDegrees)
    ring.push(offset(center, east, north))
  }
  return ring
}

/** A circle on the ground, as a polygon with `steps` vertices. */
export function createCircle(center: LongitudeLatitude, radiusMeters: number, options: RoundShapeOptions = {}): ShapeFeature {
  requirePositive('createCircle', 'radiusMeters', radiusMeters)
  const ring = ellipseRing(center, radiusMeters, radiusMeters, 0, options.steps ?? 64)
  return polygonFeature(ring, { type: 'circle', center: [center[0], center[1]], radiusMeters }, options)
}

/** An ellipse on the ground; its major axis points towards `rotationDegrees` (0: north). */
export function createEllipse(
  center: LongitudeLatitude,
  semiMajorAxisMeters: number,
  semiMinorAxisMeters: number,
  { rotationDegrees = 0, ...options }: RoundShapeOptions & { rotationDegrees?: number } = {},
): ShapeFeature {
  requirePositive('createEllipse', 'semiMajorAxisMeters', semiMajorAxisMeters)
  requirePositive('createEllipse', 'semiMinorAxisMeters', semiMinorAxisMeters)
  const ring = ellipseRing(center, semiMajorAxisMeters, semiMinorAxisMeters, rotationDegrees, options.steps ?? 64)
  return polygonFeature(ring, { type: 'ellipse', center: [center[0], center[1]], semiMajorAxisMeters, semiMinorAxisMeters, rotationDegrees }, options)
}

/** A rectangle on the ground, `widthMeters` across and `lengthMeters` along `rotationDegrees` (0: north). */
export function createRectangle(
  center: LongitudeLatitude,
  widthMeters: number,
  lengthMeters: number,
  { rotationDegrees = 0, ...options }: ShapeOptions & { rotationDegrees?: number } = {},
): ShapeFeature {
  requirePositive('createRectangle', 'widthMeters', widthMeters)
  requirePositive('createRectangle', 'lengthMeters', lengthMeters)
  const halfWidth = widthMeters / 2
  const halfLength = lengthMeters / 2
  // Counter-clockwise from the south-west corner.
  const corners: Array<[number, number]> = [[-halfWidth, -halfLength], [halfWidth, -halfLength], [halfWidth, halfLength], [-halfWidth, halfLength]]
  const ring = corners.map(([x, y]) => offset(center, ...rotate(x, y, rotationDegrees)))
  return polygonFeature(ring, { type: 'rectangle', center: [center[0], center[1]], widthMeters, lengthMeters, rotationDegrees }, options)
}

/** A regular polygon (triangle, hexagon…) whose vertices are `radiusMeters` from the center, the first towards `rotationDegrees`. */
export function createRegularPolygon(
  center: LongitudeLatitude,
  radiusMeters: number,
  sides: number,
  { rotationDegrees = 0, ...options }: ShapeOptions & { rotationDegrees?: number } = {},
): ShapeFeature {
  requirePositive('createRegularPolygon', 'radiusMeters', radiusMeters)
  if (!Number.isInteger(sides) || sides < 3) throw new Error(`createRegularPolygon: sides is ${sides}; give a whole number of 3 or more.`)
  const ring: LongitudeLatitude[] = []
  // Counter-clockwise: bearings decrease.
  for (let side = 0; side < sides; side++) ring.push(destination(center, radiusMeters, rotationDegrees - (side / sides) * 360))
  return polygonFeature(ring, { type: 'regular-polygon', center: [center[0], center[1]], radiusMeters, sides, rotationDegrees }, options)
}

/**
 * A sphere: a point feature drawn as a 3D ball of `radiusMeters`. Its center is `baseHeightMeters` above the ellipsoid
 * when given; without it the ball rests on the terrain.
 */
export function createSphere(center: LongitudeLatitude, radiusMeters: number, options: Omit<ShapeOptions, 'extrusionHeightMeters'> = {}): ShapeFeature<Point> {
  requirePositive('createSphere', 'radiusMeters', radiusMeters)
  const shape: ShapeDescription = { type: 'sphere', center: [center[0], center[1]], radiusMeters }
  const coordinates: Position = options.baseHeightMeters === undefined ? [center[0], center[1]] : [center[0], center[1], options.baseHeightMeters]
  const feature = { type: 'Feature' as const, properties: { ...options.properties, shape }, geometry: { type: 'Point' as const, coordinates } }
  return options.id === undefined ? feature : { ...feature, id: options.id }
}

/** The shape a feature was made from, or null for a plain feature. */
export function shapeOf(feature: Pick<DrawFeature, 'properties'>): ShapeDescription | null {
  const shape = feature.properties?.shape as ShapeDescription | undefined
  return shape !== undefined && shape !== null && typeof shape === 'object' && typeof shape.type === 'string' ? shape : null
}

/** A feature's extrusion height (`properties.extrusionHeightMeters`), or 0. */
export function extrusionHeightOf(feature: Pick<DrawFeature, 'properties'>): number {
  const height = feature.properties?.extrusionHeightMeters
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0
}

function requirePositive(name: string, parameter: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name}: ${parameter} is ${value}; give a positive number of metres.`)
}
