// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
// Extends 3DTilesRendererJS's ImageOverlayPlugin (Apache-2.0, (c) NASA-AMMOS and contributors), v0.5.4.
import { ImageOverlayPlugin as ImageOverlayPluginBase } from '3d-tiles-renderer/three/plugins'
import { Mesh, type Color, type Object3D, type Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { ImageryCompositor } from './imagery/ImageryCompositor.js'
import { ImageryStatistics } from './imagery/ImageryStatistics.js'
import { isGpuComposedOverlay } from './imagery/XYZImageryOverlay.js'
import { wrapOverlaysNodeMaterial } from './wrapOverlaysNodeMaterial.js'

interface ImageOverlay {
  color: Color
  opacity: number
  alphaMask: boolean
  alphaInvert: boolean
}

export interface OverlayParams {
  layerMaps: { value: Array<Texture | null> }
  layerInfo: { value: ImageOverlay[] }
}

export interface ImageOverlayPluginOptions {
  /** Overlays to start with. More can be added with `addOverlay`. Default: none. */
  overlays?: object[]
  /** Size of each terrain tile's composed overlay texture, in pixels. Default: 256. */
  resolution?: number
  /** Split terrain tiles along imagery tile boundaries when imagery has more detail. Default: true. */
  enableTileSplitting?: boolean
  /** Main-thread time GPU composition may spend per frame, in milliseconds. Default: 2. */
  compositionBudgetMilliseconds?: number
}

/** Upstream private methods this class wraps (pinned to 3d-tiles-renderer 0.5.x). */
interface UpstreamInternals {
  addOverlay(overlay: object, order?: number | null): void
  deleteOverlay(overlay: object): void
  dispose(): void
  _updateLayers(tile: object): void
  _initTileSceneOverlayInfo(scene: Object3D, tile: object, overlay?: object | object[]): Promise<unknown>
  expandVirtualChildren(scene: Object3D, tile: object): Promise<void>
}

const upstream = ImageOverlayPluginBase.prototype as unknown as UpstreamInternals

/**
 * 3DTilesRenderer's `ImageOverlayPlugin`, for `WebGPURenderer`:
 *
 * - The GLSL `onBeforeCompile` material patch is replaced by a TSL `colorNode`.
 * - Overlays that accept a compositor (`XYZImageryOverlay`) compose each terrain tile's texture on the GPU
 *   instead of on a main-thread canvas. Call `composeImagery` once per frame to draw queued compositions.
 * - `statistics` counts the imagery work left on the main thread, per frame.
 *
 * Relies on the base class's `_wrapMaterials`, `_updateLayers`, `_initTileSceneOverlayInfo`,
 * `expandVirtualChildren` and `meshParams` internals: pinned to 3d-tiles-renderer 0.5.x.
 */
export class ImageOverlayPlugin extends ImageOverlayPluginBase {
  declare meshParams: WeakMap<Object3D, OverlayParams>
  /** Draws composite overlay textures on the GPU. Shared by every GPU-composed overlay of this plugin. */
  readonly compositor: ImageryCompositor
  /** Main-thread imagery work, per frame and in total. */
  readonly statistics = new ImageryStatistics()

  constructor({ compositionBudgetMilliseconds, ...options }: ImageOverlayPluginOptions = {}) {
    // The compositor must exist before the base constructor adds the initial overlays.
    const compositor = new ImageryCompositor({ budgetMilliseconds: compositionBudgetMilliseconds })
    super({ ...options, overlays: [], renderer: null as never } as ConstructorParameters<typeof ImageOverlayPluginBase>[0])
    this.compositor = compositor
    for (const overlay of options.overlays ?? []) this.addOverlay(overlay as never)
  }

  /**
   * Ends the statistics frame, then draws queued compositions within the budget. Call once per frame,
   * before rendering the scene.
   */
  composeImagery(renderer: WebGPURenderer): void {
    this.statistics.endFrame()
    const count = this.statistics.measure('compositionMilliseconds', () => this.compositor.render(renderer))
    this.statistics.addTilesComposited(count)
  }

  override addOverlay(overlay: Parameters<ImageOverlayPluginBase['addOverlay']>[0], order?: number): void {
    if (isGpuComposedOverlay(overlay)) overlay.compositor = this.compositor
    upstream.addOverlay.call(this, overlay, order ?? null)
  }

  override deleteOverlay(overlay: Parameters<ImageOverlayPluginBase['deleteOverlay']>[0]): void {
    upstream.deleteOverlay.call(this, overlay)
    if (isGpuComposedOverlay(overlay) && overlay.compositor === this.compositor) overlay.compositor = null
  }

  dispose(): void {
    upstream.dispose.call(this)
    this.compositor.dispose()
  }

  _wrapMaterials(scene: Object3D): void {
    scene.traverse(object => {
      if (object instanceof Mesh) {
        const params = wrapOverlaysNodeMaterial(object.material)
        this.meshParams.set(object, params)
      }
    })
  }

  _updateLayers(tile: object): void {
    this.statistics.measure('layerSetupMilliseconds', () => upstream._updateLayers.call(this, tile))
  }

  // Measures the synchronous part only: once the overlay is ready, that is the per-vertex layer UV
  // generation. With an array, upstream calls this method again for each overlay, which is measured there.
  _initTileSceneOverlayInfo(scene: Object3D, tile: object, overlay?: object | object[]): Promise<unknown> {
    if (overlay === undefined || Array.isArray(overlay)) return upstream._initTileSceneOverlayInfo.call(this, scene, tile, overlay)
    return this.statistics.measure('layerSetupMilliseconds', () => upstream._initTileSceneOverlayInfo.call(this, scene, tile, overlay))
  }

  // Upstream's implementation is `async` but never awaits, so this measures all of it.
  expandVirtualChildren(scene: Object3D, tile: object): Promise<void> {
    return this.statistics.measure('tileSplittingMilliseconds', () => upstream.expandVirtualChildren.call(this, scene, tile))
  }
}
