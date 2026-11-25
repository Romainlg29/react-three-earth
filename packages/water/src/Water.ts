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
import { cameraViewMatrix, ceil, dot, exp, exp2, float, floor, fwidth, hash, log2, max, min, mix, normalize, pow, saturate, smoothstep, sqrt, step, uniform, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { computeWaterOptics, surfaceMeanSquareSlope, surfaceRoughness, whitecapCoverage } from './optics.js'
import { significantWaveHeight, type SeaStateOptions } from './waves/spectrum.js'
import { WATER_INDEX_OF_REFRACTION, WaveMesh, type WaveMeshGround, type WaveMeshShading, type WaveMeshView } from './waves/WaveMesh.js'
import { WaveProbe, type WaveProbeOptions } from './waves/WaveProbe.js'
import { earthCenteredFromGeographic, WaveSurface, type WaveSurfaceNodes } from './waves/WaveSurface.js'
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
  /**
   * Water temperature, °C: the surface tension and density in the waves' dispersion. Its effect is small at the drawn
   * scales (capillary ripples are shorter than the smallest cascade's waves). Default: the preset's.
   */
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
  /**
   * Seeds the waves' random phases (an integer): the same seed, sea state and wave time (`water.waveSurface.timeSeconds`)
   * draw the same sea on every device. Default: 1.
   */
  waveSeed?: number
  /**
   * Draw the sea near the camera as geometry moved by the waves (needs WebGPU): crests rise, troughs sink and the
   * surface leans towards the crests. Off, or on WebGL2, the waves tilt the terrain's normals only. Default: true.
   */
  waveMesh?: boolean
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
  /** The share of sunlight a crest lit from behind sends on to the eye, per band (`WaterOptics.crestTransmittance`); 0 for a fixed `color`. */
  readonly crestTransmittance: readonly [number, number, number]
  readonly imageryOpacity: number
  readonly depthFromElevation: boolean
  readonly waveSeed: number
  readonly waveMesh: boolean
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
  /** The colour of sunlight scattered back out of the water after a metre through it: the faint glow of faces turned to the camera. */
  protected readonly scatterColor = uniform(new Color())
  /** The colour of sunlight through a crest lit from behind: its turquoise. */
  protected readonly crestColor = uniform(new Color())
  /** Towards the sun, in the wave plane's frame (x east, y north, z up). */
  protected readonly sunInPlane = uniform(new Vector3(0, 0, 1))
  /** The waves' clock for the glitter's flashes, seconds, wrapped every `GLITTER_PERIOD_SECONDS`. */
  protected readonly glitterTime = uniform(0)
  /** The sunlight reaching the sea under the camera, through the atmosphere, in the scene's units; 0 without one. */
  protected readonly sunIlluminance = uniform(new Vector3())
  /** 1 when `roughness` is fixed: the drawn waves then do not change it. */
  protected readonly fixedRoughnessWeight = uniform(0)
  /** The surface's whole slope variance from the wind (Cox & Munk): drawn waves carry part of it, roughness the rest. */
  protected readonly meanSquareSlope = uniform(0)
  /** The sea near the camera as geometry moved by the waves (GPU path only). */
  readonly waveMesh: WaveMesh
  /** The waves, simulated on the GPU under WebGPU (with foam on the breaking crests), else on the CPU, and laid under the camera. */
  readonly waveSurface = new WaveSurface()

  protected readonly probes = new Set<WaveProbe>()

  constructor({ name = 'water', ...settings }: WaterOptions = {}) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('Water: give it a non-empty `name`, or leave it out for "water".')
    this.name = name
    this.settingsValue = {}
    this.waveMesh = new WaveMesh(this.waveSurface, (waves, ground, view) => this.meshShading(waves, ground, view))
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
    this.waveSurface.setWhitecapCoverage(state.whitecapCoverage)
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
    const [red, green, blue] = state.diffuseAttenuationPerMeter
    this.scatterColor.value.setRGB(state.albedo[0] * Math.exp(-red), state.albedo[1] * Math.exp(-green), state.albedo[2] * Math.exp(-blue))
    this.crestColor.value.setRGB(...state.crestTransmittance)
    const fixedRoughness = settings.roughness === undefined ? preset.roughness : settings.roughness
    this.fixedRoughnessWeight.value = fixedRoughness === null ? 0 : 1
    this.meanSquareSlope.value = surfaceMeanSquareSlope(state.windSpeedMetersPerSecond)
    this.waveSurface.setSurfaceMeanSquareSlope(this.meanSquareSlope.value)
    this.waveSurface.weight.value = state.waves ? 1 : 0
    this.waveMesh.depthWeight.value = state.depthFromElevation ? 1 : 0
    this.waveMesh.significantWaveHeightMeters.value = state.significantWaveHeightMeters
    this.waveSurface.seaLevelMeters = settings.seaLevelMeters ?? 0
    this.waveSurface.setSeed(state.waveSeed)
    if (state.waves) this.waveSurface.setSeaState(seaStateOf(state))
    this.earth?.requestFrame()
  }

  install(context: PluginContext): void {
    const { earth } = context
    this.earth = earth
    context.registerTerrainShading(this.createShading())
    context.addObject(this.waveMesh.mesh)
    // Animates only while waves can show: not on the flat map, not from high above (the frames stop there too).
    context.onUpdate(({ deltaSeconds, camera, morph, renderer }) => {
      this.followSun(earth)
      const animating = this.stateValue.waves && morph < 1 && this.waveSurface.update(deltaSeconds, camera, earth, renderer)
      this.glitterTime.value = this.waveSurface.timeSeconds % GLITTER_PERIOD_SECONDS
      // The mesh only on the globe: on the way to the flat map the terrain bends away from its plane.
      this.waveMesh.update(animating && this.stateValue.waveMesh && morph === 0, { renderer, terrain: earth.terrain, earth })
      for (const probe of this.probes) probe.update(renderer)
      return animating
    })
    context.onDispose(() => {
      if (this.earth === earth) this.earth = null
    })
  }

  /**
   * Samples the sea's height and normal at a few points, to float a boat on the waves: set its points with
   * `probe.setPoints([{ longitudeDegrees, latitudeDegrees }])` and read `probe.samples` each frame (they lag a frame or
   * two). It reads what the wave mesh draws; `probe.dispose()` stops it.
   */
  createProbe(options?: WaveProbeOptions): WaveProbe {
    const probe = new WaveProbe(this.waveSurface, this.waveMesh, options, disposed => this.probes.delete(disposed))
    this.probes.add(probe)
    return probe
  }

  inspect(): WaterState {
    return this.stateValue
  }

  /**
   * The sea's roughness at the fragment: what the drawn waves leave of the wind's slope variance (Cox & Munk), as GGX
   * roughness, roughened by the whitecaps. Near the camera the waves carry the slopes and the surface sharpens; far off
   * no wave is drawn and the roughness is the wind's whole. A fixed roughness stays as given.
   */
  protected waterRoughness(resolvedMeanSquareSlope: Node<'float'>, foam: Node<'float'>): Node<'float'> {
    const residual = pow(max(this.meanSquareSlope.sub(resolvedMeanSquareSlope), 1e-4), 0.25)
    const withFoam = residual.add(float(1).sub(residual).mul(foam))
    return mix(withFoam, this.roughness, this.fixedRoughnessWeight) as unknown as Node<'float'>
  }

  /** Frees the wave textures, mesh and probes. Call when the plugin will not be installed again. */
  dispose(): void {
    for (const probe of [...this.probes]) probe.dispose()
    this.waveSurface.dispose()
    this.waveMesh.dispose()
  }

  /** Points the light scattered through the crests at the atmosphere's sun, with its light where the camera is. */
  protected followSun(earth: Earth): void {
    const { atmosphere } = earth
    const surface = this.waveSurface
    if (atmosphere === null || !Number.isFinite(surface.cameraHeightMeters)) {
      this.sunIlluminance.value.set(0, 0, 0)
      return
    }
    surface.directionToPlane(atmosphere.sunDirectionECEF, this.sunInPlane.value)
    const position = earthCenteredFromGeographic((surface.cameraLongitudeRadians * 180) / Math.PI, (surface.cameraLatitudeRadians * 180) / Math.PI, surface.seaLevelMeters, scratchPosition)
    const { sun } = atmosphere.getSunAndSkyIlluminance(position, scratchIlluminance)
    this.sunIlluminance.value.copy(sun).multiplyScalar(atmosphere.opacity)
  }

  /**
   * Sunlight scattered through the waves to the eye (after Atlas's water, GDC 2019): through the thin crests and backs
   * of waves standing between the camera and the sun, glowing in the water's own scattered colour, the more the higher
   * the crest; and a little through every face turned to the camera. None under foam.
   */
  protected scatteredSunlight(view: WaveMeshView, foam: Node<'float'>): Node<'vec3'> {
    const sun = this.sunInPlane
    const { normal, toCamera, waveHeightMeters, significantWaveHeightMeters } = view
    // Towards the sun along the sea: crests glow when the camera looks towards it, however high it stands.
    const sunAlong = normalize(vec3(sun.x, sun.y, 0).add(vec3(1e-4, 0, 0)))
    const behind = pow(saturate(dot(sunAlong, toCamera.negate())), 2)
    const turnedAway = saturate(float(0.5).sub(dot(sun, normal).mul(0.5)))
    const crest = pow(saturate(waveHeightMeters.div(max(significantWaveHeightMeters.mul(0.5), 0.05))), 2)
    const facing = pow(saturate(dot(toCamera, normal)), 2)
    const throughCrests = (this.crestColor as unknown as Node<'vec3'>).mul(crest.mul(behind).mul(turnedAway).mul(SCATTER_THROUGH_CRESTS))
    const towardsCamera = (this.scatterColor as unknown as Node<'vec3'>).mul(facing.mul(SCATTER_TOWARDS_CAMERA))
    const daylight = saturate(sun.z.mul(4))
    return throughCrests.add(towardsCamera).mul(this.sunIlluminance as unknown as Node<'vec3'>).mul(daylight).mul(float(1).sub(foam)) as unknown as Node<'vec3'>
  }

  /**
   * The sun's glint off the ripples too fine to draw, as glitter: the few facets among them that catch the sun flash.
   * A share of cells on the plane, each about a pixel, light up in turn with a multiple of the highlight the roughness
   * spreads there (three's GGX, as the material draws it). It only adds light, about `GLITTER_SHARE × GLITTER_GAIN` of
   * the fine ripples' highlight on average: dimming the cells between would need the material's own highlight, which
   * its specular anti-aliasing widens.
   */
  protected sunGlitter(waves: WaveSurfaceNodes, view: WaveMeshView, foam: Node<'float'>): Node<'vec3'> {
    const sun = this.sunInPlane
    const { normal, toCamera } = view
    // The facets' slope variance left over: GGX's alpha² as the material's roughness gives it (roughness⁴).
    const alphaSquared = max(this.meanSquareSlope.sub(waves.resolvedMeanSquareSlope), 1e-4)
    const halfway = normalize(sun.add(toCamera))
    const facingHalfway = saturate(dot(normal, halfway))
    const facingCamera = max(dot(normal, toCamera), 0.05)
    const facingSun = saturate(dot(normal, sun))
    const spread = facingHalfway.mul(facingHalfway).mul(alphaSquared.sub(1)).add(1)
    const distribution = alphaSquared.div(spread.mul(spread).mul(Math.PI))
    // Smith's height-correlated visibility, as three's.
    const towardsSun = facingCamera.mul(sqrt(alphaSquared.add(float(1).sub(alphaSquared).mul(facingSun.mul(facingSun)))))
    const towardsCamera = facingSun.mul(sqrt(alphaSquared.add(float(1).sub(alphaSquared).mul(facingCamera.mul(facingCamera)))))
    const visibility = float(0.5).div(max(towardsSun.add(towardsCamera), 1e-6))
    const fresnel = float(1).sub(saturate(dot(toCamera, halfway))).pow(5).mul(1 - WATER_REFLECTANCE_STRAIGHT_ON).add(WATER_REFLECTANCE_STRAIGHT_ON)
    // Bounded: a half-float target overflows past 65504, and one infinite pixel blackens the bloom and exposure.
    const highlight = min(fresnel.mul(distribution).mul(visibility).mul(facingSun), GLITTER_MAXIMUM_HIGHLIGHT)
    // Cells about a pixel wide (the footprint's geometric mean), by powers of two, from a centimetre.
    const plane = waves.plane
    const footprint = max(sqrt(fwidth(plane.x).mul(fwidth(plane.y))), GLITTER_CELL_METERS)
    const level = ceil(log2(footprint.div(GLITTER_CELL_METERS)))
    const cell = floor(plane.div(exp2(level).mul(GLITTER_CELL_METERS))).add(GLITTER_CELL_OFFSET)
    const first = hash(cell.x)
    const second = hash(cell.y.add(floor(first.mul(16777216))))
    const flash = floor(this.glitterTime.mul(GLITTER_FLASHES_PER_SECOND).add(second.mul(64)))
    const chance = hash(floor(second.mul(1048576)).add(flash).add(level.mul(977)))
    const flashing = step(chance, GLITTER_SHARE)
    const daylight = saturate(sun.z.mul(4))
    return (this.sunIlluminance as unknown as Node<'vec3'>).mul(highlight.mul(flashing).mul(GLITTER_GAIN).mul(daylight).mul(float(1).sub(foam))) as unknown as Node<'vec3'>
  }

  /** The sea on the wave mesh: the water's colour, seafloor and the wind's roughness, as on the terrain, and the light scattered through its crests. */
  protected meshShading(waves: WaveSurfaceNodes, ground: WaveMeshGround, view: WaveMeshView): WaveMeshShading {
    return {
      emissive: this.scatteredSunlight(view, waves.foam).add(this.sunGlitter(waves, view, waves.foam)) as unknown as Node<'vec3'>,
      color: mix(this.waterBody(ground.depthMeters), vec3(FOAM_ALBEDO), waves.foam) as unknown as Node<'vec3'>,
      roughness: this.waterRoughness(waves.resolvedMeanSquareSlope, waves.foam),
    }
  }

  /** The water's own colour over a seafloor `depth` metres down: the seafloor's light, dimmed going down and coming back up (Maritorena et al. 1994). */
  protected waterBody(depth: Node<'float'>): Node<'vec3'> {
    // Elevation models fill the sea with sea level where they hold no depth (Terrarium's land data near coasts, in
    // rectangles): no depth there is no seafloor, not a sandbar. Real shallows, half a metre down, still show.
    const knownDepth = smoothstep(0.05, 0.5, depth)
    const seafloorShare = exp(this.diffuseAttenuation.mul(depth).mul(-2)).mul(this.depthWeight).mul(knownDepth)
    return mix(this.albedo, this.seafloorAlbedo, seafloorShare) as unknown as Node<'vec3'>
  }

  /** The terrain shading: built once per terrain shader, read from this plugin's uniforms. */
  protected createShading(): TerrainShadingDefinition {
    return {
      name: this.name,
      shade: inputs => {
        const ground = inputs.color.rgb
        const waves = this.waveSurface.createNodes()
        const onSea = terrainWaterMask.mul(float(1).sub(terrainFlatMorph))
        const body = this.waterBody(max(this.seaLevelMeters.sub(terrainElevationMeters), 0) as unknown as Node<'float'>)
        // Off the sea (and on the flat map) the foam is the whitecap share, as without waves.
        const foam = mix(this.whitecaps, waves.foam, onSea)
        const surface = mix(body, vec3(FOAM_ALBEDO), foam)
        const onGlobe = mix(surface, ground, this.imageryOpacity)
        const onFlatMap = mix(ground, this.flatMapColor, this.flatMapColorWeight)
        const sea = mix(onGlobe, onFlatMap, terrainFlatMorph)
        return {
          color: vec4(mix(ground, sea, terrainWaterMask), inputs.color.a) as unknown as Node<'vec4'>,
          roughness: mix(inputs.roughness, this.waterRoughness(waves.resolvedMeanSquareSlope.mul(onSea), foam as unknown as Node<'float'>), terrainWaterMask) as unknown as Node<'float'>,
          metalness: mix(inputs.metalness, float(0), terrainWaterMask) as unknown as Node<'float'>,
          // Under the wave mesh the terrain's water gives way to it, by the mesh's own map of the ground (so no gap opens
          // between them); land stays.
          mask: inputs.mask.and(this.waveMesh.coverage(waves.plane, 4).lessThan(0.5).or(this.waveMesh.coversWater(waves.plane).not())) as unknown as Node<'bool'>,
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
  const waveSeed = settings.waveSeed ?? 1

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
  if (!Number.isSafeInteger(waveSeed)) throw new Error(`Water: waveSeed must be an integer (the same seed draws the same sea), got ${waveSeed}.`)
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
    crestTransmittance: fixedColor === null ? optics.crestTransmittance : [0, 0, 0],
    imageryOpacity,
    depthFromElevation: settings.depthFromElevation ?? false,
    waveSeed,
    waveMesh: settings.waveMesh ?? true,
  }
}

/** How strongly sunlight glows through a crest standing between the camera and the sun (Atlas's k1, tuned on the scene's units). */
const SCATTER_THROUGH_CRESTS = 0.6
/** How much scattered light every face turned to the camera sends (Atlas's k2). */
const SCATTER_TOWARDS_CAMERA = 0.3
/** Water's reflectance looking straight down: ((n - 1) / (n + 1))². */
const WATER_REFLECTANCE_STRAIGHT_ON = ((WATER_INDEX_OF_REFRACTION - 1) / (WATER_INDEX_OF_REFRACTION + 1)) ** 2
/** The glitter's smallest cells, metres. */
const GLITTER_CELL_METERS = 0.01
/** Keeps the cells' indices positive (the plane spans ±20 km), and exact in 32-bit floats. */
const GLITTER_CELL_OFFSET = 4_000_000
/** The share of cells flashing at once. */
const GLITTER_SHARE = 0.08
/** How much brighter than the fine ripples' smooth highlight a flashing cell is, on top of it. */
const GLITTER_GAIN = 2
/** The most a fine ripples' highlight counts for a flash, per unit of sunlight. */
const GLITTER_MAXIMUM_HIGHLIGHT = 16
/** How often a cell draws again whether it flashes. */
const GLITTER_FLASHES_PER_SECOND = 6
const GLITTER_PERIOD_SECONDS = 1000
const scratchPosition = new Vector3()
const scratchIlluminance = { sun: new Vector3(), sky: new Vector3(), skyAvailable: false }
