import { describe, expect, it } from 'vitest'

import { toCartesian } from '../src/core/camera.js'

// WGS84 semi-axes in meters
const EQUATORIAL_RADIUS_METERS = 6_378_137
const POLAR_RADIUS_METERS = 6_356_752.314245

describe('toCartesian', () => {
  it('puts (0°, 0°) on the equator at the equatorial radius, along +X', () => {
    const p = toCartesian({ longitudeDegrees: 0, latitudeDegrees: 0 })
    expect(p.x).toBeCloseTo(EQUATORIAL_RADIUS_METERS, 3)
    expect(p.y).toBeCloseTo(0, 3)
    expect(p.z).toBeCloseTo(0, 3)
  })

  it('puts the north pole at the polar radius, along +Z', () => {
    expect(toCartesian({ longitudeDegrees: 0, latitudeDegrees: 90 }).z).toBeCloseTo(POLAR_RADIUS_METERS, 3)
  })

  it('adds height along the ellipsoid normal', () => {
    const ground = toCartesian({ longitudeDegrees: 138.7274, latitudeDegrees: 35.3606 })
    const summit = toCartesian({ longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 3776 })
    expect(summit.distanceTo(ground)).toBeCloseTo(3776, 6)
  })
})

describe('setCameraView', () => {
  it('places the camera at the requested distance, looking at the target from the requested heading and pitch', async () => {
    const { PerspectiveCamera, Vector3 } = await import('three')
    const { setCameraView } = await import('../src/core/camera.js')
    const camera = new PerspectiveCamera()
    const view = { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 1000, headingDegrees: 0, pitchDegrees: -30 }
    setCameraView(camera, view)
    const target = toCartesian(view)
    expect(camera.position.distanceTo(target)).toBeCloseTo(1000, 6)
    // At (0°, 0°) north is +Z and up is +X: heading north, pitched down 30°, the camera sits south and above
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    expect(forward.z).toBeCloseTo(Math.cos(Math.PI / 6), 6)
    expect(forward.x).toBeCloseTo(-0.5, 6)
  })
})
