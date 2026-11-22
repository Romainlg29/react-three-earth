import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Vector3, type Ray } from 'three'

/** A point on the screen, in CSS pixels from the canvas's top-left corner. */
export interface ScreenPosition {
  xPixels: number
  yPixels: number
}

/** Where a geographic position lands on the screen. */
export interface ProjectedPosition extends ScreenPosition {
  /** In front of the camera, inside the viewport and not behind the globe's horizon. */
  visible: boolean
}

const scaledCamera = new Vector3()
const scaledPoint = new Vector3()
const closestPoint = new Vector3()

/**
 * True when the WGS84 ellipsoid hides `point` from `cameraPosition` (both ECEF metres): the point lies
 * beyond the horizon. Exact for points on the ellipsoid, conservative for points above it. Terrain is not
 * taken into account. From Cesium's ellipsoidal occluder: in a frame where the ellipsoid is the unit sphere,
 * a point is hidden when it is behind the horizon plane and inside the cone that the sphere casts.
 */
export function isOccludedByEllipsoid(cameraPosition: Vector3, point: Vector3): boolean {
  const radius = WGS84_ELLIPSOID.radius
  scaledCamera.copy(cameraPosition).divide(radius)
  scaledPoint.copy(point).divide(radius)
  const horizonDistanceSquared = scaledCamera.lengthSq() - 1
  if (horizonDistanceSquared <= 0) return false // the camera is inside the ellipsoid
  const toPoint = scaledPoint.sub(scaledCamera)
  const alongCamera = -toPoint.dot(scaledCamera)
  return alongCamera > horizonDistanceSquared && (alongCamera * alongCamera) / toPoint.lengthSq() > horizonDistanceSquared
}

/**
 * The ellipsoid point where `ray` meets the WGS84 ellipsoid, or, when it misses, the surface point under
 * the ray's closest approach to the Earth: about where the ray grazes the horizon. Returns null only when
 * the ray points away from the Earth.
 */
export function intersectEllipsoidOrHorizon(ray: Ray, target: Vector3): { point: Vector3; hit: boolean } | null {
  if (WGS84_ELLIPSOID.intersectRay(ray, target) !== null) return { point: target, hit: true }
  const along = -ray.origin.dot(ray.direction)
  if (along <= 0) return null
  ray.at(along, closestPoint)
  WGS84_ELLIPSOID.getPositionToSurfacePoint(closestPoint, target)
  return { point: target, hit: false }
}

/**
 * Heading (clockwise from north) and pitch (below the horizon, negative looks down) of a camera, in
 * radians, in a local frame. Looking steeply down or up, the heading comes from screen-up, so it stays
 * defined when looking straight down.
 */
export function headingAndPitch(
  forward: Vector3,
  cameraUp: Vector3,
  east: Vector3,
  north: Vector3,
  up: Vector3,
): { headingRadians: number; pitchRadians: number } {
  const pitchRadians = Math.asin(Math.min(1, Math.max(-1, forward.dot(up))))
  // Screen-up leans along the heading when looking down, against it when looking up.
  const steep = Math.abs(pitchRadians) > Math.PI / 4
  const sign = pitchRadians < 0 ? 1 : -1
  const eastward = steep ? sign * cameraUp.dot(east) : forward.dot(east)
  const northward = steep ? sign * cameraUp.dot(north) : forward.dot(north)
  return { headingRadians: Math.atan2(eastward, northward), pitchRadians }
}

/** Brings degrees into [-180, 180). */
export function wrapLongitudeDegrees(longitudeDegrees: number): number {
  return ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180
}
