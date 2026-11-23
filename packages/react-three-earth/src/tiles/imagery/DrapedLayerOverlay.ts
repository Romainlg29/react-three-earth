import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { OrthographicCamera, RenderTarget, type Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { GeographicBounds, GeographicPosition } from '../../core/camera.js'
import type { DrapedLayerDrawer, DrapedLayerRegion, RegisteredDrapedLayer } from '../../plugins/drapedLayers.js'
import { boundsToMercatorRectangles, rectanglesOverlap, type MercatorRectangle } from '../../vector/worker/rectangles.js'
import type { CompositionPriority, ImageryCompositor } from './ImageryCompositor.js'
import type { GpuComposedOverlay } from './XYZImageryOverlay.js'

/** Deepest level of the (never fetched) tiling the overlay borrows from `XYZTilesOverlay`. */
const TILING_LEVELS = 25
const MAP_TILE_SIZE_PIXELS = 512
const MAXIMUM_LATITUDE_DEGREES = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI

/** One terrain region the layer is held for. */
interface DrapedRegion {
  readonly key: string
  readonly range: readonly [number, number, number, number]
  /** Terrain tiles holding it. */
  locks: number
  /**
   * The region's texture. 1 × 1 and never drawn (transparent: new GPU textures start zeroed) while the region
   * is outside the layer's bounds; resized in place when it enters them, so the terrain keeps the same
   * `Texture` and needs no rebinding.
   */
  readonly target: RenderTarget
  /** Whether the target has its full size (the region is inside the bounds). */
  sized: boolean
  /** The draw in flight, if any. */
  controller: AbortController | null
  /** Settles when the first draw ends: 3DTilesRenderer waits for it before showing the tile. */
  firstDraw: Promise<Texture> | null
}

function latitudeToY(latitudeDegrees: number): number {
  const clamped = Math.max(-MAXIMUM_LATITUDE_DEGREES, Math.min(MAXIMUM_LATITUDE_DEGREES, latitudeDegrees))
  const latitude = (clamped * Math.PI) / 180
  return 0.5 + Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI)
}

function yToLatitude(y: number): number {
  return (Math.atan(Math.sinh((y - 0.5) * 2 * Math.PI)) * 180) / Math.PI
}

/**
 * Resizes a target in place. The new version makes materials that sample it rebind the new GPU texture
 * (three keeps the old binding of a resized render target otherwise).
 */
function resizeTarget(target: RenderTarget, sizePixels: number): void {
  target.setSize(sizePixels, sizePixels)
  target.texture.needsUpdate = true
}

function rangeRectangle([minimumX, minimumY, maximumX, maximumY]: readonly number[]): MercatorRectangle {
  return { minimumX: minimumX ?? 0, minimumY: minimumY ?? 0, maximumX: maximumX ?? 0, maximumY: maximumY ?? 0 }
}

/**
 * Draws a plugin's draped layer (`context.registerDrapedLayer`) onto terrain regions, through the shared
 * `ImageryCompositor`: under its per-frame budget, waited-for regions first. `ImageOverlayPlugin` creates one
 * per registered layer and stacks it above every imagery overlay.
 *
 * Regions outside the layer's bounds hold a 1 × 1 transparent target and are never drawn. `invalidate`
 * redraws in place, resizing a region's target when it enters or leaves the bounds.
 *
 * Extends 3DTilesRenderer's `XYZTilesOverlay` only for its Web Mercator tiling; nothing is fetched.
 */
export class DrapedLayerOverlay extends XYZTilesOverlay implements GpuComposedOverlay, DrapedLayerDrawer {
  /** Set by `ImageOverlayPlugin` when the overlay is added to it. */
  compositor: ImageryCompositor | null = null
  readonly layer: RegisteredDrapedLayer

  declare imageSource: { init(): Promise<void> }
  protected resolution = 256
  protected readonly regions = new Map<string, DrapedRegion>()
  /** Regions to redraw (or shrink) at the start of the next compositor frame. */
  protected readonly staleRegions = new Set<string>()
  protected readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1)
  protected readonly startRedraws = (): void => this.redrawStaleRegions()
  protected readonly removeDrawer: () => void
  /** Redraws after `invalidate` in flight (first draws are not counted: 3DTilesRenderer waits for those). */
  protected recompositionsInFlight = 0
  protected warnedDraw = false
  protected disposed = false
  /**
   * Called after `invalidate` resized held regions' targets (entering or leaving the bounds), so the owner can
   * recount the tile set's memory. `ImageOverlayPlugin` sets it.
   */
  onTargetsResized: (() => void) | null = null

  constructor(layer: RegisteredDrapedLayer) {
    super({ url: 'draped-layer://{z}/{x}/{y}', levels: TILING_LEVELS, tileDimension: 256, projection: 'EPSG:3857' })
    this.layer = layer
    this.removeDrawer = layer.addDrawer(this)
  }

  // Upstream `TiledImageOverlay._init` would create a region source over the (unused) XYZ image source.
  async _init(): Promise<void> {
    await this.imageSource.init()
  }

  get regionCount(): number {
    return this.regions.size
  }

  get drawnRegionCount(): number {
    let count = 0
    for (const region of this.regions.values()) if (region.sized) count++
    return count
  }

  /** Regions waiting for a redraw after `invalidate`, or being drawn. `Terrain.imageryRecompositionsPending` counts them. */
  get recompositionsPending(): number {
    return this.staleRegions.size + this.recompositionsInFlight
  }

  /** Smallest level whose 256-pixel tiles have at least `resolution` pixels across the range. */
  calculateLevel(range: number[]): number {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const size = Math.max(maximumX - minimumX, maximumY - minimumY)
    const level = Math.ceil(Math.log2(this.resolution / (256 * size)) - 1e-6)
    return Math.min(Math.max(level, 0), TILING_LEVELS - 1)
  }

  // Bounds can change on any `invalidate`: every region may get content, so 3DTilesRenderer always asks for it.
  hasContent(): boolean {
    return true
  }

  lockTexture(range: number[]): Promise<Texture> {
    const key = range.join('_')
    const existing = this.regions.get(key)
    if (existing !== undefined) {
      existing.locks++
      return existing.firstDraw ?? Promise.resolve(existing.target.texture)
    }
    const target = this.compositor?.createTarget(1) ?? new RenderTarget(1, 1)
    target.texture.name = 'DrapedLayer'
    const region: DrapedRegion = { key, range: [range[0] ?? 0, range[1] ?? 0, range[2] ?? 0, range[3] ?? 0], locks: 1, target, sized: false, controller: null, firstDraw: null }
    this.regions.set(key, region)
    if (this.isInside(region, this.readBoundsRectangles())) {
      const firstDraw = this.draw(region, 'preload').then(() => {
        if (region.firstDraw === firstDraw) region.firstDraw = null
        return target.texture
      })
      region.firstDraw = firstDraw
    }
    return region.firstDraw ?? Promise.resolve(target.texture)
  }

  // 3DTilesRenderer calls this when it starts waiting for the texture: draw it before preloads.
  getTexture(range: number[]): Promise<Texture | null> {
    const region = this.regions.get(range.join('_'))
    if (region === undefined) return Promise.resolve(null)
    if (region.firstDraw !== null) {
      this.compositor?.prioritize(region.target)
      return region.firstDraw
    }
    return Promise.resolve(region.target.texture)
  }

  releaseTexture(range: number[]): void {
    const key = range.join('_')
    const region = this.regions.get(key)
    if (region === undefined || --region.locks > 0) return
    this.regions.delete(key)
    this.staleRegions.delete(key)
    region.controller?.abort(new DOMException('Draped layer: region released', 'AbortError'))
    region.target.dispose()
  }

  // Drawn at the terrain tile's own resolution: a draped layer never asks for finer terrain tiles.
  shouldSplit(): boolean {
    return false
  }

  setResolution(resolution: number): void {
    this.resolution = resolution
  }

  /**
   * Redraws the held regions within `bounds` (no argument: all), in place, at the start of the next compositor
   * frame. Each region re-reads the layer's bounds: one that entered them gets a texture, one that left them
   * loses it.
   */
  invalidate(bounds?: GeographicBounds): void {
    if (this.disposed) return
    const rectangles = bounds === undefined ? null : boundsToMercatorRectangles(bounds)
    for (const region of this.regions.values()) {
      if (rectangles === null || rectangles.some(rectangle => rectanglesOverlap(rangeRectangle(region.range), rectangle))) this.staleRegions.add(region.key)
    }
    if (this.staleRegions.size > 0) this.compositor?.runBeforeNextRender(this.startRedraws)
  }

  /** Frees every region. Call after removing the overlay from its plugin. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeDrawer()
    for (const region of this.regions.values()) {
      region.controller?.abort(new DOMException('Draped layer: disposed', 'AbortError'))
      region.target.dispose()
    }
    this.regions.clear()
    this.staleRegions.clear()
  }

  protected readBoundsRectangles(): MercatorRectangle[] {
    const bounds = this.layer.readBounds()
    if (bounds === null) return []
    try {
      return boundsToMercatorRectangles(bounds)
    } catch (error) {
      console.error(`Draped layer "${this.layer.id}": its bounds are invalid, so it draws nowhere. ${(error as Error).message}`)
      return []
    }
  }

  protected isInside(region: DrapedRegion, rectangles: readonly MercatorRectangle[]): boolean {
    const rectangle = rangeRectangle(region.range)
    return rectangles.some(bounds => rectanglesOverlap(rectangle, bounds))
  }

  protected redrawStaleRegions(): void {
    const keys = [...this.staleRegions]
    this.staleRegions.clear()
    if (this.disposed) return
    const rectangles = this.readBoundsRectangles()
    let resized = false
    for (const key of keys) {
      const region = this.regions.get(key)
      if (region === undefined) continue
      if (this.isInside(region, rectangles)) {
        resized = this.grow(region) || resized
        void this.draw(region, region.firstDraw === null ? 'recomposition' : 'waited')
      } else {
        resized = this.shrink(region) || resized
      }
    }
    if (resized) this.onTargetsResized?.()
  }

  /** To the full resolution. Returns whether the target was resized. */
  protected grow(region: DrapedRegion): boolean {
    if (region.sized) return false
    resizeTarget(region.target, this.resolution)
    region.sized = true
    return true
  }

  /**
   * Back to a 1 × 1 transparent target: a resized render target is a new, zeroed GPU texture. Returns whether
   * the target was resized.
   */
  protected shrink(region: DrapedRegion): boolean {
    region.controller?.abort(new DOMException('Draped layer: region left the bounds', 'AbortError'))
    region.controller = null
    if (!region.sized) return false
    region.sized = false
    resizeTarget(region.target, 1)
    return true
  }

  /** Queues a draw of the region (replacing one in flight). Settles when it ends, drawn or not. */
  protected async draw(region: DrapedRegion, priority: CompositionPriority): Promise<void> {
    const compositor = this.compositor
    if (compositor === null) return
    // A first draw sizes the target before 3DTilesRenderer counts the tile's bytes.
    this.grow(region)
    region.controller?.abort(new DOMException('Draped layer: redrawn', 'AbortError'))
    const controller = new AbortController()
    region.controller = controller
    // Every draw but a tile's first one is a recomposition the map waits on, including one replacing a first draw.
    const recomposition = priority !== 'preload'
    if (recomposition) this.recompositionsInFlight++
    try {
      await compositor.enqueueRender(region.target, (renderer, target) => this.drawRegion(renderer, target, region), controller.signal, priority)
    } catch (error) {
      if (!controller.signal.aborted && !this.warnedDraw) {
        this.warnedDraw = true
        console.error(`Draped layer "${this.layer.id}": draw threw, so the region stays transparent until the next invalidate(). Fix the layer's draw function.`, error)
      }
    } finally {
      if (region.controller === controller) region.controller = null
      if (recomposition) this.recompositionsInFlight--
      // The last redraw settled after its frame: one more, so `loading` turns false (and `idle` fires) on demand-driven hosts.
      if (this.recompositionsPending === 0) compositor.onQueued?.()
    }
  }

  protected drawRegion(renderer: WebGPURenderer, target: RenderTarget, region: DrapedRegion): void {
    renderer.setRenderTarget(target)
    renderer.clear()
    this.layer.definition.draw({ renderer, target, region: this.describeRegion(region, target.width) })
  }

  protected describeRegion(region: DrapedRegion, resolutionPixels: number): DrapedLayerRegion {
    const [minimumX, minimumY, maximumX, maximumY] = region.range
    const width = maximumX - minimumX
    const height = maximumY - minimumY
    const centreX = (minimumX + maximumX) / 2
    return {
      mercatorRange: region.range,
      bounds: { westDegrees: minimumX * 360 - 180, southDegrees: yToLatitude(minimumY), eastDegrees: maximumX * 360 - 180, northDegrees: yToLatitude(maximumY) },
      zoom: Math.log2(resolutionPixels / (MAP_TILE_SIZE_PIXELS * width)),
      resolutionPixels,
      camera: this.camera,
      project: ({ longitudeDegrees, latitudeDegrees }: GeographicPosition) => {
        // The copy of the longitude closest to the region, so regions next to the antimeridian see both sides.
        let x = (longitudeDegrees + 180) / 360
        x -= Math.round(x - centreX)
        return { x: (x - minimumX) / width, y: (latitudeToY(latitudeDegrees) - minimumY) / height }
      },
    }
  }
}
