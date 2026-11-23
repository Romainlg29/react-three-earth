import type { Node, NodeMaterial } from 'three/webgpu'

/** The value type of a custom style layer property. */
export type StyleLayerPropertyType = 'color' | 'number' | 'enum' | 'boolean'

/** A built-in tessellator input a material-tier property can feed. */
export type StyleLayerGeometryInput = 'line-width' | 'line-offset' | 'line-cap' | 'line-join' | 'circle-radius'

/**
 * One paint or layout property of a custom style layer type, checked and evaluated like the style
 * specification's own: MapLibre expressions, `zoom`, `feature-state` (paint) and `global-state` all work.
 */
export interface StyleLayerPropertyDefinition {
  type: StyleLayerPropertyType
  /** Used when the style does not set the property. Colours as CSS strings. */
  default: string | number | boolean
  /** Whether the value may depend on the feature (`['get', …]`, `feature-state`), not only on the zoom. Default: true. */
  dataDriven?: boolean
  /** The allowed values of an `enum` property; `paint.enumIndex(name)` is the index in this list. */
  values?: readonly string[]
  minimum?: number
  maximum?: number
  /**
   * Material tier only: the built-in tessellator reads this property as its input, so a plugin's
   * `'my-line-width'` makes lines that wide without plugin code. Widths, offsets and radii are in pixels.
   */
  geometryInput?: StyleLayerGeometryInput
}

/** The built-in tessellation a material-tier layer type reuses. */
export type StyleLayerGeometry = 'fill' | 'line' | 'circle'

/**
 * A plugin's worker module (geometry tier): an ES module bundled on its own, with no bare imports, loaded
 * into the vector tile worker with `import()`. `exportName` names its `WorkerLayerTypeFactory`.
 */
export interface StyleLayerWorkerModule {
  moduleUrl: URL | string
  exportName: string
}

/**
 * Draws the layer into its own target first, then composites that target into the map at the layer's place.
 * For layers that cannot blend straight into the map: `maximum` keeps the strongest value where features
 * overlap (glows), `additive` sums them (densities, heatmaps).
 */
export interface StyleLayerOffscreen {
  blending: 'maximum' | 'additive'
  /**
   * The colour drawn into the map from the layer target's texel (`layer`: linear, premultiplied, blended),
   * straight alpha. Default: `vec4(layer.rgb / layer.a, layer.a)`.
   */
  composite?: (inputs: { layer: Node<'vec4'> }) => Node<'vec4'>
}

/** The layer's paint properties as shader values, per vertex (data-driven values are evaluated per feature). */
export interface StyleLayerPaintNodes {
  /** A colour property: linear RGB, straight alpha. */
  color(name: string): Node<'vec4'>
  number(name: string): Node<'float'>
  /** An `enum` property's index in its `values`; a `boolean` property as 0 or 1. */
  enumIndex(name: string): Node<'float'>
}

/** Values of the tile being drawn. */
export interface StyleLayerTileNodes {
  /** Map pixels per tile unit at the drawn region's zoom: multiply tile-unit distances by it to get pixels. */
  pixelsPerTileUnit: Node<'float'>
  /** The zoom the region is drawn at. */
  zoom: Node<'float'>
  /** The vertex or fragment position in tile units (0 to 4096, y down). */
  position: Node<'vec2'>
}

export interface StyleLayerMaterialInputs {
  paint: StyleLayerPaintNodes
  tile: StyleLayerTileNodes
}

/**
 * A custom style layer type. A style layer with `"type": "<type>"` is drawn by it, at its place in the style,
 * with its `filter`, zoom range and properties evaluated by the library.
 *
 * Two tiers: the **material tier** (`geometry`) reuses the built-in fill, line or circle tessellation and only
 * brings a shader; the **geometry tier** (`worker`) brings its own tessellation in a worker module.
 */
export interface StyleLayerTypeDefinition {
  /** The `type` style layers use. Must not be a MapLibre type. */
  type: string
  paint?: Readonly<Record<string, StyleLayerPropertyDefinition>>
  layout?: Readonly<Record<string, StyleLayerPropertyDefinition>>
  /** Material tier: the built-in tessellation to reuse. */
  geometry?: StyleLayerGeometry
  /** Geometry tier: the worker module that tessellates the layer's features. */
  worker?: StyleLayerWorkerModule
  /**
   * How far the layer draws past its features, in pixels (a glow's radius). Neighbouring tiles within
   * this distance are drawn too, and the layer is not clipped to its tile, so a feature in the buffer two
   * tiles share is drawn by both: use `offscreen: { blending: 'maximum' }`, or (geometry tier) emit only the
   * features `host.isInsideTile` owns. The material tier needs `'maximum'`. At most 512. Default: 0.
   */
  maximumReachPixels?: number
  offscreen?: StyleLayerOffscreen
  /**
   * The layer's material, built once per type per map source. The library sets blending, depth and
   * sides, and clips it to its tile when it has no reach. Set `colorNode` (straight alpha, also for offscreen
   * layers: the library premultiplies what goes into the layer target).
   */
  createMaterial(inputs: StyleLayerMaterialInputs): NodeMaterial
}

/** Layer types MapLibre defines: a plugin cannot take them over. */
const MAPLIBRE_LAYER_TYPES = new Set(['background', 'fill', 'line', 'symbol', 'circle', 'fill-extrusion', 'raster', 'hillshade', 'heatmap', 'color-relief'])

/** At most this many paint properties per material-tier type: each is a vertex buffer (WebGPU allows 8). */
export const MAXIMUM_MATERIAL_PAINT_PROPERTIES = 6

/** Checks a definition, throwing an error that states the fix. */
export function validateStyleLayerType(definition: StyleLayerTypeDefinition): void {
  const { type } = definition
  if (typeof type !== 'string' || type.length === 0) throw new Error('registerStyleLayerType: give the layer type a non-empty `type`.')
  if (MAPLIBRE_LAYER_TYPES.has(type)) throw new Error(`registerStyleLayerType: "${type}" is a MapLibre layer type; pick another name, such as "my-${type}".`)
  if ((definition.geometry === undefined) === (definition.worker === undefined)) {
    throw new Error(`registerStyleLayerType("${type}"): set exactly one of \`geometry\` (reuse a built-in tessellation) or \`worker\` (your own worker module).`)
  }
  if (typeof definition.createMaterial !== 'function') throw new Error(`registerStyleLayerType("${type}"): \`createMaterial\` must be a function returning a node material.`)
  const reach = definition.maximumReachPixels ?? 0
  if (!(reach >= 0 && reach <= 512)) throw new Error(`registerStyleLayerType("${type}"): \`maximumReachPixels\` must be between 0 and 512 (one tile), not ${reach}.`)
  if (reach > 0 && definition.geometry !== undefined && definition.offscreen?.blending !== 'maximum') {
    throw new Error(`registerStyleLayerType("${type}"): a material-tier type with \`maximumReachPixels\` needs \`offscreen: { blending: 'maximum' }\`, or the features two tiles share are drawn twice.`)
  }
  for (const kind of ['paint', 'layout'] as const) {
    for (const [name, property] of Object.entries(definition[kind] ?? {})) {
      if (!['color', 'number', 'enum', 'boolean'].includes(property.type)) throw new Error(`registerStyleLayerType("${type}"): ${kind} property "${name}" needs a type: 'color', 'number', 'enum' or 'boolean'.`)
      if (property.type === 'enum' && !(property.values?.length)) throw new Error(`registerStyleLayerType("${type}"): enum property "${name}" needs its \`values\`.`)
      if (property.geometryInput !== undefined && definition.geometry === undefined) {
        throw new Error(`registerStyleLayerType("${type}"): "${name}" sets \`geometryInput\`, which only material-tier types (\`geometry\`) read.`)
      }
    }
  }
  if (definition.geometry !== undefined && Object.keys(definition.paint ?? {}).length > MAXIMUM_MATERIAL_PAINT_PROPERTIES) {
    throw new Error(`registerStyleLayerType("${type}"): at most ${MAXIMUM_MATERIAL_PAINT_PROPERTIES} paint properties in the material tier; use a worker module for more.`)
  }
}

/** The shader attribute name of a paint property: its index, since property names are not identifiers. */
export function paintAttributeName(definition: Pick<StyleLayerTypeDefinition, 'paint'>, name: string): string {
  const index = Object.keys(definition.paint ?? {}).indexOf(name)
  if (index === -1) throw new Error(`Style layer type: there is no paint property "${name}"; declare it in \`paint\`.`)
  return `paint${index}`
}

/** What the vector tile worker needs of a layer type: plain data, posted to it. */
export interface WorkerLayerTypeDescriptor {
  type: string
  paint: Record<string, StyleLayerPropertyDefinition>
  layout: Record<string, StyleLayerPropertyDefinition>
  geometry: StyleLayerGeometry | null
  /** An absolute URL (a `URL` cannot be posted, and a relative one would resolve against the worker's). */
  module: { href: string; exportName: string } | null
  maximumReachPixels: number
  /** Changes when the definition is registered again, so the worker calls the module's factory again (`import()` caches the module by URL). */
  revision: number
}

/** Listener of a registry: called after a type was registered or removed. */
export type StyleLayerTypeListener = () => void

/**
 * The custom style layer types installed on one `Earth` (`earth.styleLayerTypes`). Plugins register through
 * `context.registerStyleLayerType`; map style sources read it and draw the layers of these types.
 */
export class StyleLayerTypeRegistry {
  protected readonly definitions = new Map<string, { definition: StyleLayerTypeDefinition; revision: number }>()
  protected readonly listeners = new Set<StyleLayerTypeListener>()
  protected revision = 0

  /** Adds a type. Returns a function that removes it. Throws when the type is taken, stating the fix. */
  register(definition: StyleLayerTypeDefinition): () => void {
    validateStyleLayerType(definition)
    if (this.definitions.has(definition.type)) {
      throw new Error(`registerStyleLayerType: the layer type "${definition.type}" is already registered by another plugin; remove that plugin first.`)
    }
    const entry = { definition, revision: ++this.revision }
    this.definitions.set(definition.type, entry)
    this.notify()
    return () => {
      if (this.definitions.get(definition.type) !== entry) return
      this.definitions.delete(definition.type)
      this.notify()
    }
  }

  get(type: string): StyleLayerTypeDefinition | undefined {
    return this.definitions.get(type)?.definition
  }

  has(type: string): boolean {
    return this.definitions.has(type)
  }

  get size(): number {
    return this.definitions.size
  }

  values(): IterableIterator<StyleLayerTypeDefinition> {
    return [...this.definitions.values()].map(entry => entry.definition)[Symbol.iterator]()
  }

  /** Calls `listener` after each change. Returns a function that removes it. */
  subscribe(listener: StyleLayerTypeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The types as the worker receives them. `baseHref` resolves relative module URLs (default: the page). */
  describe(baseHref = typeof location === 'undefined' ? undefined : location.href): WorkerLayerTypeDescriptor[] {
    return [...this.definitions.values()].map(({ definition, revision }) => ({
      type: definition.type,
      paint: { ...definition.paint },
      layout: { ...definition.layout },
      geometry: definition.geometry ?? null,
      module: definition.worker === undefined ? null : { href: new URL(String(definition.worker.moduleUrl), baseHref).href, exportName: definition.worker.exportName },
      maximumReachPixels: definition.maximumReachPixels ?? 0,
      revision,
    }))
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('StyleLayerTypeRegistry: a listener threw.', error)
      }
    }
  }
}
