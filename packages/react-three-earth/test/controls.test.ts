import { describe, expect, it } from 'vitest'

import { lockPinchToFingers } from '../src/core/EarthControls.js'

function pinch(state: number, separations: { start: number; now: number }, pointerType = 'touch') {
  return {
    state,
    zoomDelta: 0,
    zoomSpeed: 1,
    pointerTracker: {
      getPointerType: () => pointerType,
      getPointerCount: () => 2,
      getTouchPointerDistance: () => separations.now,
      getStartTouchPointerDistance: () => separations.start,
    },
  }
}

describe('pinch zoom', () => {
  it('keeps the ground under the fingers: twice the spread, half the distance', () => {
    const controls = pinch(3, { start: 100, now: 200 })
    const separation = lockPinchToFingers(controls, null)
    expect(separation).toBe(200)
    // 3DTilesRenderer moves the camera by zoomDelta * distance * 0.0025 towards the zoom point
    expect(1 - controls.zoomDelta * 0.0025).toBeCloseTo(0.5, 9)
    // Next frame, from the last spread: 200 to 100 px doubles the distance
    const next = pinch(3, { start: 100, now: 100 })
    lockPinchToFingers(next, separation)
    expect(1 - next.zoomDelta * 0.0025).toBeCloseTo(2, 9)
  })

  it('leaves the mouse wheel and other gestures alone', () => {
    const wheel = pinch(3, { start: 100, now: 200 }, 'mouse')
    wheel.zoomDelta = 7
    expect(lockPinchToFingers(wheel, null)).toBeNull()
    expect(wheel.zoomDelta).toBe(7)
    const rotating = pinch(2, { start: 100, now: 200 })
    expect(lockPinchToFingers(rotating, 150)).toBeNull()
    expect(rotating.zoomDelta).toBe(0)
  })
})
