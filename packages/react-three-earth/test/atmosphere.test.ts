import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { AtmosphereParameters } from '../src/atmosphere/AtmosphereParameters.js'
import { getSunDirectionECEF } from '../src/atmosphere/ephemeris.js'
import { setCameraView, toCartesian } from '../src/core/camera.js'
import { Atmosphere } from '../src/core/Atmosphere.js'

const FUJI = { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606 }

describe('AtmosphereParameters', () => {
  it('defaults to Earth', () => {
    const parameters = new AtmosphereParameters()
    expect(parameters.bottomRadiusMeters).toBe(6_360_000)
    expect(parameters.topRadiusMeters).toBe(6_420_000)
    expect(parameters.rayleighScaleHeightMeters).toBe(8000)
    expect(parameters.mieScaleHeightMeters).toBe(1200)
  })

  it('packs the 4D scattering lookup into a mobile-sized 3D texture', () => {
    const size = new AtmosphereParameters().getScatteringTextureSizeTexels()
    expect(size.toArray()).toEqual([256, 128, 32])
    const halfFloatBytes = size.x * size.y * size.z * 4 * 2
    expect(halfFloatBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('creates subclasses with overrides that win over the subclass defaults', () => {
    class Thin extends AtmosphereParameters {
      override topRadiusMeters = 6_400_000
    }
    const parameters = Thin.create({ topRadiusMeters: 6_410_000 })
    expect(parameters).toBeInstanceOf(Thin)
    expect(parameters.topRadiusMeters).toBe(6_410_000)
  })

  it('takes overrides', () => {
    expect(AtmosphereParameters.create({ scatteringOrders: 2 }).scatteringOrders).toBe(2)
  })

  it('scales luminance so that the sun colour has unit luminance per unit radiance', () => {
    const parameters = new AtmosphereParameters()
    const luminance = parameters.sunRadianceToLuminanceLumensPerWatt.dot(new Vector3(0.2126, 0.7152, 0.0722)) * parameters.getLuminanceScale()
    expect(luminance).toBeCloseTo(1, 12)
  })
})

describe('Atmosphere', () => {
  it('points the sun and its light for the date', () => {
    const atmosphere = new Atmosphere()
    const date = new Date('2026-11-22T07:00:00Z')
    const camera = new PerspectiveCamera()
    setCameraView(camera, { ...FUJI, distanceMeters: 60_000, pitchDegrees: -25 })
    atmosphere.update(camera, date)
    const expected = getSunDirectionECEF(date)
    expect(atmosphere.sunDirectionECEF.distanceTo(expected)).toBeLessThan(1e-12)
    expect(atmosphere.light.position.clone().normalize().distanceTo(expected)).toBeLessThan(1e-12)
  })

  // The model's planet is a sphere; positions are moved radially so their altitude is their ellipsoidal height.
  it.each([
    [35.36, 0],
    [35.36, 3776],
    [35.36, 10_000],
    [0, 400_000],
    [45, 400_000],
    [89.9, 2_000_000],
    [45, 20_000_000],
  ])('gives a point at %f° and %f m its ellipsoidal height as altitude', (latitudeDegrees, heightMeters) => {
    const atmosphere = new Atmosphere()
    const position = toCartesian({ longitudeDegrees: 138.7, latitudeDegrees, heightMeters })
    const altitudeMeters = atmosphere.context.toAtmosphereFrameKilometers(position).length() * 1000 - atmosphere.parameters.bottomRadiusMeters
    // Radial and normal heights differ by h(1 - cos δ), δ ≤ 0.19°: 6 µm per metre of height.
    expect(Math.abs(altitudeMeters - heightMeters)).toBeLessThanOrEqual(1e-3 + heightMeters * 6e-6)
  })

  it('keeps the ground at the bottom of the atmosphere everywhere, seen from any altitude', () => {
    const atmosphere = new Atmosphere()
    for (let latitudeDegrees = -90; latitudeDegrees <= 90; latitudeDegrees += 15) {
      const ground = toCartesian({ longitudeDegrees: 0, latitudeDegrees })
      const altitudeMeters = atmosphere.context.toAtmosphereFrameKilometers(ground).length() * 1000 - atmosphere.parameters.bottomRadiusMeters
      expect(Math.abs(altitudeMeters)).toBeLessThan(1e-3)
    }
  })

  it('creates an aerial perspective node bound to the scene camera', () => {
    const atmosphere = new Atmosphere()
    const camera = new PerspectiveCamera()
    const node = atmosphere.createAerialPerspective(atmosphere.context.sunDirection, atmosphere.context.sunDirection, camera) as unknown as {
      camera: unknown
    }
    expect(node.camera).toBe(camera)
  })
})
