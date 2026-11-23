import type { ControlsLocale } from './locale.js'

export type ScaleUnit = 'metric' | 'imperial' | 'nautical'

const METERS_PER_FOOT = 0.3048
const FEET_PER_MILE = 5280
const METERS_PER_NAUTICAL_MILE = 1852

/**
 * The largest "nice" number not above `value`: 1, 2, 3 or 5 times a power of ten (MapLibre's steps), so a
 * scale bar reads 1 km, 2 km, 3 km, 5 km, 10 km… Zero for a value that is not positive and finite.
 */
export function roundScaleLength(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0
  const power = 10 ** Math.floor(Math.log10(value))
  // Guards against log10 landing just below an exact power of ten (log10(1000) can be 2.9999999999999996)
  const corrected = value / power >= 10 ? power * 10 : power
  const fraction = value / corrected
  const step = fraction >= 5 ? 5 : fraction >= 3 ? 3 : fraction >= 2 ? 2 : 1
  return Number((corrected * step).toPrecision(12))
}

export interface ScaleBar {
  /** Width of the bar in CSS pixels, at most the maximum width. 0 when no scale can be drawn. */
  widthPixels: number
  /** The length the bar stands for, in `unitKey`'s unit. */
  length: number
  unitKey: 'unitMeters' | 'unitKilometers' | 'unitFeet' | 'unitMiles' | 'unitNauticalMiles'
}

/**
 * The scale bar for a map scale: the longest rounded length that fits in `maximumWidthPixels`. Kilometres
 * and miles take over from metres and feet at one unit.
 */
export function computeScaleBar(groundMetersPerPixel: number, maximumWidthPixels: number, unit: ScaleUnit): ScaleBar {
  const maximumMeters = groundMetersPerPixel * maximumWidthPixels
  if (!(maximumMeters > 0) || !Number.isFinite(maximumMeters)) return { widthPixels: 0, length: 0, unitKey: 'unitMeters' }

  let unitKey: ScaleBar['unitKey']
  let metersPerUnit: number
  if (unit === 'imperial') {
    const maximumFeet = maximumMeters / METERS_PER_FOOT
    if (maximumFeet >= FEET_PER_MILE) [unitKey, metersPerUnit] = ['unitMiles', FEET_PER_MILE * METERS_PER_FOOT]
    else [unitKey, metersPerUnit] = ['unitFeet', METERS_PER_FOOT]
  } else if (unit === 'nautical') {
    ;[unitKey, metersPerUnit] = ['unitNauticalMiles', METERS_PER_NAUTICAL_MILE]
  } else if (maximumMeters >= 1000) {
    ;[unitKey, metersPerUnit] = ['unitKilometers', 1000]
  } else {
    ;[unitKey, metersPerUnit] = ['unitMeters', 1]
  }
  const length = roundScaleLength(maximumMeters / metersPerUnit)
  return { widthPixels: (length * metersPerUnit) / groundMetersPerPixel, length, unitKey }
}

/** "5 km", "200 m", "0.5 m": the bar's label. */
export function formatScaleBar(bar: ScaleBar, locale: Pick<ControlsLocale, ScaleBar['unitKey']>): string {
  return `${bar.length} ${locale[bar.unitKey]}`
}
