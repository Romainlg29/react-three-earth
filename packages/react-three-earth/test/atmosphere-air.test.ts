import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { AEROSOL_SINGLE_SCATTERING_ALBEDO, ANGSTROM_EXPONENT, getRayleighDensity, KOSCHMIEDER_CONSTANT } from '../src/atmosphere/air.js'
import { AtmosphereIlluminance } from '../src/atmosphere/AtmosphereIlluminance.js'
import { AtmosphereParameters } from '../src/atmosphere/AtmosphereParameters.js'
import { getStandardAir, SEA_LEVEL_PRESSURE_PASCALS } from '../src/atmosphere/standardAtmosphere.js'
import { toCartesian } from '../src/core/camera.js'

describe('getStandardAir', () => {
  // ISO 2533 / U.S. Standard Atmosphere 1976 tables, at each layer's base.
  it.each([
    [0, 288.15, 101_325],
    [11_000, 216.65, 22_632.1],
    [20_000, 216.65, 5_474.89],
    [32_000, 228.65, 868.019],
    [47_000, 270.65, 110.906],
    [51_000, 270.65, 66.9389],
    [71_000, 214.65, 3.95642],
  ])('matches the standard tables at %d m', (altitude, temperature, pressure) => {
    const air = getStandardAir(altitude)
    expect(air.temperatureKelvin).toBeCloseTo(temperature, 2)
    expect(air.pressurePascals / pressure).toBeCloseTo(1, 3)
  })

  it('gives the standard sea-level density, and thinner air on a warmer day at the same pressure', () => {
    expect(getStandardAir(0).densityKilogramsPerCubicMeter).toBeCloseTo(1.225, 3)
    expect(getStandardAir(5000).densityRatio).toBeCloseTo(0.6012, 3)
    const warm = getStandardAir(5000, 15)
    expect(warm.pressurePascals).toBeCloseTo(getStandardAir(5000).pressurePascals, 6)
    expect(warm.densityRatio).toBeCloseTo((0.6012 * 255.65) / 270.65, 3)
  })

  it('holds sea level below it', () => {
    expect(getStandardAir(-200).pressurePascals).toBe(SEA_LEVEL_PRESSURE_PASCALS)
  })
})

describe('the shared air', () => {
  it('follows the standard atmosphere for air molecules by default, or Bruneton’s exponential', () => {
    const standard = new AtmosphereParameters()
    expect(getRayleighDensity(standard, 11_000)).toBeCloseTo(getStandardAir(11_000).densityRatio, 12)
    const exponential = AtmosphereParameters.create({ rayleighDensityProfile: 'exponential' })
    expect(getRayleighDensity(exponential, 8000)).toBeCloseTo(Math.exp(-1), 12)
  })

  it('reports the extinction in @aeronautic/core’s shape', () => {
    const parameters = new AtmosphereParameters()
    const air = parameters.getAirExtinction(0)
    expect(air.rayleigh).toEqual([5.802e-6, 13.558e-6, 33.1e-6])
    expect(air.aerosol).toEqual([4.44e-6, 4.44e-6, 4.44e-6])
    expect(air.ozone).toEqual([0, 0, 0])
  })

  it('has a visibility of about 217 km with the default (clean) haze', () => {
    expect(new AtmosphereParameters().getVisibilityMeters() / 1000).toBeCloseTo(KOSCHMIEDER_CONSTANT / (13.558e-6 + 4.44e-6) / 1000, 6)
  })

  it('sets the haze from a visibility as @aeronautic/core’s extinction() does', () => {
    const parameters = AtmosphereParameters.fromVisibility(20_000)
    // @aeronautic/core 0.1.3: haze = 3.912 / V - rayleigh(550 nm), times (λ / 550)^-1.3
    const haze = 3.912 / 20_000 - 13.558e-6
    const expected = [680, 550, 440].map(wavelength => haze * (wavelength / 550) ** -1.3)
    expect(parameters.mieExtinctionPerMeter.x / expected[0]!).toBeCloseTo(1, 10)
    expect(parameters.mieExtinctionPerMeter.y / expected[1]!).toBeCloseTo(1, 10)
    expect(parameters.mieExtinctionPerMeter.z / expected[2]!).toBeCloseTo(1, 10)
    expect(parameters.mieScatteringPerMeter.y / parameters.mieExtinctionPerMeter.y).toBeCloseTo(AEROSOL_SINGLE_SCATTERING_ALBEDO, 12)
    expect(parameters.miePhaseAsymmetry).toBe(0.7)
    expect(parameters.getVisibilityMeters()).toBeCloseTo(20_000, 6)
    expect(ANGSTROM_EXPONENT).toBe(1.3)
  })

  it('lets overrides through, and keeps the subclass', () => {
    class Mars extends AtmosphereParameters {}
    const parameters = Mars.fromVisibility(50_000, { scatteringOrders: 2, miePhaseAsymmetry: 0.6 })
    expect(parameters).toBeInstanceOf(Mars)
    expect(parameters.scatteringOrders).toBe(2)
    expect(parameters.miePhaseAsymmetry).toBe(0.6)
  })

  it('leaves no haze for a visibility beyond clean air', () => {
    expect(AtmosphereParameters.fromVisibility(1e9).mieExtinctionPerMeter.toArray()).toEqual([0, 0, 0])
  })
})

describe('AtmosphereIlluminance', () => {
  const zenithDepth = (parameters: AtmosphereParameters): Vector3 => {
    const illuminance = new AtmosphereIlluminance(parameters)
    const transmittance = illuminance.getTransmittanceToTopAtmosphereBoundary(parameters.bottomRadiusMeters, 1)
    return new Vector3(-Math.log(transmittance.x), -Math.log(transmittance.y), -Math.log(transmittance.z))
  }

  it('integrates the exponential profiles to their analytic optical depths', () => {
    const parameters = AtmosphereParameters.create({ rayleighDensityProfile: 'exponential' })
    const depth = zenithDepth(parameters)
    // β H for the exponentials (cut at 60 km, a 6e-4 share), β × half width for the ozone tent
    const expected = parameters.rayleighScatteringPerMeter
      .clone()
      .multiplyScalar(8000 * (1 - Math.exp(-60 / 8)))
      .addScaledVector(parameters.mieExtinctionPerMeter, 1200)
      .addScaledVector(parameters.ozoneAbsorptionPerMeter, 15_000)
    // The trapezoidal rule's 120 m steps against the aerosols' 1.2 km scale height: within 1e-4
    expect(depth.x / expected.x).toBeCloseTo(1, 3)
    expect(depth.z / expected.z).toBeCloseTo(1, 3)
  })

  it('integrates the standard atmosphere to its column: p₀ / (ρ₀ g), about 8.43 km of sea-level air', () => {
    const parameters = AtmosphereParameters.create({ mieExtinctionPerMeter: new Vector3(), ozoneAbsorptionPerMeter: new Vector3() })
    const column = zenithDepth(parameters).y / parameters.rayleighScatteringPerMeter.y
    expect(column).toBeGreaterThan(8400)
    expect(column).toBeLessThan(8440)
  })

  it('lights a point with the sun overhead, not one at night, and has no skylight before the read-back', () => {
    const parameters = new AtmosphereParameters()
    const illuminance = new AtmosphereIlluminance(parameters)
    const position = toCartesian({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 3000 })
    const up = position.clone().normalize()
    const day = illuminance.getSunAndSkyIlluminance(position, up)
    expect(day.skyAvailable).toBe(false)
    expect(day.sky.toArray()).toEqual([0, 0, 0])
    // Sunlight at the top of the atmosphere is about 1.75 scaled units (≈ 133 klx); some is lost on the way.
    const top = parameters.solarIrradianceWattsPerSquareMeterNanometer.clone().multiply(parameters.sunRadianceToLuminanceLumensPerWatt)
    const luminance = (v: Vector3): number => v.dot(new Vector3(0.2126, 0.7152, 0.0722))
    const topLuminance = luminance(top) * parameters.getLuminanceScale()
    expect(luminance(day.sun) / topLuminance).toBeGreaterThan(0.85)
    expect(luminance(day.sun) / topLuminance).toBeLessThan(0.98)
    // Reddened: blue loses more than red.
    expect(day.sun.z / top.z).toBeLessThan(day.sun.x / top.x)
    const night = illuminance.getSunAndSkyIlluminance(position, up.clone().negate())
    expect(night.sun.toArray()).toEqual([0, 0, 0])
  })

  it('orders read-back rows by their tags and looks up skylight between texel centres', () => {
    const parameters = new AtmosphereParameters()
    const { x: width, y: height } = parameters.textureSizesTexels.irradiance
    // Rows read back in reverse order (as one backend might); each texel's value is its row index.
    const pixels = new Float32Array(width * height * 4)
    for (let readRow = 0; readRow < height; readRow++) {
      const textureRow = height - 1 - readRow
      for (let x = 0; x < width; x++) pixels.set([textureRow, textureRow, textureRow, textureRow], (readRow * width + x) * 4)
    }
    const illuminance = new AtmosphereIlluminance(parameters)
    illuminance.setIrradianceTexels(pixels)
    expect(illuminance.skyAvailable).toBe(true)
    // Half way up the atmosphere is half way between the first and last row centres.
    const radius = (parameters.bottomRadiusMeters + parameters.topRadiusMeters) / 2
    const sample = (illuminance as unknown as { sampleIrradiance(r: number, mu: number, t: Vector3): Vector3 }).sampleIrradiance(radius, 0.3, new Vector3())
    expect(sample.x).toBeCloseTo((height - 1) / 2, 5)
  })
})
