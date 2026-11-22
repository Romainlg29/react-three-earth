import { Vector3, type Camera } from 'three'
import { uniform, vec3 } from 'three/tsl'
import type { Node, NodeFrame, UniformNode } from 'three/webgpu'

import { AtmosphereModel, LENGTH_UNIT_METERS } from './AtmosphereModel.js'
import type { AtmosphereParameters } from './AtmosphereParameters.js'
import { AtmosphereTextures } from './AtmosphereTextures.js'

const cameraPosition = /*#__PURE__*/ new Vector3()

/**
 * Everything the atmosphere's shaders share: the model (parameters compiled into TSL), its lookup
 * textures, the sun direction, and where the model's spherical planet sits in the ECEF world.
 *
 * The Bruneton model assumes a spherical planet; the world is a WGS84 ellipsoid. The sphere is placed
 * tangent to the ellipsoid below the camera (`setReferencePoint`), which keeps altitudes exact near the
 * camera and within metres for anything closer than the horizon.
 */
export class AtmosphereContext {
  readonly model: AtmosphereModel
  readonly textures: AtmosphereTextures

  /** Unit vector towards the sun, ECEF (which is also the world frame). */
  readonly sunDirection: UniformNode<'vec3', Vector3> = uniform(new Vector3(0, 0, 1))

  /** Centre of the model's sphere in ECEF metres. Double precision: only ever used on the CPU. */
  readonly sphereCenterECEF = new Vector3()

  constructor(parameters: AtmosphereParameters) {
    this.model = new AtmosphereModel(parameters)
    this.textures = new AtmosphereTextures(this.model)
  }

  get parameters(): AtmosphereParameters {
    return this.model.parameters
  }

  /**
   * Camera position relative to the sphere centre, in shader units, updated before each render. Computed
   * in double precision on the CPU, so it can be combined with camera-relative offsets on the GPU without
   * float32 losing the 6.4e6 m planet radius. Pass a camera to follow it; otherwise the node follows the
   * camera being rendered (wrong inside a post-processing pass, where that is the full-screen quad's).
   */
  createCameraPositionNode(camera?: Camera): Node<'vec3'> {
    return uniform(new Vector3()).onRenderUpdate((frame: NodeFrame, self) => {
      const followed = camera ?? frame.camera
      if (followed == null) return
      followed.updateMatrixWorld()
      cameraPosition.setFromMatrixPosition(followed.matrixWorld)
      self.value.copy(this.toSphereUnits(cameraPosition, self.value))
    })
  }

  /** Converts an ECEF position in metres to the model's frame (sphere-centred, shader units). */
  toSphereUnits(positionECEF: Vector3, target = new Vector3()): Vector3 {
    return target.subVectors(positionECEF, this.sphereCenterECEF).divideScalar(LENGTH_UNIT_METERS)
  }

  /** Places the model's sphere tangent to the ellipsoid at a surface point with the given outward normal. */
  setReferencePoint(surfacePointECEF: Vector3, surfaceNormal: Vector3): void {
    this.sphereCenterECEF.copy(surfacePointECEF).addScaledVector(surfaceNormal, -this.parameters.bottomRadiusMeters)
  }

  /** Factor from sky radiance to scaled luminance. */
  get skyLuminanceFactor(): Node<'vec3'> {
    const { skyRadianceToLuminance: value, luminanceScale } = this.parameters
    return vec3(value.x, value.y, value.z).mul(luminanceScale)
  }

  /** Factor from sun radiance or irradiance to scaled luminance or illuminance. */
  get sunLuminanceFactor(): Node<'vec3'> {
    const { sunRadianceToLuminance: value, luminanceScale } = this.parameters
    return vec3(value.x, value.y, value.z).mul(luminanceScale)
  }

  dispose(): void {
    this.textures.dispose()
  }
}
