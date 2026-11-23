import {
  Color,
  createVisibilityExpression,
  featureFilter,
  latest,
  normalizePropertyExpression,
  type Feature,
  type FeatureFilter,
  type FeatureState,
  type StylePropertyExpression,
  type VisibilityExpression,
} from '@maplibre/maplibre-gl-style-spec'

/** Style layer types the renderer draws. Others (heatmap) are skipped with a warning. */
export const SUPPORTED_LAYER_TYPES = ['background', 'fill', 'line', 'symbol', 'circle', 'fill-extrusion', 'raster', 'hillshade', 'color-relief'] as const

/** Layer types drawn from raster tiles, each with a draw group of its own (`assignLayerOrder`). */
const RASTER_LAYER_TYPES = new Set(['raster', 'hillshade', 'color-relief'])
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

/** The property specifications of a custom layer type (a plugin's), in the style specification's format. */
export interface CustomLayerSpecifications {
  paint: Record<string, PropertySpecification>
  layout: Record<string, PropertySpecification>
}

/** RGBA, straight alpha, 0 to 255, sRGB. */
export type Rgba = [number, number, number, number]

/**
 * Paint properties whose feature-state dependence a colour slot absorbs: a state change only redraws. Any other
 * state-dependent paint property (a width, a radius, text paint) changes geometry, so the tile is processed again.
 */
const SLOT_PAINT_PROPERTIES = new Set([
  'fill-color',
  'fill-opacity',
  'fill-outline-color',
  'line-color',
  'line-opacity',
  'circle-color',
  'circle-opacity',
  'circle-stroke-color',
  'circle-stroke-opacity',
  'fill-extrusion-color',
  'fill-extrusion-opacity',
])

/** How a layer's drawing depends on feature-state. */
export type FeatureStateDependence = 'none' | 'colors' | 'geometry'

/** A style layer with its filter and properties compiled once, evaluated per feature. */
export class CompiledStyleLayer {
  readonly id: string
  /** A MapLibre type, or a plugin's custom type (`custom` is set then). */
  readonly type: SupportedLayerType | (string & {})
  /** The specifications of a custom layer type (plugins); null for MapLibre types. */
  readonly custom: CustomLayerSpecifications | null
  readonly source: string | undefined
  readonly sourceLayer: string | undefined
  readonly minimumZoom: number
  readonly maximumZoom: number
  /** Index of the group of consecutive layers sharing this layer's source. Set by `assignLayerOrder`. */
  group = 0
  /** Index of the layer in the style. Set by `assignLayerOrder`. */
  index: number
  /** How drawing depends on feature-state: not at all, through colour slots only, or through geometry. */
  readonly featureStateDependence: FeatureStateDependence
  /** Names of `global-state` values the filter, visibility or properties read; `null` when unknown (any). */
  readonly globalStateReferences: ReadonlySet<string> | null

  protected readonly filter: FeatureFilter
  protected readonly visibility: VisibilityExpression
  protected readonly properties = new Map<string, StylePropertyExpression>()
  protected readonly specification: StyleLayerSpecification
  protected readonly globalState: Record<string, unknown>

  /** `globalState` is read live: change its values, then process the tiles of layers that reference them. */
  constructor(layer: StyleLayerSpecification, index: number, globalState: Record<string, unknown> = {}, custom: CustomLayerSpecifications | null = null) {
    this.custom = custom
    this.specification = layer
    this.globalState = globalState
    this.id = layer.id
    this.type = layer.type
    this.index = index
    this.source = layer.source
    this.sourceLayer = layer['source-layer']
    this.minimumZoom = layer.minzoom ?? 0
    this.maximumZoom = layer.maxzoom ?? 24
    this.visibility = createVisibilityExpression((layer.layout?.visibility ?? 'visible') as never, `layers.${layer.id}.layout.visibility`, globalState)
    this.filter = featureFilter(layer.filter as never, layer.id, globalState)
    // Compile every property now, so a bad expression skips the layer (with a warning) instead of failing tiles.
    const references = new Set(this.filter.getGlobalStateRefs())
    let unknownReferences = Array.isArray(layer.layout?.visibility)
    let dependence: FeatureStateDependence = 'none'
    for (const kind of ['paint', 'layout'] as const) {
      for (const name of Object.keys(this.propertySpecifications(kind))) {
        const property = this.compile(kind, name) as StylePropertyExpression & { isStateDependent?: boolean; globalStateRefs?: Set<string> }
        if (property.globalStateRefs === undefined) unknownReferences ||= this.has(kind, name)
        else for (const reference of property.globalStateRefs) references.add(reference)
        if (kind === 'paint' && property.isStateDependent === true) {
          if (!SLOT_PAINT_PROPERTIES.has(name) || this.type === 'symbol') dependence = 'geometry'
          else if (dependence === 'none') dependence = 'colors'
        }
      }
    }
    this.featureStateDependence = dependence
    this.globalStateReferences = unknownReferences ? null : references
  }

  /** Whether the layer draws at this zoom (MapLibre: minzoom inclusive, maxzoom exclusive). */
  isVisibleAtZoom(zoom: number): boolean {
    return zoom >= this.minimumZoom && zoom < this.maximumZoom && this.visibility.evaluate() !== 'none'
  }

  /** Whether the layer reads any of these `global-state` names. */
  readsGlobalState(names: Iterable<string>): boolean {
    if (this.globalStateReferences === null) return true
    for (const name of names) if (this.globalStateReferences.has(name)) return true
    return false
  }

  accepts(zoom: number, feature: StyleFeature): boolean {
    return this.filter.filter({ zoom }, feature) === true
  }

  /** Evaluates a paint or layout property for a feature (or for no feature, for zoom-only properties). */
  evaluate<T>(kind: PropertyKind, name: string, zoom: number, feature?: StyleFeature, featureState?: FeatureState): T {
    return this.compile(kind, name).evaluate({ zoom }, feature as never, featureState) as T
  }

  /**
   * Evaluates a property with more globals than the zoom: `elevation` for `color-relief-color`. Feature-less, so
   * only for properties that do not read feature data.
   */
  evaluateWithGlobals<T>(kind: PropertyKind, name: string, globals: { zoom: number; elevation?: number }): T {
    return this.compile(kind, name).evaluate(globals as never, undefined as never) as T
  }

  /**
   * The compiled expression's root (the style specification's `Interpolate`, `Step`…), or undefined for a
   * constant. Internal API of the style specification, read to list a colour ramp's stops.
   */
  expressionOf(kind: PropertyKind, name: string): unknown {
    return (this.compile(kind, name) as { _styleExpression?: { expression?: unknown } })._styleExpression?.expression
  }

  /** A colour property multiplied by an opacity, as straight-alpha sRGB bytes. */
  evaluateColor(name: string, zoom: number, feature: StyleFeature | undefined, opacity = 1, featureState?: FeatureState): Rgba {
    return toRgba(this.evaluate<Color | undefined>('paint', name, zoom, feature, featureState), opacity)
  }

  /** `line-gradient` at a line progress (0 at the line's start, 1 at its end), times an opacity. */
  evaluateLineGradient(zoom: number, progress: number, opacity = 1): Rgba {
    return toRgba(this.compile('paint', 'line-gradient').evaluate({ zoom, lineProgress: progress } as never) as Color | undefined, opacity)
  }

  /** The layer as written in the style. */
  get layerSpecification(): StyleLayerSpecification {
    return this.specification
  }

  /** The property's value as written in the style, before compilation. */
  raw(kind: PropertyKind, name: string): unknown {
    return this.specification[kind]?.[name]
  }

  /** Whether the style sets this property (as opposed to relying on the default). */
  has(kind: PropertyKind, name: string): boolean {
    return this.specification[kind]?.[name] !== undefined
  }

  protected propertySpecifications(kind: PropertyKind): Record<string, PropertySpecification> {
    return (this.custom === null ? specification[`${kind}_${this.type}`] : this.custom[kind]) ?? {}
  }

  protected compile(kind: PropertyKind, name: string): StylePropertyExpression {
    const key = `${kind}/${name}`
    let property = this.properties.get(key)
    if (property === undefined) {
      const propertySpecification = this.propertySpecifications(kind)[name]
      if (propertySpecification === undefined) throw new Error(`Style layer "${this.id}": unknown ${kind} property "${name}".`)
      const value = this.specification[kind]?.[name] ?? propertySpecification.default
      property = normalizePropertyExpression(value as never, name, propertySpecification as never, this.globalState)
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
export function compileStyleLayers(
  layers: readonly StyleLayerSpecification[],
  globalState: Record<string, unknown> = {},
): { layers: CompiledStyleLayer[]; skipped: string[] } {
  const compiled: CompiledStyleLayer[] = []
  const skipped: string[] = []
  layers.forEach((layer, index) => {
    const compiledLayer = compileStyleLayer(layer, index, globalState)
    if (compiledLayer === null) skipped.push(layer.id)
    else compiled.push(compiledLayer)
  })
  assignLayerOrder(compiled, layers)
  return { layers: compiled, skipped }
}

/** Compiles one layer; null (with a warning) when its type is not drawn yet or an expression does not compile. */
export function compileStyleLayer(
  layer: StyleLayerSpecification,
  index: number,
  globalState: Record<string, unknown>,
  onError?: (message: string) => void,
  customTypes?: ReadonlyMap<string, CustomLayerSpecifications>,
): CompiledStyleLayer | null {
  const custom = customTypes?.get(layer.type) ?? null
  if (custom === null && !(SUPPORTED_LAYER_TYPES as readonly string[]).includes(layer.type)) return null
  try {
    return new CompiledStyleLayer(layer, index, globalState, custom)
  } catch (error) {
    const message = `MapStyleSource: skipping layer "${layer.id}": ${(error as Error).message}`
    console.warn(message)
    onError?.(message)
    return null
  }
}

/**
 * Sets each compiled layer's `index` (its position among the style's `layers`) and `group` (consecutive layers
 * sharing a source), after layers were added, removed or moved.
 */
export function assignLayerOrder(compiled: readonly CompiledStyleLayer[], layers: readonly StyleLayerSpecification[]): void {
  const positions = new Map(layers.map((layer, index) => [layer.id, index]))
  let group = -1
  let groupSource: string | undefined | null = null
  let previousCustom = false
  for (const layer of [...compiled].sort((a, b) => positions.get(a.id)! - positions.get(b.id)!)) {
    layer.index = positions.get(layer.id)!
    // A custom layer (plugin) or a raster layer draws with its own material: it gets a group of its own, and
    // ends the one before.
    const custom = layer.custom !== null || RASTER_LAYER_TYPES.has(layer.type)
    if (layer.type !== 'background' && (layer.source !== groupSource || custom || previousCustom)) {
      group++
      groupSource = layer.source
    }
    if (layer.type !== 'background') previousCustom = custom
    layer.group = Math.max(group, 0)
  }
}
