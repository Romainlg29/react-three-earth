import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { describe, expect, it } from 'vitest'

import { setRegionVisibleBalanced } from '../src/tiles/regionVisibility.js'

describe('setRegionVisibleBalanced', () => {
  it('drops a hide that was never shown instead of throwing, and counts the rest as upstream', () => {
    const overlay = new XYZTilesOverlay({ url: 'https://example.com/{z}/{x}/{y}.png' })
    const counts = (overlay as unknown as { _visibleRegionCounts: Map<string, { count: number }> })._visibleRegionCounts
    const range = [0, 0, 0.5, 0.5]
    expect(() => (overlay as unknown as { setRegionVisible(range: number[], visible: boolean): void }).setRegionVisible(range, false)).toThrow()
    counts.clear()
    expect(() => setRegionVisibleBalanced(overlay, range, false)).not.toThrow()
    setRegionVisibleBalanced(overlay, range, true)
    setRegionVisibleBalanced(overlay, range, true)
    expect(counts.get('0_0_0.5_0.5')?.count).toBe(2)
    setRegionVisibleBalanced(overlay, range, false)
    setRegionVisibleBalanced(overlay, range, false)
    setRegionVisibleBalanced(overlay, range, false)
    expect(counts.has('0_0_0.5_0.5')).toBe(false)
  })
})
