import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'

import { composeRegionsOnGpu, type TiledRegionImageSourceLike } from './composeRegionsOnGpu.js'
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

  // Upstream `TiledImageOverlay._init` creates the region source; it is private API (pinned to 0.5.x).
  async _init(): Promise<void> {
    await (XYZTilesOverlay.prototype as unknown as { _init(this: XYZImageryOverlay): Promise<void> })._init.call(this)
    if (this.regionImageSource !== null) composeRegionsOnGpu(this.regionImageSource, () => this.compositor)
  }
}
