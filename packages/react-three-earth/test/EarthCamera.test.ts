import { PerspectiveCamera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { Earth } from '../src/core/Earth.js'
import type { EarthEventType } from '../src/core/events.js'
import { EarthEventTracker } from '../src/core/events.js'
import {
  groundMetersPerPixelToZoom,
  mercatorMetersPerPixelToZoom,
  zoomToGroundMetersPerPixel,
  zoomToMercatorMetersPerPixel,
} from '../src/core/zoom.js'

const WIDTH_PIXELS = 800
const HEIGHT_PIXELS = 600
const renderer = { getSize: (target: { set(x: number, y: number): void }) => target.set(WIDTH_PIXELS, HEIGHT_PIXELS) } as unknown as WebGPURenderer

function createEarth(view: '2d' | '3d' = '3d') {
  const earth = new Earth({ view })
  const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
  earth.camera.setCamera(camera)
  earth.camera.setViewportSize(WIDTH_PIXELS, HEIGHT_PIXELS)
  return { earth, camera }
}

/** Angle difference in degrees, wrapped to [-180, 180). */
const angleDifference = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180

describe('zoom', () => {
  it('matches MapLibre: zoom 0 is one 512-pixel tile for the whole world', () => {
    expect(zoomToMercatorMetersPerPixel(0)).toBeCloseTo((2 * Math.PI * 6_378_137) / 512, 6)
    expect(zoomToMercatorMetersPerPixel(1)).toBeCloseTo(zoomToMercatorMetersPerPixel(0) / 2, 6)
    expect(mercatorMetersPerPixelToZoom(zoomToMercatorMetersPerPixel(13.37))).toBeCloseTo(13.37, 10)
  })

  it('round-trips ground resolution at several latitudes', () => {
    for (const latitudeDegrees of [0, 35.36, 60, -72.5]) {
      for (const zoom of [0.5, 7, 14.25, 20]) {
        expect(groundMetersPerPixelToZoom(zoomToGroundMetersPerPixel(zoom, latitudeDegrees), latitudeDegrees)).toBeCloseTo(zoom, 9)
      }
    }
    expect(zoomToGroundMetersPerPixel(10, 60)).toBeCloseTo(zoomToMercatorMetersPerPixel(10) / 2, 9)
  })
})

describe('EarthCamera on the globe', () => {
  it('reads back the view setCameraView placed, looking straight down too', () => {
    const { earth, camera } = createEarth()
    for (const pitchDegrees of [-90, -60, -25, -5]) {
      const placed = { longitudeDegrees: 138.7, latitudeDegrees: 35.4, distanceMeters: 12_000, headingDegrees: -40, pitchDegrees }
      setCameraView(camera, placed)
      const view = earth.camera.getView()
      expect(view.longitudeDegrees).toBeCloseTo(placed.longitudeDegrees, 6)
      expect(view.latitudeDegrees).toBeCloseTo(placed.latitudeDegrees, 6)
      expect(view.heightMeters).toBeCloseTo(0, 2)
      expect(view.distanceMeters).toBeCloseTo(placed.distanceMeters, 2)
      expect(angleDifference(view.headingDegrees, placed.headingDegrees)).toBeCloseTo(0, 4)
      expect(view.pitchDegrees).toBeCloseTo(pitchDegrees, 4)
    }
  })

  it('round-trips zoom and distance through jumpTo at several latitudes', () => {
    const { earth } = createEarth()
    for (const latitudeDegrees of [0, 35.36, 60, -72.5]) {
      for (const zoom of [3, 9.5, 16]) {
        earth.camera.jumpTo({ longitudeDegrees: 10, latitudeDegrees, zoom, headingDegrees: 30, pitchDegrees: -50 })
        const view = earth.camera.getView()
        expect(view.zoom).toBeCloseTo(zoom, 6)
        expect(view.latitudeDegrees).toBeCloseTo(latitudeDegrees, 6)
        expect(earth.camera.getGroundResolutionMetersPerPixel()).toBeCloseTo(zoomToGroundMetersPerPixel(zoom, latitudeDegrees), 6)
        // Same zoom from the distance alone
        earth.camera.jumpTo({ distanceMeters: view.distanceMeters })
        expect(earth.camera.getView().zoom).toBeCloseTo(zoom, 6)
      }
    }
  })

  it('keeps zoom, heading and pitch when only the centre moves', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 2.35, latitudeDegrees: 48.85, zoom: 12, headingDegrees: 15, pitchDegrees: -40 })
    earth.camera.jumpTo({ longitudeDegrees: 139.69, latitudeDegrees: 35.69 })
    const view = earth.camera.getView()
    expect(view).toMatchObject({ zoom: expect.closeTo(12, 6), headingDegrees: expect.closeTo(15, 4), pitchDegrees: expect.closeTo(-40, 4) })
  })

  it('projects the centre to the middle of the screen, and round-trips project / unproject within a pixel', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: -122.4, latitudeDegrees: 37.8, zoom: 11, headingDegrees: 70, pitchDegrees: -35 })
    const centre = earth.project({ longitudeDegrees: -122.4, latitudeDegrees: 37.8 })
    expect(centre.visible).toBe(true)
    expect(centre.xPixels).toBeCloseTo(WIDTH_PIXELS / 2, 4)
    expect(centre.yPixels).toBeCloseTo(HEIGHT_PIXELS / 2, 4)
    for (const [xPixels, yPixels] of [[0, HEIGHT_PIXELS], [WIDTH_PIXELS, HEIGHT_PIXELS], [123, 456], [WIDTH_PIXELS / 2, 200]] as const) {
      const position = earth.unproject({ xPixels, yPixels })
      expect(position).not.toBeNull()
      const back = earth.project(position!)
      expect(Math.hypot(back.xPixels - xPixels, back.yPixels - yPixels)).toBeLessThan(1)
    }
  })

  it('returns null for sky, and hides points behind the horizon', () => {
    const { earth, camera } = createEarth()
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 5000, pitchDegrees: -2 })
    expect(earth.unproject({ xPixels: WIDTH_PIXELS / 2, yPixels: 0 })).toBeNull()
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 20_000_000, pitchDegrees: -90 })
    expect(earth.project({ longitudeDegrees: 0, latitudeDegrees: 0 }).visible).toBe(true)
    expect(earth.project({ longitudeDegrees: 180, latitudeDegrees: 0 }).visible).toBe(false)
  })

  it('bounds the view, across the antimeridian and over a pole', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 10, latitudeDegrees: 0, zoom: 10, headingDegrees: 0, pitchDegrees: -90 })
    const bounds = earth.camera.getBounds()
    const metersPerPixel = zoomToGroundMetersPerPixel(10, 0)
    const halfWidthDegrees = ((WIDTH_PIXELS / 2) * metersPerPixel) / 111_319.49
    expect(bounds.westDegrees).toBeCloseTo(10 - halfWidthDegrees, 2)
    expect(bounds.eastDegrees).toBeCloseTo(10 + halfWidthDegrees, 2)
    expect(bounds.southDegrees).toBeLessThan(0)
    expect(bounds.northDegrees).toBeGreaterThan(0)

    earth.camera.jumpTo({ longitudeDegrees: 180, latitudeDegrees: -16, zoom: 8 })
    const across = earth.camera.getBounds()
    expect(across.westDegrees).toBeGreaterThan(across.eastDegrees)
    expect(across.westDegrees).toBeGreaterThan(170)
    expect(across.eastDegrees).toBeLessThan(-170)

    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 84, zoom: 1.5, pitchDegrees: -90 })
    expect(earth.camera.getBounds()).toMatchObject({ westDegrees: -180, eastDegrees: 180, northDegrees: 90 })
  })
})

describe('EarthCamera bounds and edge cases', () => {
  it('reaches the horizon when the screen shows sky', () => {
    const { earth, camera } = createEarth()
    // About 2 km up, looking north just below the horizon: the horizon is about 160 km (1.44°) away.
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 2000 / Math.sin((10 * Math.PI) / 180), headingDegrees: 0, pitchDegrees: -10 })
    const bounds = earth.camera.getBounds()
    expect(bounds.northDegrees).toBeGreaterThan(1.3)
    expect(bounds.northDegrees).toBeLessThan(1.6)
  })

  it('bounds the whole globe when it sits inside the screen', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 20, latitudeDegrees: 0, distanceMeters: 60_000_000, headingDegrees: 0, pitchDegrees: -90 })
    const bounds = earth.camera.getBounds()
    expect(bounds.westDegrees).toBeLessThan(20 - 75)
    expect(bounds.eastDegrees).toBeGreaterThan(20 + 75)
    // From 60,000 km over the equator the outline reaches acos(R / d) ≈ 84° from the centre.
    expect(bounds.northDegrees).toBeGreaterThan(83)
    expect(bounds.southDegrees).toBeLessThan(-83)
  })

  it('keeps zoom finite at the poles', () => {
    const { earth } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 90, distanceMeters: 10_000, pitchDegrees: -90 })
    expect(Number.isFinite(earth.camera.getView().zoom)).toBe(true)
    expect(earth.camera.getView().zoom).toBeGreaterThan(5)
  })

  it('reports no camera in inspect() for an orthographic camera instead of throwing', async () => {
    const { OrthographicCamera } = await import('three')
    const earth = new Earth()
    earth.camera.setCamera(new OrthographicCamera())
    earth.camera.setViewportSize(WIDTH_PIXELS, HEIGHT_PIXELS)
    expect(earth.inspect().camera).toBeNull()
  })
})

describe('EarthCamera on the flat map', () => {
  it('keeps centre, zoom and heading through the morph to 2D', () => {
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, zoom: 12, headingDegrees: -40, pitchDegrees: -60 })
    const before = earth.camera.getView()
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
    expect(earth.view.morph).toBe(1)
    const after = earth.camera.getView()
    expect(after.longitudeDegrees).toBeCloseTo(before.longitudeDegrees, 6)
    expect(after.latitudeDegrees).toBeCloseTo(before.latitudeDegrees, 6)
    expect(after.zoom).toBeCloseTo(before.zoom, 6)
    expect(angleDifference(after.headingDegrees, before.headingDegrees)).toBeCloseTo(0, 3)
    expect(after.pitchDegrees).toBeCloseTo(-90, 3) // the morph looks straight down
  })

  it('round-trips jumpTo, and project / unproject within a pixel, away from the anchor', () => {
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 45, zoom: 6, pitchDegrees: -90 })
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
    earth.camera.jumpTo({ longitudeDegrees: 5, latitudeDegrees: 50, zoom: 9.5, headingDegrees: 20, pitchDegrees: -70 })
    const view = earth.camera.getView()
    expect(view.longitudeDegrees).toBeCloseTo(5, 6)
    expect(view.latitudeDegrees).toBeCloseTo(50, 6)
    expect(view.zoom).toBeCloseTo(9.5, 6)
    expect(view.headingDegrees).toBeCloseTo(20, 4)
    expect(view.pitchDegrees).toBeCloseTo(-70, 4)
    // On the flat map a pixel spans the same Web Mercator metres everywhere on screen.
    expect(earth.camera.getGroundResolutionMetersPerPixel()).toBeCloseTo(zoomToMercatorMetersPerPixel(9.5) * Math.cos((50 * Math.PI) / 180), 6)
    for (const [xPixels, yPixels] of [[10, 590], [400, 300], [790, 120]] as const) {
      const position = earth.unproject({ xPixels, yPixels })
      expect(position).not.toBeNull()
      const back = earth.project(position!)
      expect(Math.hypot(back.xPixels - xPixels, back.yPixels - yPixels)).toBeLessThan(1)
    }
  })

  it('jumps across the antimeridian onto the world copy next to the anchor', () => {
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 175, latitudeDegrees: 0, zoom: 8, pitchDegrees: -90 })
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
    earth.camera.jumpTo({ longitudeDegrees: -178 })
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(-178, 6)
    const bounds = earth.camera.getBounds()
    expect(bounds.westDegrees).toBeLessThan(bounds.eastDegrees)
  })

  it('projects onto the copy of the world the camera has panned into', async () => {
    const { Vector3 } = await import('three')
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 0, latitudeDegrees: 0, zoom: 6, headingDegrees: 0, pitchDegrees: -90 })
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.camera.jumpTo({ longitudeDegrees: 179 })
    // Pan 2° further east, past the antimeridian, without the controls' wrap back to the anchor's copy.
    const east = new Vector3().setFromMatrixColumn(earth.view.anchorFrame, 0)
    camera.position.addScaledVector(east, ((2 * Math.PI) / 180) * 6_378_137 * earth.view.scale)
    camera.updateMatrixWorld()
    earth.view.updateWorldCopies(camera)
    expect(earth.camera.getView().longitudeDegrees).toBeCloseTo(-179, 6)
    const projected = earth.project({ longitudeDegrees: -179, latitudeDegrees: 0 })
    expect(projected.visible).toBe(true)
    expect(projected.xPixels).toBeCloseTo(WIDTH_PIXELS / 2, 3)
    expect(projected.yPixels).toBeCloseTo(HEIGHT_PIXELS / 2, 3)
  })

  it('bounds the whole world when the map is narrower than the screen', () => {
    const { earth, camera } = createEarth()
    earth.camera.jumpTo({ longitudeDegrees: 30, latitudeDegrees: 0, zoom: 4, pitchDegrees: -90 })
    earth.setView('2d', { durationSeconds: 0 })
    earth.view.update(camera, 0)
    earth.view.updateWorldCopies(camera)
    earth.camera.jumpTo({ zoom: -0.5 })
    expect(earth.camera.getBounds()).toMatchObject({ westDegrees: -180, eastDegrees: 180 })
  })
})

describe('Earth events', () => {
  it('orders move, load and idle events', () => {
    const tracker = new EarthEventTracker()
    expect(tracker.update({ cameraMoved: false, busy: true })).toEqual([])
    expect(tracker.update({ cameraMoved: false, busy: false })).toEqual(['load', 'idle'])
    expect(tracker.update({ cameraMoved: false, busy: false })).toEqual([])
    expect(tracker.update({ cameraMoved: true, busy: false })).toEqual(['movestart', 'move'])
    expect(tracker.update({ cameraMoved: true, busy: true })).toEqual(['move'])
    expect(tracker.update({ cameraMoved: false, busy: true })).toEqual(['moveend'])
    expect(tracker.update({ cameraMoved: false, busy: false })).toEqual(['idle'])
  })

  it('dispatches them from earth.update, for jumpTo, and asks for frames', () => {
    const { earth, camera } = createEarth()
    const fired: EarthEventType[] = []
    for (const type of ['load', 'idle', 'movestart', 'move', 'moveend', 'framerequest'] as const) earth.addEventListener(type, () => fired.push(type))
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 1e6 })
    expect(earth.update(camera, renderer, 0.016)).toBe(false)
    expect(fired).toEqual(['load', 'idle'])
    expect(earth.inspect()).toMatchObject({ loaded: true, idle: true, camera: { zoom: expect.any(Number) } })

    fired.length = 0
    earth.camera.jumpTo({ zoom: 5 })
    expect(fired).toEqual(['framerequest'])
    expect(earth.update(camera, renderer, 0.016)).toBe(true) // one more frame, to see the camera stop
    expect(earth.update(camera, renderer, 0.016)).toBe(false)
    expect(fired).toEqual(['framerequest', 'movestart', 'move', 'moveend', 'idle'])
  })
})
