// The heatmap kernel, as MapLibre draws it: each point adds a Gaussian of its weight times the layer's intensity,
// `heatmap-radius` pixels wide, to the density that `heatmap-color` turns into colour. Shared by the worker (quad
// sizes) and the tests; the shader in `HeatmapLayers.ts` evaluates the same formula.

/** 1 / √(2π): the Gaussian's normalisation, as MapLibre's `GAUSS_COEF`. */
export const HEATMAP_GAUSS_COEFFICIENT = 0.3989422804014327

/** A density below this is not drawn (MapLibre's `ZERO`): where a point's kernel ends. */
export const HEATMAP_ZERO_DENSITY = 1 / 255 / 16

/** The density a point adds at `distanceRadii` (the distance over `heatmap-radius`), for its weight times intensity. */
export function heatmapKernel(weightTimesIntensity: number, distanceRadii: number): number {
  return weightTimesIntensity * HEATMAP_GAUSS_COEFFICIENT * Math.exp(-0.5 * 9 * distanceRadii * distanceRadii)
}

/**
 * How far a point's kernel reaches, in radii: where it falls to `HEATMAP_ZERO_DENSITY`. 0 when even its centre
 * stays below that (the point adds nothing). About 1.28 for a weight and intensity of 1.
 */
export function heatmapExtentRadii(weightTimesIntensity: number): number {
  const peak = weightTimesIntensity * HEATMAP_GAUSS_COEFFICIENT
  if (!(peak > HEATMAP_ZERO_DENSITY)) return 0
  return Math.sqrt(-2 * Math.log(HEATMAP_ZERO_DENSITY / peak)) / 3
}

/** Densities sampled in a layer's colour ramp, from 0 to 1. */
export const HEATMAP_COLOR_RAMP_SIZE = 256

/** The furthest a heatmap reaches past its points, in pixels: one tile, the width of the region ring. */
export const HEATMAP_MAXIMUM_REACH_PIXELS = 512
