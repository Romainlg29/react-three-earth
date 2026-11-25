import { HalfFloatType, LinearFilter, RepeatWrapping } from 'three'
import { cos, float, fract, Fn, instancedArray, instanceIndex, int, ivec2, sin, storageTexture, uniform, vec2, vec4 } from 'three/tsl'
import { StorageArrayTexture, type ComputeNode, type Node, type StorageBufferNode, type WebGPURenderer } from 'three/webgpu'

import { createFourierPlan } from './fft.js'
import { WAVE_REPEAT_PERIOD_SECONDS, type WaveField } from './WaveField.js'

/**
 * The wave field's per-frame work moved to the GPU (WebGPU compute): the spectrum advanced in time and four real fields
 * transformed by inverse FFTs, for every cascade at once, in 14 dispatches. Besides the slopes it transforms what the CPU
 * path cannot afford: the derivatives of the waves' horizontal displacement (Tessendorf's choppy waves), whose Jacobian
 * shows where the sea folds over and breaks, and the height. The spectrum itself still comes from `WaveField`.
 *
 * The transform is the CPU's (`fft.ts`): radix 2, bit reversal folded into the first stage, one dispatch per stage and
 * direction, ping-ponging between two pairs of buffers.
 */
export class WaveComputeField {
  /** Per cascade (one layer each): slopes east and north, then ∂Dx/∂x and ∂Dy/∂y of the displacement per unit choppiness. */
  readonly surfaceTexture: StorageArrayTexture
  /** Per cascade: ∂Dx/∂y (= ∂Dy/∂x) of the displacement per unit choppiness, then the height in metres. */
  readonly foldTexture: StorageArrayTexture
  protected readonly field: WaveField
  /** The time as a share of `WAVE_REPEAT_PERIOD_SECONDS`, reduced in 64-bit on the CPU. */
  protected readonly periodShare = uniform(0)
  protected readonly spectrum: StorageBufferNode<'vec4'>
  protected readonly waves: StorageBufferNode<'vec4'>
  protected readonly kernels: ComputeNode[]
  /** Every storage buffer, freed with the field. */
  protected readonly buffers: ReadonlyArray<{ readonly value: { dispose(): void } }>
  protected uploadedVersion = -1

  constructor(field: WaveField) {
    this.field = field
    const size = field.gridSize
    const layers = field.cascades.length
    const cells = size * size
    const count = cells * layers
    this.surfaceTexture = createStorageTexture(size, layers)
    this.foldTexture = createStorageTexture(size, layers)

    this.spectrum = instancedArray(count, 'vec4')
    this.waves = instancedArray(count, 'vec4')
    // Two lanes of complex values in each: [slopes, ∂Dx/∂x + i ∂Dy/∂y] and [∂Dx/∂y + i height]; ping and pong.
    const surface = [instancedArray(count, 'vec4'), instancedArray(count, 'vec4')]
    const fold = [instancedArray(count, 'vec2'), instancedArray(count, 'vec2')]
    const stages = Math.log2(size)
    const butterflies = instancedArray(createButterflies(size), 'vec4')

    const index = instanceIndex.toInt()
    const cascade = index.div(cells)
    const cell = index.mod(cells)
    const row = cell.div(size)
    const column = cell.mod(size)

    const advance = Fn(() => {
      const amplitude = this.spectrum.element(index)
      const wave = this.waves.element(index)
      // Whole cycles over the period times the share of it gone: reduced to one cycle before the sine, exact for days.
      const phase = fract(wave.z.mul(this.periodShare)).mul(2 * Math.PI)
      const cosine = cos(phase)
      const sine = sin(phase)
      // h(k, t) = h0(k) e^(-iωt) + conj(h0(-k)) e^(iωt), as on the CPU.
      const heightReal = amplitude.x.mul(cosine).add(amplitude.y.mul(sine)).add(amplitude.z.mul(cosine)).sub(amplitude.w.mul(sine))
      const heightImaginary = amplitude.y.mul(cosine).sub(amplitude.x.mul(sine)).add(amplitude.z.mul(sine)).add(amplitude.w.mul(cosine))
      const kx = wave.x
      const ky = wave.y
      // The choppy displacement moves the surface by -λ D towards the crests, D = -i k/|k| h (Tessendorf): the
      // derivatives of D are real multiples of h, (kx², ky², kx ky) / |k|.
      const xx = kx.mul(kx).mul(wave.w)
      const yy = ky.mul(ky).mul(wave.w)
      const xy = kx.mul(ky).mul(wave.w)
      surface[0]!.element(index).assign(
        vec4(
          ky.negate().mul(heightReal).sub(kx.mul(heightImaginary)),
          kx.mul(heightReal).sub(ky.mul(heightImaginary)),
          xx.mul(heightReal).sub(yy.mul(heightImaginary)),
          xx.mul(heightImaginary).add(yy.mul(heightReal)),
        ),
      )
      fold[0]!.element(index).assign(vec2(xy.mul(heightReal).sub(heightImaginary), xy.mul(heightImaginary).add(heightReal)))
    })().compute(count)

    const multiply = (twiddle: Node<'vec4'>, value: Node<'vec2'>): Node<'vec2'> =>
      vec2(twiddle.x.mul(value.x).sub(twiddle.y.mul(value.y)), twiddle.x.mul(value.y).add(twiddle.y.mul(value.x))) as unknown as Node<'vec2'>

    const transforms: ComputeNode[] = []
    let source = 0
    for (const horizontal of [true, false]) {
      for (let stage = 0; stage < stages; stage++) {
        const from = source
        const to = 1 - source
        transforms.push(
          Fn(() => {
            const butterfly = butterflies.element(int(stage * size).add(horizontal ? column : row))
            const first = butterfly.z.toInt()
            const second = butterfly.w.toInt()
            const base = cascade.mul(cells)
            const firstIndex = horizontal ? base.add(row.mul(size)).add(first) : base.add(first.mul(size)).add(column)
            const secondIndex = horizontal ? base.add(row.mul(size)).add(second) : base.add(second.mul(size)).add(column)
            const a = surface[from]!.element(firstIndex)
            const b = surface[from]!.element(secondIndex)
            const twiddle = butterfly as unknown as Node<'vec4'>
            const low = multiply(twiddle, b.xy as unknown as Node<'vec2'>)
            const high = multiply(twiddle, b.zw as unknown as Node<'vec2'>)
            surface[to]!.element(index).assign(vec4(a.xy.add(low), a.zw.add(high)))
            const foldB = multiply(twiddle, fold[from]!.element(secondIndex) as unknown as Node<'vec2'>)
            fold[to]!.element(index).assign(fold[from]!.element(firstIndex).add(foldB))
          })().compute(count),
        )
        source = to
      }
    }

    const final = source
    const resolve = Fn(() => {
      const texel = ivec2(column, row)
      const value = surface[final]!.element(index)
      const folded = fold[final]!.element(index)
      storageTexture(this.surfaceTexture, texel, value).depth(cascade).toStack()
      storageTexture(this.foldTexture, texel, vec4(folded, float(0), float(1))).depth(cascade).toStack()
    })().compute(count)

    this.kernels = [advance, ...transforms, resolve]
    this.buffers = [this.spectrum, this.waves, ...surface, ...fold, butterflies]
  }

  /** Advances the waves to `timeSeconds` on the GPU, uploading the spectrum first if the sea state changed. */
  update(renderer: WebGPURenderer, timeSeconds: number): void {
    if (this.uploadedVersion !== this.field.seaStateVersion) {
      this.field.writeSpectrum(this.spectrum.value.array as Float32Array, this.waves.value.array as Float32Array)
      this.spectrum.value.needsUpdate = true
      this.waves.value.needsUpdate = true
      this.uploadedVersion = this.field.seaStateVersion
    }
    this.periodShare.value = (timeSeconds % WAVE_REPEAT_PERIOD_SECONDS) / WAVE_REPEAT_PERIOD_SECONDS
    // One compute pass, one submit: each dispatch sees what the previous one wrote.
    void renderer.compute(this.kernels)
  }

  dispose(): void {
    for (const kernel of this.kernels) kernel.dispose()
    for (const buffer of this.buffers) buffer.value.dispose()
    this.surfaceTexture.dispose()
    this.foldTexture.dispose()
  }
}

function createStorageTexture(size: number, layers: number): StorageArrayTexture {
  const texture = new StorageArrayTexture(size, size, layers)
  texture.type = HalfFloatType
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  return texture
}

/**
 * The radix-2 butterflies of an inverse FFT of `size`, per stage and output position: output = input[z] + (x + iy) ·
 * input[w]. The first stage reads its inputs in bit-reversed order, so no separate reordering pass is needed.
 */
export function createButterflies(size: number): Float32Array {
  const { reversed, twiddles } = createFourierPlan(size)
  const stages = Math.log2(size)
  const table = new Float32Array(stages * size * 4)
  for (let stage = 0; stage < stages; stage++) {
    const span = 2 ** (stage + 1)
    const half = span / 2
    for (let position = 0; position < size; position++) {
      const inBlock = position % span
      const top = inBlock < half
      const pair = top ? inBlock : inBlock - half
      let first = position - inBlock + pair
      let second = first + half
      if (stage === 0) {
        first = reversed[first]!
        second = reversed[second]!
      }
      const twiddle = pair * (size / span) * 2
      const sign = top ? 1 : -1
      const offset = (stage * size + position) * 4
      table[offset] = sign * twiddles[twiddle]!
      table[offset + 1] = sign * twiddles[twiddle + 1]!
      table[offset + 2] = first
      table[offset + 3] = second
    }
  }
  return table
}
