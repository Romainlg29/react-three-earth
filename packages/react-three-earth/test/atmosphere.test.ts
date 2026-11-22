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
    const size = new AtmosphereParameters().scatteringTextureSize
    expect(size.toArray()).toEqual([256, 128, 32])
    const halfFloatBytes = size.x * size.y * size.z * 4 * 2
    expect(halfFloatBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('takes overrides', () => {
    expect(new AtmosphereParameters({ scatteringOrders: 2 }).scatteringOrders).toBe(2)
  })

  it('scales luminance so that the sun colour has unit luminance per unit radiance', () => {
    const parameters = new AtmosphereParameters()
    const luminance = parameters.sunRadianceToLuminance.dot(new Vector3(0.2126, 0.7152, 0.0722)) * parameters.luminanceScale
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

  it('places the model sphere tangent to the ellipsoid below the camera', () => {
    const atmosphere = new Atmosphere()
    const camera = new PerspectiveCamera()
    const heightMeters = 2500
    camera.position.copy(toCartesian({ ...FUJI, heightMeters }))
    camera.updateMatrixWorld()
    atmosphere.update(camera, new Date('2026-11-22T07:00:00Z'))

    const { bottomRadiusMeters } = atmosphere.parameters
    // The camera's altitude in the model equals its ellipsoidal height, though Earth is not a sphere.
    const cameraRadius = atmosphere.context.toSphereUnits(camera.position).length() * 1000
    expect(cameraRadius - bottomRadiusMeters).toBeCloseTo(heightMeters, 3)
    // So does the ground's, 50 km away (within metres: the ellipsoid curves differently from the sphere).
    const nearby = toCartesian({ longitudeDegrees: FUJI.longitudeDegrees + 0.55, latitudeDegrees: FUJI.latitudeDegrees })
    const nearbyRadius = atmosphere.context.toSphereUnits(nearby).length() * 1000
    expect(Math.abs(nearbyRadius - bottomRadiusMeters)).toBeLessThan(5)
  })

  it('keeps shader positions small: the camera is kilometres from the sphere centre, not metres', () => {
    const atmosphere = new Atmosphere()
    const camera = new PerspectiveCamera()
    setCameraView(camera, { ...FUJI, distanceMeters: 60_000, pitchDegrees: -25 })
    atmosphere.update(camera, new Date())
    const radius = atmosphere.context.toSphereUnits(camera.position).length()
    expect(radius).toBeGreaterThan(6360)
    expect(radius).toBeLessThan(6420)
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
