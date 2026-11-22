import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Vector3, type Camera } from 'three'
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

const cameraPosition = /*#__PURE__*/ new Vector3()
const surfacePoint = /*#__PURE__*/ new Vector3()
const surfaceNormal = /*#__PURE__*/ new Vector3()

/**
 * Physically based sky, sun light and aerial perspective: Bruneton's precomputed atmospheric scattering
 * (2017), with lookup textures generated on the GPU at startup and no network fetches.
 *
 * - `light`: the sun, lighting node materials (terrain tiles) with attenuated sunlight and sky irradiance.
 *   `Earth.setAtmosphere` adds it to the scene.
 * - `createAerialPerspective`: the post-processing node that draws the sky and hazes distant geometry.
 * - `update`: points the sun for a date. Call it every frame with the rendering camera.
 *
 * Luminances are scaled so that sunlight at the top of the atmosphere is about 1.5; an exposure of
 * about 10 suits daylight.
 */
export class Atmosphere {
  readonly context: AtmosphereContext
  readonly light: AtmosphereLight

  /** Resolves once the lookup textures are generated (after `install`). */
  ready: Promise<void> | null = null

  constructor({ parameters = new AtmosphereParameters() }: AtmosphereOptions = {}) {
    this.context = new AtmosphereContext(parameters)
    this.light = new AtmosphereLight(this.context)
  }

  get parameters(): AtmosphereParameters {
    return this.context.parameters
  }

  /** Unit vector towards the sun in ECEF, as of the last `update`. Read-only. */
  get sunDirectionECEF(): Vector3 {
    return this.context.sunDirection.value
  }

  /** Time the lookup textures took to generate, in milliseconds, or null before they are ready. */
  get generationTimeMilliseconds(): number | null {
    return this.context.textures.generationTimeMilliseconds
  }

  /**
   * Generates the lookup textures on this renderer, once (see `generationTimeMilliseconds`; `ready`
   * resolves when done). Nothing else on the renderer changes, so the returned undo function has nothing
   * to restore; the textures are kept until `dispose`, since generating them again would cost the same.
   */
  install(renderer: WebGPURenderer): () => void {
    this.light.atmosphere = this.context
    this.ready ??= renderer.init().then(async () => {
      await this.context.textures.generate(renderer)
    })
    return () => {}
  }

  /** Points the sun for this date and centres the model's planet under the camera. Cheap. */
  update(camera: Camera, date: Date): void {
    const sunDirection = getSunDirectionECEF(date, this.context.sunDirection.value)
    this.light.position.copy(sunDirection)
    this.light.updateMatrixWorld()

    camera.updateMatrixWorld()
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    if (cameraPosition.lengthSq() < 1) return // At the Earth's centre: no meaningful surface point.
    WGS84_ELLIPSOID.getPositionToSurfacePoint(cameraPosition, surfacePoint)
    WGS84_ELLIPSOID.getPositionToNormal(cameraPosition, surfaceNormal)
    this.context.setReferencePoint(surfacePoint, surfaceNormal)
  }

  /**
   * Wraps a scene pass: attenuates and hazes geometry, draws the sky and sun where depth is the
   * background, and returns an opaque color. Pass the scene camera: in a post-processing pass the
   * renderer's own camera is the full-screen quad's, which would point every sky ray the wrong way.
   */
  createAerialPerspective(colorNode: Node, depthNode: Node, camera: Camera): Node {
    return new AerialPerspectiveNode(this.context, colorNode as Node<'vec4'>, depthNode as Node<'vec4'>, camera)
  }

  /** Releases the GPU textures. A later `install` generates them again. */
  dispose(): void {
    this.light.atmosphere = null
    this.ready = null
    this.context.dispose()
  }
}
