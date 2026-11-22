import { describe, expect, it } from 'vitest'

import { ATMOSPHERE_PRECOMPUTE_VERSION, createAtmosphereCacheKey, hashString, type AtmosphereTextureData } from '../src/atmosphere/AtmosphereTextureCache.js'
import { AtmosphereParameters } from '../src/atmosphere/AtmosphereParameters.js'
import { isPlausible } from '../src/atmosphere/AtmosphereTextures.js'
import modelSource from '../src/atmosphere/AtmosphereModel.ts?raw'
import precomputeSource from '../src/atmosphere/precompute.ts?raw'
import texturesSource from '../src/atmosphere/AtmosphereTextures.ts?raw'
import { GenerationPacer } from '../src/atmosphere/GenerationPacer.js'

describe('GenerationPacer', () => {
  it('runs one unit until it has measured one', () => {
    expect(new GenerationPacer(4).plan([1, 1, 1], 0)).toBe(1)
  })

  it('fits batches to the budget from the measured cost per weight', () => {
    const pacer = new GenerationPacer(4)
    pacer.maximumGrowth = Infinity
    pacer.observe(10, 1) // 0.1 ms per weight
    expect(pacer.plan([10, 10, 10, 10, 10, 10], 0)).toBe(4) // 4 × 1 ms fits, 5 does not
    expect(pacer.plan([10, 10, 10, 10, 10, 10], 4)).toBe(2) // only two left
    expect(pacer.plan([10], 1)).toBe(0)
  })

  it('always runs at least one unit, however costly', () => {
    const pacer = new GenerationPacer(4)
    pacer.observe(1, 100)
    expect(pacer.plan([5, 5], 0)).toBe(1)
  })

  it('grows batches at most by maximumGrowth over the last measured one', () => {
    const pacer = new GenerationPacer(1000)
    pacer.observe(1, 1e-9) // a fence that signalled almost at once
    expect(pacer.plan(Array(100).fill(1), 0)).toBe(2)
  })

  it('never plans a batch heavier than maximumWeight', () => {
    const pacer = new GenerationPacer(1000)
    pacer.maximumGrowth = Infinity
    pacer.maximumWeight = 25
    pacer.observe(10, 1e-9)
    expect(pacer.plan(Array(100).fill(10), 0)).toBe(2)
  })

  it('follows a costlier measurement at once and a cheaper one gradually', () => {
    const pacer = new GenerationPacer(4)
    pacer.observe(1, 1)
    pacer.observe(1, 3)
    expect(pacer.millisecondsPerWeight).toBe(3)
    pacer.observe(1, 1)
    expect(pacer.millisecondsPerWeight).toBeCloseTo(2.4)
  })

  it('ignores empty batches and invalid times', () => {
    const pacer = new GenerationPacer(4)
    pacer.observe(0, 5)
    pacer.observe(1, Number.NaN)
    pacer.observe(1, 0) // no slower than the waiter's own latency
    pacer.observe(1, -0.5)
    expect(pacer.millisecondsPerWeight).toBeNull()
  })
  it('estimates the remaining GPU time once a batch is measured', () => {
    const pacer = new GenerationPacer(4)
    expect(pacer.estimateRemaining([10, 10, 10], 0)).toBe(Infinity)
    pacer.observe(10, 1) // 0.1 ms per weight
    expect(pacer.estimateRemaining([10, 10, 10], 1)).toBeCloseTo(2)
    expect(pacer.estimateRemaining([10, 10, 10], 3)).toBe(0)
  })
})

describe('createAtmosphereCacheKey', () => {
  it('is equal for equal parameters and differs when any parameter or the storage type does', () => {
    const key = createAtmosphereCacheKey(new AtmosphereParameters(), true)
    expect(createAtmosphereCacheKey(new AtmosphereParameters(), true)).toBe(key)
    expect(createAtmosphereCacheKey(new AtmosphereParameters(), false)).not.toBe(key)
    expect(createAtmosphereCacheKey(AtmosphereParameters.create({ mieScaleHeightMeters: 1500 }), true)).not.toBe(key)
    const resized = new AtmosphereParameters()
    resized.textureSizesTexels.scatteringAltitude = 16
    expect(createAtmosphereCacheKey(resized, true)).not.toBe(key)
    const recoloured = new AtmosphereParameters()
    recoloured.groundAlbedo.x = 0.3
    expect(createAtmosphereCacheKey(recoloured, true)).not.toBe(key)
  })
})

describe('isPlausible', () => {
  const valid = (): AtmosphereTextureData => ({
    transmittance: new Float32Array([1, 1, 1, 1, 0.5, 0.2, 0.1, 1]),
    irradiance: new Float32Array([0, 0.1, 0.2, 1]),
    scattering: new Uint16Array([0x3c00, 0, 0x3800, 0x3c00]),
    scatteringHalfFloat: true,
  })

  it('accepts valid textures', () => {
    expect(isPlausible(valid())).toBe(true)
  })

  it('rejects all-zero textures (a failed readback)', () => {
    expect(isPlausible({ ...valid(), transmittance: new Float32Array(8) })).toBe(false)
    expect(isPlausible({ ...valid(), scattering: new Uint16Array(4) })).toBe(false)
    expect(isPlausible({ ...valid(), scattering: new Float32Array(4), scatteringHalfFloat: false })).toBe(false)
  })

  it('rejects NaN, negative and infinite values', () => {
    expect(isPlausible({ ...valid(), irradiance: new Float32Array([Number.NaN, 0, 0, 1]) })).toBe(false)
    expect(isPlausible({ ...valid(), scattering: new Uint16Array([0x7c00, 0, 0, 0]) })).toBe(false) // half infinity
    expect(isPlausible({ ...valid(), scattering: new Uint16Array([0xbc00, 0, 0, 0]) })).toBe(false) // half -1
    expect(isPlausible({ ...valid(), scattering: new Float32Array([-1, 0, 0, 0]), scatteringHalfFloat: false })).toBe(false)
  })
})

describe('ATMOSPHERE_PRECOMPUTE_VERSION', () => {
  // Cached lookup textures are keyed by this version. When these files change, decide whether the
  // generated textures change: if they do, bump ATMOSPHERE_PRECOMPUTE_VERSION; either way, record the new
  // hash and version here.
  const recorded = { version: 2, sourceHash: '80c0c548' }

  it('is reviewed whenever the code that generates the lookup textures changes', () => {
    const source = [modelSource, precomputeSource, texturesSource].map(text => text.replace(/\r\n/g, '\n')).join('\n')
    expect({ version: ATMOSPHERE_PRECOMPUTE_VERSION, sourceHash: hashString(source) }).toEqual(recorded)
  })
})
