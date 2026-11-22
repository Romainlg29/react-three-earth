import { collectAttributions, type AttributionProvider } from './attribution.js'
import type { ImagerySource } from './sources.js'

export interface ImageryOptions {
  /** Sources stacked bottom to top. */
  sources: ImagerySource[]
  /** 0 to 1. Default: 1. */
  opacity?: number
}

interface OverlayLike {
  opacity: number
  dispose?(): void
}

/** A raster layer draped on the terrain. Several `Imagery` layers stack in the order they are added. */
export class Imagery implements AttributionProvider {
  readonly sources: readonly ImagerySource[]
  /** The 3DTilesRenderer overlays, one per source. */
  readonly overlays: readonly OverlayLike[]
  protected _opacity: number

  constructor({ sources, opacity = 1 }: ImageryOptions) {
    this.sources = sources
    this._opacity = opacity
    this.overlays = sources.map(source => source.createOverlay({ opacity }) as OverlayLike)
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
