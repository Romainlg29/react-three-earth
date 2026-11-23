import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three'

import type { ViewMorph } from '../view/ViewMorph.js'
import { mercatorScaleFactor, wrapMercatorXNear } from '../view/webMercator.js'
import type { GeographicPosition } from './camera.js'

export interface GeographicAnchorOptions {
  /** Turns the anchor's frame clockwise from north, seen from above. Default: 0 (x east, y north, z up). */
  headingDegrees?: number
}

const east = new Vector3()
const north = new Vector3()
const up = new Vector3()
const basis = new Matrix4()
const headingRotation = new Quaternion()
const globePosition = new Vector3()
const globeQuaternion = new Quaternion()
const flatPosition = new Vector3()
const flatQuaternion = new Quaternion()
const Z_AXIS = new Vector3(0, 0, 1)

/**
 * An `Object3D` at a geographic position, oriented east-north-up (x east, y north, z up, in metres), that
 * stays on its spot through the globe-to-map morph. Children placed in it sit on the map like terrain does:
 * the terrain blends each vertex between its globe and flat positions, and the anchor blends its position,
 * rotation and scale the same way every frame.
 *
 * Create it with `earth.createGeographicAnchor(position)`, which keeps it updated, and add it under the
 * earth (`earth.add(anchor)`, or `context.addObject(anchor)` in a plugin). On the flat map it is drawn on the
 * copy of the world nearest the camera.
 */
export class GeographicAnchor extends Object3D {
  readonly geographicPosition: Required<GeographicPosition>
  headingDegrees: number
  protected disposed = false

  constructor(position: GeographicPosition, { headingDegrees = 0 }: GeographicAnchorOptions = {}) {
    super()
    this.name = 'GeographicAnchor'
    this.geographicPosition = { longitudeDegrees: position.longitudeDegrees, latitudeDegrees: position.latitudeDegrees, heightMeters: position.heightMeters ?? 0 }
    this.headingDegrees = headingDegrees
  }

  /** Whether `dispose` was called: `Earth` no longer updates it. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Moves the anchor. It takes effect at the next `update`. */
  setPosition(position: GeographicPosition, headingDegrees = this.headingDegrees): void {
    this.geographicPosition.longitudeDegrees = position.longitudeDegrees
    this.geographicPosition.latitudeDegrees = position.latitudeDegrees
    this.geographicPosition.heightMeters = position.heightMeters ?? 0
    this.headingDegrees = headingDegrees
  }

  /**
   * Places the anchor for the view's current morph. `Earth.update` calls it every frame for anchors it
   * created; call it yourself for an anchor you made with `new GeographicAnchor`.
   */
  update(view: ViewMorph | null): void {
    const { longitudeDegrees, latitudeDegrees, heightMeters } = this.geographicPosition
    const longitude = MathUtils.degToRad(longitudeDegrees)
    const latitude = MathUtils.degToRad(latitudeDegrees)
    headingRotation.setFromAxisAngle(Z_AXIS, -MathUtils.degToRad(this.headingDegrees))

    WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, heightMeters, globePosition)
    WGS84_ELLIPSOID.getEastNorthUpAxes(latitude, longitude, east, north, up)
    globeQuaternion.setFromRotationMatrix(basis.makeBasis(east, north, up)).multiply(headingRotation)

    const morph = view?.morph ?? 0
    if (view === null || morph === 0) {
      this.position.copy(globePosition)
      this.quaternion.copy(globeQuaternion)
      this.scale.setScalar(1)
    } else {
      view.geodeticToFlat(longitude, latitude, heightMeters, flatPosition)
      flatPosition.x = wrapMercatorXNear(flatPosition.x, view.worldCopyReferenceXMeters)
      flatPosition.applyMatrix4(view.flatToEarth)
      flatQuaternion.setFromRotationMatrix(view.anchorFrame).multiply(headingRotation)
      this.position.lerpVectors(globePosition, flatPosition, morph)
      this.quaternion.slerpQuaternions(globeQuaternion, flatQuaternion, morph)
      // The flat map's scale at this latitude, so children keep their size against the terrain.
      this.scale.setScalar(MathUtils.lerp(1, view.scale * mercatorScaleFactor(latitude), morph))
    }
    this.updateMatrix()
    this.matrixWorldNeedsUpdate = true
  }

  /** Stops `Earth` updating the anchor and takes it out of its parent. */
  override dispose(): void {
    this.disposed = true
    this.removeFromParent()
  }
}
