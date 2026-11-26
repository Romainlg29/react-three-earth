import { describe, expect, it, vi } from 'vitest'

import { Water } from '../src/Water.js'
import { hullCorners, WaveBuoyancy } from '../src/waves/WaveBuoyancy.js'
import type { WaveProbe, WaveProbeSample } from '../src/waves/WaveProbe.js'
import { Vector3 } from 'three'

const hull = { longitudeDegrees: 10, latitudeDegrees: 45, headingDegrees: 0, lengthMeters: 10, beamMeters: 4 }

/** A probe whose samples the test sets: bow port, bow starboard, stern port, stern starboard. */
function fakeProbe(): WaveProbe & { set(heights: number[]): void } {
  const samples: WaveProbeSample[] = []
  return {
    capacity: 4,
    samples,
    setPoints: vi.fn((points: unknown[]) => {
      samples.length = 0
      for (let index = 0; index < points.length; index++) samples.push({ heightMeters: 0, waveHeightMeters: 0, onWater: true, normal: new Vector3(0, 0, 1), ready: false })
    }),
    dispose: vi.fn(),
    set(heights: number[]) {
      heights.forEach((height, index) => Object.assign(samples[index]!, { heightMeters: height, ready: true }))
    },
  } as unknown as WaveProbe & { set(heights: number[]): void }
}

describe('hullCorners', () => {
  it('puts the bow ahead along the heading and starboard to its right, metres apart as given', () => {
    const [bowPort, bowStarboard, sternPort] = hullCorners({ ...hull, headingDegrees: 90 })
    // Heading east: the bow lies east of the stern, starboard south of port.
    const metersPerDegreeLatitude = 111_132
    const metersPerDegreeLongitude = 78_847
    expect((bowPort!.longitudeDegrees - sternPort!.longitudeDegrees) * metersPerDegreeLongitude).toBeCloseTo(10, 1)
    expect((bowPort!.latitudeDegrees - bowStarboard!.latitudeDegrees) * metersPerDegreeLatitude).toBeCloseTo(4, 1)
  })
})

describe('WaveBuoyancy', () => {
  it('heaves, pitches and rolls with its corners, following them with a lag', () => {
    const probe = fakeProbe()
    const buoyancy = new WaveBuoyancy(probe, hull, { responseSeconds: 1, draftMeters: 0.5 })
    buoyancy.update(0.016)
    expect(buoyancy.state.ready).toBe(false)
    // Bow 1 m higher than the stern, starboard 0.4 m higher than port.
    probe.set([1.3, 1.7, 0.3, 0.7])
    buoyancy.update(0.016)
    expect(buoyancy.state.ready).toBe(true)
    expect(buoyancy.state.heightMeters).toBeCloseTo(1 - 0.5, 9)
    expect(buoyancy.state.pitchRadians).toBeCloseTo(Math.atan2(1, 10), 9)
    expect(buoyancy.state.rollRadians).toBeCloseTo(Math.atan2(0.4, 4), 9)
    // Level sea: after one response time, about 63 % of the way there.
    probe.set([0, 0, 0, 0])
    buoyancy.update(1)
    expect(buoyancy.state.pitchRadians).toBeCloseTo(Math.atan2(1, 10) * Math.exp(-1), 9)
  })

  it('refuses a hull it cannot sample, and frees its probe once', () => {
    const probe = fakeProbe()
    expect(() => new WaveBuoyancy(probe, { ...hull, beamMeters: 0 })).toThrow(/positive lengthMeters and beamMeters/)
    const onDispose = vi.fn()
    const buoyancy = new WaveBuoyancy(probe, hull, {}, onDispose)
    buoyancy.dispose()
    buoyancy.dispose()
    expect(probe.dispose).toHaveBeenCalledTimes(1)
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(() => buoyancy.setHull(hull)).toThrow(/disposed/)
  })

  it('comes from the water with four points sampled, and goes with it', () => {
    const water = new Water({ quality: 'high' })
    const buoyancy = water.createBuoyancy(hull)
    expect(buoyancy.probe.samples).toHaveLength(4)
    water.dispose()
    expect(() => buoyancy.setHull(hull)).toThrow(/disposed/)
  })
})
