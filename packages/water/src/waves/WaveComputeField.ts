import { HalfFloatType, LinearFilter, RepeatWrapping } from 'three'
import { cos, float, fract, Fn, instancedArray, instanceIndex, int, ivec2, max, sin, smoothstep, storageTexture, uniform, vec2, vec4, workgroupArray, workgroupBarrier } from 'three/tsl'
import { StorageArrayTexture, type ComputeNode, type Node, type StorageBufferNode, type WebGPURenderer } from 'three/webgpu'

import { createFourierPlan } from './fft.js'
import { WAVE_CHOPPINESS, WAVE_FOAM_LIFETIME_SECONDS } from './foam.js'
import { WAVE_REPEAT_PERIOD_SECONDS, type WaveField } from './WaveField.js'

/**
 * The wave field's per-frame work moved to the GPU (WebGPU compute): the spectrum advanced in time and four real fields
 * transformed by inverse FFTs, for every cascade at once, in 4 dispatches. Besides the slopes it transforms what the CPU
 * path cannot afford: the derivatives of the waves' horizontal displacement (Tessendorf's choppy waves), whose Jacobian
 * shows where the sea folds over and breaks, and the height. The spectrum itself still comes from `WaveField`.
 *
 * The transform is the CPU's (`fft.ts`): radix 2, bit reversal folded into the first stage. Each direction is one
 * dispatch whose workgroups transform a line each in workgroup memory, so the buffers are read and written once per
 * direction rather than once per stage.
 */
export class WaveComputeField {
  /** Per cascade (one layer each): slopes east and north, then ∂Dx/∂x and ∂Dy/∂y of the displacement per unit choppiness. */
  readonly surfaceTexture: StorageArrayTexture
  /**
   * Per cascade: ∂Dx/∂y (= ∂Dy/∂x) of the displacement per unit choppiness, the height in metres, then the displacement D
   * itself east and north, metres per unit choppiness (the surface moves by -λ D).
   */
  readonly foldTexture: StorageArrayTexture
  /**
   * Per cascade: the foam the cascade's breaking crests left, 0 to 1, in x. Crests add to it as they fold, and it fades
   * over `WAVE_FOAM_LIFETIME_SECONDS` where they have passed, so the foam trails behind the waves that broke.
   */
  readonly foamTexture: StorageArrayTexture
  /** Φ⁻¹ of the share of each cascade's surface breaking at any moment: how far below its mean the Jacobian falls there. */
  readonly breakingScore = uniform(-8)
  /** Choppiness λ: how far the surface moves towards the crests (`choppinessForWind`). */
  readonly choppiness = uniform(WAVE_CHOPPINESS)
  protected readonly field: WaveField
  /** What the foam keeps of itself this frame: exp(-Δt / lifetime). */
  protected readonly foamKept = uniform(0)
  /** Per cascade: the spread of its Jacobian per unit choppiness, the root of its slope variance. */
  protected readonly cascadeSpreads: StorageBufferNode<'float'>
  protected readonly foam: StorageBufferNode<'float'>
  protected lastTimeSeconds: number | null = null
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
    this.foamTexture = createStorageTexture(size, layers)
    this.cascadeSpreads = instancedArray(layers, 'float')
    this.foam = instancedArray(count, 'float')

    this.spectrum = instancedArray(count, 'vec4')
    this.waves = instancedArray(count, 'vec4')
    // Two lanes of complex values in each: [slopes, ∂Dx/∂x + i ∂Dy/∂y] and [∂Dx/∂y + i height, Dx + i Dy]; ping and pong.
    const surface = [instancedArray(count, 'vec4'), instancedArray(count, 'vec4')]
    const fold = [instancedArray(count, 'vec4'), instancedArray(count, 'vec4')]
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
      // D itself: -i kx/|k| h east plus i times -i ky/|k| h north, packed as one complex value.
      const displacementReal = kx.mul(heightImaginary).add(ky.mul(heightReal)).mul(wave.w)
      const displacementImaginary = ky.mul(heightImaginary).sub(kx.mul(heightReal)).mul(wave.w)
      fold[0]!.element(index).assign(
        vec4(xy.mul(heightReal).sub(heightImaginary), xy.mul(heightImaginary).add(heightReal), displacementReal, displacementImaginary),
      )
    })().compute(count)

    const multiply = (twiddle: Node<'vec4'>, value: Node<'vec2'>): Node<'vec2'> =>
      vec2(twiddle.x.mul(value.x).sub(twiddle.y.mul(value.y)), twiddle.x.mul(value.y).add(twiddle.y.mul(value.x))) as unknown as Node<'vec2'>

    // One dispatch per direction: each workgroup transforms one line (a row, then a column) of one cascade in its own
    // memory, all the stages with barriers between them, so a pass reads and writes the buffers once instead of once a
    // stage. Two lanes of `size` vec4 each: 8 KiB at 256, under WebGPU's 16 KiB floor.
    const transform = (horizontal: boolean, from: number, to: number): ComputeNode =>
      Fn(() => {
        const position = index.mod(size)
        const line = index.div(size)
        const base = line.div(size).mul(cells)
        const across = line.mod(size)
        const element = (along: Node<'int'>) => (horizontal ? base.add(across.mul(size)).add(along) : base.add(along.mul(size)).add(across))
        // The types leave out `element`, which the node has.
        const surfaceLane = workgroupArray('vec4', size) as unknown as WorkgroupLane
        const foldLane = workgroupArray('vec4', size) as unknown as WorkgroupLane
        surfaceLane.element(position).assign(surface[from]!.element(element(position as unknown as Node<'int'>)))
        foldLane.element(position).assign(fold[from]!.element(element(position as unknown as Node<'int'>)))
        workgroupBarrier()
        for (let stage = 0; stage < stages; stage++) {
          const butterfly = butterflies.element(int(stage * size).add(position))
          const first = butterfly.z.toInt()
          const second = butterfly.w.toInt()
          const twiddle = butterfly as unknown as Node<'vec4'>
          const a = surfaceLane.element(first)
          const b = surfaceLane.element(second)
          const foldA = foldLane.element(first)
          const foldB = foldLane.element(second)
          // Read both inputs before any invocation overwrites them.
          const nextSurface = vec4(a.xy.add(multiply(twiddle, b.xy as unknown as Node<'vec2'>)), a.zw.add(multiply(twiddle, b.zw as unknown as Node<'vec2'>))).toVar()
          const nextFold = vec4(foldA.xy.add(multiply(twiddle, foldB.xy as unknown as Node<'vec2'>)), foldA.zw.add(multiply(twiddle, foldB.zw as unknown as Node<'vec2'>))).toVar()
          workgroupBarrier()
          surfaceLane.element(position).assign(nextSurface)
          foldLane.element(position).assign(nextFold)
          workgroupBarrier()
        }
        surface[to]!.element(element(position as unknown as Node<'int'>)).assign(surfaceLane.element(position))
        fold[to]!.element(element(position as unknown as Node<'int'>)).assign(foldLane.element(position))
      })().compute(count, [size])
    const transforms = [transform(true, 0, 1), transform(false, 1, 0)]
    const source = 0

    const final = source
    const resolve = Fn(() => {
      const texel = ivec2(column, row)
      const value = surface[final]!.element(index)
      const folded = fold[final]!.element(index)
      storageTexture(this.surfaceTexture, texel, value).depth(cascade).toStack()
      storageTexture(this.foldTexture, texel, folded).depth(cascade).toStack()
      // This cascade's own Jacobian: its crests break where it folds, past its own spread (see foam.ts).
      const lambda = this.choppiness
      const jacobian = float(1)
        .sub(value.z.mul(lambda))
        .mul(float(1).sub(value.w.mul(lambda)))
        .sub(folded.x.mul(folded.x).mul(lambda.mul(lambda)))
      const spread = this.cascadeSpreads.element(cascade).mul(lambda)
      const threshold = float(1).add(spread.mul(this.breakingScore))
      const edge = spread.mul(0.25).add(1e-4)
      const breaking = float(1).sub(smoothstep(threshold.sub(edge), threshold.add(edge), jacobian))
      const foam = max(this.foam.element(index).mul(this.foamKept), breaking)
      this.foam.element(index).assign(foam)
      storageTexture(this.foamTexture, texel, vec4(foam, 0, 0, 1)).depth(cascade).toStack()
    })().compute(count)

    this.kernels = [advance, ...transforms, resolve]
    this.buffers = [this.spectrum, this.waves, ...surface, ...fold, butterflies, this.cascadeSpreads, this.foam]
  }

  /** Advances the waves to `timeSeconds` on the GPU, uploading the spectrum first if the sea state changed. */
  update(renderer: WebGPURenderer, timeSeconds: number): void {
    if (this.uploadedVersion !== this.field.seaStateVersion) {
      this.field.writeSpectrum(this.spectrum.value.array as Float32Array, this.waves.value.array as Float32Array)
      this.spectrum.value.needsUpdate = true
      this.waves.value.needsUpdate = true
      const spreads = this.cascadeSpreads.value.array as Float32Array
      this.field.cascades.forEach((cascade, index) => {
        spreads[index] = Math.sqrt(cascade.meanSquareSlope)
      })
      this.cascadeSpreads.value.needsUpdate = true
      this.uploadedVersion = this.field.seaStateVersion
    }
    this.periodShare.value = (timeSeconds % WAVE_REPEAT_PERIOD_SECONDS) / WAVE_REPEAT_PERIOD_SECONDS
    this.foamKept.value = foamKept(this.lastTimeSeconds === null ? null : timeSeconds - this.lastTimeSeconds)
    this.lastTimeSeconds = timeSeconds
    // One compute pass, one submit: each dispatch sees what the previous one wrote.
    void renderer.compute(this.kernels)
  }

  dispose(): void {
    for (const kernel of this.kernels) kernel.dispose()
    for (const buffer of this.buffers) buffer.value.dispose()
    this.surfaceTexture.dispose()
    this.foldTexture.dispose()
    this.foamTexture.dispose()
  }
}

/** A workgroup array of vec4, by element. */
interface WorkgroupLane {
  element(index: Node): Node<'vec4'>
}

/**
 * What the foam keeps of itself over `deltaSeconds` of the waves' clock: exp(-Δt / lifetime). None on the first frame or
 * when the clock jumps back (the foam then is not this sea's); a jump forward of more than a second counts as one.
 */
export function foamKept(deltaSeconds: number | null): number {
  if (deltaSeconds === null || !(deltaSeconds >= 0)) return 0
  return Math.exp(-Math.min(deltaSeconds, 1) / WAVE_FOAM_LIFETIME_SECONDS)
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
