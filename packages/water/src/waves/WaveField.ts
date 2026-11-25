import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RepeatWrapping, RGFormat } from 'three'

import { createFourierPlan, inverseTransform2D, type FourierPlan } from './fft.js'
import { angularFrequency, seaStateConstants, wavenumberSpectrum, type SeaStateOptions } from './spectrum.js'

/**
 * Side of each cascade's tile, metres: ratios near 7 so their repeats do not line up. The longest holds a storm's
 * dominant waves (some 400 m), the shortest ripples of about 13 cm.
 */
export const WAVE_CASCADE_LENGTHS_METERS = [800, 110, 15, 2.1] as const
/** Texels per side of each cascade. */
export const WAVE_GRID_SIZE = 64

/** One cascade: a periodic tile of the sea's slopes, holding the wavelengths between its two wavenumbers. */
export interface WaveCascade {
  readonly lengthMeters: number
  /** rad/m, inclusive. */
  readonly minimumWavenumber: number
  /** rad/m, exclusive: the next cascade takes over. A quarter of the grid's Nyquist, so its waves stay well sampled. */
  readonly maximumWavenumber: number
  /** The slopes east (red) and north (green), dimensionless, rows from the south, texel (0, 0) at the tile's corner. */
  readonly texture: DataTexture
  /** The variance of the slope its waves add (east plus north), from the spectrum: the gloss it takes over from roughness. */
  meanSquareSlope: number
}

export interface WaveFieldOptions {
  /** Default: `WAVE_CASCADE_LENGTHS_METERS`. */
  lengthsMeters?: readonly number[]
  /** Default: `WAVE_GRID_SIZE`. */
  gridSize?: number
  /** Seeds the random phases: the same seed draws the same sea. Default: 1. */
  seed?: number
}

/** A small seeded generator (mulberry32): the same sea on every load and every device. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The sea's surface simulated on the CPU (Tessendorf 2001): per cascade, a random field shaped by the wave spectrum,
 * advanced in time by each wave's own frequency and transformed to slopes by an inverse FFT every `update`. About
 * 1.5 ms a frame for four 64² cascades on a desktop CPU (only the cells and rows in each band are computed).
 */
export class WaveField {
  readonly cascades: WaveCascade[]
  readonly gridSize: number
  protected readonly plan: FourierPlan
  /** Per cascade: two unit Gaussian numbers per wavenumber, drawn once so a new sea state keeps the same waves. */
  protected readonly gaussians: Float64Array[]
  /** Per cascade: the starting amplitudes h0(k), interleaved complex. */
  protected readonly amplitudes: Float64Array[]
  /** Per cascade: ω(k). */
  protected readonly frequencies: Float64Array[]
  protected readonly work: Float64Array
  /** Per cascade: the grid cells inside its band, the only ones `update` computes. */
  protected readonly activeCells: Uint32Array[]
  /** Per cascade: 1 for each grid row holding an active cell. */
  protected readonly nonzeroRows: Uint8Array[]
  /** Per cascade: the wavenumber of each column (east) and row (north), rad/m. */
  protected readonly wavenumbersX: Float64Array[]
  protected readonly wavenumbersY: Float64Array[]
  protected readonly halves: Uint16Array[]

  constructor({ lengthsMeters = WAVE_CASCADE_LENGTHS_METERS, gridSize = WAVE_GRID_SIZE, seed = 1 }: WaveFieldOptions = {}) {
    this.gridSize = gridSize
    this.plan = createFourierPlan(gridSize)
    const cells = gridSize * gridSize
    const random = createRandom(seed)
    let minimumWavenumber = 0
    this.cascades = lengthsMeters.map(lengthMeters => {
      const maximumWavenumber = (gridSize / 4) * ((2 * Math.PI) / lengthMeters)
      const halves = new Uint16Array(cells * 2)
      const texture = new DataTexture(halves, gridSize, gridSize, RGFormat, HalfFloatType)
      texture.wrapS = RepeatWrapping
      texture.wrapT = RepeatWrapping
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
      texture.generateMipmaps = false
      texture.flipY = false
      texture.needsUpdate = true
      const cascade: WaveCascade = { lengthMeters, minimumWavenumber, maximumWavenumber, texture, meanSquareSlope: 0 }
      minimumWavenumber = maximumWavenumber
      return cascade
    })
    this.halves = this.cascades.map(cascade => cascade.texture.image.data as Uint16Array)
    this.gaussians = this.cascades.map(() => {
      const values = new Float64Array(cells * 2)
      for (let index = 0; index < cells; index++) {
        // Box–Muller.
        const radius = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12)))
        const angle = 2 * Math.PI * random()
        values[index * 2] = radius * Math.cos(angle)
        values[index * 2 + 1] = radius * Math.sin(angle)
      }
      return values
    })
    this.amplitudes = this.cascades.map(() => new Float64Array(cells * 2))
    this.frequencies = this.cascades.map(() => new Float64Array(cells))
    this.work = new Float64Array(cells * 2)
    this.activeCells = this.cascades.map(() => new Uint32Array(0))
    this.nonzeroRows = this.cascades.map(() => new Uint8Array(gridSize))
    this.wavenumbersX = this.cascades.map(cascade => Float64Array.from({ length: gridSize }, (_, index) => this.wavenumber(index, cascade.lengthMeters)))
    this.wavenumbersY = this.wavenumbersX
  }

  /** Wavenumber of grid index `index` along one axis of a cascade, rad/m (FFT order: negative ones in the upper half). */
  protected wavenumber(index: number, lengthMeters: number): number {
    const signed = index < this.gridSize / 2 ? index : index - this.gridSize
    return (2 * Math.PI * signed) / lengthMeters
  }

  /** Shapes the waves for a sea state. The random phases stay, so the sea changes in place. */
  setSeaState(options: SeaStateOptions): void {
    const constants = seaStateConstants(options)
    const size = this.gridSize
    this.cascades.forEach((cascade, cascadeIndex) => {
      const step = (2 * Math.PI) / cascade.lengthMeters
      const cellArea = step * step
      const amplitudes = this.amplitudes[cascadeIndex]!
      const frequencies = this.frequencies[cascadeIndex]!
      const gaussians = this.gaussians[cascadeIndex]!
      const active: number[] = []
      let meanSquareSlope = 0
      amplitudes.fill(0)
      for (let row = 0; row < size; row++) {
        const ky = this.wavenumber(row, cascade.lengthMeters)
        for (let column = 0; column < size; column++) {
          const kx = this.wavenumber(column, cascade.lengthMeters)
          const index = row * size + column
          const wavenumber = Math.hypot(kx, ky)
          // The band is symmetric in |k|: a cell and its mirror are in or out together.
          if (!(wavenumber >= cascade.minimumWavenumber && wavenumber < cascade.maximumWavenumber && wavenumber > 0)) continue
          active.push(index)
          const variance = wavenumberSpectrum(kx, ky, options, constants) * cellArea
          // h0 = (ξ1 + iξ2) √(S Δk² / 4), so E|h0|² = S Δk² / 2: h(k) and h(-k) then hold S(k) Δk² between them, once.
          const scale = Math.sqrt(variance / 4)
          amplitudes[index * 2] = gaussians[index * 2]! * scale
          amplitudes[index * 2 + 1] = gaussians[index * 2 + 1]! * scale
          frequencies[index] = angularFrequency(wavenumber, constants.surfaceTensionOverDensity)
          meanSquareSlope += wavenumber * wavenumber * variance
        }
      }
      this.activeCells[cascadeIndex] = Uint32Array.from(active)
      const rows = new Uint8Array(size)
      for (const index of active) rows[(index / size) | 0] = 1
      this.nonzeroRows[cascadeIndex] = rows
      cascade.meanSquareSlope = meanSquareSlope
    })
  }

  /** Advances the sea to `timeSeconds` and writes each cascade's slopes into its texture. */
  update(timeSeconds: number): void {
    const size = this.gridSize
    const work = this.work
    this.cascades.forEach((cascade, cascadeIndex) => {
      const amplitudes = this.amplitudes[cascadeIndex]!
      const frequencies = this.frequencies[cascadeIndex]!
      const wavenumbersX = this.wavenumbersX[cascadeIndex]!
      const wavenumbersY = this.wavenumbersY[cascadeIndex]!
      work.fill(0)
      // Only the cells in the cascade's band: about a fifth of the grid.
      for (const index of this.activeCells[cascadeIndex]!) {
        const row = (index / size) | 0
        const column = index - row * size
        const mirror = ((size - row) % size) * size + ((size - column) % size)
        const kx = wavenumbersX[column]!
        const ky = wavenumbersY[row]!
        const phase = frequencies[index]! * timeSeconds
        const cos = Math.cos(phase)
        const sin = Math.sin(phase)
        // h(k, t) = h0(k) e^(-iωt) + conj(h0(-k)) e^(iωt): real heights, each wave running along its own k (the
        // transform is e^(+ik·x), so the phase k·x - ωt moves along k).
        const forwardReal = amplitudes[index * 2]!
        const forwardImaginary = amplitudes[index * 2 + 1]!
        const backwardReal = amplitudes[mirror * 2]!
        const backwardImaginary = -amplitudes[mirror * 2 + 1]!
        const heightReal = forwardReal * cos + forwardImaginary * sin + backwardReal * cos - backwardImaginary * sin
        const heightImaginary = forwardImaginary * cos - forwardReal * sin + backwardReal * sin + backwardImaginary * cos
        // Both slopes in one transform: i kx h + i (i ky h) = h (-ky + i kx); real part east, imaginary part north.
        work[index * 2] = -ky * heightReal - kx * heightImaginary
        work[index * 2 + 1] = kx * heightReal - ky * heightImaginary
      }
      // The band leaves about half the rows empty: their transforms are skipped.
      inverseTransform2D(work, this.plan, this.nonzeroRows[cascadeIndex])
      const halves = this.halves[cascadeIndex]!
      for (let index = 0; index < size * size * 2; index++) halves[index] = DataUtils.toHalfFloat(work[index]!)
      cascade.texture.needsUpdate = true
    })
  }

  dispose(): void {
    for (const cascade of this.cascades) cascade.texture.dispose()
  }
}
