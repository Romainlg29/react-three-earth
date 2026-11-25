/**
 * In-place inverse discrete Fourier transforms on interleaved complex arrays (`[re0, im0, re1, im1, …]`), radix 2, without
 * normalisation: `x[n] = Σ_k X[k] e^(+2πi k n / N)`. For the CPU wave field; sizes must be powers of two.
 */

/** Precomputed bit reversal and twiddle factors for one size. */
export interface FourierPlan {
  readonly size: number
  readonly reversed: Uint32Array
  /** `e^(+2πi j / N)` for j below N / 2, interleaved. */
  readonly twiddles: Float64Array
}

export function createFourierPlan(size: number): FourierPlan {
  if (!Number.isInteger(Math.log2(size)) || size < 2) throw new Error(`createFourierPlan: the size must be a power of two of at least 2, got ${size}.`)
  const bits = Math.log2(size)
  const reversed = new Uint32Array(size)
  for (let index = 0; index < size; index++) {
    let value = 0
    for (let bit = 0; bit < bits; bit++) value |= ((index >> bit) & 1) << (bits - 1 - bit)
    reversed[index] = value
  }
  const twiddles = new Float64Array(size)
  for (let index = 0; index < size / 2; index++) {
    const angle = (2 * Math.PI * index) / size
    twiddles[index * 2] = Math.cos(angle)
    twiddles[index * 2 + 1] = Math.sin(angle)
  }
  return { size, reversed, twiddles }
}

/** One inverse transform of `size` complex values starting at `offset`, `stride` complex values apart. */
function inverseTransform(data: Float32Array | Float64Array, offset: number, stride: number, plan: FourierPlan): void {
  const { size, reversed, twiddles } = plan
  for (let index = 0; index < size; index++) {
    const swap = reversed[index]!
    if (swap <= index) continue
    const a = (offset + index * stride) * 2
    const b = (offset + swap * stride) * 2
    const real = data[a]!
    const imaginary = data[a + 1]!
    data[a] = data[b]!
    data[a + 1] = data[b + 1]!
    data[b] = real
    data[b + 1] = imaginary
  }
  for (let span = 2; span <= size; span *= 2) {
    const half = span / 2
    const twiddleStep = size / span
    for (let start = 0; start < size; start += span) {
      for (let pair = 0; pair < half; pair++) {
        const twiddleReal = twiddles[pair * twiddleStep * 2]!
        const twiddleImaginary = twiddles[pair * twiddleStep * 2 + 1]!
        const even = (offset + (start + pair) * stride) * 2
        const odd = (offset + (start + pair + half) * stride) * 2
        const oddReal = data[odd]! * twiddleReal - data[odd + 1]! * twiddleImaginary
        const oddImaginary = data[odd]! * twiddleImaginary + data[odd + 1]! * twiddleReal
        const evenReal = data[even]!
        const evenImaginary = data[even + 1]!
        data[even] = evenReal + oddReal
        data[even + 1] = evenImaginary + oddImaginary
        data[odd] = evenReal - oddReal
        data[odd + 1] = evenImaginary - oddImaginary
      }
    }
  }
}

/** The inverse transform of a `size × size` grid, rows of `size` complex values, in place. */
export function inverseTransform2D(data: Float32Array | Float64Array, plan: FourierPlan): void {
  const { size } = plan
  for (let row = 0; row < size; row++) inverseTransform(data, row * size, 1, plan)
  for (let column = 0; column < size; column++) inverseTransform(data, column, size, plan)
}
