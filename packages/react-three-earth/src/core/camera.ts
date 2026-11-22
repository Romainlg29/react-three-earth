import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Vector3, type Camera } from 'three'

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

const target = new Vector3()
const east = new Vector3()
const north = new Vector3()
const up = new Vector3()
const viewDirection = new Vector3()

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

  // Direction from the camera to the target, in the target's east-north-up frame
  viewDirection
    .copy(north)
    .multiplyScalar(Math.cos(heading))
    .addScaledVector(east, Math.sin(heading))
    .multiplyScalar(Math.cos(pitch))
    .addScaledVector(up, Math.sin(pitch))

  camera.position.copy(target).addScaledVector(viewDirection, -distanceMeters)
  camera.up.copy(up)
  camera.lookAt(target)
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
