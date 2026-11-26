import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'

type RegionVisibilityCounts = { _visibleRegionCounts?: Map<string, unknown> }

const upstreamSetRegionVisible = (XYZTilesOverlay.prototype as unknown as { setRegionVisible: (range: number[], visible: boolean) => void }).setRegionVisible

/**
 * 3DTilesRenderer's `ImageOverlay.setRegionVisible`, without its throw when a region is hidden more often than shown.
 * Its `ImageOverlayPlugin` can report a tile hidden whose showing it never counted (a tile shown before its overlay
 * info had a range), and the bare `Error` it throws then stops the frame's whole update. Reads its private
 * `_visibleRegionCounts` (3d-tiles-renderer 0.5.4).
 */
export function setRegionVisibleBalanced(overlay: XYZTilesOverlay, range: number[], visible: boolean): void {
  const counts = (overlay as unknown as RegionVisibilityCounts)._visibleRegionCounts
  if (!visible && counts !== undefined && !counts.has(range.join('_'))) return
  upstreamSetRegionVisible.call(overlay, range, visible)
}
