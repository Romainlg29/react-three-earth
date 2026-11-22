import { DirectionalLight } from 'three'
import { cameraViewMatrix, cameraWorldMatrix, normalWorld, positionView, select, vec4 } from 'three/tsl'
import { AnalyticLightNode, type Node, type NodeBuilder } from 'three/webgpu'
import type { DirectLightData } from 'three/src/nodes/lighting/LightsNode.js'

import type { AtmosphereCameraNodes, AtmosphereContext } from './AtmosphereContext.js'
import { LENGTH_UNIT_METERS } from './AtmosphereModel.js'

/** Share of the unattenuated sunlight used as ambient light while the lookup textures are not ready. */
const FALLBACK_AMBIENT_SHARE = 0.15

/**
 * Shades an `AtmosphereLight`, per fragment: sun illuminance attenuated by the transmittance from the
 * fragment to the sun (so terrain reddens and darkens at sunset, and mountains are brighter than valleys),
 * plus the sky's irradiance as diffuse ambient light.
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

  override setupDirect(builder: NodeBuilder): DirectLightData | undefined {
    const light = this.light
    if (light == null) return undefined
    const context = light.atmosphere
    const { model, textures, sunDirection, texturesReady } = context
    context.prepare(builder.renderer)
    this.camera ??= context.createCameraNodes()

    // Fragment position relative to the camera, which is exact under `renderer.highPrecision` (computed
    // from the 64-bit model-view matrix), rotated to world axes and added to the camera's ECEF position.
    const offsetWorld = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz
    const positionKilometers = this.camera.positionKilometers.add(offsetWorld.div(LENGTH_UNIT_METERS)).toConst()
    const position = context.toAtmosphereFrame(positionKilometers)
    // Sun elevation and sky factor against the fragment's true (ellipsoid) vertical: normal and sun are
    // world directions, untouched by the model's radial mapping.
    const up = context.ellipsoidNormal(positionKilometers)
    const { sun, sky } = model.getSunAndSkyIrradiance(textures, position, normalWorld, sunDirection, up)

    const unattenuated = model.solarIrradianceWattsPerSquareMeterNanometer.mul(context.sunLuminanceFactor)
    const ready = texturesReady.greaterThan(0.5)
    const ambient = select(ready, sky.mul(context.skyLuminanceFactor), unattenuated.mul(FALLBACK_AMBIENT_SHARE))
    const direct = select(ready, sun.mul(context.sunLuminanceFactor), unattenuated)

    const lighting = builder.context as unknown as { irradiance: { addAssign(node: unknown): void } }
    lighting.irradiance.addAssign(ambient.mul(this.colorNode))

    return {
      lightDirection: cameraViewMatrix.mul(vec4(sunDirection, 0)).xyz.normalize(),
      lightColor: direct.mul(this.colorNode),
    }
  }
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
