import {
  PLUGIN_API_VERSION,
  terrainElevationMeters,
  terrainFlatMorph,
  terrainWaterMask,
  type Earth,
  type EarthPlugin,
  type PluginContext,
  type TerrainShadingDefinition,
} from '@earthkit/globe'
import { Color, Vector3, type ColorRepresentation } from 'three'
import { cameraViewMatrix, exp, float, max, mix, pow, uniform, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { computeWaterOptics, surfaceMeanSquareSlope, surfaceRoughness, whitecapCoverage } from './optics.js'
import { significantWaveHeight, type SeaStateOptions } from './waves/spectrum.js'
import { WaveSurface } from './waves/WaveSurface.js'
import { WATER_PRESETS, type WaterPreset } from './presets.js'

export interface WaterSettings {
  /** The starting point: a physical sea (`'calm'`, `'breeze'`, `'open-ocean'`, `'storm'`, `'coastal'`) or `'map'`. Default: `'breeze'`. */
  preset?: WaterPreset
  /** Wind speed 10 m above the sea, m/s: the gloss (wider sun glint as it rises) and the whitecaps. */
  windSpeedMetersPerSecond?: number
  /** Chlorophyll, mg/m³: 0.03 deep blue, 0.1 to 0.3 open ocean, 1 and more green-blue coasts. */
  chlorophyllMilligramsPerCubicMeter?: number
  /** Salinity, g/kg: 35 for the ocean, 0 for fresh water. Salt water scatters a little more light, and is denser. */
  salinityPartsPerThousand?: number
  /** Draw waves near the camera: an FFT ocean shaped by the wind, the fetch and the water. Default: true but for `'map'`. */
  waves?: boolean
  /** The direction the wind blows from, degrees clockwise from north: the waves run the other way. Default: 270 (westerly). */
  windDirectionDegrees?: number
  /** How far the wind has blown over open water, km: a short fetch raises short, steep waves, a long one a swell-like sea. */
  fetchKilometers?: number
  /** Water temperature, °C: the surface tension and density that shape the smallest (capillary) ripples. */
  temperatureCelsius?: number
  /**
   * A fixed colour instead of the one the water's optics give, for a stylised sea; null for the optics. Strings and
   * numbers are sRGB, a `Color` is taken as linear (three's working space).
   */
  color?: ColorRepresentation | null
  /** A fixed roughness, 0 to 1, instead of the wind's; null for the wind's. */
  roughness?: number | null
  /**
   * How much of the ground's own colour (the imagery, or the terrain style) shows through on water, 0 to 1. Default: 0,
   * the water's colour alone, as the satellite sea is a photograph of other light and weather.
   */
  imageryOpacity?: number
  /**
   * The colour the sea takes on the flat map, where the terrain is drawn unlit as a map (sRGB); null keeps the ground's
   * colour there (the imagery). Default: `color`, else the preset's colour, else `'#a0c8f0'`.
   */
  flatMapColor?: ColorRepresentation | null
  /**
   * Show the seafloor through shallow water, from the terrain's elevation below `seaLevelMeters`: needs a source that
   * holds the seafloor (Terrarium through `RasterDemSource` with `flattenBelowSeaLevel`). Default: false.
   */
  depthFromElevation?: boolean
  /** The sea's height for `depthFromElevation`, metres: match the terrain source's `seaLevelMeters`. Default: 0. */
  seaLevelMeters?: number
  /** The seafloor's colour for `depthFromElevation` (sRGB). Default: `'#c2b280'`, sand. */
  seafloorColor?: ColorRepresentation
}

export interface WaterOptions extends WaterSettings {
  /** Unique on an earth, as every plugin's, and the terrain shading's name. Default: `'water'`. */
  name?: string
}

/** The settings resolved over the preset, as `water.inspect()` reports them. */
export interface WaterState {
  readonly preset: WaterPreset
  readonly windSpeedMetersPerSecond: number
  readonly chlorophyllMilligramsPerCubicMeter: number
  readonly salinityPartsPerThousand: number
  readonly waves: boolean
  readonly windDirectionDegrees: number
  readonly fetchKilometers: number
  readonly temperatureCelsius: number
  /** Significant wave height of the sea state (the mean of the highest third of the waves), metres. */
  readonly significantWaveHeightMeters: number
  /** The water's colour as a diffuse albedo in linear RGB: the fixed `color` or the optics'. */
  readonly albedo: readonly [number, number, number]
  /** The roughness drawn far from the camera, where no wave is drawn: the fixed `roughness` or the wind's. */
  readonly roughness: number
  /** The share of the sea white with whitecaps. */
  readonly whitecapCoverage: number
  /** Downwelling light lost per metre of depth, per band (red, green, blue). */
  readonly diffuseAttenuationPerMeter: readonly [number, number, number]
  readonly imageryOpacity: number
  readonly depthFromElevation: boolean
}

const DEFAULT_FLAT_MAP_COLOR = '#a0c8f0'
const DEFAULT_SEAFLOOR_COLOR = '#c2b280'
/** Albedo of whitecap foam (Koepke 1984: about 0.22 effective, up to 0.55 for fresh foam). */
const FOAM_ALBEDO = 0.4
/** Light crossing the surface twice, down to the seafloor and back up, keeps about half. */
const SURFACE_TRANSMITTANCE = 0.5

/**
 * A physically based sea for the terrain, as a plugin: install it with `<Earth plugins={[water]}>`,
 * `earth.addPlugin(water)` or `<Water>` from `@earthkit/water/react`. It shades wherever `terrainWaterMask` says the
 * terrain is water, over the imagery and any terrain style:
 *
 * - The colour comes from the water's optics: absorption and scattering of seawater, phytoplankton (chlorophyll) and
 *   dissolved matter, so clear ocean is deep blue and productive coasts green-blue. Shallow water shows the seafloor.
 * - The gloss comes from the wind (Cox & Munk), so under `<Atmosphere>` the sea mirrors the sky with Fresnel and the
 *   sun's glint widens as the wind rises; whitecaps pale a windy sea.
 * - Near the camera, waves from a JONSWAP spectrum (wind, fetch, temperature, salinity) simulated by FFT tilt the
 *   surface, and the roughness hands their slopes over to the wind's gloss farther off.
 * - On the flat map the sea takes a map colour, as the terrain is drawn unlit there.
 *
 * Changing the settings (`setSettings`) updates uniforms only: no shader rebuild, no tile reload.
 */
export class Water implements EarthPlugin {
  readonly name: string
  readonly apiVersion = PLUGIN_API_VERSION
  protected settingsValue: WaterSettings
  protected stateValue!: WaterState
  protected earth: Earth | null = null

  protected readonly albedo = uniform(new Color())
  protected readonly roughness = uniform(0)
  protected readonly whitecaps = uniform(0)
  protected readonly imageryOpacity = uniform(0)
  protected readonly flatMapColor = uniform(new Color())
  /** 1 to show `flatMapColor` on the flat map, 0 to keep the ground's colour there. */
  protected readonly flatMapColorWeight = uniform(1)
  protected readonly depthWeight = uniform(0)
  protected readonly seaLevelMeters = uniform(0)
  protected readonly seafloorAlbedo = uniform(new Color())
  protected readonly diffuseAttenuation = uniform(new Vector3())
  /** 1 when `roughness` is fixed: the drawn waves then do not change it. */
  protected readonly fixedRoughnessWeight = uniform(0)
  /** The surface's whole slope variance from the wind (Cox & Munk): drawn waves carry part of it, roughness the rest. */
  protected readonly meanSquareSlope = uniform(0)
  /** The waves, simulated on the CPU and laid under the camera. */
  readonly waveSurface = new WaveSurface()

  constructor({ name = 'water', ...settings }: WaterOptions = {}) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('Water: give it a non-empty `name`, or leave it out for "water".')
    this.name = name
    this.settingsValue = {}
    this.setSettings(settings)
  }

  /** The settings as given (what the preset does not set), as passed to the constructor or `setSettings`. */
  get settings(): Readonly<WaterSettings> {
    return this.settingsValue
  }

  /** The settings resolved over the preset. */
  get state(): WaterState {
    return this.stateValue
  }

  /**
   * Replaces the settings: those left out fall back to the preset's. To change one, spread the current ones:
   * `water.setSettings({ ...water.settings, windSpeedMetersPerSecond: 12 })`. Throws, stating the fix, on a value out
   * of range (nothing changes then). Updates uniforms only.
   */
  setSettings(settings: WaterSettings): void {
    const state = resolveState(settings)
    this.settingsValue = { ...settings }
    this.stateValue = state

    this.albedo.value.setRGB(...state.albedo)
    this.roughness.value = state.roughness
    this.whitecaps.value = state.whitecapCoverage
    this.imageryOpacity.value = state.imageryOpacity
    const preset = WATER_PRESETS[state.preset]
    const fixedColor = settings.color === undefined ? preset.color : settings.color
    const flatMapColor = settings.flatMapColor === undefined ? (fixedColor ?? DEFAULT_FLAT_MAP_COLOR) : settings.flatMapColor
    this.flatMapColorWeight.value = flatMapColor === null ? 0 : 1
    if (flatMapColor !== null) this.flatMapColor.value.set(flatMapColor)
    this.depthWeight.value = state.depthFromElevation ? 1 : 0
    this.seaLevelMeters.value = settings.seaLevelMeters ?? 0
    this.seafloorAlbedo.value.set(settings.seafloorColor ?? DEFAULT_SEAFLOOR_COLOR).multiplyScalar(SURFACE_TRANSMITTANCE)
    this.diffuseAttenuation.value.set(...state.diffuseAttenuationPerMeter)
    const fixedRoughness = settings.roughness === undefined ? preset.roughness : settings.roughness
    this.fixedRoughnessWeight.value = fixedRoughness === null ? 0 : 1
    this.meanSquareSlope.value = surfaceMeanSquareSlope(state.windSpeedMetersPerSecond)
    this.waveSurface.weight.value = state.waves ? 1 : 0
    if (state.waves) this.waveSurface.setSeaState(seaStateOf(state))
    this.earth?.requestFrame()
  }

  install(context: PluginContext): void {
    const { earth } = context
    this.earth = earth
    context.registerTerrainShading(this.createShading())
    context.onUpdate(({ deltaSeconds, camera }) => {
      if (!this.stateValue.waves) return false
      this.waveSurface.update(deltaSeconds, camera, earth)
      return true
    })
    context.onDispose(() => {
      if (this.earth === earth) this.earth = null
    })
  }

  inspect(): WaterState {
    return this.stateValue
  }

  /**
   * The sea's roughness at the fragment: what the drawn waves leave of the wind's slope variance (Cox & Munk), as GGX
   * roughness, roughened by the whitecaps. Near the camera the waves carry the slopes and the surface sharpens; far off
   * no wave is drawn and the roughness is the wind's whole. A fixed roughness stays as given.
   */
  protected waterRoughness(resolvedMeanSquareSlope: Node<'float'>): Node<'float'> {
    const residual = pow(max(this.meanSquareSlope.sub(resolvedMeanSquareSlope), 1e-4), 0.25)
    const withFoam = residual.add(float(1).sub(residual).mul(this.whitecaps))
    return mix(withFoam, this.roughness, this.fixedRoughnessWeight) as unknown as Node<'float'>
  }

  /** Frees the wave textures. Call when the plugin will not be installed again. */
  dispose(): void {
    this.waveSurface.dispose()
  }

  /** The terrain shading: built once per terrain shader, read from this plugin's uniforms. */
  protected createShading(): TerrainShadingDefinition {
    return {
      name: this.name,
      shade: inputs => {
        const ground = inputs.color.rgb
        const waves = this.waveSurface.createNodes()
        const onSea = terrainWaterMask.mul(float(1).sub(terrainFlatMorph))
        // Shallow water: the seafloor's light, dimmed going down and coming back up (Maritorena et al. 1994).
        const depth = max(this.seaLevelMeters.sub(terrainElevationMeters), 0)
        const seafloorShare = exp(this.diffuseAttenuation.mul(depth).mul(-2)).mul(this.depthWeight)
        const body = mix(this.albedo, this.seafloorAlbedo, seafloorShare)
        const surface = mix(body, vec3(FOAM_ALBEDO), this.whitecaps)
        const onGlobe = mix(surface, ground, this.imageryOpacity)
        const onFlatMap = mix(ground, this.flatMapColor, this.flatMapColorWeight)
        const sea = mix(onGlobe, onFlatMap, terrainFlatMorph)
        return {
          color: vec4(mix(ground, sea, terrainWaterMask), inputs.color.a) as unknown as Node<'vec4'>,
          roughness: mix(inputs.roughness, this.waterRoughness(waves.resolvedMeanSquareSlope), terrainWaterMask) as unknown as Node<'float'>,
          metalness: mix(inputs.metalness, float(0), terrainWaterMask) as unknown as Node<'float'>,
          // The waves tilt the surface: their slopes, east and north, taken off the ground's normal.
          normal: inputs.normal
            .sub(cameraViewMatrix.mul(vec4(waves.east, 0)).xyz.mul(waves.slope.x.mul(onSea)))
            .sub(cameraViewMatrix.mul(vec4(waves.north, 0)).xyz.mul(waves.slope.y.mul(onSea)))
            .normalize() as unknown as Node<'vec3'>,
        }
      },
    }
  }
}

/** Throws, stating the fix, on a colour string three does not know (it would draw white, or keep the last colour). */
function checkColor(setting: string, value: ColorRepresentation | null | undefined): void {
  if (typeof value === 'string' && !isKnownColor(value)) {
    throw new Error(`Water: ${setting} must be a CSS colour ('#1b4f8a', 'rgb(27, 79, 138)', 'steelblue'), got "${value}".`)
  }
}

function isKnownColor(value: string): boolean {
  // Two different starting colours: an unknown string leaves each as it was.
  const first = new Color(1, 0, 0)
  const second = new Color(0, 0, 1)
  const warn = console.warn
  console.warn = () => {}
  try {
    first.setStyle(value)
    second.setStyle(value)
  } finally {
    console.warn = warn
  }
  return first.equals(second)
}

/** The wind and water a sea state needs, from the resolved settings. */
function seaStateOf(state: WaterState): SeaStateOptions {
  return {
    windSpeedMetersPerSecond: state.windSpeedMetersPerSecond,
    windDirectionDegrees: state.windDirectionDegrees,
    fetchKilometers: state.fetchKilometers,
    temperatureCelsius: state.temperatureCelsius,
    salinityPartsPerThousand: state.salinityPartsPerThousand,
  }
}

function inRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum
}

/** The settings resolved over their preset. Throws, stating the fix, on a value out of range. */
export function resolveState(settings: WaterSettings): WaterState {
  const presetName = settings.preset ?? 'breeze'
  if (!Object.hasOwn(WATER_PRESETS, presetName)) {
    throw new Error(`Water: unknown preset "${presetName}". Use one of ${Object.keys(WATER_PRESETS).map(name => `'${name}'`).join(', ')}.`)
  }
  const preset = WATER_PRESETS[presetName]
  const windSpeedMetersPerSecond = settings.windSpeedMetersPerSecond ?? preset.windSpeedMetersPerSecond
  const chlorophyllMilligramsPerCubicMeter = settings.chlorophyllMilligramsPerCubicMeter ?? preset.chlorophyllMilligramsPerCubicMeter
  const salinityPartsPerThousand = settings.salinityPartsPerThousand ?? preset.salinityPartsPerThousand
  const imageryOpacity = settings.imageryOpacity ?? 0
  const windDirectionDegrees = settings.windDirectionDegrees ?? 270
  const fetchKilometers = settings.fetchKilometers ?? preset.fetchKilometers
  const temperatureCelsius = settings.temperatureCelsius ?? preset.temperatureCelsius
  const fixedRoughness = settings.roughness === undefined ? preset.roughness : settings.roughness
  const fixedColor = settings.color === undefined ? preset.color : settings.color

  if (!inRange(windSpeedMetersPerSecond, 0, 60)) throw new Error(`Water: windSpeedMetersPerSecond must be between 0 and 60, got ${windSpeedMetersPerSecond}.`)
  if (!inRange(chlorophyllMilligramsPerCubicMeter, 0, 100)) {
    throw new Error(`Water: chlorophyllMilligramsPerCubicMeter must be between 0 and 100 (0.1 for open ocean), got ${chlorophyllMilligramsPerCubicMeter}.`)
  }
  if (!inRange(salinityPartsPerThousand, 0, 45)) throw new Error(`Water: salinityPartsPerThousand must be between 0 (fresh) and 45, got ${salinityPartsPerThousand}.`)
  if (!inRange(imageryOpacity, 0, 1)) throw new Error(`Water: imageryOpacity must be between 0 and 1, got ${imageryOpacity}.`)
  if (fixedRoughness !== null && !inRange(fixedRoughness, 0, 1)) throw new Error(`Water: roughness must be between 0 and 1, or null for the wind's, got ${fixedRoughness}.`)
  if (!Number.isFinite(windDirectionDegrees)) throw new Error(`Water: windDirectionDegrees must be a finite number (270: from the west), got ${windDirectionDegrees}.`)
  if (!inRange(fetchKilometers, 0.1, 5000)) throw new Error(`Water: fetchKilometers must be between 0.1 and 5000, got ${fetchKilometers}.`)
  if (!inRange(temperatureCelsius, -2, 40)) throw new Error(`Water: temperatureCelsius must be between -2 and 40 (liquid seawater), got ${temperatureCelsius}.`)
  checkColor('color', fixedColor)
  checkColor('flatMapColor', settings.flatMapColor)
  checkColor('seafloorColor', settings.seafloorColor)
  if (settings.seaLevelMeters !== undefined && !Number.isFinite(settings.seaLevelMeters)) {
    throw new Error(`Water: seaLevelMeters must be a finite number, got ${settings.seaLevelMeters}.`)
  }

  const optics = computeWaterOptics({ chlorophyllMilligramsPerCubicMeter, salinityPartsPerThousand })
  const albedo = fixedColor === null ? optics.deepAlbedo : (new Color(fixedColor).toArray() as [number, number, number])
  // A fixed style has no foam: it draws the sea as given.
  const whitecaps = fixedColor === null ? whitecapCoverage(windSpeedMetersPerSecond) : 0
  const windRoughness = surfaceRoughness(windSpeedMetersPerSecond)
  return {
    preset: presetName,
    windSpeedMetersPerSecond,
    chlorophyllMilligramsPerCubicMeter,
    salinityPartsPerThousand,
    waves: settings.waves ?? preset.waves,
    windDirectionDegrees,
    fetchKilometers,
    temperatureCelsius,
    significantWaveHeightMeters: significantWaveHeight({ windSpeedMetersPerSecond, windDirectionDegrees, fetchKilometers, temperatureCelsius, salinityPartsPerThousand }),
    albedo,
    // Foam is matte: whitecaps roughen the sea in proportion.
    roughness: fixedRoughness ?? windRoughness + (1 - windRoughness) * whitecaps,
    whitecapCoverage: whitecaps,
    diffuseAttenuationPerMeter: optics.diffuseAttenuationPerMeter,
    imageryOpacity,
    depthFromElevation: settings.depthFromElevation ?? false,
  }
}
