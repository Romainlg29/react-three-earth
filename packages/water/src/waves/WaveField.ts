import { DataArrayTexture, DataUtils, HalfFloatType, LinearFilter, RepeatWrapping, RGFormat } from 'three'

import { createFourierPlan, inverseTransform2D, type FourierPlan } from './fft.js'
import { angularFrequency, seaStateConstants, wavenumberSpectrum, type SeaStateOptions } from './spectrum.js'

/**
 * Side of each cascade's tile, metres: ratios near 7 so their repeats do not line up. The longest holds a storm's
 * dominant waves (some 400 m), the shortest ripples of about 13 cm.
 */
export const WAVE_CASCADE_LENGTHS_METERS = [800, 110, 15, 2.1] as const
/** Texels per side of each cascade. */
export const WAVE_GRID_SIZE = 64
/**
 * The sea repeats after this long, seconds: each wave's angular frequency is rounded to a whole number of cycles over
 * it (Tessendorf's dispersion quantisation, shifting none by more than 0.3 %). The GPU then reduces each phase exactly,
 * so the waves stay sharp however long the page runs.
 */
export const WAVE_REPEAT_PERIOD_SECONDS = 3600

/** One cascade: a periodic tile of the sea's slopes, holding the wavelengths between its two wavenumbers. */
export interface WaveCascade {
  readonly lengthMeters: number
  /** rad/m, inclusive. */
  readonly minimumWavenumber: number
  /** rad/m, exclusive: the next cascade takes over. A quarter of the grid's Nyquist, so its waves stay well sampled. */
  readonly maximumWavenumber: number
  /**
   * Its layer of `WaveField.texture`: the slopes east and north, interleaved, dimensionless, rows from the south, texel
   * (0, 0) at the tile's corner, as half floats.
   */
  readonly slopes: Uint16Array
  /** The variance of the slope its waves add (east plus north), from the spectrum: the gloss it takes over from roughness. */
  meanSquareSlope: number
}

export interface WaveFieldOptions {
  /** Default: `WAVE_CASCADE_LENGTHS_METERS`. */
  lengthsMeters?: readonly number[]
  /** Default: `WAVE_GRID_SIZE`. */
  gridSize?: number
  /** Seeds the random phases: the same seed draws the same sea, its long waves alike on grids of any size. Default: 1. */
  seed?: number
}

/** Mixes a 32-bit integer (lowbias32): neighbouring inputs give unrelated outputs. */
function mix32(value: number): number {
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

/**
 * The hash of one wave's draw, from the seed, the cascade and the wave's signed wavenumber indices, chained so each part
 * can be hashed once for many waves. Hashed rather than drawn in turn, so a wave keeps its phase whatever the grid's
 * size: the GPU's 256² and 128² simulations and the CPU's share their long waves, on every device.
 */
function hashStep(hash: number, value: number): number {
  return mix32((hash ^ value) >>> 0)
}

/** A 32-bit hash as a uniform number strictly inside (0, 1). */
function unitInterval(hash: number): number {
  return (hash + 0.5) / 4294967296
}

/**
 * The sea's surface simulated on the CPU (Tessendorf 2001): per cascade, a random field shaped by the wave spectrum,
 * advanced in time by each wave's own frequency and transformed to slopes by an inverse FFT every `update`. About
 * 1.5 ms a frame for four 64² cascades on a desktop CPU (only the cells and rows in each band are computed).
 */
export class WaveField {
  readonly cascades: WaveCascade[]
  readonly gridSize: number
  /**
   * The slopes east (red) and north (green) of every cascade, one layer each, repeating. Written by `update` (the
   * CPU path); `WaveComputeField` writes its own on the GPU.
   */
  readonly texture: DataArrayTexture
  /** Counts `setSeaState` calls, so a GPU copy of the spectrum knows when to upload it again. */
  seaStateVersion = 0
  protected readonly plan: FourierPlan
  /** Per cascade: two unit Gaussian numbers per wavenumber, drawn once so a new sea state keeps the same waves. */
  protected gaussians: Float64Array[]
  protected seedValue: number
  protected lastSeaState: SeaStateOptions | null = null
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

  constructor({ lengthsMeters = WAVE_CASCADE_LENGTHS_METERS, gridSize = WAVE_GRID_SIZE, seed = 1 }: WaveFieldOptions = {}) {
    this.gridSize = gridSize
    this.plan = createFourierPlan(gridSize)
    const cells = gridSize * gridSize
    this.seedValue = seed
    const halves = new Uint16Array(cells * 2 * lengthsMeters.length)
    const texture = new DataArrayTexture(halves, gridSize, gridSize, lengthsMeters.length)
    texture.format = RGFormat
    texture.type = HalfFloatType
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = false
    texture.flipY = false
    texture.needsUpdate = true
    this.texture = texture
    let minimumWavenumber = 0
    this.cascades = lengthsMeters.map((lengthMeters, index) => {
      const maximumWavenumber = (gridSize / 4) * ((2 * Math.PI) / lengthMeters)
      const slopes = halves.subarray(index * cells * 2, (index + 1) * cells * 2)
      const cascade: WaveCascade = { lengthMeters, minimumWavenumber, maximumWavenumber, slopes, meanSquareSlope: 0 }
      minimumWavenumber = maximumWavenumber
      return cascade
    })
    this.gaussians = this.drawGaussians(seed)
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

  /** The seed of the random phases. */
  get seed(): number {
    return this.seedValue
  }

  /** Draws another sea: new random phases from `seed`, shaped by the same sea state. The same seed draws the same sea. */
  setSeed(seed: number): void {
    if (seed === this.seedValue) return
    this.seedValue = seed
    this.gaussians = this.drawGaussians(seed)
    if (this.lastSeaState !== null) this.setSeaState(this.lastSeaState)
  }

  /**
   * Two unit Gaussian numbers per wavenumber and cascade (Box–Muller), hashed from the seed and the wave's signed
   * wavenumber indices: the same wave gets the same numbers on a grid of any size.
   */
  protected drawGaussians(seed: number): Float64Array[] {
    const size = this.gridSize
    const cells = size * size
    const seedHash = mix32(seed >>> 0)
    return this.cascades.map((_, cascadeIndex) => {
      const values = new Float64Array(cells * 2)
      const cascadeHash = hashStep(seedHash, cascadeIndex)
      for (let column = 0; column < size; column++) {
        const waveX = column < size / 2 ? column : column - size
        const columnHash = hashStep(cascadeHash, waveX & 0xffff)
        for (let row = 0; row < size; row++) {
          const waveY = row < size / 2 ? row : row - size
          const waveHash = hashStep(columnHash, waveY & 0xffff)
          const index = row * size + column
          const radius = Math.sqrt(-2 * Math.log(unitInterval(hashStep(waveHash, 0))))
          const angle = 2 * Math.PI * unitInterval(hashStep(waveHash, 1))
          values[index * 2] = radius * Math.cos(angle)
          values[index * 2 + 1] = radius * Math.sin(angle)
        }
      }
      return values
    })
  }

  /** Shapes the waves for a sea state. The random phases stay, so the sea changes in place. */
  setSeaState(options: SeaStateOptions): void {
    this.lastSeaState = { ...options }
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
          const cycles = Math.max(1, Math.round((angularFrequency(wavenumber, constants.surfaceTensionOverDensity) * WAVE_REPEAT_PERIOD_SECONDS) / (2 * Math.PI)))
          frequencies[index] = (2 * Math.PI * cycles) / WAVE_REPEAT_PERIOD_SECONDS
          meanSquareSlope += wavenumber * wavenumber * variance
        }
      }
      this.activeCells[cascadeIndex] = Uint32Array.from(active)
      const rows = new Uint8Array(size)
      for (const index of active) rows[(index / size) | 0] = 1
      this.nonzeroRows[cascadeIndex] = rows
      cascade.meanSquareSlope = meanSquareSlope
    })
    this.seaStateVersion++
  }

  /**
   * Writes the spectrum in the GPU's layout, cascade after cascade, rows of `gridSize` cells: per cell, `spectrum` gets
   * h0(k) and conj(h0(-k)) (four floats) and `waves` kx, ky, ω(k) as whole cycles per `WAVE_REPEAT_PERIOD_SECONDS`, and
   * 1/|k| (0 at k = 0).
   */
  writeSpectrum(spectrum: Float32Array, waves: Float32Array): void {
    const size = this.gridSize
    const cells = size * size
    this.cascades.forEach((_, cascadeIndex) => {
      const amplitudes = this.amplitudes[cascadeIndex]!
      const frequencies = this.frequencies[cascadeIndex]!
      const wavenumbersX = this.wavenumbersX[cascadeIndex]!
      const wavenumbersY = this.wavenumbersY[cascadeIndex]!
      for (let index = 0; index < cells; index++) {
        const row = (index / size) | 0
        const column = index - row * size
        const mirror = ((size - row) % size) * size + ((size - column) % size)
        const offset = (cascadeIndex * cells + index) * 4
        spectrum[offset] = amplitudes[index * 2]!
        spectrum[offset + 1] = amplitudes[index * 2 + 1]!
        spectrum[offset + 2] = amplitudes[mirror * 2]!
        spectrum[offset + 3] = -amplitudes[mirror * 2 + 1]!
        const kx = wavenumbersX[column]!
        const ky = wavenumbersY[row]!
        const wavenumber = Math.hypot(kx, ky)
        waves[offset] = kx
        waves[offset + 1] = ky
        waves[offset + 2] = Math.round((frequencies[index]! * WAVE_REPEAT_PERIOD_SECONDS) / (2 * Math.PI))
        waves[offset + 3] = wavenumber > 0 ? 1 / wavenumber : 0
      }
    })
  }

  /** Advances the sea to `timeSeconds` and writes each cascade's slopes into its texture. */
  update(timeSeconds: number): void {
    const size = this.gridSize
    const work = this.work
    // Every wave repeats over the period: reducing the time keeps the phases exact.
    const time = timeSeconds % WAVE_REPEAT_PERIOD_SECONDS
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
        const phase = frequencies[index]! * time
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
      const slopes = cascade.slopes
      for (let index = 0; index < size * size * 2; index++) slopes[index] = DataUtils.toHalfFloat(work[index]!)
    })
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
