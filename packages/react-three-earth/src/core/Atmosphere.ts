import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
} from '@takram/three-atmosphere'
import { Vector3, type Camera, type Matrix4 } from 'three'
import { context, vec4 } from 'three/tsl'
import type { Node, WebGPURenderer } from 'three/webgpu'

import { atmosphere as takram, geospatial } from '../compat/takram.js'

const { aerialPerspective, AtmosphereContext, AtmosphereLight, AtmosphereLightNode, StarsNode } = takram

export interface AtmosphereOptions {
  /**
   * Star catalogue (takram's `stars.bin`, shipped in `@takram/three-atmosphere/assets`). Default: fetched
   * from takram's GitHub LFS. Self-host it in production.
   */
  starsUrl?: string
  /**
   * Spatiotemporal blue noise used to dither ray marching (takram's `stbn.bin`, 128 x 128 x 64 bytes).
   * Default: fetched from takram's GitHub LFS. Self-host it in production. Global: the last value set wins.
   */
  blueNoiseUrl?: string
}

/**
 * Physically based sky, sun light and aerial perspective (Bruneton precomputed scattering with
 * Hillaire multiple scattering), powered by takram's `@takram/three-atmosphere/webgpu`.
 */
export class Atmosphere {
  readonly context: InstanceType<typeof AtmosphereContext>
  readonly light: InstanceType<typeof AtmosphereLight>

  protected readonly observerECEF = new Vector3()

  readonly starsUrl: string | undefined

  constructor({ starsUrl, blueNoiseUrl }: AtmosphereOptions = {}) {
    this.starsUrl = starsUrl
    if (blueNoiseUrl !== undefined) geospatial.stbnTexture.url = blueNoiseUrl
    this.context = new AtmosphereContext()
    this.light = new AtmosphereLight()
  }

  /** Registers the atmosphere on the renderer. Returns a function that undoes it. */
  install(renderer: WebGPURenderer): () => void {
    const previous = renderer.contextNode
    renderer.contextNode = context({ ...(previous.value as object), getAtmosphere: () => this.context })
    renderer.library.addLight(AtmosphereLightNode as never, AtmosphereLight)
    return () => {
      renderer.contextNode = previous
    }
  }

  /** Points the sun and moon for this date, seen from the camera. Cheap: a few matrix products. */
  update(camera: Camera, date: Date): void {
    this.context.camera = camera
    camera.updateMatrixWorld()
    this.observerECEF.setFromMatrixPosition(camera.matrixWorld)
    const eciToEcef = getECIToECEFRotationMatrix(date, this.context.matrixECIToECEF.value as Matrix4)
    getSunDirectionECI(date, this.context.sunDirectionECEF.value as Vector3, this.observerECEF).applyMatrix4(eciToEcef)
    getMoonDirectionECI(date, this.context.moonDirectionECEF.value as Vector3, this.observerECEF).applyMatrix4(eciToEcef)
  }

  /**
   * Wraps a scene pass: adds atmospheric transmittance and in-scattering, and draws the sky where depth is 1.
   * Pass the scene camera: the sky reads it when the node compiles, and in a post-processing pass the
   * renderer's own camera is the full-screen quad's, which would point every sky ray into the ground.
   */
  createAerialPerspective(colorNode: Node, depthNode: Node, camera: Camera): Node {
    this.context.camera = camera
    const node = aerialPerspective(colorNode as never, depthNode as never)
    const sky = node.skyNode as InstanceType<typeof takram.SkyNode> | null | undefined
    if (sky != null && this.starsUrl !== undefined) sky.starsNode = new StarsNode(this.starsUrl)
    // The sky fills every pixel the scene left empty, so the result is opaque. Without this the cleared
    // alpha (0) survives and the canvas shows the page behind it where the sky should be.
    return vec4((node as unknown as { rgb: never }).rgb, 1) as unknown as Node
  }

  dispose(): void {
    this.context.dispose()
  }
}
