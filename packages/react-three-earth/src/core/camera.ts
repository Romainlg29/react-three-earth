import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Matrix4, Vector3, type Camera } from 'three'

export interface CameraView {
  /** The point looked at. */
  longitudeDegrees: number
  latitudeDegrees: number
  /** Ellipsoidal height of the point looked at. Default: 0. */
  heightMeters?: number
  /** Distance from the camera to that point. */
  distanceMeters: number
  /** Compass direction the camera faces, clockwise from north. Default: 0. */
  headingDegrees?: number
  /** Angle below the horizon, negative looks down. Default: -45. */
  pitchDegrees?: number
}

export interface GeographicPosition {
  longitudeDegrees: number
  latitudeDegrees: number
  /** Ellipsoidal (WGS84) height. Default: 0. */
  heightMeters?: number
}

/** A longitude-latitude box. It crosses the antimeridian when `westDegrees` is greater than `eastDegrees`. */
export interface GeographicBounds {
  westDegrees: number
  southDegrees: number
  eastDegrees: number
  northDegrees: number
}

const target = new Vector3()
const east = new Vector3()
const north = new Vector3()
const up = new Vector3()
const forward = new Vector3()
const right = new Vector3()
const cameraUp = new Vector3()
const backward = new Vector3()
const basis = new Matrix4()

/** Places a camera looking at a point on Earth, in ECEF meters. */
export function setCameraView(
  camera: Camera,
  { longitudeDegrees, latitudeDegrees, heightMeters = 0, distanceMeters, headingDegrees = 0, pitchDegrees = -45 }: CameraView,
): void {
  const latitude = MathUtils.degToRad(latitudeDegrees)
  const longitude = MathUtils.degToRad(longitudeDegrees)
  const heading = MathUtils.degToRad(headingDegrees)
  const pitch = MathUtils.degToRad(pitchDegrees)

  WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, heightMeters, target)
  WGS84_ELLIPSOID.getEastNorthUpAxes(latitude, longitude, east, north, up)
  placeCameraAround(camera, target, east, north, up, heading, pitch, distanceMeters)
}

/**
 * Places a camera `distanceMeters` from `target`, facing it from `headingRadians` (clockwise from `north`)
 * and `pitchRadians` (below the horizon, negative looks down), in the frame `east`, `north`, `up` (unit,
 * orthogonal). Unlike `lookAt`, it stays well defined looking straight down: screen-up then points along
 * the heading. Sets `camera.up` to `up`.
 */
export function placeCameraAround(
  camera: Camera,
  target: Vector3,
  east: Vector3,
  north: Vector3,
  up: Vector3,
  headingRadians: number,
  pitchRadians: number,
  distanceMeters: number,
): void {
  // The heading on the ground, then tipped down by the pitch.
  const horizontal = right.copy(north).multiplyScalar(Math.cos(headingRadians)).addScaledVector(east, Math.sin(headingRadians))
  forward.copy(horizontal).multiplyScalar(Math.cos(pitchRadians)).addScaledVector(up, Math.sin(pitchRadians))
  cameraUp.copy(horizontal).multiplyScalar(-Math.sin(pitchRadians)).addScaledVector(up, Math.cos(pitchRadians))
  right.crossVectors(forward, cameraUp)
  backward.copy(forward).negate()
  camera.quaternion.setFromRotationMatrix(basis.makeBasis(right, cameraUp, backward))
  camera.position.copy(target).addScaledVector(forward, -distanceMeters)
  camera.up.copy(up)
  camera.updateMatrixWorld()
}

/** Converts geographic coordinates to ECEF meters (WGS84). */
export function toCartesian(
  { longitudeDegrees, latitudeDegrees, heightMeters = 0 }: GeographicPosition,
  result = new Vector3(),
): Vector3 {
  return WGS84_ELLIPSOID.getCartographicToPosition(
    MathUtils.degToRad(latitudeDegrees),
    MathUtils.degToRad(longitudeDegrees),
    heightMeters,
    result,
  )
}
