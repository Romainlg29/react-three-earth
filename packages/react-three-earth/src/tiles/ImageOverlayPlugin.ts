// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
// Extends 3DTilesRendererJS's ImageOverlayPlugin (Apache-2.0, (c) NASA-AMMOS and contributors), v0.5.4.
import { ImageOverlayPlugin as ImageOverlayPluginBase } from '3d-tiles-renderer/three/plugins'
import { Mesh, type Color, type Object3D, type Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { DrapedLayerRegistry, RegisteredDrapedLayer } from '../plugins/drapedLayers.js'
import type { StyleLayerTypeRegistry } from '../plugins/styleLayerTypes.js'
import type { SymbolEffectRegistry } from '../plugins/symbolEffects.js'
import { DrapedLayerOverlay } from './imagery/DrapedLayerOverlay.js'
import { GeoreferencedImageOverlay } from './imagery/GeoreferencedImageOverlay.js'
import { ImageryCompositor } from './imagery/ImageryCompositor.js'
import { ImageryStatistics } from './imagery/ImageryStatistics.js'
import { isGpuComposedOverlay } from './imagery/XYZImageryOverlay.js'
import { MAXIMUM_TERRAIN_LAYERS, wrapOverlaysNodeMaterial } from './wrapOverlaysNodeMaterial.js'

/** An overlay that draws custom style layer types and symbol effects (`MapStyleOverlay`). */
interface StyleLayerTypeConsumer {
  setStyleLayerTypes(registry: StyleLayerTypeRegistry | null): void
  setSymbolEffects(registry: SymbolEffectRegistry | null): void
}

function isStyleLayerTypeConsumer(overlay: unknown): overlay is StyleLayerTypeConsumer {
  return typeof (overlay as Partial<StyleLayerTypeConsumer> | null)?.setStyleLayerTypes === 'function'
}

interface ImageOverlay {
  color: Color
  opacity: number
  alphaMask: boolean
  alphaInvert: boolean
  /** The layer's texture holds premultiplied colour (a draped layer with `premultipliedAlpha`). Default: false. */
  premultipliedAlpha?: boolean
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
 * Draped layers draw above every imagery overlay: their order starts here, far above what imagery layers reach
 * (they count up from 0 by one per overlay added).
 */
const DRAPED_LAYER_ORDER_START = 1_000_000_000

function terrainFullError(what: string): Error {
  return new Error(
    `The terrain has no layer slot left for this ${what}: imagery sources and draped layers share ${MAXIMUM_TERRAIN_LAYERS}. ` +
      'Remove an imagery source or a draped layer first, or merge sources into one MapStyleSource.',
  )
}

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
  /** Upstream's per-overlay state; only `order` is read here. */
  declare overlayInfo: Map<object, { order: number }>
  declare overlays: object[]
  /** Upstream's job queue, null until `init`. */
  declare processQueue: object | null
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

  protected symbolEffects: SymbolEffectRegistry | null = null

  /** Hands the symbol effects (plugins) to the overlays that draw labels, now and later. */
  setSymbolEffects(registry: SymbolEffectRegistry | null): void {
    this.symbolEffects = registry
    for (const overlay of this.styleLayerOverlays) overlay.setSymbolEffects(registry)
  }

  protected drapedLayers: DrapedLayerRegistry | null = null
  protected unsubscribeDrapedLayers: (() => void) | null = null
  protected readonly drapedLayerOverlays = new Map<RegisteredDrapedLayer, DrapedLayerOverlay>()
  /** Layers left out for lack of a slot, reported once each. */
  protected readonly refusedDrapedLayers = new WeakSet<RegisteredDrapedLayer>()
  /** Recounts tile memory once a draped region's target changed size (its tile was counted at the old size). */
  protected readonly recountBytes = (): void => (this.tiles as { recalculateBytesUsed?(): void } | null)?.recalculateBytesUsed?.()

  /** Terrain layer slots left for imagery sources and draped layers (each takes one). */
  get freeLayerSlots(): number {
    return MAXIMUM_TERRAIN_LAYERS - this.overlays.length
  }

  /** Draws the draped layers plugins register (`earth.drapedLayers`) above every imagery overlay, now and later. */
  setDrapedLayers(registry: DrapedLayerRegistry | null): void {
    if (this.drapedLayers === registry) return
    this.unsubscribeDrapedLayers?.()
    this.unsubscribeDrapedLayers = null
    this.drapedLayers = registry
    if (registry !== null) {
      const unsubscribe = registry.subscribe(() => this.syncDrapedLayers())
      // Refuse a layer the terrain has no slot for, at registration, so the plugin gets the error.
      const removeValidator = registry.addValidator(({ id }) => {
        if (this.freeLayerSlots < 1) throw terrainFullError(`draped layer "${id}"`)
      })
      this.unsubscribeDrapedLayers = () => {
        unsubscribe()
        removeValidator()
      }
    }
    this.syncDrapedLayers()
  }

  /** The overlays drawing draped layers, bottom to top. */
  get drapedOverlays(): IterableIterator<DrapedLayerOverlay> {
    return this.drapedLayerOverlays.values()
  }

  /** Draped regions waiting for, or in, a redraw after `invalidate`. Read every frame: no allocation. */
  get drapedRecompositionsPending(): number {
    let count = 0
    for (const overlay of this.drapedLayerOverlays.values()) count += overlay.recompositionsPending
    return count
  }

  protected syncDrapedLayers(): void {
    const layers = new Set(this.drapedLayers?.values() ?? [])
    for (const [layer, overlay] of this.drapedLayerOverlays) {
      if (layers.has(layer)) continue
      this.drapedLayerOverlays.delete(layer)
      this.deleteOverlay(overlay as never)
      overlay.dispose()
    }
    for (const layer of layers) {
      if (this.drapedLayerOverlays.has(layer)) continue
      if (this.freeLayerSlots < 1) {
        // Only on a terrain change: registration refuses layers past the slots.
        if (!this.refusedDrapedLayers.has(layer)) console.error(terrainFullError(`draped layer "${layer.id}"`).message)
        this.refusedDrapedLayers.add(layer)
        continue
      }
      const overlay = new DrapedLayerOverlay(layer)
      overlay.onTargetsResized = this.recountBytes
      this.drapedLayerOverlays.set(layer, overlay)
      this.addOverlay(overlay as never, DRAPED_LAYER_ORDER_START + layer.sequence)
    }
  }

  override addOverlay(overlay: Parameters<ImageOverlayPluginBase['addOverlay']>[0], order?: number): void {
    if (this.overlays.includes(overlay)) return
    if (this.freeLayerSlots < 1) throw terrainFullError(overlay instanceof DrapedLayerOverlay ? `draped layer "${overlay.layer.id}"` : 'imagery source')
    // Imagery counts up below the draped layers, whenever it is added. A georeferenced picture is imagery drawn
    // the way a draped layer is.
    const isImagery = !(overlay instanceof DrapedLayerOverlay) || overlay instanceof GeoreferencedImageOverlay
    if (overlay instanceof GeoreferencedImageOverlay) overlay.onTargetsResized = this.recountBytes
    if (order === undefined && isImagery) {
      order = 0
      for (const other of this.overlays) {
        const otherOrder = this.overlayInfo.get(other)?.order ?? 0
        if (otherOrder < DRAPED_LAYER_ORDER_START) order = Math.max(order, otherOrder + 1)
      }
    }
    if (isGpuComposedOverlay(overlay)) overlay.compositor = this.compositor
    if (isStyleLayerTypeConsumer(overlay)) {
      this.styleLayerOverlays.add(overlay)
      overlay.setStyleLayerTypes(this.styleLayerTypes)
      overlay.setSymbolEffects(this.symbolEffects)
    }
    upstream.addOverlay.call(this, overlay, order ?? null)
  }

  override deleteOverlay(overlay: Parameters<ImageOverlayPluginBase['deleteOverlay']>[0]): void {
    if (this.processQueue === null) {
      // Before the plugin joined a tiles renderer, upstream's clean-up would throw on its missing queue: only unlist it.
      const index = this.overlays.indexOf(overlay)
      if (index !== -1) this.overlays.splice(index, 1)
      this.overlayInfo.delete(overlay)
    } else upstream.deleteOverlay.call(this, overlay)
    if (isStyleLayerTypeConsumer(overlay) && this.styleLayerOverlays.delete(overlay)) {
      overlay.setStyleLayerTypes(null)
      overlay.setSymbolEffects(null)
    }
    if (isGpuComposedOverlay(overlay) && overlay.compositor === this.compositor) overlay.compositor = null
  }

  dispose(): void {
    this.unsubscribeDrapedLayers?.()
    this.unsubscribeDrapedLayers = null
    upstream.dispose.call(this)
    for (const overlay of this.drapedLayerOverlays.values()) overlay.dispose()
    this.drapedLayerOverlays.clear()
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
