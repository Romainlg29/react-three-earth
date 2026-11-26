import { DataUtils, Matrix4, PerspectiveCamera, Group, type Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
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
import { inverseStandardNormal, WAVE_BREAKING_SHARE, WAVE_CHOPPINESS, WAVE_FOAM_LIFETIME_SECONDS } from '../src/waves/foam.js'
import { createButterflies, foamKept } from '../src/waves/WaveComputeField.js'
import { WAVE_CASCADE_LENGTHS_METERS, WAVE_REPEAT_PERIOD_SECONDS, WaveField } from '../src/waves/WaveField.js'
import { whitecapCoverage } from '../src/optics.js'
import { eastNorthAt, WAVE_COMPUTE_GRID_SIZE, WaveSurface } from '../src/waves/WaveSurface.js'

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
    // Averaged over seeds: each draw is random, the mean must be the spectrum's.
    const ratios = [1, 2, 3, 4, 5, 6, 7, 8].map(seed => {
      const field = new WaveField({ seed })
      field.setSeaState(openOcean)
      field.update(12.5)
      const cascade = field.cascades[1]!
      const halves = cascade.slopes
      let sum = 0
      for (let index = 0; index < halves.length; index++) sum += DataUtils.fromHalfFloat(halves[index]!) ** 2
      return sum / (halves.length / 2) / cascade.meanSquareSlope
    })
    const mean = ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length
    expect(mean).toBeGreaterThan(0.8)
    expect(mean).toBeLessThan(1.25)
  })

  it('moves each wave along its own direction, downwind', () => {
    const field = new WaveField()
    field.setSeaState(openOcean)
    const internals = field as unknown as { amplitudes: Float64Array[]; frequencies: Float64Array[]; activeCells: Uint32Array[] }
    // One wave in the second cascade, running east (+x): column 4, row 0.
    const size = field.gridSize
    const cascade = field.cascades[1]!
    const index = 4
    internals.amplitudes[1]!.fill(0)
    internals.amplitudes[1]![index * 2] = 1
    internals.activeCells[1] = Uint32Array.from([index, size - 4])
    ;(field as unknown as { nonzeroRows: Uint8Array[] }).nonzeroRows[1] = Uint8Array.from({ length: size }, (_, row) => (row === 0 ? 1 : 0))
    const wavenumber = (2 * Math.PI * 4) / cascade.lengthMeters
    const speed = internals.frequencies[1]![index]! / wavenumber
    const peakColumn = (time: number): number => {
      field.update(time)
      const halves = cascade.slopes
      let best = 0
      for (let column = 0; column < size; column++) {
        if (DataUtils.fromHalfFloat(halves[column * 2]!) > DataUtils.fromHalfFloat(halves[best * 2]!)) best = column
      }
      return best
    }
    const texelMeters = cascade.lengthMeters / size
    const start = peakColumn(0)
    // Two texels later: the crest has moved two columns east.
    expect((peakColumn((2 * texelMeters) / speed) - start + size) % size).toBe(2)
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
    expect(a.cascades[1]!.slopes).toEqual(b.cascades[1]!.slopes)
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
    // From orbit no wave shows: nothing is simulated.
    camera.position.set(6378137 + 400_000, 0, 0)
    camera.updateMatrixWorld()
    expect(surface.update(0.016, camera, earth)).toBe(false)
  })
})

/** The GPU pipeline (`WaveComputeField`) replayed on the CPU: advance, butterflies, both directions. */
function simulateGpu(field: WaveField, timeSeconds: number): { surface: Float64Array; fold: Float64Array } {
  const size = field.gridSize
  const cells = size * size
  const count = cells * field.cascades.length
  const spectrum = new Float32Array(count * 4)
  const waves = new Float32Array(count * 4)
  field.writeSpectrum(spectrum, waves)
  let surface = new Float64Array(count * 4)
  let fold = new Float64Array(count * 4)
  for (let index = 0; index < count; index++) {
    const [ar, ai, br, bi] = spectrum.subarray(index * 4, index * 4 + 4)
    const [kx, ky, omega, inverse] = waves.subarray(index * 4, index * 4 + 4)
    // As the GPU: whole cycles over the period times the share of it gone, in 32-bit, reduced to one cycle.
    const share = Math.fround((timeSeconds % WAVE_REPEAT_PERIOD_SECONDS) / WAVE_REPEAT_PERIOD_SECONDS)
    const cycles = Math.fround(omega! * share)
    const phase = (cycles - Math.floor(cycles)) * 2 * Math.PI
    const c = Math.cos(phase)
    const s = Math.sin(phase)
    const hr = ar! * c + ai! * s + br! * c - bi! * s
    const hi = ai! * c - ar! * s + br! * s + bi! * c
    const xx = kx! * kx! * inverse!
    const yy = ky! * ky! * inverse!
    const xy = kx! * ky! * inverse!
    surface.set([-ky! * hr - kx! * hi, kx! * hr - ky! * hi, xx * hr - yy * hi, xx * hi + yy * hr], index * 4)
    const dr = (kx! * hi + ky! * hr) * inverse!
    const di = (ky! * hi - kx! * hr) * inverse!
    fold.set([xy * hr - hi, xy * hi + hr, dr, di], index * 4)
  }
  const butterflies = createButterflies(size)
  const stages = Math.log2(size)
  for (const horizontal of [true, false]) {
    for (let stage = 0; stage < stages; stage++) {
      const nextSurface = new Float64Array(surface.length)
      const nextFold = new Float64Array(fold.length)
      for (let index = 0; index < count; index++) {
        const cascade = Math.floor(index / cells)
        const row = Math.floor((index % cells) / size)
        const column = index % size
        const offset = (stage * size + (horizontal ? column : row)) * 4
        const [wr, wi, first, second] = butterflies.subarray(offset, offset + 4)
        const at = (position: number): number => cascade * cells + (horizontal ? row * size + position : position * size + column)
        const a = at(first!)
        const b = at(second!)
        for (let lane = 0; lane < 4; lane++) {
          const [source, target, stride, laneOffset] = lane < 2 ? [surface, nextSurface, 4, lane * 2] : [fold, nextFold, 4, (lane - 2) * 2]
          const br = source[b * stride + laneOffset]!
          const bi = source[b * stride + laneOffset + 1]!
          target[index * stride + laneOffset] = source[a * stride + laneOffset]! + wr! * br - wi! * bi
          target[index * stride + laneOffset + 1] = source[a * stride + laneOffset + 1]! + wr! * bi + wi! * br
        }
      }
      surface = nextSurface
      fold = nextFold
    }
  }
  return { surface, fold }
}

describe('WaveComputeField', () => {
  it('butterflies that invert like the CPU transform', () => {
    const size = 16
    const input = Float64Array.from({ length: size * 2 }, (_, index) => Math.sin(index * 1.7) + index * 0.01)
    // The sum itself: x[n] = Σ X[k] e^(+2πi k n / N).
    const expected = new Float64Array(size * 2)
    for (let n = 0; n < size; n++) {
      let real = 0
      let imaginary = 0
      for (let k = 0; k < size; k++) {
        const angle = (2 * Math.PI * k * n) / size
        real += input[k * 2]! * Math.cos(angle) - input[k * 2 + 1]! * Math.sin(angle)
        imaginary += input[k * 2]! * Math.sin(angle) + input[k * 2 + 1]! * Math.cos(angle)
      }
      expected[n * 2] = real
      expected[n * 2 + 1] = imaginary
    }
    let data = input.slice()
    const butterflies = createButterflies(size)
    for (let stage = 0; stage < Math.log2(size); stage++) {
      const next = new Float64Array(data.length)
      for (let position = 0; position < size; position++) {
        const [wr, wi, first, second] = butterflies.subarray((stage * size + position) * 4, (stage * size + position) * 4 + 4)
        const br = data[second! * 2]!
        const bi = data[second! * 2 + 1]!
        next[position * 2] = data[first! * 2]! + wr! * br - wi! * bi
        next[position * 2 + 1] = data[first! * 2 + 1]! + wr! * bi + wi! * br
      }
      data = next
    }
    // The table holds 32-bit floats, as on the GPU.
    for (let index = 0; index < size * 2; index++) expect(data[index]).toBeCloseTo(expected[index]!, 5)
  })

  it('computes the same slopes as the CPU path', () => {
    const field = new WaveField({ seed: 3 })
    field.setSeaState(openOcean)
    field.update(7.25)
    const { surface } = simulateGpu(field, 7.25)
    const cells = field.gridSize ** 2
    field.cascades.forEach((cascade, cascadeIndex) => {
      let error = 0
      let scale = 0
      for (let cell = 0; cell < cells; cell++) {
        for (let axis = 0; axis < 2; axis++) {
          const gpu = surface[(cascadeIndex * cells + cell) * 4 + axis]!
          error = Math.max(error, Math.abs(gpu - DataUtils.fromHalfFloat(cascade.slopes[cell * 2 + axis]!)))
          scale = Math.max(scale, Math.abs(gpu))
        }
      }
      // Half floats on the CPU side: three significant digits.
      expect(error).toBeLessThan(scale * 2e-3 + 1e-6)
    })
  })

  it('folds the crests over the whitecap share of the sea', () => {
    const storm: SeaStateOptions = { ...openOcean, windSpeedMetersPerSecond: 15 }
    const coverage = whitecapCoverage(15)
    const shares = [1, 2, 3, 4].map(seed => {
      const field = new WaveField({ seed })
      field.setSeaState(storm)
      const { surface, fold } = simulateGpu(field, 4)
      const cells = field.gridSize ** 2
      const variance = field.cascades.reduce((sum, cascade) => sum + cascade.meanSquareSlope, 0)
      const threshold = 1 + WAVE_CHOPPINESS * inverseStandardNormal(coverage) * Math.sqrt(variance)
      // The sea at each cell of the shortest cascade, the others sampled at the same place (nearest texel).
      let folded = 0
      for (let cell = 0; cell < cells; cell++) {
        const x = (cell % field.gridSize) / field.gridSize
        const y = Math.floor(cell / field.gridSize) / field.gridSize
        let xx = 0
        let yy = 0
        let xy = 0
        field.cascades.forEach((cascade, cascadeIndex) => {
          const scale = field.cascades.at(-1)!.lengthMeters / cascade.lengthMeters
          const column = Math.floor((x * scale + 0.37 * cascadeIndex) * field.gridSize) % field.gridSize
          const row = Math.floor((y * scale + 0.61 * cascadeIndex) * field.gridSize) % field.gridSize
          const index = cascadeIndex * cells + row * field.gridSize + column
          xx += surface[index * 4 + 2]!
          yy += surface[index * 4 + 3]!
          xy += fold[index * 4]!
        })
        const jacobian = (1 - WAVE_CHOPPINESS * xx) * (1 - WAVE_CHOPPINESS * yy) - WAVE_CHOPPINESS ** 2 * xy * xy
        if (jacobian < threshold) folded++
      }
      return folded / cells
    })
    const share = shares.reduce((sum, value) => sum + value, 0) / shares.length
    expect(share).toBeGreaterThan(coverage * 0.6)
    expect(share).toBeLessThan(coverage * 1.6)
  })

  it('moves to the GPU under WebGPU and back to the CPU without it, with the same sampling', () => {
    const surface = new WaveSurface()
    surface.setSeaState(openOcean)
    const earth = new Group()
    earth.updateMatrixWorld()
    const camera = new PerspectiveCamera()
    camera.position.set(6378137 + 300, 0, 0)
    camera.updateMatrixWorld()
    const dispatched: unknown[] = []
    const webgpu = { backend: { isWebGPUBackend: true }, compute: (kernels: unknown) => void dispatched.push(kernels) } as unknown as WebGPURenderer
    const webgl = { backend: { isWebGLBackend: true } } as unknown as WebGPURenderer
    const samplers = surface as unknown as { surfaceSampler: { value: Texture }; foldSampler: { value: Texture } }
    const cpuFold = samplers.foldSampler.value
    surface.update(0.016, camera, earth, webgpu)
    const compute = surface.compute!
    expect(compute).not.toBeNull()
    // One submit a frame: all the dispatches at once.
    expect(dispatched).toHaveLength(1)
    expect(samplers.surfaceSampler.value).toBe(compute.surfaceTexture)
    // Shaders built before the swap keep the placeholder's sampling: it must match the GPU textures'.
    for (const [before, after] of [
      [surface.field.texture, compute.surfaceTexture],
      [cpuFold, compute.foldTexture],
    ] as const) {
      expect([before.wrapS, before.wrapT, before.minFilter, before.magFilter, before.type]).toEqual([after.wrapS, after.wrapT, after.minFilter, after.magFilter, after.type])
    }
    // The GPU simulates finer tiles: the fades follow its texels.
    const texelSizes = (surface as unknown as { texelSizes: { value: number }[] }).texelSizes
    expect(texelSizes[0]!.value).toBeCloseTo(WAVE_CASCADE_LENGTHS_METERS[0] / WAVE_COMPUTE_GRID_SIZE, 9)
    surface.update(0.016, camera, earth, webgl)
    expect(texelSizes[0]!.value).toBeCloseTo(WAVE_CASCADE_LENGTHS_METERS[0] / surface.field.gridSize, 9)
    expect(surface.compute).toBeNull()
    expect(samplers.surfaceSampler.value).toBe(surface.field.texture)
    expect(samplers.foldSampler.value).toBe(cpuFold)
    surface.dispose()
  })

  it('rounds each wave to whole cycles over the repeat period', () => {
    const field = new WaveField()
    field.setSeaState(openOcean)
    const before = field.cascades[1]!.slopes.slice()
    field.update(5)
    const first = field.cascades[1]!.slopes.slice()
    field.update(5 + WAVE_REPEAT_PERIOD_SECONDS)
    expect(field.cascades[1]!.slopes).toEqual(first)
    expect(first).not.toEqual(before)
  })

  it('transforms the height and the displacement, which carries its variance east and north', () => {
    const field = new WaveField({ seed: 5 })
    field.setSeaState(openOcean)
    const { fold } = simulateGpu(field, 2)
    const cells = field.gridSize ** 2
    const cascade = 0
    let height = 0
    let displacement = 0
    for (let cell = 0; cell < cells; cell++) {
      const index = (cascade * cells + cell) * 4
      height += fold[index + 1]! ** 2
      displacement += fold[index + 2]! ** 2 + fold[index + 3]! ** 2
    }
    // |kx/k|² + |ky/k|² = 1: D east and north hold the height's variance between them, wave by wave.
    expect(displacement / height).toBeCloseTo(1, 6)
    expect(height / cells).toBeGreaterThan(0)
  })

  it('lets the foam fade over its lifetime, and drops it when the clock jumps back', () => {
    expect(foamKept(0)).toBe(1)
    expect(foamKept(WAVE_FOAM_LIFETIME_SECONDS / 4)).toBeCloseTo(Math.exp(-0.25), 9)
    // A long pause (a hidden tab) fades it by a second's worth, not all at once.
    expect(foamKept(60)).toBeCloseTo(Math.exp(-1 / WAVE_FOAM_LIFETIME_SECONDS), 9)
    expect(foamKept(null)).toBe(0)
    expect(foamKept(-1)).toBe(0)
    expect(foamKept(Number.NaN)).toBe(0)
  })

  it('breaks only a share of the whitecap coverage at once: the rest is the foam left behind', () => {
    const surface = new WaveSurface()
    surface.setWhitecapCoverage(0.1)
    const score = (surface as unknown as { whitecapScore: { value: number } }).whitecapScore.value
    expect(score).toBeCloseTo(inverseStandardNormal(0.1 * WAVE_BREAKING_SHARE), 9)
    surface.dispose()
  })

  it('leaves the ripples finer than the cascades to the close-up detail, never a negative share', () => {
    const surface = new WaveSurface()
    surface.setSeaState({ windSpeedMetersPerSecond: 10, windDirectionDegrees: 270, fetchKilometers: 300, temperatureCelsius: 15, salinityPartsPerThousand: 35 })
    const unresolved = (surface as unknown as { unresolvedMeanSquareSlope: { value: number } }).unresolvedMeanSquareSlope
    const drawn = surface.field.cascades.reduce((sum, cascade) => sum + cascade.meanSquareSlope, 0)
    expect(unresolved.value).toBe(0)
    surface.setSurfaceMeanSquareSlope(drawn + 0.02)
    expect(unresolved.value).toBeCloseTo(0.02, 9)
    // A calmer sea state keeps the whole slope variance in step.
    surface.setSeaState({ windSpeedMetersPerSecond: 5, windDirectionDegrees: 270, fetchKilometers: 300, temperatureCelsius: 15, salinityPartsPerThousand: 35 })
    const calmer = surface.field.cascades.reduce((sum, cascade) => sum + cascade.meanSquareSlope, 0)
    expect(unresolved.value).toBeCloseTo(drawn + 0.02 - calmer, 9)
    surface.setSurfaceMeanSquareSlope(drawn / 10)
    expect(unresolved.value).toBe(0)
    surface.dispose()
  })

  it('scores the normal distribution', () => {
    expect(inverseStandardNormal(0.5)).toBeCloseTo(0, 9)
    expect(inverseStandardNormal(0.975)).toBeCloseTo(1.959964, 5)
    expect(inverseStandardNormal(0.01)).toBeCloseTo(-2.326348, 5)
    expect(inverseStandardNormal(0)).toBe(-8)
  })
})

describe('the foam texture', () => {
  it('tiles seamlessly, holds the cells over their full range and a streak noise centred on a half', async () => {
    const { createFoamTextureData } = await import('../src/waves/foamTexture.js')
    const size = 64
    const data = createFoamTextureData(size)
    expect(createFoamTextureData(size)).toBe(data)
    const at = (column: number, row: number, channel: number): number => data[(row * size + column) * 4 + channel]!
    let red = [255, 0]
    let green = 0
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        red = [Math.min(red[0]!, at(column, row, 0)), Math.max(red[1]!, at(column, row, 0))]
        green += at(column, row, 1) / 255 / (size * size)
      }
    }
    expect(red[0]).toBeLessThan(60)
    expect(red[1]).toBeGreaterThan(200)
    expect(green).toBeGreaterThan(0.4)
    expect(green).toBeLessThan(0.6)
    // Across the seam the texels change no more than between neighbours inside the tile.
    for (const channel of [0, 1]) {
      let inside = 0
      let seam = 0
      for (let row = 0; row < size; row++) {
        inside = Math.max(inside, Math.abs(at(1, row, channel) - at(0, row, channel)))
        seam = Math.max(seam, Math.abs(at(0, row, channel) - at(size - 1, row, channel)))
      }
      expect(seam).toBeLessThanOrEqual(inside * 1.5 + 8)
    }
  })
})
