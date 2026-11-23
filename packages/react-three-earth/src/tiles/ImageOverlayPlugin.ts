// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
// Extends 3DTilesRendererJS's ImageOverlayPlugin (Apache-2.0, (c) NASA-AMMOS and contributors), v0.5.4.
import { ImageOverlayPlugin as ImageOverlayPluginBase } from '3d-tiles-renderer/three/plugins'
import { Mesh, type Color, type Object3D, type Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { StyleLayerTypeRegistry } from '../plugins/styleLayerTypes.js'
import { ImageryCompositor } from './imagery/ImageryCompositor.js'
import { ImageryStatistics } from './imagery/ImageryStatistics.js'
import { isGpuComposedOverlay } from './imagery/XYZImageryOverlay.js'
import { wrapOverlaysNodeMaterial } from './wrapOverlaysNodeMaterial.js'

/** An overlay that draws custom style layer types (`MapStyleOverlay`). */
interface StyleLayerTypeConsumer {
  setStyleLayerTypes(registry: StyleLayerTypeRegistry | null): void
}

function isStyleLayerTypeConsumer(overlay: unknown): overlay is StyleLayerTypeConsumer {
  return typeof (overlay as Partial<StyleLayerTypeConsumer> | null)?.setStyleLayerTypes === 'function'
}

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
  resolutionPixels?: number
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
  declare tiles: { dispatchEvent(event: { type: string }): void } | null
  /** Draws composite overlay textures on the GPU. Shared by every GPU-composed overlay of this plugin. */
  readonly compositor: ImageryCompositor
  /** Main-thread imagery work, per frame and in total. */
  readonly statistics = new ImageryStatistics()

  constructor({ compositionBudgetMilliseconds, resolutionPixels, overlays = [], enableTileSplitting }: ImageOverlayPluginOptions = {}) {
    const options = { resolution: resolutionPixels, enableTileSplitting, overlays: [], renderer: null as never }
    super(options as ConstructorParameters<typeof ImageOverlayPluginBase>[0])
    this.compositor = new ImageryCompositor({ budgetMilliseconds: compositionBudgetMilliseconds })
    this.compositor.onQueued = () => this.requestUpdate()
    // Added here, not by the base constructor, so they get the compositor.
    for (const overlay of overlays) this.addOverlay(overlay as never)
  }

  /**
   * Ends the statistics frame, then draws queued compositions within the budget. Call once per frame,
   * before rendering the scene. While compositions remain, it asks for another frame (`needs-update`).
   */
  composeImagery(renderer: WebGPURenderer): void {
    this.statistics.endFrame()
    const startMilliseconds = performance.now()
    const count = this.compositor.render(renderer)
    if (count === 0) return
    this.statistics.addTime('compositionMilliseconds', performance.now() - startMilliseconds)
    this.statistics.addTilesComposited(count)
    this.tiles?.dispatchEvent({ type: 'needs-render' })
    if (this.compositor.pendingCount > 0) this.requestUpdate()
  }

  /** Asks the host for another `TilesRenderer.update` (a frame), for hosts that render on demand. */
  protected requestUpdate(): void {
    this.tiles?.dispatchEvent({ type: 'needs-update' })
  }

  protected styleLayerTypes: StyleLayerTypeRegistry | null = null
  protected readonly styleLayerOverlays = new Set<StyleLayerTypeConsumer>()

  /** Hands the custom style layer types (plugins) to the overlays that draw style layers, now and later. */
  setStyleLayerTypes(registry: StyleLayerTypeRegistry | null): void {
    this.styleLayerTypes = registry
    for (const overlay of this.styleLayerOverlays) overlay.setStyleLayerTypes(registry)
  }

  override addOverlay(overlay: Parameters<ImageOverlayPluginBase['addOverlay']>[0], order?: number): void {
    if (isGpuComposedOverlay(overlay)) overlay.compositor = this.compositor
    if (isStyleLayerTypeConsumer(overlay)) {
      this.styleLayerOverlays.add(overlay)
      overlay.setStyleLayerTypes(this.styleLayerTypes)
    }
    upstream.addOverlay.call(this, overlay, order ?? null)
  }

  override deleteOverlay(overlay: Parameters<ImageOverlayPluginBase['deleteOverlay']>[0]): void {
    upstream.deleteOverlay.call(this, overlay)
    if (isStyleLayerTypeConsumer(overlay) && this.styleLayerOverlays.delete(overlay)) overlay.setStyleLayerTypes(null)
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
