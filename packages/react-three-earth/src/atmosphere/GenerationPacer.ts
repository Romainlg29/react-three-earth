/**
 * Decides how much lookup-texture work to submit per animation frame so that the GPU time it takes stays
 * within a budget. Work comes in units (one full-screen pass, or one slice of a 3D pass), each with a
 * relative cost (its `weight`: roughly texture fetches per texel times texels). The pacer learns how many
 * milliseconds one weight unit takes from measured batches and plans the next batch to fit the budget.
 *
 * Pure bookkeeping, no GPU access: `AtmosphereTextures` measures the batches (see `GpuIdleWaiter`).
 */
export class GenerationPacer {
  /** GPU time to spend per frame, in milliseconds. */
  readonly budgetMilliseconds: number

  /** Measured cost of one weight unit, in milliseconds, or null before the first measurement. */
  millisecondsPerWeight: number | null = null

  /**
   * How much heavier than the last measured batch the next one may be. A measurement can come out too
   * low (a fence that signals early, a cheap batch followed by a costly pass), and this bounds the damage
   * to one frame twice as long as a good one.
   */
  maximumGrowth = 2

  /**
   * Heaviest batch ever planned, whatever the estimate says: a guard against an estimate that is far
   * too low. The default is about two slices of the scattering-density pass at the default sizes.
   */
  maximumWeight = 40_000_000

  protected lastWeight = 0

  constructor(budgetMilliseconds: number) {
    // Anything but a positive number (NaN from a bad query string) would disable the budget.
    this.budgetMilliseconds = budgetMilliseconds > 0 ? budgetMilliseconds : 4
  }

  /**
   * How many of the units, taken in order from `first`, to run this frame: as many as the estimate says
   * fit in the budget, within `maximumGrowth` of the last batch and under `maximumWeight`, and always at least one (a unit
   * cannot be split). One before any measurement.
   */
  plan(weights: readonly number[], first: number): number {
    const remaining = weights.length - first
    if (remaining <= 0) return 0
    const perWeight = this.millisecondsPerWeight
    if (perWeight === null) return 1
    const maximumWeight = Math.min(this.lastWeight * this.maximumGrowth, this.maximumWeight)
    let count = 0
    let weight = 0
    while (count < remaining) {
      weight += weights[first + count]!
      if (count > 0 && (weight * perWeight > this.budgetMilliseconds || weight > maximumWeight)) break
      count++
    }
    return count
  }

  /**
   * Records that a batch of the given total weight took `milliseconds` of GPU time. The estimate follows
   * a costlier measurement at once (a long frame is what the budget guards against) and a cheaper one
   * gradually, since passes differ in cost per weight and one cheap batch says little about the next.
   */
  observe(weight: number, milliseconds: number): void {
    // Nothing measurable (at or below the waiter's own latency) says nothing about the cost.
    if (!(weight > 0) || !(milliseconds > 0) || !Number.isFinite(milliseconds)) return
    this.lastWeight = weight
    const sample = milliseconds / weight
    const previous = this.millisecondsPerWeight
    this.millisecondsPerWeight = previous === null || sample > previous ? sample : previous * 0.7 + sample * 0.3
  }
}
