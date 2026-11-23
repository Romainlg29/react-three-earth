// Custom style layer types (plugins) on the worker side: their property specifications, their worker modules,
// and the per-tile builders that turn a custom layer's features into a mesh.
import { classifyRings } from '@maplibre/maplibre-gl-style-spec'
import earcut from 'earcut'

import type {
  WorkerFeature,
  WorkerLayerType,
  WorkerLayerTypeFactory,
  WorkerLayerTypeHost,
  WorkerPoint,
  WorkerStyleLayer,
  WorkerTileBuilder,
} from '../../plugins/pluginWorker.js'
import type { StyleLayerPropertyDefinition, WorkerLayerTypeDescriptor } from '../../plugins/styleLayerTypes.js'
import { createHeatmapWorkerLayerType, HEATMAP_DESCRIPTOR, HEATMAP_SPECIFICATIONS } from '../heatmap/heatmapWorker.js'
import { ShapeBuilder, type LineCap, type LineJoin, type Point } from './ShapeBuilder.js'
import type { CompiledStyleLayer, StyleFeature } from './styleLayers.js'
import { TILE_EXTENT, type CustomLayerAttribute, type CustomLayerMesh, type FeatureState } from './types.js'

/** A property specification in the style specification's own format, as `normalizePropertyExpression` reads it. */
export interface PropertySpecification {
  type: string
  default?: unknown
  values?: Record<string, object>
  minimum?: number
  maximum?: number
  'property-type'?: string
  expression?: { interpolated: boolean; parameters: string[] }
  transition?: boolean
}

/** A custom layer type, loaded: its specifications and, for the geometry tier, its worker module. */
export interface LoadedLayerType {
  readonly descriptor: WorkerLayerTypeDescriptor
  readonly paint: Record<string, PropertySpecification>
  readonly layout: Record<string, PropertySpecification>
  /** The module's layer type (geometry tier), null for the material tier. */
  readonly module: WorkerLayerType | null
}

function toSpecification(property: StyleLayerPropertyDefinition, kind: 'paint' | 'layout'): PropertySpecification {
  const dataDriven = property.dataDriven ?? true
  const parameters = dataDriven ? (kind === 'paint' ? ['zoom', 'feature', 'feature-state'] : ['zoom', 'feature']) : ['zoom']
  return {
    type: property.type,
    default: property.default,
    ...(property.values !== undefined ? { values: Object.fromEntries(property.values.map(value => [value, {}])) } : {}),
    ...(property.minimum !== undefined ? { minimum: property.minimum } : {}),
    ...(property.maximum !== undefined ? { maximum: property.maximum } : {}),
    'property-type': dataDriven ? 'data-driven' : 'data-constant',
    expression: { interpolated: property.type === 'color' || property.type === 'number', parameters },
    transition: false,
  }
}

/**
 * MapLibre layer types the library draws through the custom layer path (`heatmap`): always loaded, with the style
 * specification's own properties. Plugins cannot register MapLibre types, so these names never collide.
 */
let builtInLayerTypes: ReadonlyMap<string, LoadedLayerType> | null = null
export function getBuiltInLayerTypes(): ReadonlyMap<string, LoadedLayerType> {
  builtInLayerTypes ??= new Map([
    [HEATMAP_DESCRIPTOR.type, { descriptor: HEATMAP_DESCRIPTOR, ...HEATMAP_SPECIFICATIONS, module: createHeatmapWorkerLayerType(createHost(HEATMAP_DESCRIPTOR)) }],
  ])
  return builtInLayerTypes
}

/** Per type, the revision whose worker module failed to load in this worker. */
const failedRevisions = new Map<string, number>()

/**
 * Loads the layer types, importing each worker module once: a type whose descriptor did not change keeps
 * its module. A module that fails to load skips its type, with a warning naming the URL. The built-in types
 * (`getBuiltInLayerTypes`) come first, always.
 */
export async function loadLayerTypes(descriptors: readonly WorkerLayerTypeDescriptor[], previous: ReadonlyMap<string, LoadedLayerType>): Promise<Map<string, LoadedLayerType>> {
  const builtIns = getBuiltInLayerTypes()
  const loaded = await Promise.all(
    descriptors.filter(descriptor => !builtIns.has(descriptor.type)).map(async (descriptor): Promise<LoadedLayerType | null> => {
      const kept = previous.get(descriptor.type)
      if (kept !== undefined && kept.descriptor.revision === descriptor.revision) return kept
      // A module that failed is retried only when its type is registered again (a new revision).
      if (failedRevisions.get(descriptor.type) === descriptor.revision) return null
      let module: WorkerLayerType | null = null
      if (descriptor.module !== null) {
        const { href, exportName } = descriptor.module
        try {
          const exports = await importWithTimeout(href)
          const factory = exports[exportName]
          if (typeof factory !== 'function') throw new Error(`it has no export "${exportName}" that is a function; export the WorkerLayerTypeFactory under that name.`)
          module = (factory as WorkerLayerTypeFactory)(createHost(descriptor))
          if (typeof module?.createTileBuilder !== 'function') throw new Error(`"${exportName}" must return an object with createTileBuilder(options).`)
        } catch (error) {
          console.warn(`MapStyleSource: the worker module of layer type "${descriptor.type}" (${href}) did not load, its layers are skipped: ${(error as Error).message}`)
          failedRevisions.set(descriptor.type, descriptor.revision)
          return null
        }
      }
      const specifications = (kind: 'paint' | 'layout') => Object.fromEntries(Object.entries(descriptor[kind]).map(([name, property]) => [name, toSpecification(property, kind)]))
      return { descriptor, paint: specifications('paint'), layout: specifications('layout'), module }
    }),
  )
  return new Map([...builtIns, ...loaded.flatMap(type => (type === null ? [] : [[type.descriptor.type, type] as const]))])
}

/** A worker module that takes longer than this is skipped, so it cannot hold up the whole style. */
export const WORKER_MODULE_TIMEOUT_MILLISECONDS = 10_000

async function importWithTimeout(href: string): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it took over ${WORKER_MODULE_TIMEOUT_MILLISECONDS / 1000} s; check the URL and that the server answers. Registering the type again retries.`)), WORKER_MODULE_TIMEOUT_MILLISECONDS)
  })
  try {
    return (await Promise.race([import(/* @vite-ignore */ href), timeout])) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

function createHost(descriptor: WorkerLayerTypeDescriptor): WorkerLayerTypeHost {
  return {
    TILE_EXTENT,
    classifyRings: rings => classifyRings(rings as never, 500) as unknown as WorkerPoint[][][],
    earcut: (vertices, holeIndices, dimensions) => earcut(vertices as number[], holeIndices as number[] | undefined, dimensions),
    clampReach: pixels => Math.min(Math.max(pixels, 0), descriptor.maximumReachPixels),
    isInsideTile: point => point.x >= 0 && point.x < TILE_EXTENT && point.y >= 0 && point.y < TILE_EXTENT,
  }
}

/** Builds one custom layer's mesh for one tile. */
export interface CustomLayerBuilder {
  addFeature(feature: StyleFeature, state: FeatureState, geometry: Point[][]): void
  finish(): CustomLayerMesh | null
}

export interface CustomLayerBuilderOptions {
  zoom: number
  unitsPerPixel: number
  tile: { x: number; y: number; z: number }
}

const warned = new Set<string>()
function warnOnce(key: string, message: string, error?: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message, ...(error === undefined ? [] : [error]))
}

/** The builder of a custom layer, for its tier. */
export function createCustomLayerBuilder(layer: CompiledStyleLayer, type: LoadedLayerType, options: CustomLayerBuilderOptions): CustomLayerBuilder {
  return type.module === null ? new MaterialTierBuilder(layer, type, options) : new GeometryTierBuilder(layer, type, type.module, options)
}

/** Paint values per vertex: colours as 4 normalised bytes, everything else as one float. */
class PaintColumns {
  protected readonly columns: Array<{ name: string; property: StyleLayerPropertyDefinition; values: number[] }>

  constructor(protected readonly layer: CompiledStyleLayer, type: LoadedLayerType) {
    this.columns = Object.entries(type.descriptor.paint).map(([name, property]) => ({ name, property, values: [] }))
  }

  /** Repeats the feature's paint values for `count` new vertices. */
  push(feature: StyleFeature, state: FeatureState, zoom: number, count: number): void {
    for (const { name, property, values } of this.columns) {
      if (property.type === 'color') {
        const [r, g, b, a] = this.layer.evaluateColor(name, zoom, feature, 1, state)
        for (let vertex = 0; vertex < count; vertex++) values.push(r, g, b, a)
        continue
      }
      const value = this.layer.evaluate<unknown>('paint', name, zoom, feature, state)
      const number = property.type === 'enum' ? Math.max(property.values?.indexOf(String(value)) ?? 0, 0) : property.type === 'boolean' ? (value === true ? 1 : 0) : Number(value)
      for (let vertex = 0; vertex < count; vertex++) values.push(number)
    }
  }

  attributes(): CustomLayerAttribute[] {
    return this.columns.map(({ property, values }, index) =>
      property.type === 'color'
        ? { name: `paint${index}`, array: Uint8Array.from(values), itemSize: 4, normalized: true }
        : { name: `paint${index}`, array: Float32Array.from(values), itemSize: 1, normalized: false },
    )
  }
}

/** Reuses the built-in tessellation; the paint properties become vertex attributes. */
class MaterialTierBuilder implements CustomLayerBuilder {
  protected readonly shapes = new ShapeBuilder()
  protected readonly paint: PaintColumns
  protected readonly inputs = new Map<string, string>()

  constructor(
    protected readonly layer: CompiledStyleLayer,
    protected readonly type: LoadedLayerType,
    protected readonly options: CustomLayerBuilderOptions,
  ) {
    this.paint = new PaintColumns(layer, type)
    for (const kind of ['paint', 'layout'] as const) {
      for (const [name, property] of Object.entries(type.descriptor[kind])) if (property.geometryInput !== undefined) this.inputs.set(property.geometryInput, `${kind}\u0000${name}`)
    }
    this.shapes.setColor([255, 255, 255, 255])
  }

  /** A geometry input's value for a feature, or the fallback when no property feeds it. */
  protected input<T>(input: string, fallback: T, feature: StyleFeature, state: FeatureState): T {
    const key = this.inputs.get(input)
    if (key === undefined) return fallback
    const [kind, name] = key.split('\u0000') as ['paint' | 'layout', string]
    return this.layer.evaluate<T>(kind, name, this.options.zoom, feature, state) ?? fallback
  }

  addFeature(feature: StyleFeature, state: FeatureState, geometry: Point[][]): void {
    const { zoom, unitsPerPixel } = this.options
    const before = this.shapes.vertexCount
    const geometryKind = this.type.descriptor.geometry
    if (geometryKind === 'fill') {
      if (feature.type !== 3) return
      this.shapes.addPolygons(classifyRings(geometry as never, 500) as unknown as Point[][][])
    } else if (geometryKind === 'line') {
      if (feature.type !== 2 && feature.type !== 3) return
      const widthPixels = this.input<number>('line-width', 1, feature, state)
      if (!(widthPixels > 0)) return
      const style = {
        width: widthPixels * unitsPerPixel,
        offset: this.input<number>('line-offset', 0, feature, state) * unitsPerPixel,
        cap: this.input<LineCap>('line-cap', 'butt', feature, state),
        join: this.input<LineJoin>('line-join', 'miter', feature, state),
      }
      for (const line of geometry) this.shapes.addLine(line, style)
    } else {
      if (feature.type !== 1) return
      const radius = this.input<number>('circle-radius', 5, feature, state) * unitsPerPixel
      if (!(radius > 0)) return
      for (const ring of geometry) for (const point of ring) this.shapes.addCircle(point, radius)
    }
    const added = this.shapes.vertexCount - before
    if (added > 0) this.paint.push(feature, state, zoom, added)
  }

  finish(): CustomLayerMesh | null {
    const mesh = this.shapes.build()
    if (mesh === null || mesh.indices.length === 0) return null
    return {
      layerId: this.layer.id,
      layerType: this.layer.type,
      group: this.layer.group,
      attributes: [{ name: 'position', array: mesh.positions, itemSize: 2, normalized: false }, ...this.paint.attributes()],
      indices: mesh.indices,
    }
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** WebGPU guarantees 8 vertex buffers; each attribute takes one. */
const MAXIMUM_VERTEX_ATTRIBUTES = 8

const ATTRIBUTE_ARRAYS = [Float32Array, Uint8Array, Uint16Array, Int16Array, Uint32Array, Int32Array] as const

/** Why an attribute has no WebGPU vertex format, or null when it has one. */
function attributeProblem(attribute: { array: unknown; itemSize: number; normalized?: boolean }): string | null {
  const { array, itemSize, normalized = false } = attribute
  if (!ATTRIBUTE_ARRAYS.some(constructor => array instanceof constructor)) return 'needs a typed array (Float32Array, Uint8Array, Uint16Array, Int16Array, Uint32Array or Int32Array)'
  if (![1, 2, 3, 4].includes(itemSize)) return `needs an itemSize of 1 to 4, not ${itemSize}`
  const bytes = (array as Float32Array).BYTES_PER_ELEMENT
  if (bytes < 4 && itemSize === 3) return 'of 8 or 16 bits needs an itemSize of 1, 2 or 4 (WebGPU has no 3-component format for them); pad it to 4'
  if (normalized && bytes === 4) return 'cannot be normalized with 32-bit values; drop `normalized`, or use 8 or 16 bits'
  if (normalized && itemSize === 1) return 'normalized with 8 or 16 bits needs an itemSize of 2 or 4 (WebGPU has no 1-component format for them); use floats'
  return null
}

/** Runs the plugin's own tessellation from its worker module. */
class GeometryTierBuilder implements CustomLayerBuilder {
  protected readonly builder: WorkerTileBuilder | null = null
  protected readonly view: WorkerStyleLayer
  protected failed = false

  constructor(
    protected readonly layer: CompiledStyleLayer,
    protected readonly type: LoadedLayerType,
    module: WorkerLayerType,
    options: CustomLayerBuilderOptions,
  ) {
    this.view = {
      id: layer.id,
      type: layer.type,
      evaluate: (kind, name, zoom, feature) => layer.evaluate(kind, name, zoom, feature as StyleFeature | undefined, feature?.state as FeatureState | undefined),
      evaluateColor: (name, zoom, feature, opacity = 1) => layer.evaluateColor(name, zoom, feature as StyleFeature | undefined, opacity, feature?.state as FeatureState | undefined),
      has: (kind, name) => layer.has(kind, name),
    }
    try {
      this.builder = module.createTileBuilder({ layer: this.view, zoom: options.zoom, unitsPerPixel: options.unitsPerPixel, tile: options.tile })
    } catch (error) {
      this.fail('createTileBuilder threw', error)
    }
  }

  protected fail(what: string, error?: unknown): void {
    this.failed = true
    warnOnce(`${this.type.descriptor.type}\u0000${what}`, `MapStyleSource: layer type "${this.type.descriptor.type}" (layer "${this.layer.id}"): ${what}; fix its worker module. The layer is skipped in this tile.`, error)
  }

  addFeature(feature: StyleFeature, state: FeatureState, geometry: Point[][]): void {
    if (this.failed || this.builder === null) return
    const workerFeature: WorkerFeature = { type: feature.type as 1 | 2 | 3, properties: feature.properties as Record<string, unknown>, state, ...(feature.id !== undefined ? { id: feature.id as string | number } : {}) }
    try {
      this.builder.addFeature(workerFeature, geometry)
    } catch (error) {
      this.fail('addFeature threw', error)
    }
  }

  finish(): CustomLayerMesh | null {
    if (this.failed || this.builder === null) return null
    let geometry
    try {
      geometry = this.builder.finish()
    } catch (error) {
      this.fail('finish threw', error)
      return null
    }
    if (geometry === null || geometry === undefined) return null
    const position = geometry.attributes.position
    if (!(position?.array instanceof Float32Array) || position.itemSize !== 2) {
      this.fail('finish() needs a `position` attribute of 2 floats per vertex (tile units)')
      return null
    }
    const vertexCount = position.array.length / 2
    const paintNames = Object.keys(this.type.descriptor.paint)
    const attributes: CustomLayerAttribute[] = []
    const entries = Object.entries(geometry.attributes)
    if (entries.length > MAXIMUM_VERTEX_ATTRIBUTES) {
      this.fail(`finish() returned ${entries.length} attributes; at most ${MAXIMUM_VERTEX_ATTRIBUTES} including \`position\` (WebGPU vertex buffers)`)
      return null
    }
    for (const [name, attribute] of entries) {
      const paintIndex = paintNames.indexOf(name)
      const shaderName = paintIndex === -1 ? name : `paint${paintIndex}`
      if (!IDENTIFIER.test(shaderName) || (paintIndex === -1 && /^paint\d+$/.test(name))) {
        this.fail(`attribute "${name}" is neither a paint property nor a shader identifier (letters, digits, _; not paintN)`)
        return null
      }
      const problem = attributeProblem(attribute)
      if (problem !== null) {
        this.fail(`attribute "${name}" ${problem}`)
        return null
      }
      if (attribute.array.length !== vertexCount * attribute.itemSize) {
        this.fail(`attribute "${name}" has ${attribute.array.length} values for ${vertexCount} vertices of ${attribute.itemSize}`)
        return null
      }
      // Copied: the module may reuse its arrays across tiles, or hand views into WebAssembly or shared memory,
      // none of which can be transferred.
      attributes.push({ name: shaderName, array: attribute.array.slice(), itemSize: attribute.itemSize, normalized: attribute.normalized ?? false })
    }
    if (!(geometry.indices instanceof Uint16Array || geometry.indices instanceof Uint32Array)) {
      this.fail('finish() needs `indices` as a Uint16Array or Uint32Array')
      return null
    }
    const indices = geometry.indices.slice()
    for (let index = 0; index < indices.length; index++) {
      if (indices[index]! >= vertexCount) {
        this.fail(`index ${indices[index]} is past the ${vertexCount} vertices`)
        return null
      }
    }
    if (indices.length === 0) return null
    return { layerId: this.layer.id, layerType: this.layer.type, group: this.layer.group, attributes, indices }
  }
}
