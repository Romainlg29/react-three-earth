/**
 * Where the drawn waves break. The Jacobian of the choppy displacement, J = (1 - λ Dxx)(1 - λ Dyy) - λ² Dxy², falls
 * below 1 where the surface bunches up and towards 0 where it would fold over: the crests that break into whitecaps. To
 * first order it is 1 - λ (Dxx + Dyy), and Dxx + Dyy sums |k| h over the waves: a Gaussian field whose variance is the
 * slope variance the waves carry. So the share of the sea where J falls below 1 + λ z σ is Φ(z): choosing z so that
 * Φ(z) is the whitecap coverage (Monahan) makes the drawn foam cover the measured share, wherever it is.
 */

/**
 * How long foam lasts once its crest has passed, seconds: the e-folding time of the residual foam patches a breaking
 * crest leaves (Monahan & Woolf's stage B whitecaps, about 3 to 4 s).
 */
export const WAVE_FOAM_LIFETIME_SECONDS = 4

/**
 * The share of the whitecap coverage that is crests breaking now (Monahan's stage A); the rest is the foam they left,
 * fading over `WAVE_FOAM_LIFETIME_SECONDS`. Monahan's coverage counts both.
 */
export const WAVE_BREAKING_SHARE = 0.3

/** Choppiness λ: how far the displacement moves the surface towards the crests. 1 is the sea's own (linear theory). */
export const WAVE_CHOPPINESS = 1

/**
 * Choppiness from the wind: linear theory's 1 in a breeze, rising to 1.3 by a gale (20 m/s), as a steep, young wind sea's
 * crests sharpen and its troughs flatten beyond what a sum of sines draws (the second-order, Stokes-like part).
 * Bounded below where the surface would fold over itself.
 */
export function choppinessForWind(windSpeedMetersPerSecond: number): number {
  return WAVE_CHOPPINESS + 0.3 * Math.min(Math.max((windSpeedMetersPerSecond - 8) / 12, 0), 1)
}

/**
 * The standard score whose lower tail holds `coverage` of a normal distribution (Φ⁻¹), to about 1e-9 (Acklam's rational
 * approximation). -8 for no coverage at all, so nothing passes it.
 */
export function inverseStandardNormal(coverage: number): number {
  if (!(coverage > 0)) return -8
  if (coverage >= 1) return 8
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (coverage < low) {
    const q = Math.sqrt(-2 * Math.log(coverage))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (coverage > 1 - low) return -inverseStandardNormal(1 - coverage)
  const q = coverage - 0.5
  const r = q * q
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}
