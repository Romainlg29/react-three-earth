import type { MultiPolygon, Polygon, Position } from 'geojson'

import { closeRing, EARTH_RADIUS_METERS } from './geometry.js'
import { prismMesh, sphereMesh, type SphereMeshOptions } from './mesh.js'
import type { DrawFeature, GroundHeight, LongitudeLatitude } from './types.js'

const DEGREES = Math.PI / 180

/** A feature made by a shape builder, ready for `draw.addFeatures`: its id is optional. */
export type ShapeFeature<G extends Polygon | MultiPolygon = Polygon | MultiPolygon> = Omit<DrawFeature<G>, 'id'> & { id?: string }

/** Options shared by the shape builders. */
export interface ShapeOptions {
  /**
   * Altitude of the shape's base above the WGS84 ellipsoid, in metres: one for every vertex, or the terrain's height
   * under each (a function of longitude and latitude). Without `heightMeters` it is written as the third coordinate of
   * every position, a flat polygon at that altitude. Default: none, a flat polygon draped on the terrain (with
   * `heightMeters`: 0).
   */
  baseHeightMeters?: number | GroundHeight
  /**
   * Makes the shape a closed prism mesh (a circle a cylinder, a rectangle a box): its bottom at the base, its level top
   * this many metres above the highest base vertex. Default: none, a flat polygon.
   */
  heightMeters?: number
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

/** The altitude `baseHeightMeters` gives a position (0 without one). */
function baseHeightOf(baseHeightMeters: number | GroundHeight | undefined): (position: Position) => number {
  if (baseHeightMeters === undefined) return () => 0
  if (typeof baseHeightMeters === 'number') return () => baseHeightMeters
  return position => baseHeightMeters(position[0]!, position[1]!)
}

/**
 * The feature of a ring: a flat polygon (draped, or at the base altitude when one is given) or, with `heightMeters`, a
 * prism mesh.
 */
function polygonFeature(ring: LongitudeLatitude[], options: ShapeOptions): ShapeFeature {
  const properties: Record<string, unknown> = { ...options.properties }
  let geometry: Polygon | MultiPolygon
  if (options.heightMeters !== undefined) geometry = prismMesh([ring], baseHeightOf(options.baseHeightMeters), options.heightMeters)
  else if (options.baseHeightMeters !== undefined) {
    const base = baseHeightOf(options.baseHeightMeters)
    geometry = { type: 'Polygon', coordinates: [closeRing(ring).map(position => [position[0], position[1], base(position)])] }
  } else geometry = { type: 'Polygon', coordinates: [closeRing(ring)] }
  const feature = { type: 'Feature' as const, properties, geometry }
  return options.id === undefined ? feature : { ...feature, id: options.id }
}

/** The outline of an ellipse, counter-clockwise (as GeoJSON exterior rings should be), not closed. */
export function ellipseRing(center: LongitudeLatitude, semiMajorAxisMeters: number, semiMinorAxisMeters: number, rotationDegrees = 0, steps = 64): LongitudeLatitude[] {
  const ring: LongitudeLatitude[] = []
  for (let step = 0; step < steps; step++) {
    const angle = (step / steps) * 2 * Math.PI
    // x across (the "minor" semi-axis), y along (the "major" one, towards the rotation); either may be the longer.
    const [east, north] = rotate(semiMinorAxisMeters * Math.cos(angle), semiMajorAxisMeters * Math.sin(angle), rotationDegrees)
    ring.push(offset(center, east, north))
  }
  return ring
}

/** A circle on the ground, as a polygon with `steps` vertices; with `heightMeters`, a cylinder mesh. */
export function createCircle(center: LongitudeLatitude, radiusMeters: number, options: RoundShapeOptions = {}): ShapeFeature {
  requirePositive('createCircle', 'radiusMeters', radiusMeters)
  const ring = ellipseRing(center, radiusMeters, radiusMeters, 0, options.steps ?? 64)
  return polygonFeature(ring, options)
}

/**
 * An ellipse on the ground: `semiMajorAxisMeters` along `rotationDegrees` (0: north), `semiMinorAxisMeters` across it.
 * Nothing requires the first to be the longer.
 */
export function createEllipse(
  center: LongitudeLatitude,
  semiMajorAxisMeters: number,
  semiMinorAxisMeters: number,
  { rotationDegrees = 0, ...options }: RoundShapeOptions & { rotationDegrees?: number } = {},
): ShapeFeature {
  requirePositive('createEllipse', 'semiMajorAxisMeters', semiMajorAxisMeters)
  requirePositive('createEllipse', 'semiMinorAxisMeters', semiMinorAxisMeters)
  const ring = ellipseRing(center, semiMajorAxisMeters, semiMinorAxisMeters, rotationDegrees, options.steps ?? 64)
  return polygonFeature(ring, options)
}

/** A rectangle on the ground, `widthMeters` across and `lengthMeters` along `rotationDegrees` (0: north); with `heightMeters`, a box mesh. */
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
  return polygonFeature(ring, options)
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
  return polygonFeature(ring, options)
}

/** Options of `createSphere`. */
export interface SphereOptions extends SphereMeshOptions {
  /**
   * Altitude of the sphere's lowest point above the WGS84 ellipsoid, in metres, or the terrain's height under its center
   * (a function of longitude and latitude): it rests there. Default: 0.
   */
  baseHeightMeters?: number | GroundHeight
  /** Other properties of the feature. */
  properties?: Record<string, unknown>
  /** The feature's id. Default: none (`draw.addFeatures` gives one). */
  id?: string
}

/** A sphere of `radiusMeters` resting on its base altitude: a closed UV sphere mesh (see `sphereMesh`). */
export function createSphere(center: LongitudeLatitude, radiusMeters: number, { baseHeightMeters, properties, id, ...mesh }: SphereOptions = {}): ShapeFeature<MultiPolygon> {
  requirePositive('createSphere', 'radiusMeters', radiusMeters)
  const base = baseHeightOf(baseHeightMeters)(center)
  const feature = { type: 'Feature' as const, properties: { ...properties }, geometry: sphereMesh(center, radiusMeters, base + radiusMeters, mesh) }
  return id === undefined ? feature : { ...feature, id }
}

function requirePositive(name: string, parameter: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name}: ${parameter} is ${value}; give a positive number of metres.`)
}
