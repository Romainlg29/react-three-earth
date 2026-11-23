// Worker side of raster, hillshade and colour relief layers: their paint, evaluated per integer zoom (as the
// background is), for the main thread to draw. Each layer type is a handler in `RASTER_LAYER_TYPES`, not a branch.
import type { Color } from '@maplibre/maplibre-gl-style-spec'

import type { CompiledStyleLayer } from '../worker/styleLayers.js'
import type { RasterLayerSummary, RasterLayerType } from '../worker/types.js'

/** Zooms the paint is evaluated at: 0 to 24, as `backgroundByZoom`. */
const MAXIMUM_ZOOM = 24

/** At most this many illumination directions per hillshade layer (`multidirectional`). */
export const MAXIMUM_HILLSHADE_LIGHTS = 4

/** At most this many stops in a colour relief ramp; longer ramps are resampled. */
export const MAXIMUM_COLOR_RELIEF_STOPS = 256

/** `raster` layer paint at one zoom, already in the shader's terms (MapLibre's `raster` program). */
export interface RasterPaint {
  opacity: number
  /** `raster-hue-rotate` as the weights of a rotation about the grey axis. */
  spinWeights: [number, number, number]
  brightnessMinimum: number
  brightnessMaximum: number
  saturationFactor: number
  contrastFactor: number
  /** `raster-resampling: nearest`. */
  nearest: boolean
}

/** `hillshade-method` values, in the order of the shader's method index. */
export const HILLSHADE_METHODS = ['standard', 'basic', 'combined', 'igor', 'multidirectional'] as const
export type HillshadeMethod = (typeof HILLSHADE_METHODS)[number]

/** `hillshade` layer paint at one zoom. Colours are premultiplied sRGB, 0 to 1, as MapLibre's shader reads them. */
export interface HillshadePaint {
  method: number
  exaggeration: number
  accentColor: [number, number, number, number]
  /** Per light, up to `MAXIMUM_HILLSHADE_LIGHTS`: direction (radians, clockwise from north), altitude (radians), colours. */
  directionsRadians: number[]
  altitudesRadians: number[]
  shadowColors: Array<[number, number, number, number]>
  highlightColors: Array<[number, number, number, number]>
  /**
   * MapLibre steepens slopes below zoom 15 so relief stays visible from afar: slopes are multiplied by this
   * (`2 ^ ((15 − zoom) × factor)`, the factor 0.4, 0.35 or 0.3 by zoom).
   */
  slopeScale: number
  nearest: boolean
}

/** `color-relief` layer paint at one zoom. The ramp does not depend on the zoom; it is shared by every zoom. */
export interface ColorReliefPaint {
  opacity: number
  nearest: boolean
  /** Elevations in meters, increasing, and their colours (premultiplied sRGB, 0 to 1, four per stop). */
  elevations: number[]
  colors: number[]
}

/** How the worker evaluates one raster layer type. */
export interface RasterLayerTypeHandler {
  /** The source type the layer reads. */
  sourceType: 'raster' | 'raster-dem'
  /** The paint at a zoom where the layer is visible; null when it draws nothing there. */
  evaluatePaint(layer: CompiledStyleLayer, zoom: number): object | null
}

/** MapLibre's `raster-hue-rotate` weights: a rotation of the colour about the grey axis. */
export function spinWeights(angleDegrees: number): [number, number, number] {
  const angle = (angleDegrees * Math.PI) / 180
  const sine = Math.sin(angle)
  const cosine = Math.cos(angle)
  return [(2 * cosine + 1) / 3, (-Math.sqrt(3) * sine - cosine + 1) / 3, (Math.sqrt(3) * sine - cosine + 1) / 3]
}

/** MapLibre's `raster-contrast` factor: -1 to 1 into a slope around mid-grey. */
export function contrastFactor(contrast: number): number {
  return contrast > 0 ? 1 / (1 - contrast) : 1 + contrast
}

/** MapLibre's `raster-saturation` factor: -1 to 1 into a pull towards (or push away from) the pixel's grey. */
export function saturationFactor(saturation: number): number {
  return saturation > 0 ? 1 - 1 / (1.001 - saturation) : -saturation
}

/** MapLibre's low-zoom hillshade boost: slopes are multiplied by this at zoom `zoom`. */
export function hillshadeSlopeScale(zoom: number): number {
  const factor = zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3
  return zoom < 15 ? 2 ** ((15 - zoom) * factor) : 1
}

function premultiplied(color: Color | undefined): [number, number, number, number] {
  return color === undefined ? [0, 0, 0, 0] : [color.r, color.g, color.b, color.a]
}

/** The value at `index`, or the last one when the list is shorter (MapLibre pads shorter illumination lists). */
function padded<T>(values: readonly T[], index: number, fallback: T): T {
  return values[Math.min(index, values.length - 1)] ?? fallback
}

const raster: RasterLayerTypeHandler = {
  sourceType: 'raster',
  evaluatePaint(layer, zoom): RasterPaint | null {
    const opacity = layer.evaluate<number>('paint', 'raster-opacity', zoom)
    if (opacity <= 0) return null
    const resampling = layer.has('paint', 'raster-resampling') ? 'raster-resampling' : 'resampling'
    return {
      opacity,
      spinWeights: spinWeights(layer.evaluate<number>('paint', 'raster-hue-rotate', zoom)),
      brightnessMinimum: layer.evaluate<number>('paint', 'raster-brightness-min', zoom),
      brightnessMaximum: layer.evaluate<number>('paint', 'raster-brightness-max', zoom),
      saturationFactor: saturationFactor(layer.evaluate<number>('paint', 'raster-saturation', zoom)),
      contrastFactor: contrastFactor(layer.evaluate<number>('paint', 'raster-contrast', zoom)),
      nearest: layer.evaluate<string>('paint', resampling, zoom) === 'nearest',
    }
  },
}

const hillshade: RasterLayerTypeHandler = {
  sourceType: 'raster-dem',
  evaluatePaint(layer, zoom): HillshadePaint | null {
    const exaggeration = layer.evaluate<number>('paint', 'hillshade-exaggeration', zoom)
    const directions = layer.evaluate<{ values: number[] }>('paint', 'hillshade-illumination-direction', zoom).values
    const altitudes = layer.evaluate<{ values: number[] }>('paint', 'hillshade-illumination-altitude', zoom).values
    const shadows = layer.evaluate<{ values: Color[] }>('paint', 'hillshade-shadow-color', zoom).values
    const highlights = layer.evaluate<{ values: Color[] }>('paint', 'hillshade-highlight-color', zoom).values
    const method = HILLSHADE_METHODS.indexOf(layer.evaluate<HillshadeMethod>('paint', 'hillshade-method', zoom))
    // Only `multidirectional` reads more than the first light.
    const count = method === HILLSHADE_METHODS.indexOf('multidirectional') ? Math.min(Math.max(directions.length, altitudes.length, shadows.length, highlights.length, 1), MAXIMUM_HILLSHADE_LIGHTS) : 1
    const lights = Array.from({ length: count }, (_, index) => index)
    return {
      method: Math.max(method, 0),
      exaggeration,
      accentColor: premultiplied(layer.evaluate<Color>('paint', 'hillshade-accent-color', zoom)),
      directionsRadians: lights.map(index => (padded(directions, index, 335) * Math.PI) / 180),
      altitudesRadians: lights.map(index => (padded(altitudes, index, 45) * Math.PI) / 180),
      shadowColors: lights.map(index => premultiplied(padded(shadows, index, undefined as Color | undefined))),
      highlightColors: lights.map(index => premultiplied(padded(highlights, index, undefined as Color | undefined))),
      slopeScale: hillshadeSlopeScale(zoom),
      nearest: layer.evaluate<string>('paint', 'resampling', zoom) === 'nearest',
    }
  },
}

const colorRelief: RasterLayerTypeHandler = {
  sourceType: 'raster-dem',
  evaluatePaint(layer, zoom): ColorReliefPaint | null {
    const opacity = layer.evaluate<number>('paint', 'color-relief-opacity', zoom)
    if (opacity <= 0 || !layer.has('paint', 'color-relief-color')) return null
    const ramp = colorReliefRamp(layer)
    if (ramp.elevations.length === 0) return null
    return { opacity, nearest: layer.evaluate<string>('paint', 'resampling', zoom) === 'nearest', ...ramp }
  },
}

/** The worker's raster layer types, by style layer type. */
export const RASTER_LAYER_TYPES: ReadonlyMap<RasterLayerType, RasterLayerTypeHandler> = new Map<RasterLayerType, RasterLayerTypeHandler>([
  ['raster', raster],
  ['hillshade', hillshade],
  ['color-relief', colorRelief],
])

/** Whether a style layer type is drawn from raster tiles. */
export function isRasterLayerType(type: string): type is RasterLayerType {
  return RASTER_LAYER_TYPES.has(type as RasterLayerType)
}

/** The source type a layer type needs: `raster` or `raster-dem` for raster layers, `vector` for the others. */
export function requiredSourceType(layerType: string): 'vector' | 'raster' | 'raster-dem' {
  return RASTER_LAYER_TYPES.get(layerType as RasterLayerType)?.sourceType ?? 'vector'
}

/** Ramps already built, by layer: a layer is replaced (never mutated) when its paint changes. */
const ramps = new WeakMap<CompiledStyleLayer, { elevations: number[]; colors: number[] }>()

/**
 * The stops of `color-relief-color` (an `interpolate` or `step` over `['elevation']`, or a constant), evaluated
 * at each stop's elevation as MapLibre does, so the shader interpolates linearly between them. A `step` becomes
 * pairs of stops a centimetre apart. More than `MAXIMUM_COLOR_RELIEF_STOPS` stops are resampled evenly (a step
 * ramp then blends, with a warning).
 */
export function colorReliefRamp(layer: CompiledStyleLayer): { elevations: number[]; colors: number[] } {
  const cached = ramps.get(layer)
  if (cached !== undefined) return cached
  const evaluate = (elevation: number) => premultiplied(layer.evaluateWithGlobals<Color | undefined>('paint', 'color-relief-color', { zoom: 0, elevation }))
  const expression = layer.expressionOf('paint', 'color-relief-color') as { labels?: number[]; interpolation?: unknown } | undefined
  // Only `Interpolate` has an `interpolation` (class names do not survive an app's minifier).
  const stepped = expression?.labels !== undefined && !('interpolation' in expression)
  let elevations: number[]
  if (stepped) {
    // A step holds its output up to the next label: two stops at each label, the lower one just below it.
    const labels = expression!.labels!.filter(Number.isFinite)
    elevations = labels.length === 0 ? [0] : [labels[0]! - 0.01, ...labels.flatMap((label, index) => (index === labels.length - 1 ? [label] : [label, labels[index + 1]! - 0.01]))]
  } else if (expression?.labels !== undefined) {
    elevations = [...expression.labels]
  } else {
    elevations = [0] // a constant colour
  }
  if (elevations.length > MAXIMUM_COLOR_RELIEF_STOPS) {
    // Even resampling: a long step ramp loses its sharp edges (drawn as steep gradients).
    if (stepped) console.warn(`MapStyleSource: layer "${layer.id}" has a step ramp of more than ${MAXIMUM_COLOR_RELIEF_STOPS / 2} stops; it is resampled and its bands blend. Use fewer stops.`)
    const first = elevations[0]!
    const last = elevations.at(-1)!
    elevations = Array.from({ length: MAXIMUM_COLOR_RELIEF_STOPS }, (_, index) => first + ((last - first) * index) / (MAXIMUM_COLOR_RELIEF_STOPS - 1))
  }
  const ramp = { elevations, colors: elevations.flatMap(evaluate) }
  ramps.set(layer, ramp)
  return ramp
}

/** The raster layers the style draws, in style order, each with its paint per zoom. */
export function summarizeRasterLayers(layers: readonly CompiledStyleLayer[], sources: Record<string, { type?: string } | undefined>): RasterLayerSummary[] {
  const summaries: RasterLayerSummary[] = []
  for (const layer of layers) {
    if (!isRasterLayerType(layer.type) || layer.source === undefined) continue
    const handler = RASTER_LAYER_TYPES.get(layer.type)!
    if (sources[layer.source]?.type !== handler.sourceType) continue
    const paintByZoom = Array.from({ length: MAXIMUM_ZOOM + 1 }, (_, zoom) => {
      if (!layer.isVisibleAtZoom(zoom)) return null
      try {
        return handler.evaluatePaint(layer, zoom) as Record<string, unknown> | null
      } catch (error) {
        console.warn(`MapStyleSource: layer "${layer.id}" could not be evaluated at zoom ${zoom} and is not drawn there. ${(error as Error).message}`)
        return null
      }
    })
    summaries.push({ id: layer.id, type: layer.type, source: layer.source, group: layer.group, paintByZoom })
  }
  return summaries
}
