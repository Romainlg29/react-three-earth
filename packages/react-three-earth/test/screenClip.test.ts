import { describe, expect, it } from 'vitest'

import { Imagery } from '../src/core/Imagery.js'
import { screenClipPlane, type ScreenClip } from '../src/core/screenClip.js'
import { MapStyleSource, RasterTileSource } from '../src/core/sources.js'

/** Whether the half-plane keeps the pixel at (u, v), the canvas's normalised coordinates from the top left. */
function keeps(clip: ScreenClip | null, u: number, v: number): boolean {
  const plane = screenClipPlane(clip)
  return plane.x * u + plane.y * v >= plane.z
}

describe('screenClipPlane', () => {
  it('keeps every pixel without a clip', () => {
    for (const [u, v] of [[0, 0], [1, 1], [0.5, 0.2]] as const) expect(keeps(null, u, v)).toBe(true)
  })

  it('keeps the named side of a vertical or horizontal line', () => {
    expect(keeps({ side: 'left', positionFraction: 0.3 }, 0.2, 0.9)).toBe(true)
    expect(keeps({ side: 'left', positionFraction: 0.3 }, 0.4, 0.1)).toBe(false)
    expect(keeps({ side: 'right', positionFraction: 0.3 }, 0.4, 0.1)).toBe(true)
    expect(keeps({ side: 'right', positionFraction: 0.3 }, 0.2, 0.9)).toBe(false)
    // v grows downwards, as CSS.
    expect(keeps({ side: 'top', positionFraction: 0.7 }, 0.9, 0.6)).toBe(true)
    expect(keeps({ side: 'top', positionFraction: 0.7 }, 0.1, 0.8)).toBe(false)
    expect(keeps({ side: 'bottom', positionFraction: 0.7 }, 0.1, 0.8)).toBe(true)
    expect(keeps({ side: 'bottom', positionFraction: 0.7 }, 0.9, 0.6)).toBe(false)
  })

  it('leaves no pixel uncovered by opposite sides of the same line', () => {
    for (let u = 0; u <= 1; u += 0.05) {
      const left = keeps({ side: 'left', positionFraction: 0.45 }, u, 0.5)
      const right = keeps({ side: 'right', positionFraction: 0.45 }, u, 0.5)
      expect(left || right).toBe(true)
    }
  })

  it('clamps the position to the canvas', () => {
    expect(keeps({ side: 'left', positionFraction: 2 }, 1, 0)).toBe(true)
    expect(keeps({ side: 'right', positionFraction: -1 }, 0, 0)).toBe(true)
  })
})

describe('Imagery.screenClip', () => {
  it('reaches every overlay of the layer, a map style included, through one shared plane', () => {
    const style = new MapStyleSource({ style: { version: 8, sources: {}, layers: [] } })
    const imagery = new Imagery({ sources: [new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png' }), style], screenClip: { side: 'left', positionFraction: 0.25 } })
    const planes = imagery.overlays.map(overlay => (overlay as { screenClipPlane?: unknown }).screenClipPlane)
    expect(planes[0]).toBe(planes[1])
    expect(planes[0]).toMatchObject({ x: -1, y: 0, z: -0.25 })

    imagery.screenClip = { side: 'bottom', positionFraction: 0.6 }
    expect(planes[0]).toMatchObject({ x: 0, y: 1, z: 0.6 })
    imagery.screenClip = null
    expect(planes[0]).toMatchObject({ x: 0, y: 0, z: -1 })
    imagery.dispose()
  })

  it('copies the value, so changing the object afterwards does nothing', () => {
    const imagery = new Imagery({ sources: [new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png' })] })
    const clip: ScreenClip = { side: 'right', positionFraction: 0.5 }
    imagery.screenClip = clip
    clip.positionFraction = 0.9
    expect(imagery.screenClip).toEqual({ side: 'right', positionFraction: 0.5 })
  })

  it('states the fix for an invalid clip', () => {
    const imagery = new Imagery({ sources: [new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png' })] })
    expect(() => (imagery.screenClip = { side: 'middle' as never, positionFraction: 0.5 })).toThrow(/side must be 'left', 'right', 'top' or 'bottom'/)
    expect(() => (imagery.screenClip = { side: 'left', positionFraction: Number.NaN })).toThrow(/positionFraction must be a number from 0 to 1/)
  })
})
