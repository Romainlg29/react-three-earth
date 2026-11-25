import { Earth } from '@earthkit/globe'
import { Color } from 'three'
import { float, vec3, vec4 } from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'

import { computeWaterOptics, inherentOpticalProperties, surfaceRoughness, whitecapCoverage } from '../src/optics.js'
import { WATER_PRESETS } from '../src/presets.js'
import { resolveState, Water } from '../src/Water.js'

const ocean = { chlorophyllMilligramsPerCubicMeter: 0.1, salinityPartsPerThousand: 35 }

describe('water optics', () => {
  it('make clear ocean deep blue and dark, about 2 % reflectance in the blue', () => {
    const { deepAlbedo } = computeWaterOptics(ocean)
    const [red, green, blue] = deepAlbedo
    expect(blue).toBeGreaterThan(green)
    expect(green).toBeGreaterThan(red)
    expect(blue).toBeGreaterThan(0.015)
    expect(blue).toBeLessThan(0.04)
  })

  it('turn green-blue with chlorophyll, and murkier', () => {
    const clear = computeWaterOptics({ ...ocean, chlorophyllMilligramsPerCubicMeter: 0.03 })
    const productive = computeWaterOptics({ ...ocean, chlorophyllMilligramsPerCubicMeter: 5 })
    expect(productive.deepAlbedo[1]).toBeGreaterThan(productive.deepAlbedo[2])
    expect(clear.deepAlbedo[2]).toBeGreaterThan(clear.deepAlbedo[1])
    expect(productive.diffuseAttenuationPerMeter[2]).toBeGreaterThan(clear.diffuseAttenuationPerMeter[2] * 3)
  })

  it('let blue light reach farthest in clear water and red the least', () => {
    const [red, green, blue] = computeWaterOptics({ ...ocean, chlorophyllMilligramsPerCubicMeter: 0.03 }).diffuseAttenuationPerMeter
    expect(blue).toBeLessThan(green)
    expect(green).toBeLessThan(red)
    // Pure water's red absorption: light at 650 nm halves in about 2 m.
    expect(red).toBeGreaterThan(0.3)
  })

  it('scatter more in salt water than in fresh', () => {
    const salt = inherentOpticalProperties(450, ocean).backscatteringPerMeter
    const fresh = inherentOpticalProperties(450, { ...ocean, salinityPartsPerThousand: 0 }).backscatteringPerMeter
    expect(salt).toBeGreaterThan(fresh)
  })
})

describe('surface from the wind', () => {
  it('roughens with the wind after Cox and Munk, staying in the sky reflection range', () => {
    expect(surfaceRoughness(0)).toBeCloseTo(0.234, 3)
    expect(surfaceRoughness(5)).toBeGreaterThan(surfaceRoughness(0))
    expect(surfaceRoughness(20)).toBeLessThan(0.6)
  })

  it('whitens a gale with whitecaps, none in light air', () => {
    expect(whitecapCoverage(2)).toBe(0)
    expect(whitecapCoverage(10)).toBeCloseTo(0.0099, 3)
    expect(whitecapCoverage(20)).toBeGreaterThan(0.09)
    expect(whitecapCoverage(1000)).toBe(1)
  })
})

describe('resolveState', () => {
  it('starts from the breeze preset and lets settings override it', () => {
    const breeze = resolveState({})
    expect(breeze.preset).toBe('breeze')
    expect(breeze.windSpeedMetersPerSecond).toBe(WATER_PRESETS.breeze.windSpeedMetersPerSecond)
    const windy = resolveState({ windSpeedMetersPerSecond: 15 })
    expect(windy.roughness).toBeGreaterThan(breeze.roughness)
    expect(windy.whitecapCoverage).toBeGreaterThan(0)
  })

  it('draws the map preset as a fixed matte colour, without foam', () => {
    const map = resolveState({ preset: 'map', windSpeedMetersPerSecond: 20 })
    expect(map.roughness).toBe(1)
    expect(map.whitecapCoverage).toBe(0)
    expect(map.albedo).toEqual(new Color('#a0c8f0').toArray())
    // Back to the optics with `color: null`, to the wind's roughness with `roughness: null`.
    const physical = resolveState({ preset: 'map', color: null, roughness: null })
    expect(physical.roughness).toBeCloseTo(surfaceRoughness(0))
  })

  it('refuses values out of range, stating the fix', () => {
    expect(() => resolveState({ preset: 'lagoon' as never })).toThrow(`unknown preset "lagoon". Use one of 'map', 'calm'`)
    expect(() => resolveState({ windSpeedMetersPerSecond: -1 })).toThrow('windSpeedMetersPerSecond must be between 0 and 60')
    expect(() => resolveState({ chlorophyllMilligramsPerCubicMeter: Number.NaN })).toThrow('chlorophyllMilligramsPerCubicMeter must be between 0 and 100')
    expect(() => resolveState({ salinityPartsPerThousand: 50 })).toThrow('salinityPartsPerThousand must be between 0 (fresh) and 45')
    expect(() => resolveState({ roughness: 2 })).toThrow("roughness must be between 0 and 1, or null for the wind's")
    expect(() => resolveState({ imageryOpacity: -0.5 })).toThrow('imageryOpacity must be between 0 and 1')
    expect(() => resolveState({ seaLevelMeters: Number.POSITIVE_INFINITY })).toThrow('seaLevelMeters must be a finite number')
  })
})

describe('Water', () => {
  it('registers its terrain shading while installed, and removes it with the plugin', () => {
    const earth = new Earth()
    const water = new Water({ preset: 'storm' })
    earth.addPlugin(water)
    expect(earth.terrainShadings.has('water')).toBe(true)
    expect(earth.inspect().plugins.water).toBeDefined()
    earth.removePlugin(water)
    expect(earth.terrainShadings.size).toBe(0)
  })

  it('updates its state without a new shading, and asks for a frame', () => {
    const earth = new Earth()
    const water = new Water()
    earth.addPlugin(water)
    const shading = earth.terrainShadings.get('water')
    const requestFrame = vi.spyOn(earth, 'requestFrame')
    water.setSettings({ ...water.settings, windSpeedMetersPerSecond: 12 })
    expect(water.state.windSpeedMetersPerSecond).toBe(12)
    expect(earth.terrainShadings.get('water')).toBe(shading)
    expect(requestFrame).toHaveBeenCalled()
  })

  it('keeps its settings when new ones are refused', () => {
    const water = new Water({ preset: 'calm' })
    expect(() => water.setSettings({ windSpeedMetersPerSecond: -3 })).toThrow()
    expect(water.state.preset).toBe('calm')
    expect(water.settings).toEqual({ preset: 'calm' })
  })

  it('builds a shading that changes colour, roughness and metalness', () => {
    const earth = new Earth()
    const water = new Water({ name: 'sea' })
    earth.addPlugin(water)
    const definition = earth.terrainShadings.get('sea')!
    const outputs = definition.shade({ color: vec4(1), roughness: float(1), metalness: float(0), normal: vec3(0, 0, 1), emissive: vec3(0) } as never)
    expect(Object.keys(outputs).sort()).toEqual(['color', 'metalness', 'roughness'])
  })
})
