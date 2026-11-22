import { Matrix3, Matrix4, Quaternion, Vector3, type Camera } from 'three'
import { inverseSqrt, mix, select, smoothstep, uniform, vec3 } from 'three/tsl'
import type { Node, NodeFrame, Renderer, UniformNode } from 'three/webgpu'

import { AtmosphereModel, LENGTH_UNIT_METERS } from './AtmosphereModel.js'
import type { AtmosphereParameters } from './AtmosphereParameters.js'
import { AtmosphereTextures } from './AtmosphereTextures.js'

/**
 * Moves an Earth-centred position radially so that its distance from the centre minus
 * `bottomRadiusMeters` equals its height above the ellipsoid: the Bruneton model's planet is a sphere, the
 * world's is an ellipsoid. Exact on the ground, at every latitude and from any camera altitude; above the
 * ground the radial height differs slightly from the geodetic height (at 45°: 6 cm at 10 km, 2 m at
 * 400 km, 27 m at 20 000 km, far above the atmosphere where it no longer matters).
 *
 * The mapping also tilts the local vertical from the ellipsoid normal to the radial direction (up to 0.19°);
 * directions must be rotated to match (`getEllipsoidToAtmosphereRotation`).
 *
 * CPU version, in double precision. The shaders use `AtmosphereContext.toAtmosphereFrame`.
 *
 * @param positionMeters ECEF position.
 * @param ellipsoidRadiiMeters Semi-axes of the ellipsoid (x, y, z).
 * @param bottomRadiusMeters Radius of the model's ground sphere.
 * @returns The position in the model's frame, in metres.
 */
export function correctPositionForEllipsoid(
  positionMeters: Vector3,
  ellipsoidRadiiMeters: Vector3,
  bottomRadiusMeters: number,
  target = new Vector3(),
): Vector3 {
  const radius = positionMeters.length()
  if (radius === 0) return target.set(0, 0, bottomRadiusMeters)
  const x = positionMeters.x / radius
  const y = positionMeters.y / radius
  const z = positionMeters.z / radius
  const radii = ellipsoidRadiiMeters
  const ellipsoidRadius = 1 / Math.sqrt((x * x) / radii.x ** 2 + (y * y) / radii.y ** 2 + (z * z) / radii.z ** 2)
  return target.set(x, y, z).multiplyScalar(radius - ellipsoidRadius + bottomRadiusMeters)
}

const normalScratch = /*#__PURE__*/ new Vector3()
const radialScratch = /*#__PURE__*/ new Vector3()

/**
 * The rotation taking the ellipsoid's normal at a position to the position's radial direction: applied to
 * world directions (view rays, the sun), it makes them consistent with `correctPositionForEllipsoid` there,
 * so the model's horizon and sun elevation match the ellipsoid's as seen from that position.
 */
export function getEllipsoidToAtmosphereRotation(positionMeters: Vector3, ellipsoidRadiiMeters: Vector3, target = new Quaternion()): Quaternion {
  if (positionMeters.lengthSq() === 0) return target.identity()
  const radii = ellipsoidRadiiMeters
  normalScratch.set(positionMeters.x / radii.x ** 2, positionMeters.y / radii.y ** 2, positionMeters.z / radii.z ** 2).normalize()
  radialScratch.copy(positionMeters).normalize()
  return target.setFromUnitVectors(normalScratch, radialScratch)
}

/** Uniforms describing a camera in the model's frame, updated before each render. */
export interface AtmosphereCameraNodes {
  /** ECEF position in kilometres (float32: add camera-relative offsets, then map with `toAtmosphereFrame`). */
  positionKilometers: Node<'vec3'>
  /** Position in the model's frame, in kilometres, mapped on the CPU in double precision. */
  atmospherePosition: Node<'vec3'>
  /** Rotation of world directions into the model's frame at the camera (`getEllipsoidToAtmosphereRotation`). */
  directionRotation: Node<'mat3'>
}

/** Sunlight and skylight illuminance at a point, as shader nodes (scaled luminance units). */
export interface SunAndSkyIlluminanceNodes {
  /** Sunlight on a surface facing the sun, after the air above the point. */
  sun: Node<'vec3'>
  /** Skylight on a surface with the given normal (by default facing up), without the sun. */
  sky: Node<'vec3'>
}

/** What the air between the camera and a point does to the light from it, as shader nodes. */
export interface AerialPerspectiveNodes {
  /** Share of the point's light that reaches the camera. */
  transmittance: Node<'vec3'>
  /** Light scattered towards the camera in between, in scaled luminance units. */
  radiance: Node<'vec3'>
}

/** Share of the unattenuated sunlight used as skylight while the lookup textures are not ready. */
export const FALLBACK_SKY_SHARE = 0.15

const cameraPositionScratch = /*#__PURE__*/ new Vector3()
const rotationScratch = /*#__PURE__*/ new Quaternion()
const matrixScratch = /*#__PURE__*/ new Matrix4()

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
  /** 0 to 1: how much of the sky and haze the aerial perspective applies (faded out on the flat map). */
  readonly opacity: UniformNode<'float', number> = uniform(1)

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
  createCameraNodes(camera?: Camera): AtmosphereCameraNodes {
    const positionKilometers = uniform(new Vector3())
    const atmospherePosition = uniform(new Vector3())
    const directionRotation = uniform(new Matrix3())
    const update = (frame: NodeFrame): void => {
      const followed = camera ?? frame.camera
      if (followed == null) return
      followed.updateMatrixWorld()
      cameraPositionScratch.setFromMatrixPosition(followed.matrixWorld)
      positionKilometers.value.copy(cameraPositionScratch).divideScalar(LENGTH_UNIT_METERS)
      this.toAtmosphereFrameKilometers(cameraPositionScratch, atmospherePosition.value)
      getEllipsoidToAtmosphereRotation(cameraPositionScratch, this.parameters.ellipsoidRadiiMeters, rotationScratch)
      directionRotation.value.setFromMatrix4(matrixScratch.makeRotationFromQuaternion(rotationScratch))
    }
    // Whichever of them a shader uses keeps all three current (the update is a few dozen flops).
    positionKilometers.onRenderUpdate(update)
    atmospherePosition.onRenderUpdate(update)
    directionRotation.onRenderUpdate(update)
    return { positionKilometers, atmospherePosition, directionRotation }
  }

  /**
   * Adapts the shaders and textures to the renderer's features. Idempotent; called before any shader
   * using the model is built and before the textures are generated.
   */
  prepare(renderer: Renderer): void {
    const filterable = renderer.hasFeature('float32-filterable')
    this.model.hardwareFiltering = filterable
    this.textures.setHardwareFiltering(filterable)
  }

  /** The ellipsoid's outward normal at an ECEF position in kilometres (a world direction). */
  ellipsoidNormal(positionKilometers: Node<'vec3'>): Node<'vec3'> {
    const radii = this.parameters.ellipsoidRadiiMeters
    const inverseSquaredRadii = vec3(
      (LENGTH_UNIT_METERS / radii.x) ** 2,
      (LENGTH_UNIT_METERS / radii.y) ** 2,
      (LENGTH_UNIT_METERS / radii.z) ** 2,
    )
    return positionKilometers.mul(inverseSquaredRadii).normalize()
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

  /**
   * Sunlight and skylight at an ECEF point, in shaders (the CPU counterpart is
   * `AtmosphereIlluminance.getSunAndSkyIlluminance`). Until the lookup textures are ready: plain sunlight,
   * and a skylight of `FALLBACK_SKY_SHARE` of it.
   *
   * @param positionKilometers ECEF position in kilometres. For a fragment, add its camera-relative offset to
   *   `createCameraNodes().positionKilometers`, which keeps float32 precision.
   * @param normal World normal of the lit surface. Default: the ellipsoid's normal (a surface facing up).
   */
  getSunAndSkyIlluminance(positionKilometers: Node<'vec3'>, normal?: Node<'vec3'>): SunAndSkyIlluminanceNodes {
    const position = this.toAtmosphereFrame(positionKilometers)
    // Sun elevation and sky factor against the true (ellipsoid) vertical: normal and sun are world
    // directions, untouched by the model's radial mapping.
    const up = this.ellipsoidNormal(positionKilometers).toConst()
    const { sun, sky } = this.model.getSunAndSkyIrradiance(this.textures, position, normal ?? up, this.sunDirection, up)
    const unattenuated = this.model.solarIrradianceWattsPerSquareMeterNanometer.mul(this.sunLuminanceFactor)
    const ready = this.texturesReady.greaterThan(0.5)
    return {
      sun: select(ready, sun.mul(this.sunLuminanceFactor), unattenuated),
      sky: select(ready, sky.mul(this.skyLuminanceFactor), unattenuated.mul(FALLBACK_SKY_SHARE)),
    }
  }

  /**
   * The air between a camera and a point along a world direction: the transmittance, and the light
   * scattered in between (scaled luminance). The point need not be on any surface: use it for transparent
   * and volumetric effects (an @aeronautic plume) as `AerialPerspectiveNode` does for the opaque scene.
   * Until the lookup textures are ready: a transmittance of 1 and no light.
   *
   * @param camera From `createCameraNodes` (for the camera the effect is drawn with).
   * @param worldDirection Unit direction from the camera to the point, world (ECEF) axes.
   * @param distanceKilometers Distance from the camera to the point.
   */
  getAerialPerspective(camera: AtmosphereCameraNodes, worldDirection: Node<'vec3'>, distanceKilometers: Node<'float'>): AerialPerspectiveNodes {
    const { positionKilometers, atmospherePosition, directionRotation } = camera
    const distance = distanceKilometers.toConst()
    const viewDirectionModel = directionRotation.mul(worldDirection)
    // Near the camera, the mapping is the camera's position plus the rotation, which is exact in double
    // precision; far away, map the point itself (float32 rounding, under a metre, no longer matters).
    const nearPoint = atmospherePosition.add(viewDirectionModel.mul(distance))
    const farPoint = this.toAtmosphereFrame(positionKilometers.add(worldDirection.mul(distance)))
    const point = mix(nearPoint, farPoint, smoothstep(10, 20, distance))
    const between = this.model.getSkyRadianceToPoint(this.textures, atmospherePosition, point, directionRotation.mul(this.sunDirection))
    const ready = this.texturesReady.greaterThan(0.5)
    return {
      transmittance: select(ready, between.transmittance, vec3(1)),
      radiance: select(ready, between.radiance.mul(this.skyLuminanceFactor), vec3(0)),
    }
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
