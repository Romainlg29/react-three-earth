import type { Camera, Vector3 } from 'three'
import { cameraProjectionMatrixInverse, cameraWorldMatrix, float, getViewPosition, screenUV, vec4 } from 'three/tsl'
import type { Node, WebGPURenderer } from 'three/webgpu'

import { AerialPerspectiveNode } from '../atmosphere/AerialPerspectiveNode.js'
import {
  AtmosphereContext,
  type AerialPerspectiveNodes,
  type AtmosphereCameraNodes,
  type SunAndSkyIlluminanceNodes,
} from '../atmosphere/AtmosphereContext.js'
import { AtmosphereIlluminance, type SunAndSkyIlluminance } from '../atmosphere/AtmosphereIlluminance.js'
import { LENGTH_UNIT_METERS } from '../atmosphere/AtmosphereModel.js'
import { AtmosphereLight } from '../atmosphere/AtmosphereLight.js'
import { AtmosphereParameters } from '../atmosphere/AtmosphereParameters.js'
import { getSunDirectionECEF } from '../atmosphere/ephemeris.js'

export interface AtmosphereOptions {
  /** The physical atmosphere and lookup texture sizes. Default: Earth's (`new AtmosphereParameters()`). */
  parameters?: AtmosphereParameters
}

/** Options of `Atmosphere.createAerialPerspective`. */
export interface AerialPerspectiveOptions {
  /** Whether the sky shows the sun disk. Default: true. */
  showSun?: boolean
}

/**
 * The opaque scene drawn in a pass of its own: its colour and depth textures. The shape of
 * @aeronautic/core's `SceneBackdrop`, which its `volume_pass` hands to a `backdropNode`.
 */
export interface SceneBackdrop {
  color: Node
  depth: Node
}

/**
 * The air between the camera and points along the rendered pixel's ray (see
 * `Atmosphere.createAerialPerspectiveAlongRay`). Call it inside a material's shader.
 */
export type AerialPerspectiveAlongRay = (distanceMeters: Node<'float'>) => AerialPerspectiveNodes

let warnedAboutDepthBuffer = false

/**
 * Physically based sky, sun light and aerial perspective: Bruneton's precomputed atmospheric scattering
 * (2017), with lookup textures generated on the GPU at startup and no network fetches.
 *
 * - `light`: the sun, lighting node materials (terrain tiles) with attenuated sunlight and sky irradiance.
 *   `Earth.setAtmosphere` adds it to the scene.
 * - `createAerialPerspective`: the post-processing node that draws the sky and hazes distant geometry.
 * - `update`: points the sun for a date. Call it every frame.
 *
 * Luminances are scaled so that sunlight at the top of the atmosphere is about 1.5; an exposure of
 * about 10 suits daylight. Create the renderer with `reversedDepthBuffer: true`: with a standard depth
 * buffer, distances to far terrain (seen from orbit) are too coarse and the haze bands.
 */
export class Atmosphere {
  readonly context: AtmosphereContext
  readonly light: AtmosphereLight
  /** Sunlight and skylight at any point, on the CPU (see `getSunAndSkyIlluminance`). */
  readonly illuminance: AtmosphereIlluminance

  /**
   * Settles once the lookup textures are generated (true), or when generation is cancelled by `dispose`
   * or fails (false; failures are logged). Null before `install`.
   */
  ready: Promise<boolean> | null = null

  protected generation: AbortController | null = null

  constructor({ parameters = new AtmosphereParameters() }: AtmosphereOptions = {}) {
    this.context = new AtmosphereContext(parameters)
    this.light = new AtmosphereLight(this.context)
    this.illuminance = new AtmosphereIlluminance(parameters)
  }

  get parameters(): AtmosphereParameters {
    return this.context.parameters
  }

  /** Unit vector towards the sun in ECEF, as of the last `update`. Read-only. */
  get sunDirectionECEF(): ReturnType<typeof getSunDirectionECEF> {
    return this.context.sunDirection.value
  }

  /** Time the lookup textures took to generate, in milliseconds, or null before they are ready. */
  get generationTimeMilliseconds(): number | null {
    return this.context.textures.generationTimeMilliseconds
  }

  /**
   * Starts generating the lookup textures on this renderer, a few passes per frame (see `ready` and
   * `generationTimeMilliseconds`). Until they are ready the scene renders with neutral sunlight and no sky.
   * Nothing else on the renderer changes, so the returned undo function has nothing to restore; the
   * textures are kept until `dispose`, since generating them again would cost the same.
   */
  install(renderer: WebGPURenderer): () => void {
    this.warnAboutDepthBuffer(renderer)
    if (this.ready === null) {
      const generation = new AbortController()
      this.generation = generation
      this.ready = this.generate(renderer, generation.signal)
    }
    return () => {}
  }

  protected async generate(renderer: WebGPURenderer, signal: AbortSignal): Promise<boolean> {
    try {
      await renderer.init()
      if (signal.aborted) return false
      this.context.prepare(renderer)
      const milliseconds = await this.context.textures.generate(renderer, signal)
      if (milliseconds === null) return false
      this.context.texturesReady.value = 1
      // The skylight's CPU copy (4 KB). Sunlight on the CPU needs no texture. A failure here leaves the
      // rendering intact: only `getSunAndSkyIlluminance` goes without skylight.
      try {
        await this.illuminance.readBack(renderer, this.context)
      } catch (error) {
        console.warn('Atmosphere: reading the skylight back to the CPU failed; getSunAndSkyIlluminance has no skylight.', error)
      }
      if (signal.aborted) {
        this.illuminance.reset()
        return false
      }
      return true
    } catch (error) {
      console.error('Atmosphere: generating the lookup textures failed.', error)
      return false
    }
  }

  protected warnAboutDepthBuffer(renderer: WebGPURenderer): void {
    // A logarithmic depth buffer resolves long ranges well too.
    if (renderer.reversedDepthBuffer || renderer.logarithmicDepthBuffer || warnedAboutDepthBuffer) return
    warnedAboutDepthBuffer = true
    console.warn('Atmosphere: create the renderer with `reversedDepthBuffer: true`, or the haze bands on distant terrain.')
  }

  /** Points the sun and its light for this date. Cheap. The camera is not needed (kept for API stability). */
  update(_camera: Camera, date: Date): void {
    const sunDirection = getSunDirectionECEF(date, this.context.sunDirection.value)
    this.light.position.copy(sunDirection)
    this.light.updateMatrixWorld()
  }

  /**
   * Wraps a scene pass: attenuates and hazes geometry, draws the sky and sun where depth is the
   * background, and returns an opaque color. Pass the scene camera: in a post-processing pass the
   * renderer's own camera is the full-screen quad's, which would point every sky ray the wrong way.
   */
  createAerialPerspective(colorNode: Node, depthNode: Node, camera: Camera, options: AerialPerspectiveOptions = {}): Node {
    return new AerialPerspectiveNode(this.context, colorNode as Node<'vec4'>, depthNode as Node<'vec4'>, camera, options)
  }

  /**
   * A `backdropNode` for a render pipeline someone else owns, such as @aeronautic/core's `volume_pass`:
   * given the opaque scene's colour and depth, it returns them with aerial perspective and the sky
   * (`createAerialPerspective`). Effects drawn over it see the hazed scene through them, and are hazed
   * themselves with `createAerialPerspectiveAlongRay`.
   *
   * @example
   * const split = volume_pass(scene, camera, { backdropNode: atmosphere.createBackdropNode(camera) })
   * renderPipeline.outputNode = split.output
   */
  createBackdropNode(camera: Camera, options: AerialPerspectiveOptions = {}): (scene: SceneBackdrop) => Node<'vec4'> {
    return ({ color, depth }) => this.createAerialPerspective(color, depth, camera, options) as Node<'vec4'>
  }

  /**
   * Aerial perspective for transparent and volumetric effects, which the opaque scene's
   * `createAerialPerspective` cannot see: a function to call in the effect's shader with the distance from
   * the camera to the light along the pixel's ray. Light from that far reaches the camera multiplied by
   * `transmittance`, plus `radiance` scattered in between. For premultiplied colour (`rgb`, coverage `a`):
   * `rgb * transmittance + radiance * a`.
   *
   * The ray is the rendered pixel's (`screenUV`) for the camera being rendered, so it works in any pass
   * drawn with the scene camera, such as @aeronautic's volume pass.
   *
   * @param camera The camera the effect is drawn with. Default: the camera being rendered.
   */
  createAerialPerspectiveAlongRay(camera?: Camera): AerialPerspectiveAlongRay {
    let cameraNodes: AtmosphereCameraNodes | null = null
    return distanceMeters => {
      cameraNodes ??= this.context.createCameraNodes(camera)
      const viewDirection = getViewPosition(screenUV, float(0.5), cameraProjectionMatrixInverse).normalize()
      const worldDirection = cameraWorldMatrix.mul(vec4(viewDirection, 0)).xyz.normalize()
      return this.context.getAerialPerspective(cameraNodes, worldDirection, distanceMeters.div(LENGTH_UNIT_METERS))
    }
  }

  /**
   * Sunlight and skylight at an ECEF point, on the CPU, with the sun of the last `update`: in the scene's
   * scaled units (divide by `parameters.getLuminanceScale()` for lux). Sunlight is available at once;
   * skylight once `ready` has settled (`skyAvailable`). Cheap: a few thousand flops.
   *
   * @param positionMeters ECEF position.
   */
  getSunAndSkyIlluminance(positionMeters: Vector3, target?: SunAndSkyIlluminance): SunAndSkyIlluminance {
    return this.illuminance.getSunAndSkyIlluminance(positionMeters, this.context.sunDirection.value, target)
  }

  /**
   * Sunlight and skylight at an ECEF point, in a shader (`AtmosphereContext.getSunAndSkyIlluminance`): the
   * same values as `getSunAndSkyIlluminance`, at every fragment.
   *
   * @param positionKilometers ECEF position in kilometres.
   * @param normal World normal of the lit surface. Default: facing up.
   */
  getSunAndSkyIlluminanceNode(positionKilometers: Node<'vec3'>, normal?: Node<'vec3'>): SunAndSkyIlluminanceNodes {
    return this.context.getSunAndSkyIlluminance(positionKilometers, normal)
  }

  /** Cancels a pending generation and releases the GPU textures. A later `install` generates them again. */
  dispose(): void {
    this.generation?.abort()
    this.generation = null
    this.ready = null
    this.context.dispose()
    this.illuminance.reset()
  }
}
