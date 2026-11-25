import { DirectionalLight } from 'three'
import { cameraViewMatrix, cameraWorldMatrix, If, mix, normalWorld, positionView, reflect, roughness, smoothstep, vec4 } from 'three/tsl'
import { AnalyticLightNode, PhysicalLightingModel, type Node, type NodeBuilder } from 'three/webgpu'
import type { DirectLightData } from 'three/src/nodes/lighting/LightsNode.js'

import type { AtmosphereCameraNodes, AtmosphereContext } from './AtmosphereContext.js'
import { LENGTH_UNIT_METERS } from './AtmosphereModel.js'

/**
 * Shades an `AtmosphereLight`, per fragment: sun illuminance attenuated by the transmittance from the
 * fragment to the sun (so terrain reddens and darkens at sunset, and mountains are brighter than valleys),
 * plus the sky's irradiance as diffuse ambient light, and the sky's reflection for the indirect specular term
 * (`skyReflectionNode`).
 *
 * Why a light node rather than a DirectionalLight whose colour the CPU updates: a CPU colour would be one
 * value for the whole view, and the sky irradiance would need a light probe re-fitted every frame. A light
 * node reads the lookup textures where each fragment is and works with any node material that uses the
 * standard lighting model (MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, ...), so terrain tiles need
 * no custom material. three r187 binds light classes to node classes with `Light.registerNode()` (the
 * renderer-wide `renderer.library.addLight()` is deprecated).
 *
 * Until the lookup textures are generated it lights with plain, unattenuated sunlight and a little ambient.
 */
export class AtmosphereLightNode extends AnalyticLightNode<AtmosphereLight> {
  static get type(): string {
    return 'AtmosphereLightNode'
  }

  /** The light's colour times its intensity (declared by three, missing from its typings). */
  declare colorNode: Node<'color'>

  /** The rendered camera, shared by every material this light shades. */
  protected camera: AtmosphereCameraNodes | null = null

  protected skyReflection(positionKilometers: Node<'vec3'>, offsetWorld: Node<'vec3'>, skyIrradiance: Node<'vec3'>): Node<'vec3'> {
    return skyReflectionNode(this.light!.atmosphere, this.camera!, positionKilometers, offsetWorld, skyIrradiance)
  }

  override setupDirect(builder: NodeBuilder): DirectLightData | undefined {
    const light = this.light
    if (light == null) return undefined
    const context = light.atmosphere
    context.prepare(builder.renderer)
    this.camera ??= context.createCameraNodes()

    // Fragment position relative to the camera, which is exact under `renderer.highPrecision` (computed
    // from the 64-bit model-view matrix), rotated to world axes and added to the camera's ECEF position.
    const offsetWorld = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz
    const positionKilometers = this.camera.positionKilometers.add(offsetWorld.div(LENGTH_UNIT_METERS)).toConst()
    const { sun: direct, sky: ambient } = context.getSunAndSkyIlluminance(positionKilometers, normalWorld)

    const lighting = builder.context as unknown as {
      irradiance: { addAssign(node: unknown): void }
      radiance: { addAssign(node: unknown): void }
      lightingModel?: unknown
    }
    lighting.irradiance.addAssign(ambient.mul(this.colorNode))
    // Only the physically based model reads the reflected light (Lambert and Phong would leave roughness unset, at 0
    // in WGSL, and pay for a lookup they never use).
    if (lighting.lightingModel instanceof PhysicalLightingModel) {
      lighting.radiance.addAssign(this.skyReflection(positionKilometers, offsetWorld, ambient).mul(this.colorNode))
    }

    return {
      lightDirection: cameraViewMatrix.mul(vec4(context.sunDirection, 0)).xyz.normalize(),
      lightColor: direct.mul(this.colorNode),
    }
  }
}

/**
 * Below this roughness a surface reflects the sky along its mirror direction, fading to the even sky above. The
 * lookup costs two 3D texture samples per pixel, so matte ground (the default terrain, roughness 1) skips it.
 */
export const SKY_REFLECTION_MAXIMUM_ROUGHNESS = 0.6

/**
 * The sky light the surface reflects, for the lighting model's indirect specular term (which applies the Fresnel and
 * roughness weighting, as for an environment map). A matte surface sees the whole sky: the irradiance spread over the
 * hemisphere (divided by π). A glossy one sees the sky along its mirror direction: water turns orange at sunset and pale
 * towards the horizon. The sun's disc is left out, the light's direct term draws its glint.
 */
function skyReflectionNode(
  context: AtmosphereContext,
  camera: AtmosphereCameraNodes,
  positionKilometers: Node<'vec3'>,
  offsetWorld: Node<'vec3'>,
  skyIrradiance: Node<'vec3'>,
): Node<'vec3'> {
  const evenSky = skyIrradiance.div(Math.PI).toVar()
  const reflected = evenSky.toVar()
  If(roughness.lessThan(SKY_REFLECTION_MAXIMUM_ROUGHNESS), () => {
    const mirror = reflect(offsetWorld.normalize(), normalWorld)
    const sky = context.getSkyRadiance(camera, positionKilometers, mirror)
    reflected.assign(mix(sky, evenSky, smoothstep(0, SKY_REFLECTION_MAXIMUM_ROUGHNESS, roughness)))
  })
  return reflected as unknown as Node<'vec3'>
}

/**
 * The sun, as a light that physically based node materials understand. Its colour and intensity scale
 * the physical result (leave them at white and 1). It points itself: `Atmosphere.update` moves it.
 * It casts no shadows: `castShadow` stays false (setting it warns), since its shading ignores shadow maps.
 */
export class AtmosphereLight extends DirectionalLight {
  static {
    AtmosphereLight.registerNode(AtmosphereLightNode)
  }

  /** The atmosphere that lights it, fixed for the light's life so its shaders never need rebuilding. */
  readonly atmosphere: AtmosphereContext

  constructor(atmosphere: AtmosphereContext) {
    super(0xffffff, 1)
    this.name = 'AtmosphereLight'
    this.atmosphere = atmosphere
    Object.defineProperty(this, 'castShadow', {
      configurable: true,
      get: () => false,
      set: (value: boolean) => {
        if (value) console.warn('AtmosphereLight: shadows are not supported; castShadow stays false.')
      },
    })
  }

  /** A copy lit by the same atmosphere (three's default clone calls the constructor without arguments). */
  override clone(): this {
    const Constructor = this.constructor as new (atmosphere: AtmosphereContext) => this
    // DirectionalLight.copy always copies children (it takes no `recursive` flag).
    return new Constructor(this.atmosphere).copy(this)
  }
}
