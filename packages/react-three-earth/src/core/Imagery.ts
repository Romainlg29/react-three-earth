import type { Vector3 } from 'three'

import { collectAttributions, type AttributionProvider } from './attribution.js'
import { screenClipPlane, validateScreenClip, type ScreenClip } from './screenClip.js'
import type { ImagerySource } from './sources.js'

export interface ImageryOptions {
  /** Sources stacked bottom to top. */
  sources: ImagerySource[]
  /** 0 to 1. Default: 1. */
  opacity?: number
  /** Keeps the layer to one part of the canvas (see `ScreenClip`). Default: null, the whole canvas. */
  screenClip?: ScreenClip | null
}

interface OverlayLike {
  opacity: number
  /** Read by the terrain shader, and by a map style's labels and buildings, every frame. */
  screenClipPlane?: Vector3
  dispose?(): void
}

/** A raster layer draped on the terrain. Several `Imagery` layers stack in the order they are added. */
export class Imagery implements AttributionProvider {
  readonly sources: readonly ImagerySource[]
  /** The 3DTilesRenderer overlays, one per source. */
  readonly overlays: readonly OverlayLike[]
  protected _opacity: number
  protected _screenClip: ScreenClip | null = null
  /** `screenClip` as a half-plane, shared by every overlay of the layer. */
  protected readonly screenClipPlane = screenClipPlane(null)

  constructor({ sources, opacity = 1, screenClip = null }: ImageryOptions) {
    this.sources = sources
    this._opacity = opacity
    this.overlays = sources.map(source => source.createOverlay({ opacity }) as OverlayLike)
    for (const overlay of this.overlays) overlay.screenClipPlane = this.screenClipPlane
    this.screenClip = screenClip
  }

  get screenClip(): ScreenClip | null {
    return this._screenClip
  }

  /**
   * Keeps the layer to one side of a line across the canvas: its imagery, and a map style's labels and 3D buildings.
   * Null shows it everywhere. Takes effect on the next frame, with no shader rebuild, so it can change every frame
   * (a swipe slider). The value is copied: assign a new object to change it. Ask for a frame
   * (`earth.requestFrame()`) when rendering on demand.
   */
  set screenClip(value: ScreenClip | null) {
    validateScreenClip(value, 'Imagery')
    this._screenClip = value === null ? null : { side: value.side, positionFraction: value.positionFraction }
    screenClipPlane(value, this.screenClipPlane)
  }

  get opacity(): number {
    return this._opacity
  }

  /** Takes effect on the next frame, with no shader rebuild. */
  set opacity(value: number) {
    this._opacity = value
    for (const overlay of this.overlays) overlay.opacity = value
  }

  /** The credits of the layer's sources, in source order, de-duplicated. */
  getAttributions(): readonly string[] {
    return collectAttributions(this.sources.map(source => ({ getAttributions: () => source.getAttributions?.() ?? [] })))
  }

  /** Calls `listener` when `getAttributions()` changes. Returns a function that removes it. */
  addAttributionListener(listener: () => void): () => void {
    const removers = this.sources.map(source => source.addAttributionListener?.(listener))
    return () => {
      for (const remove of removers) remove?.()
    }
  }

  /** Frees what the sources hold (workers, caches). Call after removing the layer from the earth. */
  dispose(): void {
    for (const overlay of this.overlays) overlay.dispose?.()
  }
}
