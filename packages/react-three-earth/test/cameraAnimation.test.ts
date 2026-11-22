import { PerspectiveCamera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GeographicBounds } from '../src/core/camera.js'
import { createFlightPath, cubicBezier, fitBoundsOnMap, flightDurationSeconds, mercatorDistancePixels, toViewPadding } from '../src/core/cameraAnimation.js'
import { Earth } from '../src/core/Earth.js'
import { EarthViewControls } from '../src/core/EarthControls.js'
import { CameraMotionDetector, EarthEventTracker, type EarthEventType } from '../src/core/events.js'
import { formatViewHash, parseViewHash } from '../src/core/viewHash.js'

const WIDTH_PIXELS = 800
const HEIGHT_PIXELS = 600
const renderer = { getSize: (target: { set(x: number, y: number): void }) => target.set(WIDTH_PIXELS, HEIGHT_PIXELS) } as unknown as WebGPURenderer

function createEarth(view: '2d' | '3d' = '3d') {
  const earth = new Earth()
  const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
  earth.camera.setCamera(camera)
  earth.camera.setViewportSize(WIDTH_PIXELS, HEIGHT_PIXELS)
  earth.camera.jumpTo({ longitudeDegrees: 139.69, latitudeDegrees: 35.69, zoom: 10, headingDegrees: 0, pitchDegrees: -90 })
  if (view === '2d') {
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
  }
  return { earth, camera }
}

/** Runs the camera animation to its end at 60 frames a second; returns the frames it took. */
function runAnimation(earth: Earth, onFrame?: () => void): number {
  let frames = 0
  while (earth.camera.advanceAnimation(1 / 60)) {
    frames++
    onFrame?.()
    if (frames > 100_000) throw new Error('animation never ends')
  }
  return frames
}

const angleDifference = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180

const TOKYO = { longitudeDegrees: 139.69, latitudeDegrees: 35.69 }
const PARIS = { longitudeDegrees: 2.35, latitudeDegrees: 48.86 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('easing and the flight path', () => {
  it('cubicBezier matches CSS ease at its ends and is monotonic', () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    // CSS `ease` at half time is about 0.8024.
    expect(ease(0.5)).toBeCloseTo(0.8024, 3)
    let previous = 0
    for (let time = 0.01; time <= 1; time += 0.01) {
      expect(ease(time)).toBeGreaterThanOrEqual(previous)
      previous = ease(time)
    }
  })

  it('starts at the start, ends at the end, and zooms out on the way', () => {
    const path = createFlightPath({ startWidthPixels: 800, distancePixels: 50_000, zoomChange: 1 })
    expect(path.length).toBeGreaterThan(0)
    expect(path.centerAmount(0)).toBeCloseTo(0, 9)
    expect(path.zoomChange(0)).toBeCloseTo(0, 9)
    expect(path.centerAmount(path.length)).toBeCloseTo(1, 6)
    expect(path.zoomChange(path.length)).toBeCloseTo(1, 6)
    expect(path.zoomChange(path.length / 2)).toBeLessThan(-3)
  })

  it('divides screenSpeed by the curvature minimumZoom calls for', () => {
    const path = createFlightPath({ startWidthPixels: 800, distancePixels: 50_000, zoomChange: 0, minimumZoomChange: -2 })
    expect(path.curve).not.toBeCloseTo(1.42, 2)
    expect(flightDurationSeconds(path, { screenSpeed: 1 })).toBeCloseTo(path.length / (1 / path.curve), 9)
  })

  it('zooms without panning when the centre stays', () => {
    const path = createFlightPath({ startWidthPixels: 800, distancePixels: 0, zoomChange: 3 })
    expect(path.length).toBeGreaterThan(0)
    expect(path.zoomChange(path.length)).toBeCloseTo(3, 9)
    expect(path.zoomChange(path.length / 2)).toBeCloseTo(1.5, 9)
    expect(createFlightPath({ startWidthPixels: 800, distancePixels: 0, zoomChange: 0 }).length).toBe(0)
  })
})

describe('flyTo and easeTo', () => {
  for (const view of ['3d', '2d'] as const) {
    it(`flies Tokyo to Paris and ends at the requested view (${view})`, async () => {
      const { earth } = createEarth(view)
      const target = { ...PARIS, zoom: 12, headingDegrees: 30, pitchDegrees: view === '3d' ? -50 : -90 }
      const done = earth.camera.flyTo(target)
      expect(earth.camera.animating).toBe(true)
      let lowestZoom = Infinity
      const frames = runAnimation(earth, () => (lowestZoom = Math.min(lowestZoom, earth.camera.getView().zoom)))
      await expect(done).resolves.toBe(true)
      const end = earth.camera.getView()
      expect(end.longitudeDegrees).toBeCloseTo(target.longitudeDegrees, 6)
      expect(end.latitudeDegrees).toBeCloseTo(target.latitudeDegrees, 6)
      expect(end.zoom).toBeCloseTo(target.zoom, 6)
      expect(angleDifference(end.headingDegrees, target.headingDegrees)).toBeCloseTo(0, 3)
      expect(end.pitchDegrees).toBeCloseTo(target.pitchDegrees, 3)
      // Zooms out far above both ends, and takes as long as the curve says.
      expect(lowestZoom).toBeLessThan(5)
      const flight = createFlightPath({ startWidthPixels: WIDTH_PIXELS, distancePixels: mercatorDistancePixels(TOKYO, PARIS, 10), zoomChange: 2 })
      const durationSeconds = flightDurationSeconds(flight, {})
      expect(Math.abs(frames - durationSeconds * 60)).toBeLessThanOrEqual(1)
      expect(durationSeconds).toBeGreaterThan(3)
    })
  }

  it('takes durationSeconds when given, and follows speed otherwise', () => {
    const { earth } = createEarth()
    void earth.camera.flyTo({ ...PARIS, zoom: 12 }, { durationSeconds: 2 })
    expect(runAnimation(earth)).toBe(120)
    earth.camera.jumpTo({ ...TOKYO, zoom: 10 })
    void earth.camera.flyTo({ ...PARIS, zoom: 12 }, { speed: 1.2 })
    const slow = runAnimation(earth)
    earth.camera.jumpTo({ ...TOKYO, zoom: 10 })
    void earth.camera.flyTo({ ...PARIS, zoom: 12 }, { speed: 2.4 })
    const fast = runAnimation(earth)
    expect(slow / fast).toBeCloseTo(2, 1)
  })

  it('jumps when the flight would take longer than maximumDurationSeconds', async () => {
    const { earth } = createEarth()
    const done = earth.camera.flyTo({ ...PARIS, zoom: 12 }, { maximumDurationSeconds: 0.5 })
    expect(earth.camera.animating).toBe(false)
    await expect(done).resolves.toBe(true)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(PARIS.longitudeDegrees, 6)
  })

  it('eases along the short way round, heading included', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 175, latitudeDegrees: 0, zoom: 6, headingDegrees: 170, pitchDegrees: -60 })
    void earth.camera.easeTo({ longitudeDegrees: -175, headingDegrees: -170 }, { durationSeconds: 1 })
    for (let frame = 0; frame < 30; frame++) earth.camera.advanceAnimation(1 / 60)
    const middle = earth.camera.getView()
    expect(Math.abs(middle.longitudeDegrees)).toBeGreaterThan(175)
    expect(Math.abs(middle.headingDegrees)).toBeGreaterThan(170)
    runAnimation(earth)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(-175, 6)
    expect(earth.camera.getView().zoom).toBeCloseTo(6, 6)
  })

  it('jumps instead when the user prefers reduced motion, unless essential', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    const { earth } = createEarth()
    await expect(earth.camera.flyTo({ ...PARIS, zoom: 12 })).resolves.toBe(true)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(PARIS.longitudeDegrees, 6)
    void earth.camera.flyTo({ ...TOKYO, zoom: 12 }, { essential: true })
    expect(earth.camera.animating).toBe(true)
  })

  it('zoomTo, rotateTo, resetNorth, resetNorthPitch and panBy', async () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ ...TOKYO, zoom: 10, headingDegrees: 40, pitchDegrees: -60 })
    void earth.camera.zoomTo(12)
    runAnimation(earth)
    expect(earth.camera.getView().zoom).toBeCloseTo(12, 6)
    void earth.camera.rotateTo(-90)
    runAnimation(earth)
    expect(earth.camera.getView().headingDegrees).toBeCloseTo(-90, 4)
    void earth.camera.resetNorth()
    runAnimation(earth)
    expect(earth.camera.getView().headingDegrees).toBeCloseTo(0, 4)
    void earth.camera.resetNorthPitch()
    runAnimation(earth)
    expect(earth.camera.getView().pitchDegrees).toBeCloseTo(-90, 4)
    // Looking straight down with north up, 100 pixels right is east.
    const before = earth.camera.getView()
    const target = earth.unproject({ xPixels: WIDTH_PIXELS / 2 + 100, yPixels: HEIGHT_PIXELS / 2 })!
    void earth.camera.panBy({ xPixels: 100, yPixels: 0 })
    runAnimation(earth)
    const after = earth.camera.getView()
    expect(after.longitudeDegrees).toBeCloseTo(target.longitudeDegrees, 6)
    expect(after.latitudeDegrees).toBeCloseTo(target.latitudeDegrees, 6)
    expect(after.zoom).toBeCloseTo(before.zoom, 6)
  })
})

describe('cancelling animations', () => {
  it('stop() leaves the camera where it is and resolves false', async () => {
    const { earth } = createEarth()
    const done = earth.camera.flyTo({ ...PARIS, zoom: 12 })
    for (let frame = 0; frame < 60; frame++) earth.camera.advanceAnimation(1 / 60)
    const middle = earth.camera.getView()
    earth.camera.stop()
    await expect(done).resolves.toBe(false)
    expect(earth.camera.animating).toBe(false)
    expect(earth.camera.advanceAnimation(1 / 60)).toBe(false)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(middle.longitudeDegrees, 9)
  })

  it('jumpTo, another animation, a morph and user input on the controls stop it', async () => {
    const { earth, camera } = createEarth()
    const first = earth.camera.flyTo({ ...PARIS, zoom: 12 })
    earth.camera.jumpTo({ zoom: 9 })
    await expect(first).resolves.toBe(false)

    const second = earth.camera.easeTo({ zoom: 12 })
    const third = earth.camera.easeTo({ zoom: 13 })
    await expect(second).resolves.toBe(false)
    earth.camera.advanceAnimation(1 / 60)
    earth.setView('2d')
    earth.camera.advanceAnimation(1 / 60)
    await expect(third).resolves.toBe(false)
    earth.setView('3d', { durationSeconds: 0 })
    earth.view.update(camera, 0)

    const controls = new EarthViewControls(earth)
    const fourth = earth.camera.flyTo({ ...TOKYO, zoom: 12 })
    controls.globe.dispatchEvent({ type: 'start' })
    await expect(fourth).resolves.toBe(false)
    controls.dispose()
  })

  it('waits for the camera before the first frame, then starts', async () => {
    const earth = new Earth()
    const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
    const done = earth.camera.flyTo({ ...PARIS, zoom: 12 }, { durationSeconds: 1 })
    expect(earth.camera.animating).toBe(true)
    let frames = 0
    while (earth.update(camera, renderer, 1 / 60) && frames < 1000) frames++
    await expect(done).resolves.toBe(true)
    expect(earth.camera.getView().latitudeDegrees).toBeCloseTo(PARIS.latitudeDegrees, 6)
  })
})

/** Screen positions of points along a box's edges. */
function projectBoundsEdges(earth: Earth, { westDegrees, southDegrees, eastDegrees, northDegrees }: GeographicBounds) {
  const east = eastDegrees < westDegrees ? eastDegrees + 360 : eastDegrees
  const points: { xPixels: number; yPixels: number; visible: boolean }[] = []
  for (let index = 0; index <= 16; index++) {
    const amount = index / 16
    const longitudeDegrees = westDegrees + (east - westDegrees) * amount
    const latitudeDegrees = southDegrees + (northDegrees - southDegrees) * amount
    for (const position of [
      { longitudeDegrees, latitudeDegrees: southDegrees },
      { longitudeDegrees, latitudeDegrees: northDegrees },
      { longitudeDegrees: westDegrees, latitudeDegrees },
      { longitudeDegrees: east, latitudeDegrees },
    ]) {
      points.push({ ...earth.project(position) })
    }
  }
  return points
}

describe('fitBounds', () => {
  const cases: { name: string; bounds: GeographicBounds; padding?: number | object; viewPadding?: object; headingDegrees?: number }[] = [
    { name: 'a city', bounds: { westDegrees: 2.22, southDegrees: 48.81, eastDegrees: 2.47, northDegrees: 48.9 }, padding: 20 },
    { name: 'a wide region with uneven padding', bounds: { westDegrees: -5, southDegrees: 42, eastDegrees: 8, northDegrees: 51 }, padding: { leftPixels: 300, topPixels: 40 } },
    { name: 'across the antimeridian', bounds: { westDegrees: 170, southDegrees: -20, eastDegrees: -170, northDegrees: -10 }, padding: 50 },
    { name: 'rotated', bounds: { westDegrees: 10, southDegrees: 45, eastDegrees: 12, northDegrees: 46 }, padding: 30, headingDegrees: 35 },
    { name: 'with view padding', bounds: { westDegrees: 135, southDegrees: 34, eastDegrees: 141, northDegrees: 37 }, padding: 10, viewPadding: { rightPixels: 250, bottomPixels: 60 } },
  ]
  for (const view of ['2d', '3d'] as const) {
    for (const { name, bounds, padding, viewPadding, headingDegrees } of cases) {
      it(`contains ${name} inside the padding (${view})`, () => {
        const { earth } = createEarth(view)
        if (viewPadding !== undefined) earth.camera.setPadding(viewPadding)
        const change = earth.camera.cameraForBounds(bounds, { paddingPixels: padding as never, headingDegrees, pitchDegrees: -90 })
        expect(change).not.toBeNull()
        earth.camera.jumpTo(change!)
        const total = toViewPadding(padding as never)
        const own = toViewPadding(viewPadding as never)
        const left = total.leftPixels + own.leftPixels
        const right = WIDTH_PIXELS - total.rightPixels - own.rightPixels
        const top = total.topPixels + own.topPixels
        const bottom = HEIGHT_PIXELS - total.bottomPixels - own.bottomPixels
        const points = projectBoundsEdges(earth, bounds)
        // Inside, within half a pixel...
        for (const point of points) {
          expect(point.xPixels).toBeGreaterThan(left - 0.5)
          expect(point.xPixels).toBeLessThan(right + 0.5)
          expect(point.yPixels).toBeGreaterThan(top - 0.5)
          expect(point.yPixels).toBeLessThan(bottom + 0.5)
        }
        // ...and snug: the box reaches the padding on at least one side.
        const gap = Math.min(
          Math.min(...points.map(point => point.xPixels)) - left,
          right - Math.max(...points.map(point => point.xPixels)),
          Math.min(...points.map(point => point.yPixels)) - top,
          bottom - Math.max(...points.map(point => point.yPixels)),
        )
        expect(gap).toBeLessThan(0.5)
      })
    }
  }

  it('fits a tilted view on screen too', () => {
    const { earth } = createEarth()
    const bounds = { westDegrees: 138.5, southDegrees: 35, eastDegrees: 139.5, northDegrees: 36 }
    earth.camera.jumpTo(earth.camera.cameraForBounds(bounds, { paddingPixels: 40, headingDegrees: 20, pitchDegrees: -45 })!)
    const points = projectBoundsEdges(earth, bounds)
    expect(Math.min(...points.map(point => point.xPixels))).toBeGreaterThan(39.5)
    expect(Math.max(...points.map(point => point.xPixels))).toBeLessThan(WIDTH_PIXELS - 39.5)
    expect(Math.min(...points.map(point => point.yPixels))).toBeGreaterThan(39.5)
    expect(Math.max(...points.map(point => point.yPixels))).toBeLessThan(HEIGHT_PIXELS - 39.5)
  })

  it('zooms out until a box wider than the visible globe shows, then fits it', () => {
    const { earth } = createEarth()
    const pacific = { westDegrees: 120, southDegrees: -40, eastDegrees: -120, northDegrees: 40 }
    earth.camera.jumpTo(earth.camera.cameraForBounds(pacific, { paddingPixels: 20, pitchDegrees: -90 })!)
    const points = projectBoundsEdges(earth, pacific)
    expect(points.every(point => point.visible)).toBe(true)
  })

  it('keeps the map\'s fit for a box no single view of the globe shows whole', () => {
    const { earth } = createEarth()
    const world = { westDegrees: -180, southDegrees: -80, eastDegrees: 180, northDegrees: 80 }
    const mapFit = fitBoundsOnMap(world, { widthPixels: WIDTH_PIXELS, heightPixels: HEIGHT_PIXELS, padding: toViewPadding(0), viewPadding: toViewPadding(0), headingDegrees: 0 })!
    expect(earth.camera.cameraForBounds(world, { headingDegrees: 0, pitchDegrees: -90 })!.zoom).toBeCloseTo(mapFit.zoom, 9)
  })

  it('stops at maximumZoom, and refuses padding that leaves no room', async () => {
    const { earth } = createEarth()
    const tiny = { westDegrees: 2.35, southDegrees: 48.86, eastDegrees: 2.3501, northDegrees: 48.8601 }
    expect(earth.camera.cameraForBounds(tiny, { maximumZoom: 15 })!.zoom).toBe(15)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(earth.camera.cameraForBounds(tiny, { paddingPixels: 400 })).toBeNull()
    await expect(earth.camera.fitBounds(tiny, { paddingPixels: 400 })).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('animates there with flyTo, or easeTo when linear', async () => {
    const { earth } = createEarth()
    const bounds = { westDegrees: -5, southDegrees: 42, eastDegrees: 8, northDegrees: 51 }
    const expected = earth.camera.cameraForBounds(bounds, { pitchDegrees: -90 })!
    const done = earth.camera.fitBounds(bounds, { linear: true, pitchDegrees: -90 })
    expect(runAnimation(earth)).toBe(30) // easeTo's 0.5 s
    await expect(done).resolves.toBe(true)
    expect(earth.camera.getView().zoom).toBeCloseTo(expected.zoom!, 6)
  })

  it('fitBoundsOnMap puts the box centre at the middle of the padded area', () => {
    const fit = fitBoundsOnMap(
      { westDegrees: -1, southDegrees: -1, eastDegrees: 1, northDegrees: 1 },
      { widthPixels: 800, heightPixels: 600, padding: toViewPadding({ leftPixels: 200 }), viewPadding: toViewPadding(0), headingDegrees: 0 },
    )!
    // The free area is 600 wide, its middle 100 pixels right of the screen's: the centre sits west of the box's.
    expect(fit.longitudeDegrees).toBeLessThan(0)
    expect(fit.latitudeDegrees).toBeCloseTo(0, 9)
  })
})

describe('view padding', () => {
  for (const view of ['3d', '2d'] as const) {
    it(`centres jumpTo and getView in the padded area (${view})`, () => {
      const { earth } = createEarth(view)
      earth.camera.setPadding({ leftPixels: 300, topPixels: 100 })
      earth.camera.jumpTo({ ...PARIS, zoom: 11, headingDegrees: 20, pitchDegrees: -60 })
      const projected = earth.project(PARIS)
      expect(projected.xPixels).toBeCloseTo(300 + (WIDTH_PIXELS - 300) / 2, 3)
      expect(projected.yPixels).toBeCloseTo(100 + (HEIGHT_PIXELS - 100) / 2, 3)
      const read = earth.camera.getView()
      expect(read.longitudeDegrees).toBeCloseTo(PARIS.longitudeDegrees, 6)
      expect(read.latitudeDegrees).toBeCloseTo(PARIS.latitudeDegrees, 6)
      expect(read.zoom).toBeCloseTo(11, 6)
      expect(read.headingDegrees).toBeCloseTo(20, 4)
      expect(read.pitchDegrees).toBeCloseTo(-60, 4)
    })
  }
})

describe('zoom, rotate and pitch events', () => {
  const view = (groundMetersPerPixel: number, headingDegrees = 0, pitchDegrees = -90) => ({ groundMetersPerPixel, headingDegrees, pitchDegrees })

  it('start, repeat and end with the quantity, inside movestart and moveend', () => {
    const tracker = new EarthEventTracker()
    tracker.update({ cameraMoved: false, busy: true, view: view(10) })
    expect(tracker.update({ cameraMoved: true, busy: false, view: view(5) })).toEqual(['movestart', 'zoomstart', 'move', 'zoom'])
    expect(tracker.update({ cameraMoved: true, busy: false, view: view(4, 10) })).toEqual(['rotatestart', 'move', 'zoom', 'rotate'])
    // Panning only: zoom and rotate end while the camera keeps moving.
    expect(tracker.update({ cameraMoved: true, busy: false, view: view(4, 10) })).toEqual(['move', 'zoomend', 'rotateend'])
    expect(tracker.update({ cameraMoved: true, busy: false, view: view(4, 10, -60) })).toEqual(['pitchstart', 'move', 'pitch'])
    expect(tracker.update({ cameraMoved: false, busy: false })).toEqual(['pitchend', 'moveend', 'load', 'idle'])
  })

  it('treat a heading across ±180 as a small turn', () => {
    const tracker = new EarthEventTracker()
    tracker.update({ cameraMoved: false, busy: true, view: view(10, 179.99995) })
    expect(tracker.update({ cameraMoved: true, busy: true, view: view(10, -179.99995) })).toEqual(['movestart', 'move'])
  })

  it('fire from earth.update during an animation', () => {
    const { earth, camera } = createEarth()
    const fired: EarthEventType[] = []
    for (const type of ['movestart', 'zoomstart', 'zoomend', 'rotatestart', 'rotateend', 'pitchstart', 'moveend'] as const) earth.addEventListener(type, () => fired.push(type))
    earth.update(camera, renderer, 1 / 60)
    void earth.camera.easeTo({ zoom: 12, headingDegrees: 45 })
    let frames = 0
    while (earth.update(camera, renderer, 1 / 60) && frames < 1000) frames++
    expect(fired).toEqual(['movestart', 'zoomstart', 'rotatestart', 'zoomend', 'rotateend', 'moveend'])
  })
})

describe('camera motion', () => {
  it('ignores rounding noise in the camera matrix, but adds up a slow creep', () => {
    const detector = new CameraMotionDetector()
    const camera = new PerspectiveCamera(60, 4 / 3, 1, 1e8)
    camera.position.set(6_378_137, 1000, 2000)
    camera.updateMatrixWorld()
    detector.update(camera, 800, 600)
    // Flip the last bits, as controls re-deriving the same pose do.
    camera.matrixWorld.elements[12] = 6_378_137 + 2e-9
    expect(detector.update(camera, 800, 600)).toBe(false)
    camera.matrixWorld.elements[12] = 6_378_137 - 2e-9
    expect(detector.update(camera, 800, 600)).toBe(false)
    let moved = false
    for (let step = 1; step <= 10 && !moved; step++) {
      camera.matrixWorld.elements[12] = 6_378_137 + step * 2e-6
      moved = detector.update(camera, 800, 600)
    }
    expect(moved).toBe(true)
  })
})

describe('initialView', () => {
  it('does not stop an animation called before the first frame; it starts from the initial view', async () => {
    const earth = new Earth({ initialView: { ...TOKYO, zoom: 9, pitchDegrees: -90 } })
    const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
    const done = earth.camera.easeTo({ zoom: 11 }, { durationSeconds: 0.5 })
    earth.update(camera, renderer, 1 / 60)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(TOKYO.longitudeDegrees, 6)
    let frames = 0
    while (earth.update(camera, renderer, 1 / 60) && frames < 1000) frames++
    await expect(done).resolves.toBe(true)
    expect(earth.camera.getView().zoom).toBeCloseTo(11, 6)
  })

  it('counts at most one frame of the host\'s idle time on the first step', () => {
    const { earth } = createEarth()
    void earth.camera.flyTo({ ...PARIS, zoom: 12 }, { durationSeconds: 2 })
    // A vanilla host rendering on demand, idle for 5 s before this frame.
    expect(earth.camera.advanceAnimation(5)).toBe(true)
  })

  it('applies on the first update, once the camera is known', () => {
    const earth = new Earth({ initialView: { ...PARIS, zoom: 9, pitchDegrees: -70 } })
    const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
    earth.update(camera, renderer, 1 / 60)
    const view = earth.camera.getView()
    expect(view.longitudeDegrees).toBeCloseTo(PARIS.longitudeDegrees, 6)
    expect(view.zoom).toBeCloseTo(9, 6)
    expect(view.pitchDegrees).toBeCloseTo(-70, 4)
  })
})

/** A minimal element: listeners by type, and a bounding box. */
function createElement() {
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  return {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener)),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: WIDTH_PIXELS, height: HEIGHT_PIXELS }),
    fire: (type: string, event: object) => listeners.get(type)?.forEach(listener => listener(event)),
    count: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
  }
}

describe('pointer events', () => {
  it('report the screen position and the position on Earth, and tell clicks from drags', () => {
    const { earth } = createEarth()
    const element = createElement()
    earth.attachPointerEvents(element as unknown as HTMLElement)
    const clicks: { screen: unknown; geographic: unknown }[] = []
    const fired: string[] = []
    earth.addEventListener('click', event => clicks.push({ screen: event.screen, geographic: event.geographic }))
    for (const type of ['doubleclick', 'contextmenu', 'pointermove'] as const) earth.addEventListener(type, event => fired.push(`${type}:${event.screen.xPixels}`))

    // The centre of the canvas, which starts 10 pixels right and 20 down in the page.
    const center = { clientX: 10 + WIDTH_PIXELS / 2, clientY: 20 + HEIGHT_PIXELS / 2 }
    element.fire('pointerdown', { ...center, isPrimary: true })
    element.fire('click', center)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]!.screen).toEqual({ xPixels: WIDTH_PIXELS / 2, yPixels: HEIGHT_PIXELS / 2 })
    expect(clicks[0]!.geographic).toMatchObject({ longitudeDegrees: expect.closeTo(TOKYO.longitudeDegrees, 6), latitudeDegrees: expect.closeTo(TOKYO.latitudeDegrees, 6) })

    // A drag of 10 pixels is not a click.
    element.fire('pointerdown', { ...center, isPrimary: true })
    element.fire('click', { clientX: center.clientX + 10, clientY: center.clientY })
    expect(clicks).toHaveLength(1)

    element.fire('dblclick', center)
    element.fire('contextmenu', center)
    element.fire('pointermove', { clientX: 15, clientY: 20 })
    expect(fired).toEqual([`doubleclick:${WIDTH_PIXELS / 2}`, `contextmenu:${WIDTH_PIXELS / 2}`, 'pointermove:5'])

    earth.detachPointerEvents()
    expect(element.count()).toBe(0)
  })

  it('measures from the canvas when events come from another element', () => {
    const { earth } = createEarth()
    const source = createElement()
    const canvas = { getBoundingClientRect: () => ({ left: 110, top: 70, width: WIDTH_PIXELS, height: HEIGHT_PIXELS }) }
    earth.attachPointerEvents(source as unknown as HTMLElement, { canvas: canvas as unknown as HTMLElement })
    let screen: unknown
    earth.addEventListener('pointermove', event => (screen = event.screen))
    source.fire('pointermove', { clientX: 120, clientY: 75 })
    expect(screen).toEqual({ xPixels: 10, yPixels: 5 })
  })

  it('reports null on sky', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ zoom: 12, pitchDegrees: 0 })
    const element = createElement()
    earth.attachPointerEvents(element as unknown as HTMLElement)
    let geographic: unknown = 'unset'
    earth.addEventListener('click', event => (geographic = event.geographic))
    element.fire('pointerdown', { clientX: 410, clientY: 30, isPrimary: true })
    element.fire('click', { clientX: 410, clientY: 30 })
    expect(geographic).toBeNull()
  })
})

describe('view hash', () => {
  it('round-trips the view in MapLibre format', () => {
    const view = { zoom: 12.3456, latitudeDegrees: 48.858_37, longitudeDegrees: 2.294_48, headingDegrees: -30.04, pitchDegrees: -40 }
    const hash = formatViewHash(view)
    expect(hash).toBe('#12.35/48.85837/2.29448/-30/50')
    expect(parseViewHash(hash)).toEqual({ zoom: 12.35, latitudeDegrees: 48.858_37, longitudeDegrees: 2.294_48, headingDegrees: -30, pitchDegrees: -40 })
  })

  it('leaves out heading and pitch when they are 0, and rejects other hashes', () => {
    expect(formatViewHash({ zoom: 3, latitudeDegrees: 10, longitudeDegrees: 20, headingDegrees: 0, pitchDegrees: -90 })).toBe('#3/10/20')
    expect(parseViewHash('#3/10/20')).toEqual({ zoom: 3, latitudeDegrees: 10, longitudeDegrees: 20, headingDegrees: 0, pitchDegrees: -90 })
    expect(parseViewHash('#map')).toBeNull()
    expect(parseViewHash('#3/100/20')).toBeNull()
    expect(parseViewHash('')).toBeNull()
  })
})
