import { Vector3, type Camera } from 'three'
import { inverseSqrt, uniform, vec3 } from 'three/tsl'
import type { Node, NodeFrame, UniformNode } from 'three/webgpu'

import { AtmosphereModel, LENGTH_UNIT_METERS } from './AtmosphereModel.js'
import type { AtmosphereParameters } from './AtmosphereParameters.js'
import { AtmosphereTextures } from './AtmosphereTextures.js'

/**
 * Moves an Earth-centred position (any length unit) radially so that its distance from the centre minus
 * `bottomRadius` equals its height above the ellipsoid: the Bruneton model's planet is a sphere, the
 * world's is an ellipsoid. Exact on the ground, at every latitude and from any camera altitude; above the
 * ground the radial height differs slightly from the geodetic height (at 45°: 6 cm at 10 km, 2 m at
 * 400 km, 27 m at 20 000 km, far above the atmosphere where it no longer matters).
 *
 * CPU version, for tests and tools. The shaders use `AtmosphereContext.toAtmosphereFrame`.
 */
export function correctPositionForEllipsoid(position: Vector3, ellipsoidRadii: Vector3, bottomRadius: number, target = new Vector3()): Vector3 {
  const radius = position.length()
  if (radius === 0) return target.set(0, 0, bottomRadius)
  const x = position.x / radius
  const y = position.y / radius
  const z = position.z / radius
  const ellipsoidRadius = 1 / Math.sqrt((x * x) / ellipsoidRadii.x ** 2 + (y * y) / ellipsoidRadii.y ** 2 + (z * z) / ellipsoidRadii.z ** 2)
  return target.set(x, y, z).multiplyScalar(radius - ellipsoidRadius + bottomRadius)
}

/**
 * Everything the atmosphere's shaders share: the model (parameters compiled into TSL), its lookup
 * textures, the sun direction, and the mapping from the ECEF world to the model's spherical planet.
 *
 * Positions reach the shaders as camera-relative offsets (exact under `renderer.highPrecision`) added to
 * the camera's ECEF position in kilometres, computed in double precision on the CPU. At Earth's radius a
 * float32 kilometre value resolves 0.5 m, which is plenty for atmospheric lookups.
 */
export class AtmosphereContext {
  readonly model: AtmosphereModel
  readonly textures: AtmosphereTextures

  /** Unit vector towards the sun, ECEF (which is also the world frame). */
  readonly sunDirection: UniformNode<'vec3', Vector3> = uniform(new Vector3(0, 0, 1))

  /**
   * 1 once the lookup textures hold data, 0 before. Shaders compute both the atmospheric and a neutral
   * result and select on it, so nothing ever reads the empty textures' 0 / 0 into the frame.
   */
  readonly texturesReady: UniformNode<'float', number> = uniform(0)

  constructor(parameters: AtmosphereParameters) {
    this.model = new AtmosphereModel(parameters)
    this.textures = new AtmosphereTextures(this.model)
  }

  get parameters(): AtmosphereParameters {
    return this.model.parameters
  }

  /**
   * The camera's ECEF position in kilometres, updated before each render. Pass a camera to follow it;
   * otherwise the node follows the camera being rendered (wrong inside a post-processing pass, where that
   * is the full-screen quad's).
   */
  createCameraPositionKilometersNode(camera?: Camera): Node<'vec3'> {
    return uniform(new Vector3()).onRenderUpdate((frame: NodeFrame, self) => {
      const followed = camera ?? frame.camera
      if (followed == null) return
      followed.updateMatrixWorld()
      self.value.setFromMatrixPosition(followed.matrixWorld).divideScalar(LENGTH_UNIT_METERS)
    })
  }

  /** CPU counterpart of `toAtmosphereFrame`, for an ECEF position in metres. Returns kilometres. */
  toAtmosphereFrameKilometers(positionECEFMeters: Vector3, target = new Vector3()): Vector3 {
    const { ellipsoidRadiiMeters, bottomRadiusMeters } = this.parameters
    return correctPositionForEllipsoid(positionECEFMeters, ellipsoidRadiiMeters, bottomRadiusMeters, target).divideScalar(LENGTH_UNIT_METERS)
  }

  /**
   * Maps an ECEF position in kilometres to the model's frame (see `correctPositionForEllipsoid`): every
   * point, camera or fragment, lands at its own height above the ellipsoid, at any camera altitude.
   */
  toAtmosphereFrame(positionKilometers: Node<'vec3'>): Node<'vec3'> {
    const radii = this.parameters.ellipsoidRadiiMeters
    const inverseSquaredRadii = vec3(
      (LENGTH_UNIT_METERS / radii.x) ** 2,
      (LENGTH_UNIT_METERS / radii.y) ** 2,
      (LENGTH_UNIT_METERS / radii.z) ** 2,
    )
    const radius = positionKilometers.length().toConst()
    const direction = positionKilometers.div(radius).toConst()
    const ellipsoidRadius = inverseSqrt(direction.mul(direction).dot(inverseSquaredRadii))
    return direction.mul(radius.sub(ellipsoidRadius).add(this.model.bottomRadiusKilometers))
  }

  /** Factor from sky radiance to scaled luminance. */
  get skyLuminanceFactor(): Node<'vec3'> {
    const value = this.parameters.skyRadianceToLuminanceLumensPerWatt
    return vec3(value.x, value.y, value.z).mul(this.parameters.getLuminanceScale())
  }

  /** Factor from sun radiance or irradiance to scaled luminance or illuminance. */
  get sunLuminanceFactor(): Node<'vec3'> {
    const value = this.parameters.sunRadianceToLuminanceLumensPerWatt
    return vec3(value.x, value.y, value.z).mul(this.parameters.getLuminanceScale())
  }

  dispose(): void {
    this.texturesReady.value = 0
    this.textures.dispose()
  }
}
