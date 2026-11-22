import { DirectionalLight } from 'three'
import { cameraViewMatrix, cameraWorldMatrix, normalWorld, positionView, vec4 } from 'three/tsl'
import { AnalyticLightNode, type Node, type NodeBuilder } from 'three/webgpu'
import type { DirectLightData } from 'three/src/nodes/lighting/LightsNode.js'

import type { AtmosphereContext } from './AtmosphereContext.js'
import { LENGTH_UNIT_METERS } from './AtmosphereModel.js'

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
 */
export class AtmosphereLightNode extends AnalyticLightNode<AtmosphereLight> {
  static get type(): string {
    return 'AtmosphereLightNode'
  }

  /** The light's colour times its intensity (declared by three, missing from its typings). */
  declare colorNode: Node<'color'>

  /** The rendered camera's position in the atmosphere's frame, shared by every material this light shades. */
  protected cameraPosition: Node<'vec3'> | null = null
  protected cameraPositionContext: AtmosphereContext | null = null

  override setupDirect(builder: NodeBuilder): DirectLightData | undefined {
    const context = this.light?.atmosphere
    if (context == null) return undefined
    if (this.cameraPositionContext !== context) {
      this.cameraPosition = context.createCameraPositionNode()
      this.cameraPositionContext = context
    }
    const { model, textures, sunDirection } = context

    // Fragment position relative to the camera, which is exact under `renderer.highPrecision` (computed
    // from the 64-bit model-view matrix), rotated to world axes and added to the camera's sphere position.
    const offsetWorld = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz
    const position = this.cameraPosition!.add(offsetWorld.div(LENGTH_UNIT_METERS))
    const { sun, sky } = model.getSunAndSkyIrradiance(textures, position, normalWorld, sunDirection)

    const lighting = builder.context as unknown as { irradiance: { addAssign(node: unknown): void } }
    lighting.irradiance.addAssign(sky.mul(context.skyLuminanceFactor).mul(this.colorNode))

    return {
      lightDirection: cameraViewMatrix.mul(vec4(sunDirection, 0)).xyz.normalize(),
      lightColor: sun.mul(context.sunLuminanceFactor).mul(this.colorNode),
    }
  }
}

/**
 * The sun, as a light that physically based node materials understand. Its colour and intensity scale
 * the physical result (leave them at white and 1). It points itself: `Atmosphere.update` moves it.
 */
export class AtmosphereLight extends DirectionalLight {
  static {
    AtmosphereLight.registerNode(AtmosphereLightNode)
  }

  /** The atmosphere that lights it. Set by `Atmosphere`; the light emits nothing while it is null. */
  atmosphere: AtmosphereContext | null = null

  constructor(atmosphere: AtmosphereContext | null = null) {
    super(0xffffff, 1)
    this.name = 'AtmosphereLight'
    this.atmosphere = atmosphere
  }
}
