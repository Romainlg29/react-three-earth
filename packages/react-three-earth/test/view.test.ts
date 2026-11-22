import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Box3, BufferAttribute, BufferGeometry, MathUtils, Matrix4, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { getFlatRegionBox } from '../src/tiles/EarthTilesRenderer.js'
import { computeFlatPositions, FLAT_POSITION_ATTRIBUTE } from '../src/tiles/FlatMapPlugin.js'
import { ViewMorph } from '../src/view/ViewMorph.js'
import {
  ecefToGeodetic,
  latitudeToMercatorY,
  longitudeToMercatorX,
  mercatorScaleFactor,
  mercatorYToLatitude,
  unwrapLongitude,
  wrapMercatorXNear,
  WEB_MERCATOR_HALF_EXTENT_METERS,
  WEB_MERCATOR_MAX_LATITUDE_RADIANS,
} from '../src/view/webMercator.js'

const degrees = MathUtils.degToRad
const FUJI = { longitude: degrees(138.7274), latitude: degrees(35.3606) }

describe('Web Mercator', () => {
  it('makes the world a square ending at about 85.0511°', () => {
    expect(MathUtils.radToDeg(WEB_MERCATOR_MAX_LATITUDE_RADIANS)).toBeCloseTo(85.0511, 4)
    expect(latitudeToMercatorY(WEB_MERCATOR_MAX_LATITUDE_RADIANS)).toBeCloseTo(WEB_MERCATOR_HALF_EXTENT_METERS, 3)
    expect(longitudeToMercatorX(Math.PI)).toBeCloseTo(WEB_MERCATOR_HALF_EXTENT_METERS, 6)
    // Poles clamp to the edge instead of going to infinity
    expect(latitudeToMercatorY(Math.PI / 2)).toBeCloseTo(WEB_MERCATOR_HALF_EXTENT_METERS, 3)
  })

  it('round-trips latitudes', () => {
    for (const latitude of [-80, -35.3606, 0, 12.5, 60, 85]) {
      expect(MathUtils.radToDeg(mercatorYToLatitude(latitudeToMercatorY(degrees(latitude))))).toBeCloseTo(latitude, 10)
    }
  })

  it('enlarges lengths by 1 / cos(latitude)', () => {
    expect(mercatorScaleFactor(0)).toBe(1)
    expect(mercatorScaleFactor(degrees(60))).toBeCloseTo(2, 12)
  })

  it('places x on the copy of the world nearest the anchor', () => {
    const anchor = longitudeToMercatorX(degrees(179))
    const west = longitudeToMercatorX(degrees(-179))
    expect(wrapMercatorXNear(west, anchor)).toBeCloseTo(longitudeToMercatorX(degrees(181)), 6)
    expect(wrapMercatorXNear(anchor, anchor)).toBe(anchor)
  })

  it('unwraps longitudes around a reference', () => {
    expect(unwrapLongitude(-Math.PI + 0.01, Math.PI - 0.01)).toBeCloseTo(Math.PI + 0.01, 12)
    expect(unwrapLongitude(0.5, 0)).toBe(0.5)
  })
})

describe('ecefToGeodetic', () => {
  it('matches the iterative WGS84 conversion to a tenth of a millimetre on and above terrain', () => {
    const cartographic = { lat: 0, lon: 0, height: 0 }
    const result = { longitude: 0, latitude: 0, heightMeters: 0 }
    const position = new Vector3()
    for (const [longitude, latitude, height] of [
      [138.7274, 35.3606, 3776],
      [-70, -89.9, 2800],
      [0, 0, -400],
      [179.999, 89.999, 10],
      [12, 45, 100_000],
    ] as const) {
      WGS84_ELLIPSOID.getCartographicToPosition(degrees(latitude), degrees(longitude), height, position)
      ecefToGeodetic(position.x, position.y, position.z, result)
      WGS84_ELLIPSOID.getPositionToCartographic(position, cartographic)
      expect(result.longitude).toBeCloseTo(cartographic.lon, 12)
      // 2e-11 rad is 0.13 mm on the ground
      expect(Math.abs(result.latitude - degrees(latitude))).toBeLessThan(2e-11)
      expect(Math.abs(result.heightMeters - height)).toBeLessThan(1e-4)
    }
  })
})

describe('ViewMorph frames', () => {
  it('lays the map tangent at the anchor, true to scale there', () => {
    const view = new ViewMorph()
    view.setAnchor(FUJI.longitude, FUJI.latitude)
    const anchorFlat = view.geodeticToFlat(FUJI.longitude, FUJI.latitude, 0)
    expect(anchorFlat.clone().applyMatrix4(view.flatToEarth).distanceTo(view.anchorPosition)).toBeLessThan(1e-6)

    // 1 km east and north of the anchor on the globe and on the map, measured in the world
    for (const [dLongitude, dLatitude] of [[1, 0], [0, 1]] as const) {
      const globeA = new Vector3()
      const globeB = new Vector3()
      const step = 1e-4
      WGS84_ELLIPSOID.getCartographicToPosition(FUJI.latitude, FUJI.longitude, 0, globeA)
      WGS84_ELLIPSOID.getCartographicToPosition(FUJI.latitude + dLatitude * step, FUJI.longitude + dLongitude * step, 0, globeB)
      const flatB = view.geodeticToFlat(FUJI.longitude + dLongitude * step, FUJI.latitude + dLatitude * step, 0).applyMatrix4(view.flatToEarth)
      const globeDistance = globeA.distanceTo(globeB)
      const mapDistance = view.anchorPosition.distanceTo(flatB)
      // Spherical Web Mercator on the ellipsoid: within 0.7 % of the ground at the anchor
      expect(Math.abs(mapDistance / globeDistance - 1)).toBeLessThan(0.007)
    }

    // Heights stand along the ellipsoid normal, at true size at the anchor
    const summit = view.geodeticToFlat(FUJI.longitude, FUJI.latitude, 3776).applyMatrix4(view.flatToEarth)
    expect(summit.sub(view.anchorPosition).dot(view.anchorUp)).toBeCloseTo(3776, 6)
  })

  it('turns top-down while the map unrolls, anchored where the camera looks, without moving away', () => {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 1, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, distanceMeters: 60_000, headingDegrees: -40, pitchDegrees: -25 })
    view.setMode('2d', { durationSeconds: 1 })
    expect(view.transitioning).toBe(true)
    view.update(camera, 0.3)
    expect(view.morph).toBeGreaterThan(0)
    expect(view.morph).toBeLessThan(1)
    expect(MathUtils.radToDeg(view.anchorLongitudeRadians)).toBeCloseTo(138.7274, 4)
    expect(MathUtils.radToDeg(view.anchorLatitudeRadians)).toBeCloseTo(35.3606, 4)
    expect(camera.position.distanceTo(view.anchorPosition)).toBeCloseTo(60_000, 3)
    view.update(camera, 0.75)
    expect(view.morph).toBe(1)
    expect(view.transitioning).toBe(false)

    // Ends looking straight down at the anchor, from the same distance
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    expect(forward.dot(view.anchorUp)).toBeCloseTo(-1, 9)
    expect(camera.position.distanceTo(view.anchorPosition)).toBeCloseTo(60_000, 3)
  })

  it('from orbit, eases down to where the whole map fits, and plays backwards when reversed', () => {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 1, 1, 1e9)
    setCameraView(camera, { longitudeDegrees: 2.35, latitudeDegrees: 48.85, distanceMeters: 40_000_000, pitchDegrees: -90 })
    view.setMode('2d', { durationSeconds: 10 })
    view.update(camera, 0)
    const distance = () => camera.position.distanceTo(view.anchorPosition)
    let previous = distance()
    for (let step = 0; step < 10; step++) {
      view.update(camera, 1)
      // Never moves away, never jumps
      expect(distance()).toBeLessThanOrEqual(previous + 1e-3)
      previous = distance()
    }
    view.update(camera, 0.1)
    expect(view.transitioning).toBe(false)
    expect(view.morph).toBe(1)
    // Capped where the whole map height fills the screen (the pole slide adds a little)
    expect(distance()).toBeGreaterThanOrEqual(view.maximumFlatCameraHeightMeters(camera) - 1)

    // Reversed halfway back, it plays backwards to the map
    view.setMode('3d', { durationSeconds: 10 })
    view.update(camera, 0)
    view.update(camera, 5)
    expect(view.morph).toBeLessThan(1)
    view.setMode('2d')
    view.update(camera, 6)
    expect(view.morph).toBe(1)
  })

  it('re-anchors under the screen centre on the way back, without moving the view', () => {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 1, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 2.35, latitudeDegrees: 48.85, distanceMeters: 100_000, pitchDegrees: -90 })
    view.setMode('2d', { durationSeconds: 0 })
    view.update(camera, 0)

    // Pan 1500 km east on the map, then go back to 3D
    const eastward = new Vector3(1, 0, 0).transformDirection(view.anchorFrame)
    camera.position.addScaledVector(eastward, 1_500_000)
    camera.updateMatrixWorld()
    const before = view.earthToFlat.clone()
    const cameraFlatBefore = camera.position.clone().applyMatrix4(before)
    view.setMode('3d', { durationSeconds: 1 })
    view.update(camera, 0)

    // The camera sits over the same place of the map, and the new anchor is under it
    const cameraFlatAfter = camera.position.clone().applyMatrix4(view.earthToFlat)
    expect(cameraFlatAfter.x).toBeCloseTo(cameraFlatBefore.x, 3)
    expect(cameraFlatAfter.y).toBeCloseTo(cameraFlatBefore.y, 3)
    const anchorFlat = view.geodeticToFlat(view.anchorLongitudeRadians, view.anchorLatitudeRadians, 0)
    expect(Math.hypot(anchorFlat.x - cameraFlatAfter.x, anchorFlat.y - cameraFlatAfter.y)).toBeLessThan(1e-3)
    expect(view.inspect().mode).toBe('3d')
  })
})

describe('flat tile bounds', () => {
  it('places a tile region on the map plane around the anchor', () => {
    const view = new ViewMorph()
    view.setAnchor(FUJI.longitude, FUJI.latitude)
    const region = [degrees(138), degrees(35), degrees(139), degrees(36), -100, 3800]
    const box = new Box3()
    const scaleFactor = getFlatRegionBox(region, view, box)
    expect(scaleFactor).toBeCloseTo(mercatorScaleFactor(degrees(36)), 12)
    // About 91 km of longitude at 35.4°
    expect(box.max.x - box.min.x).toBeCloseTo(view.scale * longitudeToMercatorX(degrees(1)), 6)
    expect(box.containsPoint(new Vector3(0, 0, 0))).toBe(true)
    expect(box.max.z).toBeGreaterThan(3776)
  })
})

describe('computeFlatPositions', () => {
  it('stores Web Mercator positions relative to the mesh centre', () => {
    const geometry = new BufferGeometry()
    const points = [
      [138.7, 35.3, 0],
      [138.8, 35.3, 100],
      [138.7, 35.4, 3776],
    ].map(([longitude, latitude, height]) => WGS84_ELLIPSOID.getCartographicToPosition(degrees(latitude!), degrees(longitude!), height!, new Vector3()))
    const origin = points[0]!.clone()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flatMap(point => point.clone().sub(origin).toArray())), 3))
    const center = computeFlatPositions(geometry, new Matrix4().makeTranslation(origin), null)
    const flat = geometry.getAttribute(FLAT_POSITION_ATTRIBUTE)
    expect(flat.count).toBe(3)
    const expectedX = longitudeToMercatorX(degrees(138.8))
    // Float32 vertex positions relative to the tile origin keep the result within centimetres
    expect(Math.abs(flat.getX(1) + center[0] - expectedX)).toBeLessThan(0.05)
    expect(Math.abs(flat.getY(2) + center[1] - latitudeToMercatorY(degrees(35.4)))).toBeLessThan(0.05)
    expect(Math.abs(flat.getZ(2) + center[2] - 3776 * mercatorScaleFactor(degrees(35.4)))).toBeLessThan(0.05)
  })
})

describe('flat map like MapLibre', () => {
  function flatMapCamera(longitudeDegrees: number, latitudeDegrees: number, distanceMeters: number) {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 2, 1, 1e9)
    setCameraView(camera, { longitudeDegrees, latitudeDegrees, distanceMeters, pitchDegrees: -90 })
    view.setMode('2d', { durationSeconds: 0 })
    view.update(camera, 0)
    return { view, camera }
  }

  it('looks north when it starts from straight down', () => {
    const { view, camera } = flatMapCamera(138.7, 35.4, 100_000)
    const screenUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).transformDirection(view.earthToFlat)
    expect(screenUp.y).toBeCloseTo(1, 6)
  })

  it('stops zooming out where the whole map height fills the screen, and centres it', () => {
    const { view, camera } = flatMapCamera(138.7, 35.4, 40_000_000)
    view.constrainFlatCamera(camera)
    const flat = camera.position.clone().applyMatrix4(view.earthToFlat)
    // Visible half height on the map, in Web Mercator metres, equals the map's half height
    expect(flat.z * Math.tan(MathUtils.degToRad(30))).toBeCloseTo(WEB_MERCATOR_HALF_EXTENT_METERS, 0)
    expect(flat.y).toBeCloseTo(0, 3)
  })

  it('never shows past the poles', () => {
    const { view, camera } = flatMapCamera(0, 84, 1_000_000)
    view.constrainFlatCamera(camera)
    const flat = camera.position.clone().applyMatrix4(view.earthToFlat)
    const northHalfExtent = flat.z * Math.tan(MathUtils.degToRad(30))
    expect(flat.y + northHalfExtent).toBeLessThanOrEqual(WEB_MERCATOR_HALF_EXTENT_METERS + 1e-3)
  })

  it('repeats the world east and west when zoomed out, and wraps the camera back after a long pan', () => {
    const { view, camera } = flatMapCamera(0, 0, 40_000_000)
    view.constrainFlatCamera(camera)
    view.updateWorldCopies(camera)
    expect(view.firstWorldCopy).toBe(-1)
    expect(view.worldCopyCount).toBe(3)

    // Pan one and a quarter worlds east: the camera comes back to the middle copy, a quarter world east
    const east = new Vector3(1, 0, 0).transformDirection(view.anchorFrame)
    camera.position.addScaledVector(east, 2.5 * WEB_MERCATOR_HALF_EXTENT_METERS * view.scale)
    camera.updateMatrixWorld()
    view.constrainFlatCamera(camera)
    const flat = camera.position.clone().applyMatrix4(view.earthToFlat)
    expect(flat.x - view.anchorMercatorXMeters).toBeCloseTo(0.5 * WEB_MERCATOR_HALF_EXTENT_METERS, 0)
  })

  it('goes back to the globe across ±180° without throwing the camera a world away', () => {
    const { view, camera } = flatMapCamera(179, 10, 100_000)
    // Pan 300 km east, past the antimeridian
    camera.position.add(new Vector3(1, 0, 0).transformDirection(view.anchorFrame).multiplyScalar(300_000))
    camera.updateMatrixWorld()
    const before = camera.position.clone()
    view.setMode('3d')
    view.update(camera, 0)
    expect(view.inspect().anchorLongitudeDegrees).toBeLessThan(-177)
    // The map re-anchors under the camera (a few km as the tangent plane turns), not a world width away
    expect(camera.position.distanceTo(before)).toBeLessThan(20_000)
  })

  it('eases the pole clamp in when switching to the map near the ground', () => {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 2, 1, 1e9)
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 84.9, distanceMeters: 150_000, pitchDegrees: -90 })
    const before = camera.position.clone()
    view.setMode('2d', { durationSeconds: 1 })
    view.update(camera, 0)
    expect(camera.position.distanceTo(before)).toBeLessThan(1)
  })

  it('draws one copy on the globe', () => {
    const view = new ViewMorph()
    view.updateWorldCopies(new PerspectiveCamera())
    expect([view.firstWorldCopy, view.worldCopyCount, view.worldCopyReferenceXMeters]).toEqual([0, 1, view.anchorMercatorXMeters])
  })
})
