import {
  Color,
  featureFilter,
  latest,
  normalizePropertyExpression,
  type Feature,
  type FeatureFilter,
  type StylePropertyExpression,
} from '@maplibre/maplibre-gl-style-spec'

/** Style layer types the renderer draws. Others (raster, hillshade, heatmap…) are skipped with a warning. */
export const SUPPORTED_LAYER_TYPES = ['background', 'fill', 'line', 'symbol', 'circle', 'fill-extrusion'] as const
export type SupportedLayerType = (typeof SUPPORTED_LAYER_TYPES)[number]

/** The parts of a style layer read here. */
export interface StyleLayerSpecification {
  id: string
  type: string
  source?: string
  'source-layer'?: string
  minzoom?: number
  maxzoom?: number
  filter?: unknown
  layout?: Record<string, unknown>
  paint?: Record<string, unknown>
}

/** A feature as the style expressions see it. */
export type StyleFeature = Feature

type PropertyKind = 'paint' | 'layout'

interface PropertySpecification {
  type: string
  default?: unknown
}

const specification = latest as unknown as Record<string, Record<string, PropertySpecification> | undefined>

/** RGBA, straight alpha, 0 to 255, sRGB. */
export type Rgba = [number, number, number, number]

/** A style layer with its filter and properties compiled once, evaluated per feature. */
export class CompiledStyleLayer {
  readonly id: string
  readonly type: SupportedLayerType
  readonly source: string | undefined
  readonly sourceLayer: string | undefined
  readonly minimumZoom: number
  readonly maximumZoom: number
  readonly visible: boolean
  /** Index of the group of consecutive layers sharing this layer's source. Set by `compileStyleLayers`. */
  group = 0
  /** Index of the layer in the style. */
  readonly index: number

  protected readonly filter: FeatureFilter
  protected readonly properties = new Map<string, StylePropertyExpression>()
  protected readonly specification: StyleLayerSpecification

  constructor(layer: StyleLayerSpecification, index: number) {
    this.specification = layer
    this.id = layer.id
    this.type = layer.type as SupportedLayerType
    this.index = index
    this.source = layer.source
    this.sourceLayer = layer['source-layer']
    this.minimumZoom = layer.minzoom ?? 0
    this.maximumZoom = layer.maxzoom ?? 24
    this.visible = layer.layout?.visibility !== 'none'
    this.filter = featureFilter(layer.filter as never, layer.id)
  }

  /** Whether the layer draws at this zoom (MapLibre: minzoom inclusive, maxzoom exclusive). */
  isVisibleAtZoom(zoom: number): boolean {
    return this.visible && zoom >= this.minimumZoom && zoom < this.maximumZoom
  }

  accepts(zoom: number, feature: StyleFeature): boolean {
    return this.filter.filter({ zoom }, feature) === true
  }

  /** Evaluates a paint or layout property for a feature (or for no feature, for zoom-only properties). */
  evaluate<T>(kind: PropertyKind, name: string, zoom: number, feature?: StyleFeature): T {
    return this.compile(kind, name).evaluate({ zoom }, feature as never) as T
  }

  /** A colour property multiplied by an opacity, as straight-alpha sRGB bytes. */
  evaluateColor(name: string, zoom: number, feature: StyleFeature | undefined, opacity = 1): Rgba {
    return toRgba(this.evaluate<Color | undefined>('paint', name, zoom, feature), opacity)
  }

  /** Whether the style sets this property (as opposed to relying on the default). */
  has(kind: PropertyKind, name: string): boolean {
    return this.specification[kind]?.[name] !== undefined
  }

  protected compile(kind: PropertyKind, name: string): StylePropertyExpression {
    const key = `${kind}/${name}`
    let property = this.properties.get(key)
    if (property === undefined) {
      const propertySpecification = specification[`${kind}_${this.type}`]?.[name]
      if (propertySpecification === undefined) throw new Error(`Style layer "${this.id}": unknown ${kind} property "${name}".`)
      const value = this.specification[kind]?.[name] ?? propertySpecification.default
      property = normalizePropertyExpression(value as never, name, propertySpecification as never)
      this.properties.set(key, property)
    }
    return property
  }
}

/** Converts a style colour (premultiplied, 0 to 1) to straight-alpha bytes, times an opacity. */
export function toRgba(color: Color | undefined, opacity = 1): Rgba {
  if (color === undefined || color.a <= 0 || opacity <= 0) return [0, 0, 0, 0]
  const { r, g, b, a } = color
  const byte = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 255)
  return [byte(r / a), byte(g / a), byte(b / a), byte(a * opacity)]
}

/**
 * Compiles the style's layers that the renderer supports and numbers the groups of consecutive layers that
 * share a source (the draw order across tiles). Returns the ids of skipped layers too.
 */
export function compileStyleLayers(layers: readonly StyleLayerSpecification[]): { layers: CompiledStyleLayer[]; skipped: string[] } {
  const compiled: CompiledStyleLayer[] = []
  const skipped: string[] = []
  let group = -1
  let groupSource: string | undefined | null = null
  layers.forEach((layer, index) => {
    if (!(SUPPORTED_LAYER_TYPES as readonly string[]).includes(layer.type)) {
      skipped.push(layer.id)
      return
    }
    let compiledLayer: CompiledStyleLayer
    try {
      compiledLayer = new CompiledStyleLayer(layer, index)
    } catch (error) {
      console.warn(`MapStyleSource: skipping layer "${layer.id}": ${(error as Error).message}`)
      skipped.push(layer.id)
      return
    }
    if (compiledLayer.type !== 'background' && compiledLayer.source !== groupSource) {
      group++
      groupSource = compiledLayer.source
    }
    compiledLayer.group = Math.max(group, 0)
    compiled.push(compiledLayer)
  })
  return { layers: compiled, skipped }
}
