import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { PerspectiveCamera, Plane, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { applyTwoFingerTilt, applyTwoFingerTransformOnGlobe, applyTwoFingerTransformOnPlane, getScreenRay, getTiltRadians, type TwoFingerFrame } from '../src/core/TouchGestures.js'

function frame(previous: [number, number, number, number], current: [number, number, number, number], mode: TwoFingerFrame['mode'] = 'transform'): TwoFingerFrame {
  return {
    mode,
    previous: [new Vector2(previous[0], previous[1]), new Vector2(previous[2], previous[3])],
    current: [new Vector2(current[0], current[1]), new Vector2(current[2], current[3])],
    heightPixels: 700,
  }
}

function groundOnPlane(camera: PerspectiveCamera, plane: Plane, x: number, y: number): Vector3 {
  return getScreenRay(camera, new Vector2(x, y)).intersectPlane(plane, new Vector3())!
}

describe('two-finger gestures on the map', () => {
  const plane = new Plane(new Vector3(0, 0, 1), 0)
  function topDown(): PerspectiveCamera {
    const camera = new PerspectiveCamera(60, 0.6, 1, 1e8)
    camera.position.set(0, 0, 10_000)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    return camera
  }

  it('keeps the ground under both fingers while they pinch, twist and move together', () => {
    const camera = topDown()
    const gesture = frame([-0.2, 0, 0.2, 0], [-0.1, 0.3, 0.5, 0.1])
    const ground0 = groundOnPlane(camera, plane, -0.2, 0)
    const ground1 = groundOnPlane(camera, plane, 0.2, 0)
    expect(applyTwoFingerTransformOnPlane(camera, plane, gesture)).toBe(true)
    expect(groundOnPlane(camera, plane, -0.1, 0.3).distanceTo(ground0)).toBeLessThan(1e-6 * 10_000)
    expect(groundOnPlane(camera, plane, 0.5, 0.1).distanceTo(ground1)).toBeLessThan(1e-6 * 10_000)
  })

  it('keeps the same tilt and stays within the height limits', () => {
    const camera = topDown()
    // Fingers pinch in ten times: zoom out, capped
    applyTwoFingerTransformOnPlane(camera, plane, frame([-0.5, 0, 0.5, 0], [-0.05, 0, 0.05, 0]), { maximumHeightMeters: 20_000 })
    expect(camera.position.z).toBeCloseTo(20_000, 3)
    expect(getTiltRadians(camera, plane.normal)).toBeCloseTo(0, 9)
  })

  it('tilts towards the horizon when both fingers move up the screen, within the limit', () => {
    const camera = topDown()
    const pivot = new Vector3()
    applyTwoFingerTilt(camera, frame([-0.2, -0.5, 0.2, -0.5], [-0.2, 0, 0.2, 0], 'tilt'), pivot, plane.normal, Math.PI / 3)
    expect(getTiltRadians(camera, plane.normal)).toBeCloseTo(Math.PI / 4, 6)
    // Still looking at the pivot, from the same distance
    expect(groundOnPlane(camera, plane, 0, 0).length()).toBeLessThan(1e-3)
    expect(camera.position.length()).toBeCloseTo(10_000, 3)
    applyTwoFingerTilt(camera, frame([-0.2, -1, 0.2, -1], [-0.2, 1, 0.2, 1], 'tilt'), pivot, plane.normal, Math.PI / 3)
    expect(getTiltRadians(camera, plane.normal)).toBeCloseTo(Math.PI / 3, 6)
  })
})

describe('two-finger gestures on the globe', () => {
  function groundOnGlobe(camera: PerspectiveCamera, x: number, y: number): Vector3 {
    return WGS84_ELLIPSOID.intersectRay(getScreenRay(camera, new Vector2(x, y)), new Vector3())!
  }

  it('keeps the ground under the fingers when zoomed in', () => {
    const camera = new PerspectiveCamera(60, 0.6, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 2.35, latitudeDegrees: 48.85, distanceMeters: 20_000, pitchDegrees: -90 })
    const ground0 = groundOnGlobe(camera, -0.2, 0)
    const ground1 = groundOnGlobe(camera, 0.2, 0)
    applyTwoFingerTransformOnGlobe(camera, frame([-0.2, 0, 0.2, 0], [-0.3, 0.2, 0.3, -0.1]))
    // Within a few metres over a ~10 km span: the globe is not quite a plane
    expect(groundOnGlobe(camera, -0.3, 0.2).distanceTo(ground0)).toBeLessThan(20)
    expect(groundOnGlobe(camera, 0.3, -0.1).distanceTo(ground1)).toBeLessThan(20)
  })

  it('zooms towards the Earth from orbit when the fingers miss the globe', () => {
    const camera = new PerspectiveCamera(60, 0.6, 1, 1e9)
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 40_000_000, pitchDegrees: -90 })
    const altitude = camera.position.length() - WGS84_ELLIPSOID.radius.x
    applyTwoFingerTransformOnGlobe(camera, frame([-0.9, 0, 0.9, 0], [-0.95, 0, 0.95, 0]))
    expect((camera.position.length() - WGS84_ELLIPSOID.radius.x) / altitude).toBeCloseTo(0.9 / 0.95, 6)
  })
})
