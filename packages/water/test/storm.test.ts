import { describe, expect, it } from 'vitest'

import { WATER_PRESETS } from '../src/presets.js'
import { resolveState } from '../src/Water.js'
import { choppinessForWind, WAVE_CHOPPINESS } from '../src/waves/foam.js'

describe('a storm', () => {
  it('steepens the waves with the wind, from linear theory in a breeze to 1.3 by a gale', () => {
    expect(choppinessForWind(5)).toBe(WAVE_CHOPPINESS)
    expect(choppinessForWind(8)).toBe(WAVE_CHOPPINESS)
    expect(choppinessForWind(14)).toBeCloseTo(1.15)
    expect(choppinessForWind(20)).toBeCloseTo(1.3)
    expect(choppinessForWind(40)).toBeCloseTo(1.3)
  })

  it('is overcast in the storm preset only, and the setting overrides it', () => {
    expect(resolveState({ preset: 'storm' }).cloudCover).toBe(WATER_PRESETS.storm.cloudCover)
    expect(WATER_PRESETS.storm.cloudCover).toBeGreaterThan(0.5)
    expect(resolveState({ preset: 'breeze' }).cloudCover).toBe(0)
    expect(resolveState({ preset: 'breeze', cloudCover: 0.6 }).cloudCover).toBe(0.6)
  })

  it('rejects a cloud cover out of 0 to 1, stating the range', () => {
    expect(() => resolveState({ cloudCover: 1.5 })).toThrow(/cloudCover must be between 0 \(clear\) and 1 \(overcast\)/)
    expect(() => resolveState({ cloudCover: Number.NaN })).toThrow(/cloudCover/)
  })
})
