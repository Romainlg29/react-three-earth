import type { Camera } from 'three'
import type { Node, WebGPURenderer } from 'three/webgpu'

import { AerialPerspectiveNode } from '../atmosphere/AerialPerspectiveNode.js'
import { AtmosphereContext } from '../atmosphere/AtmosphereContext.js'
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

  /**
   * Settles once the lookup textures are generated (true), or when generation is cancelled by `dispose`
   * or fails (false; failures are logged). Null before `install`.
   */
  ready: Promise<boolean> | null = null

  protected generation: AbortController | null = null

  constructor({ parameters = new AtmosphereParameters() }: AtmosphereOptions = {}) {
    this.context = new AtmosphereContext(parameters)
    this.light = new AtmosphereLight(this.context)
  }

  get parameters(): AtmosphereParameters {
    return this.context.parameters
  }

  /**
   * 0 to 1: how much sky, haze and sunlight there is. `Earth` fades it out on the flat map. At 0 the scene
   * shows unlit and unhazed, over the canvas's clear colour. Costs nothing to change.
   */
  get opacity(): number {
    return this.context.opacity.value
  }

  set opacity(value: number) {
    this.context.opacity.value = value
    this.light.intensity = value
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

  /** Cancels a pending generation and releases the GPU textures. A later `install` generates them again. */
  dispose(): void {
    this.generation?.abort()
    this.generation = null
    this.ready = null
    this.context.dispose()
  }
}
