import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { Vector3, type Camera } from 'three'

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

const target = new Vector3()

/** Places a camera looking at a point on Earth, in ECEF metres. */
export function setCameraView(
  camera: Camera,
  { longitudeDegrees, latitudeDegrees, heightMeters = 0, distanceMeters, headingDegrees = 0, pitchDegrees = -45 }: CameraView,
): void {
  new Geodetic(radians(longitudeDegrees), radians(latitudeDegrees), heightMeters).toECEF(target)
  new PointOfView(distanceMeters, radians(headingDegrees), radians(pitchDegrees)).decompose(
    target,
    camera.position,
    camera.quaternion,
    camera.up,
  )
  camera.updateMatrixWorld()
}

/** Converts geographic coordinates to ECEF metres (WGS84). */
export function toCartesian(
  { longitudeDegrees, latitudeDegrees, heightMeters = 0 }: { longitudeDegrees: number; latitudeDegrees: number; heightMeters?: number },
  result = new Vector3(),
): Vector3 {
  return new Geodetic(radians(longitudeDegrees), radians(latitudeDegrees), heightMeters).toECEF(result)
}
