import { DataUtils, Matrix4, PerspectiveCamera, Group } from 'three'
import { describe, expect, it } from 'vitest'

import { createFourierPlan, inverseTransform2D } from '../src/waves/fft.js'
import {
  angularFrequency,
  directionalSpreading,
  jonswapSpectrum,
  seawaterDensity,
  seawaterSurfaceTension,
  significantWaveHeight,
  wavenumberSpectrum,
  type SeaStateOptions,
} from '../src/waves/spectrum.js'
import { WaveField } from '../src/waves/WaveField.js'
import { eastNorthAt, WaveSurface } from '../src/waves/WaveSurface.js'

const openOcean: SeaStateOptions = { windSpeedMetersPerSecond: 10, windDirectionDegrees: 270, fetchKilometers: 300, temperatureCelsius: 15, salinityPartsPerThousand: 35 }

describe('inverse FFT', () => {
  it('turns one wavenumber into a plane wave', () => {
    const size = 8
    const plan = createFourierPlan(size)
    const data = new Float64Array(size * size * 2)
    // X[row 0, column 1] = 1: x[r, c] = e^(2πi c / N).
    data[1 * 2] = 1
    inverseTransform2D(data, plan)
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const index = (row * size + column) * 2
        expect(data[index]).toBeCloseTo(Math.cos((2 * Math.PI * column) / size), 10)
        expect(data[index + 1]).toBeCloseTo(Math.sin((2 * Math.PI * column) / size), 10)
      }
    }
  })

  it('refuses sizes that are not powers of two', () => {
    expect(() => createFourierPlan(48)).toThrow('must be a power of two')
  })
})

describe('wave spectrum', () => {
  it('gives seawater its density and surface tension', () => {
    expect(seawaterDensity(15, 35)).toBeCloseTo(1026, 0)
    expect(seawaterDensity(4, 0)).toBeCloseTo(1000, 0)
    expect(seawaterSurfaceTension(20, 0)).toBeCloseTo(0.0726, 3)
  })

  it('makes long waves gravity waves and the shortest capillary ripples', () => {
    const capillary = 0.074 / 1025
    // A 100 m wave: about 8 s.
    expect((2 * Math.PI) / angularFrequency((2 * Math.PI) / 100, capillary)).toBeCloseTo(8, 0)
    // At 1 cm, surface tension dominates: well faster than gravity alone.
    const wavenumber = (2 * Math.PI) / 0.01
    expect(angularFrequency(wavenumber, capillary)).toBeGreaterThan(1.5 * Math.sqrt(9.81 * wavenumber))
  })

  it('peaks where JONSWAP says and grows with the wind', () => {
    const peak = 22 * (9.81 ** 2 / (10 * 300_000)) ** (1 / 3)
    expect(jonswapSpectrum(peak, 10, 300_000)).toBeGreaterThan(jonswapSpectrum(peak * 1.5, 10, 300_000))
    expect(jonswapSpectrum(peak, 10, 300_000)).toBeGreaterThan(jonswapSpectrum(peak * 0.7, 10, 300_000))
    expect(jonswapSpectrum(1, 0, 300_000)).toBe(0)
  })

  it('reaches about the fetch-limited wave height (2.8 m at 10 m/s over 300 km)', () => {
    // The fetch law g Hs / U² = 0.0016 (g F / U²)^0.5 fits the measurements; the JONSWAP shape with its fitted α and ωp
    // integrates to some 40 % more. Either is a sea of 3 to 4 m.
    const expected = 0.0016 * 10 * Math.sqrt(300_000 / 9.81)
    expect(significantWaveHeight(openOcean)).toBeGreaterThan(expected * 0.8)
    expect(significantWaveHeight(openOcean)).toBeLessThan(expected * 1.5)
  })

  it('spreads the energy around the wind, integrating to one', () => {
    let sum = 0
    for (let step = 0; step < 1000; step++) sum += directionalSpreading(-Math.PI + ((step + 0.5) / 1000) * 2 * Math.PI) * ((2 * Math.PI) / 1000)
    expect(sum).toBeCloseTo(1, 3)
    // A westerly: waves run east (+x), not north.
    expect(wavenumberSpectrum(0.05, 0, openOcean)).toBeGreaterThan(wavenumberSpectrum(0, 0.05, openOcean) * 10)
  })
})

describe('WaveField', () => {
  it('draws slopes whose variance matches the spectrum', () => {
    const field = new WaveField()
    field.setSeaState(openOcean)
    field.update(12.5)
    const [first] = field.cascades
    const halves = first!.texture.image.data as Uint16Array
    let sum = 0
    for (let index = 0; index < halves.length; index++) sum += DataUtils.fromHalfFloat(halves[index]!) ** 2
    const variance = sum / (halves.length / 2)
    // One random draw: within a factor of two of the expected slope variance.
    expect(variance).toBeGreaterThan(first!.meanSquareSlope / 2)
    expect(variance).toBeLessThan(first!.meanSquareSlope * 2)
    expect(first!.texture.version).toBeGreaterThan(0)
  })

  it('splits the wavenumbers between cascades without overlap', () => {
    const field = new WaveField()
    for (let index = 1; index < field.cascades.length; index++) {
      expect(field.cascades[index]!.minimumWavenumber).toBe(field.cascades[index - 1]!.maximumWavenumber)
    }
  })

  it('draws the same sea for the same seed, and a calm one in still air', () => {
    const a = new WaveField({ seed: 7 })
    const b = new WaveField({ seed: 7 })
    a.setSeaState(openOcean)
    b.setSeaState(openOcean)
    a.update(3)
    b.update(3)
    expect(a.cascades[1]!.texture.image.data).toEqual(b.cascades[1]!.texture.image.data)
    const still = new WaveField()
    still.setSeaState({ ...openOcean, windSpeedMetersPerSecond: 0 })
    expect(still.cascades.every(cascade => cascade.meanSquareSlope === 0)).toBe(true)
  })
})

describe('WaveSurface', () => {
  it('lays the plane under the camera, with east and north along the ellipsoid', () => {
    const { east, north, up } = eastNorthAt({ x: 6378137, y: 0, z: 0 } as never)
    expect(east.distanceTo({ x: 0, y: 1, z: 0 } as never)).toBeCloseTo(0, 9)
    expect(north.distanceTo({ x: 0, y: 0, z: 1 } as never)).toBeCloseTo(0, 9)
    expect(up.distanceTo({ x: 1, y: 0, z: 0 } as never)).toBeCloseTo(0, 9)

    const surface = new WaveSurface()
    const earth = new Group()
    earth.updateMatrixWorld()
    const camera = new PerspectiveCamera()
    camera.position.set(6378137 + 500, 0, 0)
    camera.updateMatrixWorld()
    surface.update(0.016, camera, earth)
    const offset = (surface as unknown as { cameraFromAnchor: { value: { length(): number } } }).cameraFromAnchor.value
    expect(offset.length()).toBe(0)
    // Moving 5 km keeps the anchor; 30 km lays it again.
    camera.position.set(6378137 + 500, 5000, 0)
    camera.updateMatrixWorld()
    surface.update(0.016, camera, earth)
    expect(offset.length()).toBeCloseTo(5000, 3)
    camera.position.set(6378137 + 500, 35_000, 0)
    camera.updateMatrixWorld()
    surface.update(0.016, camera, earth)
    expect(offset.length()).toBe(0)
    expect(new Matrix4().identity().equals(earth.matrixWorld)).toBe(true)
  })
})
