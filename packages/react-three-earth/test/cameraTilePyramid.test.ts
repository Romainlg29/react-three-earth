import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { computeCameraTilePyramid, horizonCap, type PyramidTile } from '../src/vector/CameraTilePyramid.js'

const WIDTH = 1000
const HEIGHT = 650

function pyramidFor(view: { longitudeDegrees: number; latitudeDegrees: number; distanceMeters: number; headingDegrees: number; pitchDegrees: number }): PyramidTile[] {
  const camera = new PerspectiveCamera(60, WIDTH / HEIGHT, 1, 1e8)
  setCameraView(camera, view)
  camera.updateMatrixWorld()
  const cameraPosition = camera.position.clone()
  return computeCameraTilePyramid({
    camera,
    widthPixels: WIDTH,
    heightPixels: HEIGHT,
    toScenePosition: (longitude, latitude, target) => WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, 0, target) as Vector3,
    visibleCap: horizonCap(cameraPosition),
    cameraHeightMeters: (WGS84_ELLIPSOID.getPositionToCartographic(cameraPosition, { lat: 0, lon: 0, height: 0 }) as { height: number }).height,
    maximumZoom: 22,
  })
}

describe('computeCameraTilePyramid', () => {
  it('covers a top-down view with a few tiles of the camera zoom', () => {
    // 60 km straight down at 35° N: about zoom 9.2 on a 650-pixel-high, 60° view.
    const tiles = pyramidFor({ longitudeDegrees: 138.75, latitudeDegrees: 35.4, distanceMeters: 60_000, headingDegrees: 0, pitchDegrees: -90 })
    const zooms = new Set(tiles.map(tile => tile.z))
    expect([...zooms]).toEqual([9])
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    expect(tiles.length).toBeLessThanOrEqual(12)
  })
})

function overlapping(tiles: PyramidTile[]): boolean {
  const ranges = tiles.map(({ x, y, z }) => [x / 2 ** z, y / 2 ** z, (x + 1) / 2 ** z, (y + 1) / 2 ** z] as const)
  return ranges.some((a, i) => ranges.some((b, j) => i !== j && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]))
}

describe('computeCameraTilePyramid, pitched and from afar', () => {
  it('goes deeper near the camera and shallower towards the horizon, without overlaps', () => {
    const tiles = pyramidFor({ longitudeDegrees: 138.75, latitudeDegrees: 35.4, distanceMeters: 25_000, headingDegrees: 30, pitchDegrees: -40 })
    const zooms = tiles.map(tile => tile.z)
    expect(Math.min(...zooms)).toBeLessThan(10)
    expect(Math.max(...zooms)).toBeGreaterThan(10)
    expect(overlapping(tiles)).toBe(false)
  })

  it('stays bounded looking along the ground (no splitting down to the deepest zoom under the camera)', () => {
    const tiles = pyramidFor({ longitudeDegrees: 138.73, latitudeDegrees: 35.25, distanceMeters: 12_000, headingDegrees: 0, pitchDegrees: -10 })
    expect(tiles.length).toBeLessThanOrEqual(128)
    expect(Math.max(...tiles.map(tile => tile.z))).toBeLessThanOrEqual(16)
    expect(overlapping(tiles)).toBe(false)
  })

  it('leaves out tiles behind the horizon', () => {
    // From 8000 km above Japan: Japan is in, the Atlantic (the far side of the globe) is not.
    const tiles = pyramidFor({ longitudeDegrees: 138, latitudeDegrees: 36, distanceMeters: 8_000_000, headingDegrees: 0, pitchDegrees: -90 })
    const covers = (longitude: number, latitude: number) =>
      tiles.some(({ x, y, z }) => {
        const count = 2 ** z
        const tileX = ((longitude + 180) / 360) * count
        const latitudeRadians = (latitude * Math.PI) / 180
        const tileY = ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * count
        return Math.floor(tileX) === x && Math.floor(tileY) === y
      })
    expect(covers(138, 36)).toBe(true)
    expect(covers(-30, 30)).toBe(false)
  })
})
