import { describe, expect, it } from 'vitest'

import { resolveState } from '../src/Water.js'
import { peakPeriodSeconds } from '../src/waves/spectrum.js'
import { deepWavenumber, shallowWavenumber, shoalingCoefficient, SURF_HEIGHT_SHARE, SURF_MAXIMUM_PERIOD_SECONDS, SURF_MINIMUM_PERIOD_SECONDS, surfPhase } from '../src/waves/surf.js'

const GRAVITY = 9.81

/** The dispersion relation solved exactly (Newton's method): ω² = g k tanh(k h). */
function exactWavenumber(periodSeconds: number, depthMeters: number): number {
  const frequency = (2 * Math.PI) / periodSeconds
  let k = frequency / Math.sqrt(GRAVITY * depthMeters)
  for (let step = 0; step < 50; step++) {
    const t = Math.tanh(k * depthMeters)
    const f = GRAVITY * k * t - frequency ** 2
    const df = GRAVITY * t + GRAVITY * k * depthMeters * (1 - t * t)
    k -= f / df
  }
  return k
}

describe('surf', () => {
  it('gives the JONSWAP peak period from the wind and fetch', () => {
    // ωp = 22 (g²/(U F))^(1/3): 10 m/s over 200 km peaks near 7.9 s.
    expect(peakPeriodSeconds(10, 200_000)).toBeCloseTo(7.85, 1)
    expect(peakPeriodSeconds(20, 200_000)).toBeGreaterThan(peakPeriodSeconds(10, 200_000))
    expect(peakPeriodSeconds(0, 200_000)).toBe(0)
  })

  it('shortens the waves over the shallows within 5 % of the dispersion relation', () => {
    const deep = deepWavenumber(8)
    expect(deep).toBeCloseTo((2 * Math.PI / 8) ** 2 / GRAVITY, 10)
    for (const depth of [0.5, 2, 5, 10, 30, 100]) {
      const approximate = shallowWavenumber(deep, depth)
      expect(Math.abs(approximate / exactWavenumber(8, depth) - 1)).toBeLessThan(0.05)
    }
    expect(shallowWavenumber(deep, 1000)).toBeCloseTo(deep, 6)
    expect(shallowWavenumber(deep, 2)).toBeGreaterThan(shallowWavenumber(deep, 10))
  })

  it('shoals: about 1 in deep water, least near kh 1.3, taller towards the shore', () => {
    expect(shoalingCoefficient(10)).toBeCloseTo(1, 3)
    expect(shoalingCoefficient(1.3)).toBeCloseTo(0.913, 2)
    expect(shoalingCoefficient(0.2)).toBeGreaterThan(shoalingCoefficient(0.5))
    expect(shoalingCoefficient(0.5)).toBeGreaterThan(1)
  })

  it('has a phase whose rate is the local wavenumber over a sloping beach', () => {
    const deep = deepWavenumber(10)
    const slope = 0.03
    for (const distance of [10, 30, 100, 400, 2000]) {
      const step = 0.01
      const rate = (surfPhase(deep, distance + step, slope) - surfPhase(deep, distance - step, slope)) / (2 * step)
      expect(Math.abs(rate / shallowWavenumber(deep, distance * slope) - 1)).toBeLessThan(0.06)
    }
    expect(surfPhase(deep, 0, slope)).toBe(0)
  })

  it('takes the surf from the sea state, and from the settings', () => {
    const breeze = resolveState({ preset: 'breeze' })
    expect(breeze.surfHeightMeters).toBeCloseTo(breeze.significantWaveHeightMeters * SURF_HEIGHT_SHARE, 6)
    expect(breeze.surfPeriodSeconds).toBeGreaterThanOrEqual(SURF_MINIMUM_PERIOD_SECONDS)
    expect(breeze.surfPeriodSeconds).toBeLessThanOrEqual(SURF_MAXIMUM_PERIOD_SECONDS)
    expect(resolveState({ surfHeightMeters: 0 }).surfHeightMeters).toBe(0)
    expect(resolveState({ surfHeightMeters: 1.5, surfPeriodSeconds: 12 })).toMatchObject({ surfHeightMeters: 1.5, surfPeriodSeconds: 12 })
    expect(resolveState({ waves: false, surfHeightMeters: 2 }).surfHeightMeters).toBe(0)
    expect(() => resolveState({ surfHeightMeters: -1 })).toThrow(/surfHeightMeters must be between 0/)
    expect(() => resolveState({ surfPeriodSeconds: 1 })).toThrow(/surfPeriodSeconds must be between 2 and 30/)
  })
})
