import { PerspectiveCamera, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { clampLongitudeDegrees, constrainView, validateCameraLimits } from '../src/core/cameraLimits.js'
import { Earth } from '../src/core/Earth.js'
import { EarthViewControls } from '../src/core/EarthControls.js'

const WIDTH_PIXELS = 800
const HEIGHT_PIXELS = 600
const renderer = { getSize: (target: { set(x: number, y: number): void }) => target.set(WIDTH_PIXELS, HEIGHT_PIXELS) } as unknown as WebGPURenderer

function createEarth(options: ConstructorParameters<typeof Earth>[0] = {}) {
  const earth = new Earth(options)
  const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
  earth.camera.setCamera(camera)
  earth.camera.setViewportSize(WIDTH_PIXELS, HEIGHT_PIXELS)
  return { earth, camera }
}

function runAnimation(earth: Earth, camera: PerspectiveCamera): void {
  for (let frame = 0; frame < 600 && earth.update(camera, renderer, 1 / 60); frame++);
}

afterEach(() => vi.restoreAllMocks())

describe('camera limits, pure', () => {
  it('clamps longitudes to a range, across the antimeridian too, towards the nearer edge', () => {
    expect(clampLongitudeDegrees(5, -10, 10)).toBe(5)
    expect(clampLongitudeDegrees(20, -10, 10)).toBe(10)
    expect(clampLongitudeDegrees(-100, -10, 10)).toBe(-10)
    // 170°E to 170°W, across the antimeridian
    expect(clampLongitudeDegrees(179, 170, -170)).toBe(179)
    expect(clampLongitudeDegrees(-175, 170, -170)).toBe(-175)
    expect(clampLongitudeDegrees(160, 170, -170)).toBe(170)
    expect(clampLongitudeDegrees(-160, 170, -170)).toBe(-170)
    // Opposite the range: the nearer edge, the shorter way round
    expect(clampLongitudeDegrees(-5, 170, -170)).toBe(-170)
    expect(clampLongitudeDegrees(5, 170, -170)).toBe(170)
    // A full turn holds every longitude
    expect(clampLongitudeDegrees(123, -180, 180)).toBe(123)
  })

  it('constrains zoom, tilt and centre, and returns the same object when inside', () => {
    const limits = { minimumZoom: 3, maximumZoom: 12, minimumTiltDegrees: 10, maximumTiltDegrees: 60, maximumBounds: { westDegrees: -5, southDegrees: 40, eastDegrees: 10, northDegrees: 52 } }
    const inside = { longitudeDegrees: 2, latitudeDegrees: 48, zoom: 8, pitchDegrees: -60 }
    expect(constrainView(inside, limits)).toBe(inside)
    expect(constrainView({ longitudeDegrees: 20, latitudeDegrees: 30, zoom: 15, pitchDegrees: -10 }, limits)).toEqual({
      longitudeDegrees: 10,
      latitudeDegrees: 40,
      zoom: 12,
      pitchDegrees: -30,
    })
    expect(constrainView({ ...inside, zoom: 1, pitchDegrees: -90 }, limits)).toMatchObject({ zoom: 3, pitchDegrees: -80 })
  })

  it('drops limits that cannot hold, with a warning that states the fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateCameraLimits({ minimumZoom: 10, maximumZoom: 4, maximumTiltDegrees: 50 })).toEqual({ maximumTiltDegrees: 50 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Swap them'))
    expect(validateCameraLimits({ maximumBounds: { westDegrees: 0, southDegrees: 10, eastDegrees: 5, northDegrees: 0 } })).toEqual({})
    expect(validateCameraLimits({ maximumZoom: Number.NaN })).toEqual({})
    expect(validateCameraLimits({ maximumTiltDegrees: 120, minimumTiltDegrees: -5 })).toEqual({ maximumTiltDegrees: 90, minimumTiltDegrees: 0 })
    // Held to 0 to 90 before the order check: never past straight down or above the horizon
    expect(validateCameraLimits({ minimumTiltDegrees: 95 })).toEqual({ minimumTiltDegrees: 90 })
    expect(validateCameraLimits({ minimumTiltDegrees: -20, maximumTiltDegrees: -10 })).toEqual({ minimumTiltDegrees: 0, maximumTiltDegrees: 0 })
  })
})

describe('camera limits on EarthCamera', () => {
  it('holds jumpTo inside the limits at once', () => {
    const { earth } = createEarth({ cameraLimits: { minimumZoom: 4, maximumZoom: 14, maximumTiltDegrees: 50 } })
    earth.camera.jumpTo({ longitudeDegrees: 6.86, latitudeDegrees: 45.83, zoom: 18, headingDegrees: 30, pitchDegrees: -10 })
    let view = earth.camera.getView()
    expect(view.zoom).toBeCloseTo(14, 6)
    expect(view.pitchDegrees).toBeCloseTo(-40, 4)
    expect(view.headingDegrees).toBeCloseTo(30, 4)
    expect(view.longitudeDegrees).toBeCloseTo(6.86, 6)
    earth.camera.jumpTo({ zoom: 1 })
    view = earth.camera.getView()
    expect(view.zoom).toBeCloseTo(4, 6)
  })

  it('moves a camera the app placed back inside on the next update, and then leaves it alone', () => {
    const { earth, camera } = createEarth({ cameraLimits: { maximumBounds: { westDegrees: -5, southDegrees: 41, eastDegrees: 10, northDegrees: 51 }, maximumZoom: 12 } })
    setCameraView(camera, { longitudeDegrees: 20, latitudeDegrees: 60, distanceMeters: 500, pitchDegrees: -90 })
    earth.update(camera, renderer, 1 / 60)
    const view = earth.camera.getView()
    expect(view.longitudeDegrees).toBeCloseTo(10, 6)
    expect(view.latitudeDegrees).toBeCloseTo(51, 6)
    expect(view.zoom).toBeCloseTo(12, 6)
    // Nothing moved since: the camera stays exactly where it is.
    const before = camera.matrixWorld.clone()
    earth.update(camera, renderer, 1 / 60)
    expect(camera.matrixWorld.equals(before)).toBe(true)
  })

  it('applies new limits on the next frame, and removes them with {}', () => {
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 0, zoom: 10, pitchDegrees: -90 })
    const requested = vi.fn()
    earth.addEventListener('framerequest', requested)
    earth.camera.setLimits({ maximumZoom: 8 })
    expect(requested).toHaveBeenCalled()
    earth.update(camera, renderer, 1 / 60)
    expect(earth.camera.getView().zoom).toBeCloseTo(8, 6)
    earth.camera.setLimits({})
    earth.camera.jumpTo({ zoom: 10 })
    expect(earth.camera.getView().zoom).toBeCloseTo(10, 6)
  })

  it('ends animations inside the limits, and holds a flight above the minimum zoom on the way', () => {
    const { earth, camera } = createEarth({ cameraLimits: { minimumZoom: 5, maximumZoom: 13 } })
    earth.camera.jumpTo({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 12, pitchDegrees: -90 })
    let lowestZoom = Infinity
    earth.addEventListener('move', () => (lowestZoom = Math.min(lowestZoom, earth.camera.getView().zoom)))
    void earth.camera.flyTo({ longitudeDegrees: 139.69, latitudeDegrees: 35.69, zoom: 17 }, { durationSeconds: 2 })
    runAnimation(earth, camera)
    const view = earth.camera.getView()
    expect(view.zoom).toBeCloseTo(13, 6)
    expect(view.longitudeDegrees).toBeCloseTo(139.69, 4)
    expect(lowestZoom).toBeGreaterThan(5 - 1e-6)
  })

  it('stops a zoom towards an off-centre point at the limit, without sliding the centre', () => {
    const { earth, camera } = createEarth({ cameraLimits: { maximumZoom: 12 } })
    earth.camera.jumpTo({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 12, pitchDegrees: -90 })
    earth.update(camera, renderer, 1 / 60)
    const before = earth.camera.getView()
    // A wheel tick at the screen's corner: the camera moves 30% of the way towards the ground there.
    const corner = earth.camera.unproject({ xPixels: 50, yPixels: 50 })!
    const target = earth.camera.toScenePosition(corner)
    camera.position.lerp(target, 0.3)
    camera.updateMatrixWorld()
    earth.update(camera, renderer, 1 / 60)
    const after = earth.camera.getView()
    expect(after.zoom).toBeCloseTo(12, 2)
    expect(after.longitudeDegrees).toBeCloseTo(before.longitudeDegrees, 6)
    expect(after.latitudeDegrees).toBeCloseTo(before.latitudeDegrees, 6)
  })

  it('keeps a pan moving at the minimum zoom, though zoom falls towards the pole at the same height', () => {
    const { earth, camera } = createEarth({ cameraLimits: { minimumZoom: 6 } })
    earth.camera.jumpTo({ longitudeDegrees: 10, latitudeDegrees: 50, zoom: 6, pitchDegrees: -90 })
    earth.update(camera, renderer, 1 / 60)
    for (let frame = 0; frame < 10; frame++) {
      // A drag frame: the camera turns northwards around the Earth's centre, at the same distance from it.
      camera.position.applyAxisAngle(new Vector3(0, 0, 1).cross(camera.position).normalize().negate(), 0.002)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()
      earth.update(camera, renderer, 1 / 60)
    }
    const view = earth.camera.getView()
    expect(view.latitudeDegrees).toBeGreaterThan(50.5)
    expect(view.zoom).toBeGreaterThanOrEqual(6 - 1e-6)
  })

  it('leaves a fresh camera alone until something places it, so a style\'s start view still applies', () => {
    const { earth, camera } = createEarth({ cameraLimits: { minimumZoom: 4 } })
    earth.update(camera, renderer, 1 / 60)
    expect(camera.position.length()).toBeLessThan(1000)
  })

  it('narrows the globe controls\' tilt to the tilt limits, and restores their own without limits', () => {
    const { earth, camera } = createEarth()
    const controls = new EarthViewControls(earth)
    controls.setCamera(camera)
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 0, zoom: 10, pitchDegrees: -90 })
    const ownMaximum = controls.globe.maxAltitude
    earth.camera.setLimits({ minimumTiltDegrees: 10, maximumTiltDegrees: 45 })
    controls.update(1 / 60)
    expect(controls.globe.maxAltitude).toBeCloseTo(Math.PI / 4, 9)
    expect(controls.globe.minAltitude).toBeCloseTo(Math.PI / 18, 9)
    earth.camera.setLimits({})
    controls.update(1 / 60)
    expect(controls.globe.maxAltitude).toBe(ownMaximum)
    expect(controls.globe.minAltitude).toBe(0)
    controls.dispose()
  })
})

describe('camera limits on the flat map', () => {
  it('holds jumpTo inside the limits in 2D', () => {
    const { earth, camera } = createEarth({ cameraLimits: { maximumZoom: 9, maximumBounds: { westDegrees: -10, southDegrees: 35, eastDegrees: 30, northDegrees: 60 } } })
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 45, zoom: 6, pitchDegrees: -90 })
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
    earth.camera.jumpTo({ longitudeDegrees: 40, latitudeDegrees: 50, zoom: 11 })
    const view = earth.camera.getView()
    expect(view.longitudeDegrees).toBeCloseTo(30, 5)
    expect(view.latitudeDegrees).toBeCloseTo(50, 5)
    expect(view.zoom).toBeCloseTo(9, 5)
  })
})
