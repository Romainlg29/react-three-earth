import { Earth } from '@earthkit/globe'
import { Color } from 'three'
import { bool, float, vec3, vec4 } from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'

import { computeWaterOptics, inherentOpticalProperties, surfaceRoughness, whitecapCoverage } from '../src/optics.js'
import { WATER_PRESETS } from '../src/presets.js'
import { detectWaterQuality, isSoftwareRenderer, resolveState, Water, WATER_QUALITY_LEVELS, WATER_SLOW_FRAME_SECONDS } from '../src/Water.js'

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

  it('glow turquoise through a crest: red absorbed, blue scattered away, greener with chlorophyll', () => {
    const [red, green, blue] = computeWaterOptics({ ...ocean, chlorophyllMilligramsPerCubicMeter: 0.2 }).crestTransmittance
    expect(green).toBeGreaterThan(red * 2)
    expect(blue).toBeGreaterThan(red * 2)
    expect(blue).toBeLessThan(1)
    const productive = computeWaterOptics({ ...ocean, chlorophyllMilligramsPerCubicMeter: 5 }).crestTransmittance
    expect(productive[1]).toBeGreaterThan(productive[2])
    expect(resolveState({}).crestTransmittance).toEqual(computeWaterOptics({ chlorophyllMilligramsPerCubicMeter: resolveState({}).chlorophyllMilligramsPerCubicMeter, salinityPartsPerThousand: 35 }).crestTransmittance)
    // A fixed colour draws the sea as given: no glow.
    expect(resolveState({ color: '#123456' }).crestTransmittance).toEqual([0, 0, 0])
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
    expect(() => resolveState({ color: 'bleu' })).toThrow(`color must be a CSS colour ('#1b4f8a', 'rgb(27, 79, 138)', 'steelblue'), got "bleu"`)
    expect(() => resolveState({ seafloorColor: 'sand' })).toThrow('seafloorColor must be a CSS colour')
    expect(resolveState({ color: 'steelblue', flatMapColor: '#fff' }).albedo).toEqual(new Color('steelblue').toArray())
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

  it('shows a fixed colour on the flat map too, unless told otherwise', () => {
    const water = new Water({ color: '#1b4f8a' }) as unknown as { flatMapColor: { value: Color } }
    expect(water.flatMapColor.value.getHexString()).toBe('1b4f8a')
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
    const outputs = definition.shade({ color: vec4(1), roughness: float(1), metalness: float(0), normal: vec3(0, 0, 1), emissive: vec3(0), mask: bool(true) } as never)
    expect(Object.keys(outputs).sort()).toEqual(['color', 'mask', 'metalness', 'normal', 'roughness'])
  })
})

describe('water quality', () => {
  it('draws a lighter sea at low quality, picks it on a touch screen, and refuses an unknown level', () => {
    const low = new Water({ quality: 'low' })
    expect(low.quality).toBe('low')
    expect(low.waveSurface.computeGridSize).toBe(WATER_QUALITY_LEVELS.low.computeGridSize)
    expect(low.waveSurface.framesPerSimulationStep).toBe(2)
    expect(low.waveSurface.detail).toBe(false)
    expect(low.waveMesh.resolution).toBe(WATER_QUALITY_LEVELS.low.meshResolution)
    const high = new Water({ quality: 'high' })
    expect(high.waveSurface.computeGridSize).toBe(256)
    expect(high.waveMesh.resolution).toBe(48)
    const matchMedia = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }))
    vi.stubGlobal('matchMedia', matchMedia)
    expect(detectWaterQuality()).toBe('low')
    expect(new Water().quality).toBe('low')
    vi.unstubAllGlobals()
    expect(detectWaterQuality()).toBe('high')
    expect(() => new Water({ quality: 'medium' as never })).toThrow(/'auto', 'high', 'low' or 'minimal'/)
    low.dispose()
    high.dispose()
  })
})

describe('adapting the quality', () => {
  const fakeRenderer = (adapterInfo: object) => ({ backend: { device: { adapterInfo } } }) as never
  const webglRenderer = (name: string) =>
    ({ backend: { gl: { RENDERER: 1, getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 2 }), getParameter: (parameter: number) => (parameter === 2 ? name : 'WebKit WebGL') } } }) as never

  it('tells a software renderer from a GPU', () => {
    expect(isSoftwareRenderer(fakeRenderer({ vendor: 'google', architecture: 'swiftshader' }))).toBe(true)
    expect(isSoftwareRenderer(fakeRenderer({ isFallbackAdapter: true }))).toBe(true)
    expect(isSoftwareRenderer(fakeRenderer({ vendor: 'nvidia', architecture: 'ampere' }))).toBe(false)
    expect(isSoftwareRenderer(webglRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe(true)
    expect(isSoftwareRenderer(webglRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'))).toBe(true)
    expect(isSoftwareRenderer(webglRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'))).toBe(false)
    expect(isSoftwareRenderer({ backend: {} } as never)).toBe(false)
  })

  it('draws the minimal sea without its mesh, and changes level at run time', () => {
    const water = new Water({ quality: 'high' })
    water.setQuality('minimal')
    expect(water.quality).toBe('minimal')
    expect(water.waveSurface.computeGridSize).toBe(WATER_QUALITY_LEVELS.minimal.computeGridSize)
    expect(water.waveSurface.framesPerSimulationStep).toBe(WATER_QUALITY_LEVELS.minimal.framesPerSimulationStep)
    expect(water.waveSurface.detail).toBe(false)
    expect(WATER_QUALITY_LEVELS.minimal.mesh).toBe(false)
    // The mesh keeps the resolution it was built with.
    expect(water.waveMesh.resolution).toBe(WATER_QUALITY_LEVELS.high.meshResolution)
    expect(() => water.setQuality('ultra' as never)).toThrow(/'high', 'low' or 'minimal'/)
    water.dispose()
  })

  it("lowers the quality a level at a time while frames stay slow, and picks 'minimal' on a software renderer for 'auto'", () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const run = (water: Water, frameSeconds: number, seconds: number, renderer?: never) => {
      for (let time = 0; time < seconds; time += frameSeconds) (water as unknown as { adaptQuality(delta: number, renderer?: never): void }).adaptQuality(frameSeconds, renderer)
    }
    const fast = new Water({ quality: 'high' })
    run(fast, 1 / 60, 20)
    expect(fast.quality).toBe('high')
    const slow = new Water({ quality: 'high' })
    run(slow, WATER_SLOW_FRAME_SECONDS * 2, 3.5)
    expect(slow.quality).toBe('high')
    run(slow, WATER_SLOW_FRAME_SECONDS * 2, 2.5)
    expect(slow.quality).toBe('low')
    run(slow, WATER_SLOW_FRAME_SECONDS * 2, 6)
    expect(slow.quality).toBe('minimal')
    run(slow, WATER_SLOW_FRAME_SECONDS * 2, 10)
    expect(slow.quality).toBe('minimal')
    expect(info).toHaveBeenCalledWith(expect.stringContaining('adaptiveQuality: false'))
    // Pauses (a hidden tab) do not count, and the option turns it off.
    const paused = new Water({ quality: 'high' })
    run(paused, 2, 60)
    expect(paused.quality).toBe('high')
    const fixed = new Water({ quality: 'high', adaptiveQuality: false })
    run(fixed, WATER_SLOW_FRAME_SECONDS * 2, 20)
    expect(fixed.quality).toBe('high')
    const auto = new Water()
    run(auto, 1 / 60, 0.1, fakeRenderer({ vendor: 'google', architecture: 'swiftshader' }))
    expect(auto.quality).toBe('minimal')
    const chosen = new Water({ quality: 'high', adaptiveQuality: false })
    run(chosen, 1 / 60, 0.1, fakeRenderer({ vendor: 'google', architecture: 'swiftshader' }))
    expect(chosen.quality).toBe('high')
    for (const water of [fast, slow, paused, fixed, auto, chosen]) water.dispose()
    info.mockRestore()
  })
})
