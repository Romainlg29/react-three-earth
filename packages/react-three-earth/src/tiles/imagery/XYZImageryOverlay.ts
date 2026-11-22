import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import type { Texture } from 'three'

import { composeRegionsOnGpu, type GpuRegionComposition, type NormalizedRange, type TiledRegionImageSourceLike } from './composeRegionsOnGpu.js'
import type { ImageryCompositor } from './ImageryCompositor.js'

/** An overlay that composes on the GPU when the plugin it is added to gives it a compositor. */
export interface GpuComposedOverlay {
  compositor: ImageryCompositor | null
}

/** Whether an overlay takes a compositor. */
export function isGpuComposedOverlay(overlay: unknown): overlay is GpuComposedOverlay {
  return typeof overlay === 'object' && overlay !== null && 'compositor' in overlay
}

/** Options of 3DTilesRenderer's `XYZTilesOverlay`. */
export type XYZImageryOverlayOptions = ConstructorParameters<typeof XYZTilesOverlay>[0]

/**
 * 3DTilesRenderer's `XYZTilesOverlay`, composing each terrain tile's texture on the GPU instead of on a
 * main-thread canvas. Source tiles are still fetched and decoded upstream (`createImageBitmap`, which decodes
 * off the main thread).
 */
export class XYZImageryOverlay extends XYZTilesOverlay implements GpuComposedOverlay {
  /** Set by `ImageOverlayPlugin` when the overlay is added to it. Null composes on a canvas, as upstream. */
  compositor: ImageryCompositor | null = null

  declare regionImageSource: TiledRegionImageSourceLike | null
  protected regionComposition: GpuRegionComposition | null = null

  // Upstream `TiledImageOverlay._init` creates the region source; it is private API (pinned to 0.5.x).
  async _init(): Promise<void> {
    await upstream._init.call(this)
    if (this.regionImageSource !== null) this.regionComposition = composeRegionsOnGpu(this.regionImageSource, () => this.compositor)
  }

  // 3DTilesRenderer calls this when it starts waiting for a terrain tile's texture (in its priority order,
  // visible tiles first), well after locking it at download start. Pinned to 0.5.x like `_init`.
  getTexture(range: NormalizedRange, level = upstream.calculateLevel.call(this, range)): Promise<Texture | null> | Texture | null {
    this.regionComposition?.prioritize([...range, level])
    return upstream.getTexture.call(this, range, level)
  }
}

/** Upstream `TiledImageOverlay` methods this class wraps. */
interface UpstreamInternals {
  _init(this: XYZImageryOverlay): Promise<void>
  calculateLevel(this: XYZImageryOverlay, range: NormalizedRange): number
  getTexture(this: XYZImageryOverlay, range: NormalizedRange, level: number): Promise<Texture | null> | Texture | null
}

const upstream = XYZTilesOverlay.prototype as unknown as UpstreamInternals
