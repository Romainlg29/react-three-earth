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
 * Source-tile GPU memory: a source tile's GPU copy is only needed while a queued composition (or a terrain
 * tile that shows that source tile as is) uses it. The compositor reference-counts those uses and disposes
 * the GPU copy when the count reaches zero, so source tiles do not sit uncounted next to the LRU-counted
 * composites. `Texture.dispose()` frees only the GPU copy: the decoded ImageBitmap stays with the image
 * source (three never closes it), and a later use uploads it again.
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

/**
 * Draws a composition into its target with any scene. Called inside `ImageryCompositor.render`, with the
 * renderer's state saved (and restored after), its clear colour transparent black and its MRT off.
 */
export type CompositionRenderer = (renderer: WebGPURenderer, target: RenderTarget) => void

/** A queued composition: source tile quads, or a custom render. */
interface CompositionJob {
  target: RenderTarget
  draws: readonly CompositeDraw[]
  render: CompositionRenderer | null
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
 *
 * Two queues keep latency low: 3DTilesRenderer locks (and so queues) a terrain tile's imagery as soon as the
 * tile starts downloading, in network order, but only waits for it later, in its own priority order.
 * `prioritize` moves a composition that is being waited for ahead of the ones that are only preloads.
 */
export class ImageryCompositor {
  /** Main-thread time `render` may spend per frame. At least one composition runs per frame regardless. */
  budgetMilliseconds: number
  /** Called when a composition is queued, so a host that renders on demand can schedule a frame. */
  onQueued: (() => void) | null = null

  protected readonly waitedQueue: CompositionJob[] = []
  protected readonly preloadQueue: CompositionJob[] = []
  protected readonly textureUseCounts = new Map<Texture, number>()
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

  /** Compositions waiting for a `render`. */
  get pendingCount(): number {
    return this.waitedQueue.length + this.preloadQueue.length
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
   * aborted first; the caller still owns (and disposes) the target. `waited` queues it ahead of preloads.
   */
  enqueue(target: RenderTarget, draws: readonly CompositeDraw[], signal?: AbortSignal, waited = false): Promise<Texture> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason)
        return
      }
      const job: CompositionJob = { target, draws, render: null, resolve, reject, signal, onAbort: () => this.cancel(job) }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      for (const draw of draws) this.retainTexture(draw.texture)
      ;(waited ? this.waitedQueue : this.preloadQueue).push(job)
      this.onQueued?.()
    })
  }

  /**
   * Queues a custom composition (vector tiles drawn with their own scene, for example), under the same
   * per-frame budget and priorities as source tile compositions. Resolves with `target.texture` once drawn.
   */
  enqueueRender(target: RenderTarget, render: CompositionRenderer, signal?: AbortSignal, waited = false): Promise<Texture> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason)
        return
      }
      const job: CompositionJob = { target, draws: [], render, resolve, reject, signal, onAbort: () => this.cancel(job) }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      ;(waited ? this.waitedQueue : this.preloadQueue).push(job)
      this.onQueued?.()
    })
  }

  /**
   * Copies a texture (v = 0 at the top, like render targets and flipped ImageBitmaps) over all of `target`,
   * with no blending. For custom compositions that resolve a multisampled scratch target into their own.
   */
  copyTexture(renderer: WebGPURenderer, texture: Texture, target: RenderTarget): void {
    try {
      this.prepareMeshes([{ texture, minimumX: 0, minimumY: 0, maximumX: 1, maximumY: 1 }])
      renderer.setRenderTarget(target)
      renderer.render(this.scene, this.camera)
    } finally {
      for (const mesh of this.meshes) mesh.userData.sourceTexture = null
    }
  }

  /** Moves the composition into `target` ahead of preloads, if it is still queued. */
  prioritize(target: RenderTarget): void {
    const index = this.preloadQueue.findIndex(job => job.target === target)
    if (index === -1) return
    this.waitedQueue.push(...this.preloadQueue.splice(index, 1))
  }

  /** Counts a use of a source texture's GPU copy (a queued draw, or a terrain tile showing it as is). */
  retainTexture(texture: Texture): void {
    this.textureUseCounts.set(texture, (this.textureUseCounts.get(texture) ?? 0) + 1)
  }

  /** Ends a use counted by `retainTexture`. The last one frees the GPU copy; the image stays for re-upload. */
  releaseTexture(texture: Texture): void {
    const count = (this.textureUseCounts.get(texture) ?? 0) - 1
    if (count > 0) {
      this.textureUseCounts.set(texture, count)
      return
    }
    this.textureUseCounts.delete(texture)
    texture.dispose()
  }

  /**
   * Draws queued compositions, waited-for ones first, until the time budget runs out. Call once per frame,
   * outside any other render. Returns how many compositions it drew.
   */
  render(renderer: WebGPURenderer): number {
    if (this.pendingCount === 0) return 0
    const startMilliseconds = performance.now()
    const restore = this.saveRendererState(renderer)
    renderer.autoClear = true
    renderer.setMRT(null)
    renderer.setClearColor(0x000000, 0)

    let count = 0
    try {
      while (this.pendingCount > 0 && (count === 0 || performance.now() - startMilliseconds < this.budgetMilliseconds)) {
        this.drawJob(renderer, (this.waitedQueue.shift() ?? this.preloadQueue.shift())!)
        count++
      }
    } finally {
      restore()
    }
    return count
  }

  /** Rejects every queued composition and frees the compositor's own GPU resources. */
  dispose(): void {
    for (const job of [...this.waitedQueue.splice(0), ...this.preloadQueue.splice(0)]) {
      this.settle(job)
      job.reject(new DOMException('ImageryCompositor: disposed', 'AbortError'))
    }
    this.geometry.dispose()
    this.material.dispose()
  }

  protected drawJob(renderer: WebGPURenderer, job: CompositionJob): void {
    try {
      if (job.render !== null) job.render(renderer, job.target)
      else {
        this.prepareMeshes(job.draws)
        renderer.setRenderTarget(job.target)
        renderer.render(this.scene, this.camera)
      }
      job.resolve(job.target.texture)
    } catch (error) {
      job.reject(error) // the tile reports a load error instead of waiting forever
    } finally {
      // Drop texture references so released source tiles are not kept alive by the pool.
      for (const mesh of this.meshes) mesh.userData.sourceTexture = null
      this.settle(job)
    }
  }

  /** Detaches a job that leaves the queue: stops listening for its abort and ends its texture uses. */
  protected settle(job: CompositionJob): void {
    job.signal?.removeEventListener('abort', job.onAbort)
    for (const draw of job.draws) this.releaseTexture(draw.texture)
  }

  /** Saves what `render` changes on the renderer and returns a function that restores it. */
  protected saveRendererState(renderer: WebGPURenderer): () => void {
    const target = renderer.getRenderTarget()
    const cubeFace = renderer.getActiveCubeFace()
    const mipmapLevel = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const autoClear = renderer.autoClear
    const clearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.savedClearColor)
    return () => {
      renderer.setRenderTarget(target, cubeFace, mipmapLevel)
      renderer.setMRT(mrt)
      renderer.autoClear = autoClear
      renderer.setClearColor(this.savedClearColor, clearAlpha)
    }
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
    for (const queue of [this.waitedQueue, this.preloadQueue]) {
      const index = queue.indexOf(job)
      if (index !== -1) queue.splice(index, 1)
    }
    this.settle(job)
    job.reject(job.signal?.reason)
  }
}
