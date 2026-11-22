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
