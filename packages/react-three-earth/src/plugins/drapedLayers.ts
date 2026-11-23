import type { OrthographicCamera, RenderTarget } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { GeographicBounds, GeographicPosition } from '../core/camera.js'

/** The terrain region a draped layer draws, handed to its `draw`. */
export interface DrapedLayerRegion {
  /**
   * The region in normalised Web Mercator space: [west, south, east, north], x from 0 (180° W) to 1 (180° E),
   * y from 0 (about 85.05° S) to 1 (about 85.05° N).
   */
  mercatorRange: readonly [number, number, number, number]
  /** The region in degrees. */
  bounds: GeographicBounds
  /** The zoom the region is drawn at, as MapLibre and `earth.camera` count it (the world is 512 × 2^zoom pixels wide). Fractional. */
  zoom: number
  /** Width and height of the target, in pixels. */
  resolutionPixels: number
  /**
   * An orthographic camera spanning the region's own space: x from 0 (west edge) to 1 (east edge), y from 0
   * (south edge) to 1 (north edge). Render a scene placed with `project` through it.
   */
  camera: OrthographicCamera
  /**
   * Where a position falls in the region's own space (the space `camera` spans), computed in 64-bit on the
   * CPU, so placement stays exact at street zooms. Points outside the region fall outside 0 to 1. Longitudes
   * wrap to the copy closest to the region.
   */
  project(position: GeographicPosition): { x: number; y: number }
}

/** What a draped layer's `draw` receives. */
export interface DrapedLayerDrawInputs {
  renderer: WebGPURenderer
  /**
   * The region's texture: sRGB, 8 bits, `resolutionPixels` square, bound and cleared to transparent. Draw
   * with straight alpha; it is blended over the imagery layers.
   */
  target: RenderTarget
  region: DrapedLayerRegion
}

/**
 * A layer draped on the terrain above every `<Imagery>` layer, drawn by plugin code, registered with
 * `context.registerDrapedLayer` (or `earth.drapedLayers.register`). For effects that do not belong in a style:
 * a selection glow, a measurement buffer.
 *
 * It is drawn per terrain region, through the imagery compositor's queue and per-frame budget, and redrawn
 * only when `invalidate` is called: it is static. Each terrain tile inside `bounds` gets one more texture and
 * the terrain shader one more sample. For motion, use scene objects or render passes.
 */
export interface DrapedLayerDefinition {
  /** Unique on an earth: `'selection-glow'`. */
  id: string
  /**
   * Where the layer draws: regions outside are skipped (no texture, no draw). A function is read again on each
   * `invalidate`, so it can follow a selection; null draws nowhere. Default: everywhere.
   */
  bounds?: GeographicBounds | null | (() => GeographicBounds | null)
  /**
   * Draws one region into `target`. Called within the compositor's budget, with the renderer's state saved
   * and restored around it. Keep it to a few draw calls: it runs once per region inside `bounds`.
   */
  draw(inputs: DrapedLayerDrawInputs): void
}

/** What `registerDrapedLayer` returns. */
export interface DrapedLayerHandle {
  readonly id: string
  /**
   * Redraws the regions within `bounds` (no argument: everywhere), in place: each keeps showing its texture
   * until the new one is drawn. Cover where the content was and where it is now. Calls within a frame are
   * coalesced; redraws share the compositor's budget.
   */
  invalidate(bounds?: GeographicBounds): void
  /** Removes the layer. Removed with the plugin anyway. */
  remove(): void
}

/** Something that draws a draped layer (one overlay per terrain): told to redraw on `invalidate`. */
export interface DrapedLayerDrawer {
  invalidate(bounds?: GeographicBounds): void
  /** Regions held and regions with a texture, for `inspect`. */
  readonly regionCount: number
  readonly drawnRegionCount: number
}

/** One draped layer in `earth.inspect().drapedLayers`. */
export interface DrapedLayerInspection {
  id: string
  /** Terrain regions holding the layer. */
  regions: number
  /** Of those, regions inside its bounds, with a texture. */
  regionsDrawn: number
}

const EVERYWHERE: GeographicBounds = { westDegrees: -180, southDegrees: -90, eastDegrees: 180, northDegrees: 90 }

/** A registered draped layer: its definition, its place in the stack, and its drawers. */
export class RegisteredDrapedLayer {
  readonly definition: DrapedLayerDefinition
  /** Registration order: later layers draw above earlier ones. */
  readonly sequence: number
  protected readonly drawers = new Set<DrapedLayerDrawer>()

  constructor(definition: DrapedLayerDefinition, sequence: number) {
    this.definition = definition
    this.sequence = sequence
  }

  get id(): string {
    return this.definition.id
  }

  /** The bounds now, or null when it draws nowhere. Errors in a bounds function count as nowhere, reported. */
  readBounds(): GeographicBounds | null {
    const { bounds } = this.definition
    if (bounds === undefined) return EVERYWHERE
    if (typeof bounds !== 'function') return bounds
    try {
      return bounds()
    } catch (error) {
      console.error(`Draped layer "${this.id}": its bounds function threw, so it draws nowhere until the next invalidate(). Fix the function.`, error)
      return null
    }
  }

  /** Adds a drawer (an overlay on a terrain). Returns a function that removes it. */
  addDrawer(drawer: DrapedLayerDrawer): () => void {
    this.drawers.add(drawer)
    return () => this.drawers.delete(drawer)
  }

  invalidate(bounds?: GeographicBounds): void {
    for (const drawer of this.drawers) drawer.invalidate(bounds)
  }

  inspect(): DrapedLayerInspection {
    let regions = 0
    let regionsDrawn = 0
    for (const drawer of this.drawers) {
      regions += drawer.regionCount
      regionsDrawn += drawer.drawnRegionCount
    }
    return { id: this.id, regions, regionsDrawn }
  }
}

/** Listener of a registry: called after a layer was registered or removed. */
export type DrapedLayerListener = () => void

/** Checks a definition, throwing an error that states the fix. */
export function validateDrapedLayer(definition: DrapedLayerDefinition): void {
  const id = definition?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('registerDrapedLayer: give the layer a non-empty `id`.')
  if (typeof definition.draw !== 'function') throw new Error(`registerDrapedLayer("${id}"): \`draw\` must be a function that draws one region into its target.`)
  const { bounds } = definition
  if (bounds !== undefined && bounds !== null && typeof bounds !== 'function' && typeof bounds !== 'object') {
    throw new Error(`registerDrapedLayer("${id}"): \`bounds\` must be geographic bounds, null, or a function returning them.`)
  }
}

/**
 * The draped layers installed on one `Earth` (`earth.drapedLayers`), bottom to top. Plugins register through
 * `context.registerDrapedLayer`; the terrain draws each above every imagery layer.
 */
export class DrapedLayerRegistry {
  protected readonly layers = new Map<string, RegisteredDrapedLayer>()
  protected readonly listeners = new Set<DrapedLayerListener>()
  protected sequence = 0

  /** Adds a layer on top of the others. Throws when the id is taken, stating the fix. */
  register(definition: DrapedLayerDefinition): DrapedLayerHandle {
    validateDrapedLayer(definition)
    const { id } = definition
    if (this.layers.has(id)) throw new Error(`registerDrapedLayer: a draped layer with id "${id}" is already registered; pick another id or remove the other layer first.`)
    const layer = new RegisteredDrapedLayer(definition, ++this.sequence)
    this.layers.set(id, layer)
    this.notify()
    return {
      id,
      invalidate: bounds => {
        if (this.layers.get(id) === layer) layer.invalidate(bounds)
      },
      remove: () => {
        if (this.layers.get(id) !== layer) return
        this.layers.delete(id)
        this.notify()
      },
    }
  }

  get(id: string): RegisteredDrapedLayer | undefined {
    return this.layers.get(id)
  }

  has(id: string): boolean {
    return this.layers.has(id)
  }

  get size(): number {
    return this.layers.size
  }

  /** The layers bottom to top (registration order). */
  values(): IterableIterator<RegisteredDrapedLayer> {
    return [...this.layers.values()][Symbol.iterator]()
  }

  /** Calls `listener` after each change. Returns a function that removes it. */
  subscribe(listener: DrapedLayerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  inspect(): DrapedLayerInspection[] {
    return [...this.layers.values()].map(layer => layer.inspect())
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('DrapedLayerRegistry: a listener threw.', error)
      }
    }
  }
}
