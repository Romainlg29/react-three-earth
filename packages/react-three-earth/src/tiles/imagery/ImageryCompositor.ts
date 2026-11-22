import {
  Color,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  SRGBColorSpace,
  Scene,
  Texture,
} from 'three'
import { texture, uv } from 'three/tsl'
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu'

/**
 * Why render-to-texture, and not sampling the source tiles in the terrain shader:
 *
 * - The terrain fragment shader keeps one texture sample per imagery layer. Sampling the source tiles
 *   directly would need a loop over every covering source tile, per-tile UV rectangles in uniforms, and a
 *   texture array or atlas with its own slot allocator. That costs fragment time on every frame (phones are
 *   fill-rate bound) and many mobile GPUs only expose 16 samplers per stage.
 * - Composition happens once per terrain tile and layer: a 256 × 256 pass with one quad per covering source
 *   tile (usually 1 to 4). The GPU cost is negligible; the main-thread cost is one `renderer.render` call.
 * - It is a plain raster pass, so it runs the same on WebGPU and on the WebGL2 fallback.
 * - No reprojection is needed per pixel: 3DTilesRenderer computes each terrain vertex's layer UV in the
 *   overlay's normalised projected space (Web Mercator for EPSG:3857), so in that space the composite is
 *   an axis-aligned blit. Placement is identical to the CPU canvas it replaces.
 *
 * Orientation: three r187 samples ImageBitmap textures (decoded with `imageOrientation: 'flipY'`) and render
 * targets with v = 0 at the top of the image on both backends. Quads are drawn with north up, so the
 * composite keeps that convention, the same as a single source tile; the terrain shader flips v for both.
 */

/** One source tile to draw into a composite, in the composite's own 0 to 1 coordinates (y up, north). */
export interface CompositeDraw {
  texture: Texture
  minimumX: number
  minimumY: number
  maximumX: number
  maximumY: number
}

/** A queued composition. */
interface CompositionJob {
  target: RenderTarget
  draws: readonly CompositeDraw[]
  resolve: (texture: Texture) => void
  reject: (reason: unknown) => void
  signal: AbortSignal | undefined
  onAbort: () => void
}

/** Per-mesh state read when the shared material is drawn for that mesh. */
interface CompositeMesh extends Mesh {
  userData: { sourceTexture: Texture | null }
}

const emptyTexture = new Texture()

const sourceTexture = texture(emptyTexture).onObjectUpdate(({ object }, self) => {
  self.value = (object as CompositeMesh).userData.sourceTexture ?? emptyTexture
})

/** Quad uv has v = 1 at the top (north); source textures have v = 0 at the image top. */
const sourceColor = sourceTexture.sample(uv().flipY())

/**
 * Composes imagery tiles into each terrain tile's overlay texture on the GPU.
 *
 * Compositions are queued as source tiles finish decoding (off the main thread, by `createImageBitmap`), and
 * drawn by `render`, which the terrain calls once per frame with a time budget, so a burst of new tiles
 * spreads over several frames instead of stalling one.
 */
export class ImageryCompositor {
  /** Main-thread time `render` may spend per frame. At least one composition runs per frame regardless. */
  budgetMilliseconds: number

  protected readonly queue: CompositionJob[] = []
  protected readonly scene = new Scene()
  protected readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1)
  protected readonly geometry = new PlaneGeometry(1, 1)
  protected readonly material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false })
  protected readonly meshes: CompositeMesh[] = []
  protected readonly savedClearColor = new Color()

  constructor({ budgetMilliseconds = 2 }: { budgetMilliseconds?: number } = {}) {
    this.budgetMilliseconds = budgetMilliseconds
    this.material.colorNode = sourceColor
    this.scene.matrixWorldAutoUpdate = true
  }

  /** Compositions waiting for the next `render`. */
  get pendingCount(): number {
    return this.queue.length
  }

  /** Allocates a composite target: sRGB 8-bit, no depth, no mipmaps, like the canvas it replaces. */
  createTarget(resolutionPixels: number): RenderTarget {
    const target = new RenderTarget(resolutionPixels, resolutionPixels, {
      colorSpace: SRGBColorSpace,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    })
    target.texture.name = 'ImageryComposite'
    return target
  }

  /**
   * Queues a composition. Resolves with `target.texture` once drawn. Rejects with the signal's reason if
   * aborted first; the caller still owns (and disposes) the target.
   */
  enqueue(target: RenderTarget, draws: readonly CompositeDraw[], signal?: AbortSignal): Promise<Texture> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason)
        return
      }
      const job: CompositionJob = { target, draws, resolve, reject, signal, onAbort: () => this.cancel(job) }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      this.queue.push(job)
    })
  }

  /**
   * Draws queued compositions until the time budget runs out. Call once per frame, outside any other
   * render. Returns how many compositions it drew.
   */
  render(renderer: WebGPURenderer): number {
    if (this.queue.length === 0) return 0
    const startMilliseconds = performance.now()
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    const previousClearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.savedClearColor)
    renderer.autoClear = true
    renderer.setClearColor(0x000000, 0)

    let count = 0
    try {
      while (this.queue.length > 0 && (count === 0 || performance.now() - startMilliseconds < this.budgetMilliseconds)) {
        const job = this.queue.shift()!
        job.signal?.removeEventListener('abort', job.onAbort)
        count++
        try {
          this.draw(renderer, job)
          job.resolve(job.target.texture)
        } catch (error) {
          job.reject(error) // the tile reports a load error instead of waiting forever
        }
      }
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
      renderer.setClearColor(this.savedClearColor, previousClearAlpha)
    }
    return count
  }

  /** Rejects every queued composition and frees the compositor's own GPU resources. */
  dispose(): void {
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.onAbort)
      job.reject(new DOMException('ImageryCompositor: disposed', 'AbortError'))
    }
    this.geometry.dispose()
    this.material.dispose()
  }

  protected draw(renderer: WebGPURenderer, { target, draws }: CompositionJob): void {
    this.prepareMeshes(draws)
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.camera)
    // Drop texture references so released source tiles are not kept alive by the pool.
    for (const mesh of this.meshes) mesh.userData.sourceTexture = null
  }

  /** Places one quad per draw; quads are in the composite's 0 to 1 space, which the camera spans. */
  protected prepareMeshes(draws: readonly CompositeDraw[]): void {
    while (this.meshes.length < draws.length) this.meshes.push(this.createMesh())
    this.meshes.forEach((mesh, index) => {
      const draw = draws[index]
      mesh.visible = draw !== undefined
      if (draw === undefined) return
      mesh.userData.sourceTexture = draw.texture
      mesh.position.set((draw.minimumX + draw.maximumX) / 2, (draw.minimumY + draw.maximumY) / 2, 0)
      mesh.scale.set(draw.maximumX - draw.minimumX, draw.maximumY - draw.minimumY, 1)
    })
  }

  protected createMesh(): CompositeMesh {
    const mesh = new Mesh(this.geometry, this.material) as unknown as CompositeMesh
    mesh.userData = { sourceTexture: null }
    mesh.frustumCulled = false
    this.scene.add(mesh)
    return mesh
  }

  protected cancel(job: CompositionJob): void {
    const index = this.queue.indexOf(job)
    if (index !== -1) this.queue.splice(index, 1)
    job.reject(job.signal?.reason)
  }
}
