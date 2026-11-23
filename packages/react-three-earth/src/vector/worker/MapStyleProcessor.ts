import { classifyRings, featureFilter, Formatted, type Color, type FeatureFilter } from '@maplibre/maplibre-gl-style-spec'

import type { WorkerLayerTypeDescriptor } from '../../plugins/styleLayerTypes.js'
import { createCustomLayerBuilder, loadLayerTypes, type CustomLayerBuilder, type LoadedLayerType } from './customLayers.js'
import { clipQueryToTile, featureHitTesters, getTileFeatureIndex, MAXIMUM_QUERY_RADIUS_PIXELS, polygonIntersectsBoxes, queryBounds, type QueryGeometry } from './featureIndex.js'
import { FeatureColorTable, featureKey } from './featureState.js'
import { createGeoJsonTileProvider, GeoJsonTileSource } from './geoJsonSource.js'
import { GlyphProvider, type Glyph } from './glyphs.js'
import {
  CollisionGrid,
  layoutLineLabels,
  layoutPointLabel,
  shapeText,
  TextBuilder,
  type Box,
  type TextAnchor,
  type TextJustify,
  type TextSection,
} from './labels.js'
import { tileOverlaps, type MercatorRectangle } from './rectangles.js'
import { SymbolBuilder, symbolMeshByteLength } from './symbols.js'
import { applyStyleCommand, copyStyleDocument, type StyleDocument } from './styleDocument.js'
import { ShapeBuilder, type LineCap, type LineGradient, type LineJoin, type Point } from './ShapeBuilder.js'
import { StyleImages, type ImageDecoder } from './sprites.js'
import { assignLayerOrder, compileStyleLayer, toRgba, type CompiledStyleLayer, type Rgba, type StyleFeature, type StyleLayerSpecification } from './styleLayers.js'
import { createVectorTileProvider, type TileSourceSpecification, type VectorTileFeatureLike, type VectorTileLike, type VectorTileProvider, type VectorTileProviderFactory } from './tileProviders.js'
import { resolveTemplate, type ResourceFetch, type VectorSourceSpecification } from './tileSources.js'
import {
  TILE_EXTENT,
  TILE_SIZE_PIXELS,
  type AtlasUpdate,
  type BackgroundPattern,
  type FeatureColorUpdate,
  type FeatureState,
  type FeatureStateChange,
  type GeoJsonSourceQuery,
  type ImageAtlasUpdate,
  type ImageChange,
  type MapStyleProcessorOptions,
  type MapStyleSummary,
  type PatternRectangle,
  type ResourceAnswer,
  type ResourceRequest,
  type SourceArea,
  type StyleCommand,
  type StyleImage,
  type StyleUpdateResult,
  type CustomLayerMesh,
  type FeatureGeometry,
  type QueryTile,
  type RenderedFeatureQuery,
  type RenderedSourceFeature,
  type SourceFeature,
  type SourceFeatureQuery,
  type TileBucket,
  type TileRequest,
} from './types.js'

/** Hooks for tests and for the worker: Node has neither the network fixtures nor OffscreenCanvas. */
export interface MapStyleProcessorHooks {
  fetch?: typeof fetch
  drawLocalGlyph?: (fontStack: string, codePoint: number) => Glyph | null
  /** Asks the main thread to resolve a request (`transformRequest`, protocols). Without it, URLs are fetched as they are. */
  resolveResource?: (request: ResourceRequest, signal?: AbortSignal) => Promise<ResourceAnswer>
  /** Decodes sprite sheets (Node has no `createImageBitmap`). */
  decodeImage?: ImageDecoder
}

/** Pattern lookups of one tile: the images it asked for, and those that do not exist. */
interface TileImages {
  used: Set<string>
  missing: Set<string>
}

/** Where a tile sits in the world, for patterns that continue seamlessly across tiles. */
export interface TilePlacement {
  x: number
  y: number
  /** Map pixels per tile at the evaluated zoom. */
  tileSizePixels: number
}


/** Raw tiles kept for reuse (overzoomed levels and neighbouring regions read the same tile). */
const RAW_TILE_CACHE_SIZE = 128
/** Tiles whose placed label boxes are kept for `queryRenderedFeatures`; others are laid out again when queried. */
const PLACED_LABEL_CACHE_SIZE = 256
/** Features `querySourceFeatures` returns at most, so a careless query cannot flood the main thread. */
const MAXIMUM_SOURCE_FEATURES = 100_000
const MAXIMUM_ZOOM = 24
const NO_STATE: FeatureState = Object.freeze({}) as FeatureState
/**
 * The style source types drawn, and how their tiles are made: a new source type only adds a provider here. Sources
 * of other types (raster…) are skipped with their layers.
 */
export const TILE_PROVIDER_FACTORIES: ReadonlyMap<string, VectorTileProviderFactory> = new Map([
  ['vector', createVectorTileProvider],
  ['geojson', createGeoJsonTileProvider],
])

/** Line gradients are evaluated at this many points from start to end (MapLibre's ramp texture width). */
const LINE_GRADIENT_SAMPLES = 256
/** A line with a gradient is split so that each piece spans at most this much of its progress. */
const LINE_GRADIENT_STEP = 1 / 128

/** Layer types MapLibre defines; a style layer of another type needs a plugin. */
const MAPLIBRE_LAYER_TYPES = new Set(['background', 'fill', 'line', 'symbol', 'circle', 'fill-extrusion', 'raster', 'hillshade', 'heatmap', 'color-relief'])

interface SymbolCandidate {
  layer: CompiledStyleLayer
  feature: StyleFeature
  /** Where the feature is in the tile, to read it again when a query hits its label. */
  sourceLayer: string
  featureIndex: number
  state: FeatureState
  type: VectorTileFeatureLike['type']
  geometry: Point[][]
  sections: TextSection[]
  sortKey: number
  order: number
}

interface RawTileEntry {
  x: number
  y: number
  z: number
  promise: Promise<VectorTileLike | null>
  waiters: number
  controller: AbortController
}

/** A label drawn in a tile: its boxes, in tile units, and the feature it labels. */
interface PlacedLabel {
  layerId: string
  sourceLayer: string
  featureIndex: number
  boxes: Box[]
}

/** The labels a tile placed, with what they were placed from: they are stale once the tile or the layers change. */
interface TileLabels {
  /** The decoded tile's serial (`tileSerial`): a refetched tile gets another. Not the tile, so the cache keeps no tile alive. */
  tileSerial: number
  layers: readonly CompiledStyleLayer[]
  labels: PlacedLabel[]
}

/** A feature a query hit, with what orders it among the others. */
interface QueryHit {
  feature: RenderedSourceFeature
  /** Labels draw above every shape layer. */
  label: boolean
  layerIndex: number
  order: number
}

/** What one tile's processing learns about feature-state, for its bucket. */
interface FeatureStateUse {
  colorKeys: Set<string>
  rebuildKeys: Set<string>
}

/**
 * Turns vector tiles into triangles for one MapLibre style: fetches tiles (XYZ, TileJSON or PMTiles),
 * evaluates the style's filters and properties per feature, tessellates fills, lines and circles, and lays
 * out text labels with SDF glyphs. Runs in a worker; pure enough to run on the main thread or in Node.
 *
 * The style can change after it loaded (`applyCommands`), as can feature-state (`applyFeatureStates`) and
 * `global-state` values; each answers what the main thread must redraw.
 */
export class MapStyleProcessor {
  summary: MapStyleSummary
  /** Compiled layers in style order. Replaced, never mutated in place, so a tile in progress keeps its list. */
  protected layers: CompiledStyleLayer[] = []
  /** The worker's own copy of the style: commands edit it in place. */
  protected readonly document: StyleDocument
  /** The tile providers of the loaded sources (vector tiles, GeoJSON), by source id. */
  protected readonly fetchers = new Map<string, VectorTileProvider>()
  /** Sources that failed to load, by their specification: retried only when replaced (`addSource`, a reload). */
  protected readonly failedSources = new WeakSet<TileSourceSpecification>()
  /** Gradient ramps of line layers, by zoom (layers are replaced, never mutated, when the style changes). */
  protected readonly lineGradients = new WeakMap<CompiledStyleLayer, Map<number, Rgba[]>>()
  /** Line layers with a `line-gradient` on a source without line metrics, warned about once. */
  protected readonly warnedLineGradients = new Set<string>()
  /** Which processor the glyph provider fetches through; shared with the processors that reload this one. */
  protected glyphRoute!: { processor: MapStyleProcessor }
  /** Sources whose TileJSON or PMTiles header is loading. */
  protected readonly pendingSources = new Map<string, { source: TileSourceSpecification; load: Promise<void> }>()
  protected glyphs: GlyphProvider
  /** Sprite and runtime images; set by `load`. */
  protected images!: StyleImages
  /** The processor this one reloads, until `load` took what it reuses. */
  protected previous: MapStyleProcessor | undefined
  protected readonly colorTable: FeatureColorTable
  protected readonly featureStates = new Map<string, FeatureState>()
  /** Feature-state messages applied so far (stamped on buckets, to spot tiles started before a change). */
  protected featureStateVersion = 0
  /** Live `global-state` values, read by compiled expressions: mutated in place, never replaced. */
  protected readonly globalState: Record<string, unknown> = {}
  /** Values set at runtime with `setGlobalStateProperty`, over the style's `state` defaults. */
  protected readonly globalStateOverrides = new Map<string, unknown>()
  protected readonly options: MapStyleProcessorOptions
  protected readonly hooks: MapStyleProcessorHooks
  protected readonly networkFetch: typeof fetch
  protected readonly rawTiles = new Map<string, RawTileEntry>()
  /** Custom layer types from plugins, with their worker modules loaded. */
  protected layerTypes: Map<string, LoadedLayerType> = new Map()
  protected layerTypeWork: Promise<unknown> = Promise.resolve()
  /** The types the plugins registered, loaded or not. */
  protected registeredLayerTypes = new Set<string>()
  /** Tiles fetched this session, oldest first (at most 4096), so `invalidate` knows which the browser may cache. */
  protected readonly fetchedTiles = new Map<string, { x: number; y: number; z: number }>()
  /**
   * Fetched tiles in invalidated areas: their next fetch uses `cache: 'no-cache'`, once, so the browser's HTTP
   * cache cannot hand back the tile from before the change.
   */
  protected readonly revalidatedTiles = new Set<string>()
  /** Labels each recently processed tile placed, by bucket key, most recent last, for `queryRenderedFeatures`. */
  protected readonly placedLabels = new Map<string, TileLabels>()
  /** Fetches through `transformRequest` and protocols when the main thread asks for it. */
  readonly fetchResource: ResourceFetch = (url, init, kind) => this.resolveAndFetch(url, init, kind)

  protected constructor(options: MapStyleProcessorOptions, hooks: MapStyleProcessorHooks, previous?: MapStyleProcessor) {
    this.document = copyStyleDocument(options.style)
    const style = this.document
    this.options = options
    this.hooks = hooks
    this.networkFetch = hooks.fetch ?? globalThis.fetch.bind(globalThis)
    for (const [name, value] of Object.entries(options.globalState ?? {})) this.globalStateOverrides.set(name, value)
    this.refreshGlobalState()
    for (const [key, state] of options.featureStates ?? []) this.featureStates.set(key, state)
    this.featureStateVersion = options.featureStateVersion ?? 0
    // The previous processor keeps serving glyphs until this one has loaded (`create`).
    const glyphRoute = previous?.glyphRoute ?? { processor: this as MapStyleProcessor }
    this.glyphRoute = glyphRoute
    const glyphOptions = {
      glyphsUrl: style.glyphs === undefined ? null : resolveTemplate(style.glyphs, options.baseUrl),
      requestHeaders: options.requestHeaders,
      localFontFamily: options.localFontFamily,
      // Through the latest processor: a glyph provider reused by later reloads must not keep this one alive.
      fetch: ((url: string, init: RequestInit) => glyphRoute.processor.fetchResource(url, init ?? {}, 'Glyphs')) as typeof fetch,
      ...(hooks.drawLocalGlyph !== undefined ? { drawLocalGlyph: hooks.drawLocalGlyph } : {}),
    }
    // After a reload, glyphs and colour slots keep their place: buckets still on screen point at them.
    this.glyphs = previous?.glyphs.matches(glyphOptions) === true ? previous.glyphs : new GlyphProvider({ ...glyphOptions, ...(previous ? { atlas: previous.glyphs.atlas } : {}) })
    this.colorTable = previous?.colorTable ?? new FeatureColorTable()
    this.previous = previous
    // Worker modules already imported stay loaded across a reload.
    if (previous !== undefined) this.layerTypes = previous.layerTypes
    this.summary = { sources: [], backgroundByZoom: [], skippedLayers: [], attributions: [], backgroundPatternByZoom: [], missingBackgroundImages: [], spriteImageIds: [], customLayerTypes: [], missingLayerTypes: [] }
  }

  static async create(options: MapStyleProcessorOptions, hooks: MapStyleProcessorHooks = {}, previous?: MapStyleProcessor): Promise<MapStyleProcessor> {
    const processor = new MapStyleProcessor(options, hooks, previous)
    await processor.load()
    processor.glyphRoute.processor = processor
    return processor
  }

  protected async load(): Promise<void> {
    const errors: string[] = []
    this.registeredLayerTypes = new Set((this.options.layerTypes ?? []).map(descriptor => descriptor.type))
    this.layerTypes = await loadLayerTypes(this.options.layerTypes ?? [], this.layerTypes)
    this.layers = this.document.layers.flatMap((layer, index) => compileStyleLayer(layer as StyleLayerSpecification, index, this.globalState, undefined, this.layerTypes) ?? [])
    assignLayerOrder(this.layers, this.document.layers as StyleLayerSpecification[])
    const used = this.usedSources()
    const imagesLoad = this.loadImages()
    await Promise.all(Object.keys(this.document.sources).filter(id => used.has(id)).map(id => this.loadSource(id, errors)))
    this.images = await imagesLoad
    this.summary = this.computeSummary()
  }

  /** Sprite sheets and runtime images. A reload with the same sprite keeps the previous images and atlas places. */
  protected async loadImages(): Promise<StyleImages> {
    const previous = this.previous
    this.previous = undefined // let it be collected
    if (previous !== undefined && JSON.stringify(previous.document.sprite) === JSON.stringify(this.document.sprite) && previous.options.spritePixelRatio === this.options.spritePixelRatio) {
      return previous.images
    }
    const fetchSprite = ((url: string, init?: RequestInit) => this.fetchResource(url, init ?? {}, /\.json(\?|#|$)/.test(url) ? 'SpriteJSON' : 'SpriteImage')) as typeof fetch
    return StyleImages.load({
      sprite: this.document.sprite,
      baseUrl: this.options.baseUrl,
      pixelRatio: this.options.spritePixelRatio ?? 1,
      requestHeaders: this.options.requestHeaders,
      fetch: fetchSprite,
      images: this.options.images ?? [],
      ...(this.hooks.decodeImage !== undefined ? { decodeImage: this.hooks.decodeImage } : {}),
    })
  }

  /** Sources at least one drawn layer reads. */
  protected usedSources(): Set<string> {
    return new Set(this.layers.flatMap(layer => (layer.type !== 'background' && layer.source !== undefined ? [layer.source] : [])))
  }

  /** Loads a source's fetcher once: a second style change while it loads waits for the same load. */
  protected loadSource(id: string, errors: string[]): Promise<void> {
    const source = this.document.sources[id] as TileSourceSpecification | undefined
    if (source === undefined || !TILE_PROVIDER_FACTORIES.has(source.type) || this.fetchers.has(id) || this.failedSources.has(source)) return Promise.resolve()
    const pending = this.pendingSources.get(id)
    if (pending?.source === source) return pending.load
    const load = this.fetchSource(id, source, errors).finally(() => {
      if (this.pendingSources.get(id)?.load === load) this.pendingSources.delete(id)
    })
    this.pendingSources.set(id, { source, load })
    return load
  }

  protected async fetchSource(id: string, source: TileSourceSpecification, errors: string[]): Promise<void> {
    try {
      const create = TILE_PROVIDER_FACTORIES.get(source.type)!
      const fetcher = await create(source, { baseUrl: this.options.baseUrl, requestHeaders: this.options.requestHeaders, fetch: this.fetchResource }, id)
      if (this.document.sources[id] === source) this.fetchers.set(id, fetcher) // not removed or replaced meanwhile
    } catch (error) {
      this.failedSources.add(source)
      const message = `MapStyleSource: source "${id}" is unavailable, its layers are skipped. ${(error as Error).message}`
      console.warn(message)
      errors.push(message)
    }
  }

  protected computeSummary(): MapStyleSummary {
    const compiled = new Set(this.layers.map(layer => layer.id))
    const sources = this.document.sources as Record<string, VectorSourceSpecification>
    const missingLayerTypes: Array<[string, string]> = []
    const skipped = this.document.layers.flatMap(layer => {
      if (!compiled.has(layer.id) && !MAPLIBRE_LAYER_TYPES.has(layer.type) && !this.layerTypes.has(layer.type)) {
        // A registered type whose worker module failed was already reported, naming its URL.
        if (!this.registeredLayerTypes.has(layer.type)) missingLayerTypes.push([layer.id, layer.type])
        return []
      }
      if (!compiled.has(layer.id)) return [layer.id]
      return layer.type !== 'background' && layer.source !== undefined && sources[layer.source] !== undefined && !TILE_PROVIDER_FACTORIES.has(sources[layer.source]!.type) ? [layer.id] : []
    })
    const used = this.usedSources()
    // In the style's source order, not in the order the requests finished, and only for sources a drawn layer uses
    const attributions = Object.entries(sources).flatMap(([id, source]) => {
      const fetcher = this.fetchers.get(id)
      if (fetcher === undefined || !used.has(id)) return []
      const attribution = source.attribution ?? fetcher.attribution
      return typeof attribution === 'string' ? [attribution] : []
    })
    return {
      sources: [...this.fetchers].filter(([id]) => used.has(id)).map(([id, fetcher]) => ({ id, minimumZoom: fetcher.minimumZoom, maximumZoom: fetcher.maximumZoom })),
      backgroundByZoom: Array.from({ length: MAXIMUM_ZOOM + 1 }, (_, zoom) => this.backgroundAt(zoom)),
      skippedLayers: skipped,
      attributions,
      ...this.backgroundPatterns(),
      spriteImageIds: this.images.spriteImageIds(),
      customLayerTypes: [...new Set(this.layers.flatMap(layer => (layer.custom !== null ? [layer.type] : [])))],
      missingLayerTypes,
    }
  }

  /**
   * Replaces the custom layer types (plugins) and recompiles every layer, keeping the raw tiles. Answers the
   * sources whose tiles must be processed again: those of layers whose type came, went or changed.
   */
  setLayerTypes(descriptors: readonly WorkerLayerTypeDescriptor[]): Promise<StyleUpdateResult> {
    // One at a time, in the order sent: a later change must not be overwritten by an earlier one still importing.
    const result = this.layerTypeWork.then(() => this.replaceLayerTypes(descriptors))
    this.layerTypeWork = result.catch(() => {})
    return result
  }

  protected async replaceLayerTypes(descriptors: readonly WorkerLayerTypeDescriptor[]): Promise<StyleUpdateResult> {
    const before = this.layerTypes
    const after = await loadLayerTypes(descriptors, before)
    const changed = new Set([...before.keys(), ...after.keys()].filter(type => before.get(type) !== after.get(type)))
    const orderBefore = this.layerOrderBySource()
    this.layerTypes = after
    this.registeredLayerTypes = new Set(descriptors.map(descriptor => descriptor.type))
    const errors: string[] = []
    const layers = this.document.layers.flatMap((layer, index) => compileStyleLayer(layer as StyleLayerSpecification, index, this.globalState, message => errors.push(message), after) ?? [])
    assignLayerOrder(layers, this.document.layers as StyleLayerSpecification[])
    this.layers = layers
    const rebuilt = new Set<string>()
    for (const layer of this.document.layers) if (changed.has(layer.type) && layer.source !== undefined) rebuilt.add(layer.source)
    // A custom layer coming or going renumbers the draw groups of every source after it.
    const orderAfter = this.layerOrderBySource()
    for (const source of new Set([...orderBefore.keys(), ...orderAfter.keys()])) if (orderBefore.get(source) !== orderAfter.get(source)) rebuilt.add(source)
    await Promise.all([...this.usedSources()].filter(id => !this.fetchers.has(id)).map(id => this.loadSource(id, errors)))
    this.summary = this.computeSummary()
    return { summary: this.summary, rebuiltSources: [...rebuilt], errors }
  }

  /**
   * Applies style commands (the main thread validated them). Answers the new summary and the sources whose tiles
   * must be processed again: the sources of changed layers, and those whose layer order or groups moved.
   */
  async applyCommands(commands: readonly StyleCommand[]): Promise<StyleUpdateResult> {
    const before = this.layerOrderBySource()
    const rebuilt = new Set<string>()
    const errors: string[] = []
    const sourceLoads: Array<Promise<void>> = []
    const areas: SourceArea[] = []
    const layers = [...this.layers]
    for (const command of commands) {
      try {
        this.applyCommand(command, layers, rebuilt, sourceLoads, errors, areas)
      } catch (error) {
        const message = `MapStyleSource: ${command.command} failed: ${(error as Error).message}`
        console.warn(message)
        errors.push(message)
      }
    }
    assignLayerOrder(layers, this.document.layers as StyleLayerSpecification[])
    layers.sort((a, b) => a.index - b.index)
    this.layers = layers
    // Sources a new layer reads start loading now
    for (const id of this.usedSources()) if (!this.fetchers.has(id)) sourceLoads.push(this.loadSource(id, errors))
    const after = this.layerOrderBySource()
    for (const source of new Set([...before.keys(), ...after.keys()])) if (before.get(source) !== after.get(source)) rebuilt.add(source)
    await Promise.all(sourceLoads)
    this.summary = this.computeSummary()
    const rebuiltAreas = areas.filter(area => !rebuilt.has(area.sourceId))
    return { summary: this.summary, rebuiltSources: [...rebuilt], errors, ...(rebuiltAreas.length > 0 ? { rebuiltAreas } : {}) }
  }

  protected applyCommand(
    command: StyleCommand,
    layers: CompiledStyleLayer[],
    rebuilt: Set<string>,
    sourceLoads: Array<Promise<void>>,
    errors: string[],
    areas: SourceArea[] = [],
  ): void {
    const document = this.document
    const layerId = typeof command.args[0] === 'string' ? command.args[0] : undefined
    const previous = command.command === 'addLayer' ? undefined : document.layers.find(layer => layer.id === layerId)
    applyStyleCommand(document, command)
    switch (command.command) {
      case 'setPaintProperty':
      case 'setLayoutProperty':
      case 'setFilter':
      case 'setLayerZoomRange':
      case 'addLayer': {
        const id = command.command === 'addLayer' ? (command.args[0] as StyleLayerSpecification).id : layerId!
        const position = document.layers.findIndex(layer => layer.id === id)
        const next = document.layers[position]! as StyleLayerSpecification
        const existing = layers.findIndex(layer => layer.id === id)
        if (existing !== -1) layers.splice(existing, 1)
        // A failing expression skips the layer, as at load
        const compiled = compileStyleLayer(next, position, this.globalState, message => errors.push(message), this.layerTypes)
        if (compiled !== null) layers.push(compiled)
        if (previous?.source !== undefined) rebuilt.add(previous.source)
        if (next.source !== undefined) rebuilt.add(next.source)
        return
      }
      case 'removeLayer': {
        const existing = layers.findIndex(layer => layer.id === layerId)
        if (existing !== -1) layers.splice(existing, 1)
        if (previous?.source !== undefined) rebuilt.add(previous.source)
        return
      }
      case 'moveLayer':
        return // the order comparison in applyCommands rebuilds what moved
      case 'addSource':
        if (layers.some(layer => layer.source === command.args[0])) sourceLoads.push(this.loadSource(command.args[0], errors))
        return
      case 'removeSource':
      case 'setSource': {
        // A replaced source loads again (below, in applyCommands) when a layer reads it
        const [sourceId] = command.args
        this.fetchers.delete(sourceId)
        this.dropRawTiles(sourceId)
        rebuilt.add(sourceId)
        return
      }
      case 'setGeoJSONSourceData':
      case 'updateGeoJSONSourceData': {
        const [sourceId] = command.args
        const provider = this.fetchers.get(sourceId)
        // Not loaded yet: it loads from the document, which holds the new data, when a layer reads it
        if (!(provider instanceof GeoJsonTileSource)) return
        this.dropRawTiles(sourceId)
        const change = command.command === 'setGeoJSONSourceData' ? provider.setData(command.args[1]) : provider.updateData(command.args[1])
        sourceLoads.push(
          change.then(
            ({ rectangles, marginTiles }) => void areas.push({ sourceId, rectangles, marginTiles }),
            (error: unknown) => {
              const message = `MapStyleSource: the data of source "${sourceId}" did not change, it keeps the previous data. ${(error as Error).message}`
              console.warn(message)
              errors.push(message)
            },
          ),
        )
        return
      }
      case 'setGlobalState':
        this.rebuildForGlobalState(this.refreshGlobalState(), layers, rebuilt)
        return
      case 'setGlobalStateProperty': {
        const [name, value] = command.args
        if (value === undefined) this.globalStateOverrides.delete(name)
        else this.globalStateOverrides.set(name, value)
        this.rebuildForGlobalState(this.refreshGlobalState(), layers, rebuilt)
      }
    }
  }

  /** Forgets the decoded tiles of a source. */
  protected dropRawTiles(sourceId: string): void {
    for (const key of this.rawTiles.keys()) if (key.startsWith(`${sourceId}/`) && key.slice(sourceId.length + 1).split('/').length === 3) this.rawTiles.delete(key)
  }

  /**
   * Answers a question about a source: the clusters of a `geojson` source. Loads the source first when no layer
   * reads it.
   */
  async querySource(sourceId: string, query: GeoJsonSourceQuery): Promise<unknown> {
    const errors: string[] = []
    if (!this.fetchers.has(sourceId)) await this.loadSource(sourceId, errors)
    const provider = this.fetchers.get(sourceId)
    if (provider instanceof GeoJsonTileSource) return provider.query(query)
    const type = this.document.sources[sourceId]?.type
    if (type === undefined) throw new Error(`GeoJsonSource: there is no source "${sourceId}" in the style; use a source id from getStyle().sources.`)
    if (type !== 'geojson') throw new Error(`GeoJsonSource: source "${sourceId}" is a ${type} source; clusters belong to geojson sources.`)
    throw new Error(errors[0] ?? `GeoJsonSource: source "${sourceId}" did not load.`)
  }

  /** Recomputes the live `global-state` values in place; returns the names whose value changed. */
  protected refreshGlobalState(): Set<string> {
    const defaults = this.document.state ?? {}
    const names = new Set([...Object.keys(this.globalState), ...Object.keys(defaults), ...this.globalStateOverrides.keys()])
    const changed = new Set<string>()
    for (const name of names) {
      const value = this.globalStateOverrides.has(name) ? this.globalStateOverrides.get(name) : defaults[name]?.default
      if (JSON.stringify(value) === JSON.stringify(this.globalState[name])) continue
      changed.add(name)
      if (value === undefined) delete this.globalState[name]
      else this.globalState[name] = value
    }
    return changed
  }

  protected rebuildForGlobalState(changed: ReadonlySet<string>, layers: readonly CompiledStyleLayer[], rebuilt: Set<string>): void {
    if (changed.size === 0) return
    for (const layer of layers) if (layer.source !== undefined && layer.type !== 'background' && layer.readsGlobalState(changed)) rebuilt.add(layer.source)
  }

  /** Per source, its layers in order with their groups: a change means the source's buckets are stale. */
  protected layerOrderBySource(): Map<string, string> {
    const order = new Map<string, string>()
    for (const layer of this.layers) {
      if (layer.source === undefined || layer.type === 'background') continue
      order.set(layer.source, `${order.get(layer.source) ?? ''}${layer.id}\u0000${layer.group}\u0000`)
    }
    return order
  }

  /**
   * Applies feature-state changes: re-evaluates the colour slots of the changed features (sent with
   * `takeFeatureColorUpdate`). Tiles whose features' state changes geometry are found by the main thread, which
   * knows which buckets hold which features.
   */
  applyFeatureStates(changes: readonly FeatureStateChange[]): void {
    this.featureStateVersion++
    for (const { key, state } of changes) {
      if (state === null) this.featureStates.delete(key)
      else this.featureStates.set(key, state)
      this.colorTable.updateFeature(key, state ?? NO_STATE)
    }
  }

  /** Slot colours changed since the last call. Send them with (and before) the next result. */
  takeFeatureColorUpdate(): FeatureColorUpdate | null {
    return this.colorTable.takeUpdate()
  }

  /** Glyph atlas changes since the last call. Send them with (and before) the next bucket. */
  takeAtlasUpdate(): AtlasUpdate | null {
    return this.glyphs.atlas.takeUpdate()
  }

  /** Image atlas changes since the last call. Send them with (and before) the next result. */
  takeImageAtlasUpdate(): ImageAtlasUpdate | null {
    return this.images.atlas.takeUpdate()
  }

  /**
   * Adds or replaces (`image`) or removes (`null`) a runtime image. Tiles processed from now on use it; the
   * answer says whether tiles processed before must be rebuilt or only redrawn.
   */
  setImage(id: string, image: StyleImage | null): ImageChange {
    const rebuild = this.images.set(id, image)
    Object.assign(this.summary, this.backgroundPatterns())
    return { rebuild, backgroundPatternByZoom: this.summary.backgroundPatternByZoom, missingBackgroundImages: this.summary.missingBackgroundImages }
  }

  /** Tessellates one tile. The bucket's `atlas` is left null: the caller attaches `takeAtlasUpdate()`. */
  async processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket> {
    const { sourceId, x, y, z, zoom } = request
    signal?.throwIfAborted()
    const tile = await this.getRawTile(sourceId, x, y, z, signal)
    signal?.throwIfAborted()
    // From here to the end of the feature loop nothing awaits: states read there are those of this version.
    const featureStateVersion = this.featureStateVersion
    const empty: TileBucket = { shapes: null, text: null, layers: [], atlas: null, images: [], missingImages: [], featureStateKeys: [], rebuildFeatureKeys: [], featureStateVersion, byteLength: 0 }
    if (tile === null) return empty

    // The version and layers of this moment: a style change meanwhile replaces `this.layers`, not this list.
    const layers = this.layers
    const promoteId = (this.document.sources[sourceId] as VectorSourceSpecification | undefined)?.promoteId
    // GeoJSON tiles have one layer, which every layer of the source reads; feature-state keys have no source layer.
    const singleLayer = this.fetchers.get(sourceId)?.singleLayer
    const unitsPerPixel = TILE_EXTENT / (TILE_SIZE_PIXELS * 2 ** (zoom - z))
    const placement: TilePlacement = { x, y, tileSizePixels: TILE_SIZE_PIXELS * 2 ** (zoom - z) }
    const images: TileImages = { used: new Set(), missing: new Set() }
    const shapes = new ShapeBuilder()
    const symbols: SymbolCandidate[] = []
    const uses: FeatureStateUse = { colorKeys: new Set(), rebuildKeys: new Set() }
    const customBuilders: CustomLayerBuilder[] = []
    if (request.symbols === true) return this.processSymbolTile(tile, request, empty, signal)
    for (const layer of layers) {
      if (layer.source !== sourceId || layer.type === 'background' || !layer.isVisibleAtZoom(zoom)) continue
      const layerName = singleLayer ?? layer.sourceLayer
      const sourceLayer = layerName === undefined ? undefined : tile.layers[layerName]
      if (sourceLayer === undefined) continue
      const stateLayer = singleLayer === undefined ? layer.sourceLayer : undefined
      const factor = TILE_EXTENT / sourceLayer.extent
      const customType = layer.custom === null ? undefined : this.layerTypes.get(layer.type)
      const custom = customType === undefined ? null : createCustomLayerBuilder(layer, customType, { zoom, unitsPerPixel, tile: { x, y, z } })
      if (custom !== null) customBuilders.push(custom)
      const promotedProperty = typeof promoteId === 'string' ? promoteId : promoteId?.[layerName!]
      for (let index = 0; index < sourceLayer.length; index++) {
        const vectorFeature = sourceLayer.feature(index)
        const id = promotedProperty === undefined ? vectorFeature.id : asFeatureId(vectorFeature.properties[promotedProperty])
        const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id }
        if (!layer.accepts(zoom, feature)) continue
        const key = layer.featureStateDependence === 'none' || id === undefined ? undefined : featureKey(sourceId, stateLayer, id)
        const state = key === undefined ? NO_STATE : (this.featureStates.get(key) ?? NO_STATE)
        if (key !== undefined && layer.featureStateDependence === 'geometry') uses.rebuildKeys.add(key)
        const geometry = scaleGeometry(vectorFeature.loadGeometry(), factor)
        if (custom !== null) custom.addFeature(feature, state, geometry)
        else if (layer.type === 'symbol') {
          const candidate = this.createSymbolCandidate(layer, feature, state, vectorFeature.type, geometry, zoom, symbols.length, layerName!, index)
          if (candidate !== null) symbols.push(candidate)
        } else this.addShape(shapes, layer, feature, vectorFeature.type, geometry, zoom, unitsPerPixel, placement, images, key, state, uses)
      }
    }
    const placed: PlacedLabel[] = []
    const text = await this.layoutLabels(symbols, zoom, unitsPerPixel, signal, placed)
    this.rememberLabels(bucketKeyOf(request), { tileSerial: tileSerial(tile), layers, labels: placed })
    const shapeMesh = shapes.build()
    const customMeshes = customBuilders.flatMap(builder => builder.finish() ?? []) as CustomLayerMesh[]
    const byteLength =
      (shapeMesh === null ? 0 : shapeMesh.positions.byteLength + shapeMesh.colors.byteLength + shapeMesh.indices.byteLength + (shapeMesh.colorSlots?.byteLength ?? 0)) +
      (shapeMesh?.patterns == null ? 0 : shapeMesh.patterns.byteLength + (shapeMesh.patternCoordinates?.byteLength ?? 0)) +
      (text === null ? 0 : text.positions.byteLength * 2 + text.colors.byteLength * 2 + text.haloEdges.byteLength + text.indices.byteLength) +
      customMeshes.reduce((sum, mesh) => sum + mesh.indices.byteLength + mesh.attributes.reduce((bytes, attribute) => bytes + attribute.array.byteLength, 0), 0)
    return {
      ...empty,
      shapes: shapeMesh,
      text,
      layers: customMeshes,
      images: [...images.used],
      missingImages: [...images.missing],
      featureStateKeys: [...uses.colorKeys],
      rebuildFeatureKeys: [...uses.rebuildKeys],
      byteLength,
    }
  }

  /**
   * The labels of a tile that face the viewer (`screenSymbols`): point-placed text, laid out once around its
   * anchor. Collision is left to the main thread, which sees every tile on the screen.
   */
  protected async processSymbolTile(tile: VectorTileLike, request: TileRequest, empty: TileBucket, signal?: AbortSignal): Promise<TileBucket> {
    const { sourceId, zoom } = request
    const layers = this.layers
    const promoteId = (this.document.sources[sourceId] as VectorSourceSpecification | undefined)?.promoteId
    const symbols: SymbolCandidate[] = []
    const rebuildKeys = new Set<string>()
    for (const layer of layers) {
      if (layer.source !== sourceId || layer.type !== 'symbol' || layer.custom !== null || !layer.isVisibleAtZoom(zoom)) continue
      const sourceLayer = layer.sourceLayer === undefined ? undefined : tile.layers[layer.sourceLayer]
      if (sourceLayer === undefined) continue
      const factor = TILE_EXTENT / sourceLayer.extent
      const promotedProperty = typeof promoteId === 'string' ? promoteId : promoteId?.[layer.sourceLayer!]
      for (let index = 0; index < sourceLayer.length; index++) {
        const vectorFeature = sourceLayer.feature(index)
        const id = promotedProperty === undefined ? vectorFeature.id : asFeatureId(vectorFeature.properties[promotedProperty])
        const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id }
        if (!layer.accepts(zoom, feature)) continue
        if (layer.evaluate<string>('layout', 'symbol-placement', zoom, feature) !== 'point') continue
        const key = layer.featureStateDependence === 'none' || id === undefined ? undefined : featureKey(sourceId, layer.sourceLayer, id)
        const state = key === undefined ? NO_STATE : (this.featureStates.get(key) ?? NO_STATE)
        // Text paint is baked in the tile: a state change processes it again.
        if (key !== undefined) rebuildKeys.add(key)
        const candidate = this.createSymbolCandidate(layer, feature, state, vectorFeature.type, scaleGeometry(vectorFeature.loadGeometry(), factor), zoom, symbols.length, layer.sourceLayer!, index)
        if (candidate !== null) symbols.push(candidate)
      }
    }
    if (symbols.length === 0) return empty
    await this.loadGlyphs(symbols)
    signal?.throwIfAborted()
    const builder = new SymbolBuilder()
    const getGlyph = (fontStack: string, codePoint: number) => this.glyphs.get(fontStack, codePoint)
    for (const symbol of symbols) {
      const { layer, feature, state } = symbol
      const anchor = representativePoint(symbol.type, symbol.geometry)
      if (anchor === null || anchor.x < 0 || anchor.y < 0 || anchor.x >= TILE_EXTENT || anchor.y >= TILE_EXTENT) continue
      const opacity = layer.evaluate<number>('paint', 'text-opacity', zoom, feature, state)
      const color = layer.evaluateColor('text-color', zoom, feature, opacity, state)
      const haloColor = toRgba(layer.evaluate<Color>('paint', 'text-halo-color', zoom, feature, state), opacity)
      if (color[3] === 0 && haloColor[3] === 0) continue
      const shaped = shapeText(
        symbol.sections,
        {
          maximumWidthEms: layer.evaluate<number>('layout', 'text-max-width', zoom, feature),
          lineHeightEms: layer.evaluate<number>('layout', 'text-line-height', zoom, feature),
          letterSpacingEms: layer.evaluate<number>('layout', 'text-letter-spacing', zoom, feature),
          anchor: firstAnchor(layer, zoom, feature),
          justify: layer.evaluate<TextJustify>('layout', 'text-justify', zoom, feature),
        },
        getGlyph,
      )
      if (shaped === null) continue
      const [offsetX = 0, offsetY = 0] = layer.evaluate<number[]>('layout', 'text-offset', zoom, feature)
      builder.add({
        anchor,
        shaped,
        offset: { x: offsetX * 24, y: offsetY * 24 },
        rotationRadians: (layer.evaluate<number>('layout', 'text-rotate', zoom, feature) * Math.PI) / 180,
        sizePixels: layer.evaluate<number>('layout', 'text-size', zoom, feature),
        nextZoomSizePixels: layer.evaluate<number>('layout', 'text-size', zoom + 1, feature),
        paddingPixels: layer.evaluate<number>('layout', 'text-padding', zoom, feature),
        allowOverlap: layer.evaluate<boolean>('layout', 'text-allow-overlap', zoom, feature),
        ignorePlacement: layer.evaluate<boolean>('layout', 'text-ignore-placement', zoom, feature),
        layerIndex: layer.index,
        sortKey: symbol.sortKey,
        color,
        haloColor,
        haloWidthPixels: layer.evaluate<number>('paint', 'text-halo-width', zoom, feature, state),
        key: `${layer.id}\u0000${symbol.sections.map(section => section.text).join('')}`,
        sourceLayer: symbol.sourceLayer,
        featureIndex: symbol.featureIndex,
      })
    }
    const mesh = builder.build()
    return { ...empty, symbols: mesh, rebuildFeatureKeys: [...rebuildKeys], byteLength: symbolMeshByteLength(mesh) }
  }

  /** Loads the glyphs the candidates' text needs, per font stack. */
  protected async loadGlyphs(symbols: readonly SymbolCandidate[]): Promise<void> {
    const codePoints = new Map<string, Set<number>>()
    for (const { sections } of symbols) {
      for (const section of sections) {
        let set = codePoints.get(section.fontStack)
        if (set === undefined) codePoints.set(section.fontStack, (set = new Set()))
        for (const character of section.text) set.add(character.codePointAt(0)!)
      }
    }
    await Promise.all([...codePoints].map(([fontStack, set]) => this.glyphs.load(fontStack, set)))
  }

  /**
   * The colour of the top-most background layer that draws at this zoom with a colour. Patterned layers draw
   * over it (`backgroundPatterns`).
   */
  protected backgroundAt(zoom: number): [number, number, number, number] | null {
    let color: [number, number, number, number] | null = null
    for (const layer of this.layers) {
      if (layer.type !== 'background' || !layer.isVisibleAtZoom(zoom)) continue
      if (patternName(layer, 'background-pattern', zoom) !== null) continue
      const opacity = layer.evaluate<number>('paint', 'background-opacity', zoom)
      const next = layer.evaluateColor('background-color', zoom, undefined, opacity)
      if (next[3] > 0) color = next
    }
    return color
  }

  /**
   * `background-pattern` per zoom: the top-most patterned background layer that draws, unless an opaque
   * colour layer above it covers it. Transparent layers and missing images are skipped (a missing image draws
   * nothing, as in MapLibre, and is listed). A translucent colour layer above a pattern draws under it: one
   * colour and one pattern per zoom is the limit.
   */
  protected backgroundPatterns(): Pick<MapStyleSummary, 'backgroundPatternByZoom' | 'missingBackgroundImages'> {
    const missing = new Set<string>()
    const backgroundPatternByZoom = Array.from({ length: MAXIMUM_ZOOM + 1 }, (_, zoom) => {
      let pattern: BackgroundPattern | null = null
      for (const layer of this.layers) {
        if (layer.type !== 'background' || !layer.isVisibleAtZoom(zoom)) continue
        const opacity = layer.evaluate<number>('paint', 'background-opacity', zoom)
        const name = patternName(layer, 'background-pattern', zoom)
        if (name === null) {
          if (layer.evaluateColor('background-color', zoom, undefined, opacity)[3] === 255) pattern = null
          continue
        }
        if (opacity <= 0) continue
        const rectangle = this.images.getPattern(name)
        if (rectangle === null) {
          if (this.images.isMissing(name)) missing.add(name)
          continue
        }
        pattern = { imageId: name, rectangle, opacity }
      }
      return pattern
    })
    return { backgroundPatternByZoom, missingBackgroundImages: [...missing] }
  }

  /** The pattern's place in the atlas, recording the lookup for the tile's image lists. */
  protected lookUpPattern(name: string, images: TileImages): PatternRectangle | null {
    images.used.add(name)
    const rectangle = this.images.getPattern(name)
    if (rectangle === null && this.images.isMissing(name)) images.missing.add(name)
    return rectangle
  }

  protected addShape(
    shapes: ShapeBuilder,
    layer: CompiledStyleLayer,
    feature: StyleFeature,
    type: VectorTileFeatureLike['type'],
    geometry: Point[][],
    zoom: number,
    unitsPerPixel: number,
    placement: TilePlacement,
    images: TileImages,
    key: string | undefined,
    state: FeatureState,
    uses: FeatureStateUse,
  ): void {
    shapes.setGroup(layer.group)
    const slotted = key !== undefined && layer.featureStateDependence === 'colors'
    /**
     * Sets the colour of the vertices about to be added; false when there is nothing to draw. A feature whose colour
     * depends on its state gets a slot, and is drawn even while transparent (a hover highlight, for example).
     */
    const useColor = (role: string, evaluate: (state: FeatureState) => Rgba): boolean => {
      const color = evaluate(state)
      if (slotted) {
        const slot = this.colorTable.allocate(key, `${key}\u0000${layer.id}\u0000${role}\u0000${zoom}`, evaluate, state)
        shapes.setColor(color)
        if (slot !== 0) {
          shapes.setColorSlot(slot)
          uses.colorKeys.add(key)
          return true
        }
        uses.rebuildKeys.add(key) // the slot table is full: baked, so a state change processes the tile again
      }
      if (color[3] === 0) return false
      shapes.setColor(color)
      return true
    }
    if (layer.type === 'fill' || layer.type === 'fill-extrusion') {
      if (type !== 3) return
      const prefix = layer.type
      const opacity = (featureState: FeatureState) => layer.evaluate<number>('paint', `${prefix}-opacity`, zoom, feature, featureState)
      const polygons = classifyRings(geometry as never, 500) as unknown as Point[][][]
      const pattern = patternName(layer, `${prefix}-pattern`, zoom, feature, state)
      if (pattern !== null) {
        // A patterned fill has no outline and no colour (MapLibre); a missing image draws nothing. Its opacity
        // is baked, so a state-dependent opacity processes the tile again.
        if (key !== undefined && layer.featureStateDependence !== 'none') uses.rebuildKeys.add(key)
        const rectangle = this.lookUpPattern(pattern, images)
        const patternOpacity = opacity(state)
        if (rectangle === null || patternOpacity <= 0) return
        shapes.setColor([255, 255, 255, Math.round(patternOpacity * 255)])
        shapes.setPattern(rectangle, planePatternMapping(rectangle, placement, unitsPerPixel))
        shapes.addPolygons(polygons)
        shapes.setPattern(null)
        return
      }
      if (useColor('fill', featureState => layer.evaluateColor(`${prefix}-color`, zoom, feature, opacity(featureState), featureState))) shapes.addPolygons(polygons)
      if (layer.type === 'fill' && layer.has('paint', 'fill-outline-color') && layer.evaluate<boolean>('paint', 'fill-antialias', zoom, feature, state)) {
        if (useColor('outline', featureState => layer.evaluateColor('fill-outline-color', zoom, feature, opacity(featureState), featureState))) {
          for (const ring of geometry) shapes.addLine(ring, { width: unitsPerPixel, join: 'miter' })
        }
      }
      return
    }
    if (layer.type === 'line') {
      if (type !== 2 && type !== 3) return
      let widthPixels = layer.evaluate<number>('paint', 'line-width', zoom, feature, state)
      const gapPixels = layer.evaluate<number>('paint', 'line-gap-width', zoom, feature, state)
      // Hairlines: draw one pixel wide and fade, as MapLibre's antialiasing does.
      const fade = widthPixels > 0 && widthPixels < 1 ? widthPixels : 1
      widthPixels = Math.max(widthPixels, widthPixels > 0 ? 1 : 0)
      if (widthPixels <= 0) return
      const lineOpacity = (featureState: FeatureState) => layer.evaluate<number>('paint', 'line-opacity', zoom, feature, featureState) * fade
      const pattern = patternName(layer, 'line-pattern', zoom, feature, state)
      const rectangle = pattern === null ? null : this.lookUpPattern(pattern, images)
      if (pattern !== null && rectangle === null) return // missing image: nothing, as in MapLibre
      // A gradient replaces the colour (and dashes), and needs the line metrics of a GeoJSON source with `lineMetrics`
      const ramp = rectangle === null && layer.has('paint', 'line-gradient') ? this.lineGradientRamp(layer, zoom, feature) : null
      if (ramp !== null) {
        // Baked: a state-dependent opacity processes the tile again.
        if (key !== undefined && layer.featureStateDependence !== 'none') uses.rebuildKeys.add(key)
        const opacity = lineOpacity(state)
        if (opacity <= 0) return
        const start = Number(feature.properties['mapbox_clip_start'])
        const end = Number(feature.properties['mapbox_clip_end'])
        shapes.setColor([0, 0, 0, 0])
        for (const line of geometry) {
          shapes.addLine(line, {
            width: widthPixels * unitsPerPixel,
            gapWidth: gapPixels * unitsPerPixel,
            offset: layer.evaluate<number>('paint', 'line-offset', zoom, feature, state) * unitsPerPixel,
            cap: layer.evaluate<LineCap>('layout', 'line-cap', zoom, feature),
            join: layer.evaluate<LineJoin>('layout', 'line-join', zoom, feature),
            miterLimit: layer.evaluate<number>('layout', 'line-miter-limit', zoom, feature),
            gradient: lineGradientAlong(line, start, end, ramp, opacity),
          })
        }
        return
      }
      if (rectangle !== null) {
        // Patterned lines bake their opacity: a state-dependent opacity processes the tile again.
        if (key !== undefined && layer.featureStateDependence !== 'none') uses.rebuildKeys.add(key)
        const alpha = Math.round(lineOpacity(state) * 255)
        if (alpha === 0) return
        shapes.setColor([255, 255, 255, alpha])
      } else if (!useColor('line', featureState => layer.evaluateColor('line-color', zoom, feature, lineOpacity(featureState), featureState))) return
      const width = widthPixels * unitsPerPixel
      // Dashes do not combine with a pattern (MapLibre).
      const dashes = rectangle === null && layer.has('paint', 'line-dasharray') ? layer.evaluate<number[] | { values: number[] }>('paint', 'line-dasharray', zoom, feature, state) : undefined
      const dashLengths = dashes === undefined ? undefined : (Array.isArray(dashes) ? dashes : dashes.values).map(length => length * width)
      shapes.setPattern(rectangle)
      for (const line of geometry) {
        shapes.addLine(line, {
          width,
          gapWidth: gapPixels * unitsPerPixel,
          offset: layer.evaluate<number>('paint', 'line-offset', zoom, feature, state) * unitsPerPixel,
          cap: layer.evaluate<LineCap>('layout', 'line-cap', zoom, feature),
          join: layer.evaluate<LineJoin>('layout', 'line-join', zoom, feature),
          miterLimit: layer.evaluate<number>('layout', 'line-miter-limit', zoom, feature),
          ...(dashLengths !== undefined ? { dashes: dashLengths } : {}),
        })
      }
      shapes.setPattern(null)
      return
    }
    if (layer.type === 'circle') {
      if (type !== 1) return
      const radius = layer.evaluate<number>('paint', 'circle-radius', zoom, feature, state) * unitsPerPixel
      const strokeWidth = layer.evaluate<number>('paint', 'circle-stroke-width', zoom, feature, state) * unitsPerPixel
      const fill = (featureState: FeatureState) =>
        layer.evaluateColor('circle-color', zoom, feature, layer.evaluate<number>('paint', 'circle-opacity', zoom, feature, featureState), featureState)
      const stroke = (featureState: FeatureState) =>
        layer.evaluateColor('circle-stroke-color', zoom, feature, layer.evaluate<number>('paint', 'circle-stroke-opacity', zoom, feature, featureState), featureState)
      for (const ring of geometry) {
        for (const point of ring) {
          if (strokeWidth > 0 && useColor('stroke', stroke)) shapes.addCircle(point, radius + strokeWidth)
          if (useColor('circle', fill)) shapes.addCircle(point, radius)
        }
      }
    }
  }

  /**
   * The layer's `line-gradient` sampled from progress 0 to 1, or null when the feature carries no line metrics (the
   * line is then drawn with `line-color`, as a warning says once per layer).
   */
  protected lineGradientRamp(layer: CompiledStyleLayer, zoom: number, feature: StyleFeature): Rgba[] | null {
    if (typeof feature.properties['mapbox_clip_start'] !== 'number' || typeof feature.properties['mapbox_clip_end'] !== 'number') {
      if (!this.warnedLineGradients.has(layer.id)) {
        this.warnedLineGradients.add(layer.id)
        console.warn(`MapStyleSource: layer "${layer.id}" has a line-gradient, which needs a geojson source with \`lineMetrics: true\`; it is drawn with line-color.`)
      }
      return null
    }
    let byZoom = this.lineGradients.get(layer)
    if (byZoom === undefined) this.lineGradients.set(layer, (byZoom = new Map()))
    let ramp = byZoom.get(zoom)
    if (ramp === undefined) {
      ramp = Array.from({ length: LINE_GRADIENT_SAMPLES }, (_, index) => layer.evaluateLineGradient(zoom, index / (LINE_GRADIENT_SAMPLES - 1)))
      byZoom.set(zoom, ramp)
    }
    return ramp
  }

  protected createSymbolCandidate(
    layer: CompiledStyleLayer,
    feature: StyleFeature,
    state: FeatureState,
    type: VectorTileFeatureLike['type'],
    geometry: Point[][],
    zoom: number,
    order: number,
    sourceLayer: string,
    featureIndex: number,
  ): SymbolCandidate | null {
    const field = layer.evaluate<Formatted | string | undefined>('layout', 'text-field', zoom, feature)
    if (field === undefined || field === null) return null
    // Legacy `{token}` strings (not expressions) substitute feature properties, as in MapLibre.
    const tokens = typeof layer.raw('layout', 'text-field') === 'string'
    const formatted = field instanceof Formatted ? field : Formatted.fromString(String(field))
    if (tokens) for (const section of formatted.sections) section.text = resolveTokens(section.text, feature.properties)
    if (formatted.isEmpty()) return null
    const fonts = layer.evaluate<string[]>('layout', 'text-font', zoom, feature)
    const fontStack = fonts.join(',')
    const transform = layer.evaluate<'none' | 'uppercase' | 'lowercase'>('layout', 'text-transform', zoom, feature)
    const sections = formatted.sections
      .filter(section => section.text.length > 0)
      .map(section => ({
        text: transform === 'uppercase' ? section.text.toLocaleUpperCase() : transform === 'lowercase' ? section.text.toLocaleLowerCase() : section.text,
        fontStack: section.fontStack ?? fontStack,
        scale: section.scale ?? 1,
      }))
    if (sections.length === 0) return null
    const sortKey = layer.has('layout', 'symbol-sort-key') ? (layer.evaluate<number | undefined>('layout', 'symbol-sort-key', zoom, feature) ?? 0) : 0
    return { layer, feature, sourceLayer, featureIndex, state, type, geometry, sections, sortKey, order }
  }

  /**
   * Places labels, top-most style layer first (as MapLibre does), then by `symbol-sort-key`, skipping those
   * that collide with labels already placed in this tile.
   */
  protected async layoutLabels(symbols: SymbolCandidate[], zoom: number, unitsPerPixel: number, signal?: AbortSignal, placed?: PlacedLabel[]) {
    if (symbols.length === 0) return null
    await this.loadGlyphs(symbols)
    signal?.throwIfAborted()

    symbols.sort((a, b) => b.layer.index - a.layer.index || a.sortKey - b.sortKey || a.order - b.order)
    const collisions = new CollisionGrid()
    const text = new TextBuilder()
    const getGlyph = (fontStack: string, codePoint: number) => this.glyphs.get(fontStack, codePoint)
    for (const symbol of symbols) {
      const { layer, feature, state } = symbol
      const placement = layer.evaluate<'point' | 'line' | 'line-center'>('layout', 'symbol-placement', zoom, feature)
      const size = layer.evaluate<number>('layout', 'text-size', zoom, feature)
      const textScale = size / 24
      const pixelsToUnits = unitsPerPixel * textScale
      const paddingUnits = layer.evaluate<number>('layout', 'text-padding', zoom, feature) * unitsPerPixel
      const allowOverlap = layer.evaluate<boolean>('layout', 'text-allow-overlap', zoom, feature)
      const ignorePlacement = layer.evaluate<boolean>('layout', 'text-ignore-placement', zoom, feature)
      const opacity = layer.evaluate<number>('paint', 'text-opacity', zoom, feature, state)
      const paint = {
        color: layer.evaluateColor('text-color', zoom, feature, opacity, state),
        haloColor: toRgba(layer.evaluate<Color>('paint', 'text-halo-color', zoom, feature, state), opacity),
        haloWidthPixels: layer.evaluate<number>('paint', 'text-halo-width', zoom, feature, state),
      }
      if (paint.color[3] === 0 && paint.haloColor[3] === 0) continue
      const lineHeightEms = layer.evaluate<number>('layout', 'text-line-height', zoom, feature)
      const letterSpacingEms = layer.evaluate<number>('layout', 'text-letter-spacing', zoom, feature)
      const tryPlace = (quads: Parameters<TextBuilder['addLabel']>[0], boxes: Box[]): void => {
        if (!allowOverlap && collisions.overlaps(boxes)) return
        if (!ignorePlacement) collisions.insert(boxes)
        text.addLabel(quads, paint, textScale)
        placed?.push({ layerId: layer.id, sourceLayer: symbol.sourceLayer, featureIndex: symbol.featureIndex, boxes })
      }

      if (placement === 'point') {
        // Faces the viewer instead: laid out by `processSymbolTile`.
        if (this.options.screenSymbols === true) continue
        const anchor = representativePoint(symbol.type, symbol.geometry)
        if (anchor === null || anchor.x < 0 || anchor.y < 0 || anchor.x >= TILE_EXTENT || anchor.y >= TILE_EXTENT) continue
        const shaped = shapeText(
          symbol.sections,
          {
            maximumWidthEms: layer.evaluate<number>('layout', 'text-max-width', zoom, feature),
            lineHeightEms,
            letterSpacingEms,
            anchor: firstAnchor(layer, zoom, feature),
            justify: layer.evaluate<TextJustify>('layout', 'text-justify', zoom, feature),
          },
          getGlyph,
        )
        if (shaped === null) continue
        const [offsetX = 0, offsetY = 0] = layer.evaluate<number[]>('layout', 'text-offset', zoom, feature)
        const rotation = (layer.evaluate<number>('layout', 'text-rotate', zoom, feature) * Math.PI) / 180
        const { quads, boxes } = layoutPointLabel(shaped, anchor, pixelsToUnits, { x: offsetX * 24, y: offsetY * 24 }, rotation, paddingUnits)
        tryPlace(quads, boxes)
        continue
      }

      if (symbol.type === 1) continue
      const shaped = shapeText(symbol.sections, { maximumWidthEms: 0, lineHeightEms, letterSpacingEms, anchor: 'center', justify: 'center' }, getGlyph)
      if (shaped === null) continue
      const options = {
        pixelsToUnits,
        spacingUnits: layer.evaluate<number>('layout', 'symbol-spacing', zoom, feature) * unitsPerPixel,
        maximumAngleRadians: (layer.evaluate<number>('layout', 'text-max-angle', zoom, feature) * Math.PI) / 180,
        keepUpright: layer.evaluate<boolean>('layout', 'text-keep-upright', zoom, feature),
        paddingUnits,
        center: placement === 'line-center',
        extent: TILE_EXTENT,
      }
      for (const line of symbol.geometry) {
        for (const { quads, boxes } of layoutLineLabels(shaped, line, options)) tryPlace(quads, boxes)
      }
    }
    return text.build()
  }

  /** Keeps a tile's placed labels, dropping the least recently processed past `PLACED_LABEL_CACHE_SIZE`. */
  protected rememberLabels(key: string, labels: TileLabels): void {
    this.placedLabels.delete(key)
    this.placedLabels.set(key, labels)
    if (this.placedLabels.size > PLACED_LABEL_CACHE_SIZE) this.placedLabels.delete(this.placedLabels.keys().next().value!)
  }

  /**
   * The labels a tile placed, as drawn. Laid out again when the tile was processed too long ago, or before its raw
   * tile or the style changed (the boxes would no longer match what a fresh bucket draws).
   */
  protected async getPlacedLabels(request: TileRequest, tile: VectorTileLike, layers: readonly CompiledStyleLayer[]): Promise<PlacedLabel[]> {
    const key = bucketKeyOf(request)
    const serial = tileSerial(tile)
    const known = this.placedLabels.get(key)
    if (known !== undefined && known.tileSerial === serial && known.layers === layers) return known.labels
    await this.processTile(request)
    const laidOut = this.placedLabels.get(key)
    // Laid out from another tile or style (it changed meanwhile): the caller starts the query again.
    return laidOut !== undefined && laidOut.tileSerial === serial && laidOut.layers === layers ? laidOut.labels : []
  }

  /**
   * The features drawn under a point or polygon, top-most first: labels (they draw above every shape), then
   * shapes from the top style layer down, as MapLibre orders them. Features with an id are listed once per layer
   * even when several tiles hold them.
   */
  async queryRenderedFeatures(query: RenderedFeatureQuery, attempt = 1): Promise<RenderedSourceFeature[]> {
    const layers = this.layers
    const wanted = query.layers === null ? null : new Set(query.layers)
    const filter = compileQueryFilter(query.filter)
    const hits: QueryHit[] = []
    const seen = new Set<string>()
    const add = (layer: CompiledStyleLayer, tileRequest: QueryTile, tile: VectorTileLike, sourceLayer: string, index: number, label: boolean): void => {
      const vectorFeature = tile.layers[sourceLayer]?.feature(index)
      if (vectorFeature === undefined) return
      const id = this.featureId(tileRequest.sourceId, sourceLayer, vectorFeature)
      if (id !== undefined) {
        const key = `${layer.id}\u0000${String(id)}`
        if (seen.has(key)) return
        seen.add(key)
      }
      const feature = this.toSourceFeature(tileRequest, sourceLayer, vectorFeature, id) as RenderedSourceFeature
      feature.layer = layer.layerSpecification as RenderedSourceFeature['layer']
      hits.push({ feature, label, layerIndex: layer.index, order: hits.length })
    }
    // Labels facing the viewer, hit on the screen by the main thread: above everything the tiles draw.
    for (const hit of query.screenLabels ?? []) {
      if (wanted !== null && !wanted.has(hit.layerId)) continue
      const layer = layers.find(candidate => candidate.id === hit.layerId)
      const tile = layer === undefined ? null : await this.getRawTile(hit.sourceId, hit.x, hit.y, hit.z)
      if (layer === undefined || tile === null) continue
      const tileRequest: QueryTile = { sourceId: hit.sourceId, x: hit.x, y: hit.y, z: hit.z, zoom: hit.zoom, column: hit.x, labelsOnly: true }
      if (filter !== null) {
        const vectorFeature = tile.layers[hit.sourceLayer]?.feature(hit.featureIndex)
        if (vectorFeature === undefined) continue
        const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id: this.featureId(hit.sourceId, hit.sourceLayer, vectorFeature) }
        if (!filter.filter({ zoom: hit.zoom }, feature)) continue
      }
      add(layer, tileRequest, tile, hit.sourceLayer, hit.featureIndex, true)
    }
    for (const tileRequest of query.tiles) {
      const { zoom, z } = tileRequest
      const labelLayers = new Map(layers.filter(layer => layer.type === 'symbol' && layer.source === tileRequest.sourceId && layer.isVisibleAtZoom(zoom) && (wanted === null || wanted.has(layer.id))).map(layer => [layer.id, layer]))
      if (tileRequest.labelsOnly && labelLayers.size === 0) continue
      const tile = await this.getRawTile(tileRequest.sourceId, tileRequest.x, tileRequest.y, tileRequest.z)
      if (tile === null) continue
      const scale = 2 ** z
      const inTile: QueryGeometry = query.geometry.map(point => ({ x: (point.x * scale - tileRequest.column) * TILE_EXTENT, y: ((1 - point.y) * scale - tileRequest.y) * TILE_EXTENT }))
      const unitsPerPixel = TILE_EXTENT / (TILE_SIZE_PIXELS * 2 ** (zoom - z))
      const toleranceUnits = query.tolerancePixels * unitsPerPixel
      const accepts = (layer: CompiledStyleLayer, feature: StyleFeature) => layer.accepts(zoom, feature) && (filter === null || filter.filter({ zoom }, feature))

      // Labels: the boxes the tile placed (ring tiles too: their labels reach into the region)
      if (labelLayers.size > 0) {
        for (const placed of await this.getPlacedLabels(tileRequest, tile, layers)) {
          const layer = labelLayers.get(placed.layerId)
          if (layer === undefined || !polygonIntersectsBoxes(inTile, placed.boxes, toleranceUnits)) continue
          if (filter !== null) {
            const vectorFeature = tile.layers[placed.sourceLayer]?.feature(placed.featureIndex)
            if (vectorFeature === undefined) continue
            const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id: this.featureId(tileRequest.sourceId, placed.sourceLayer, vectorFeature) }
            if (!filter.filter({ zoom }, feature)) continue
          }
          add(layer, tileRequest, tile, placed.sourceLayer, placed.featureIndex, true)
        }
      }
      if (tileRequest.labelsOnly) continue

      // Shapes: only what the tile draws, inside its square
      const clipped = clipQueryToTile(inTile)
      if (clipped.length === 0) continue
      for (let position = layers.length - 1; position >= 0; position--) {
        const layer = layers[position]!
        const hitTest = featureHitTesters.get(layer.type)
        const layerName = this.layerNameOf(layer)
        if (hitTest === undefined || layer.custom !== null || layer.source !== tileRequest.sourceId || layerName === undefined) continue
        if (!layer.isVisibleAtZoom(zoom) || (wanted !== null && !wanted.has(layer.id))) continue
        const index = getTileFeatureIndex(tile, layerName)
        if (index === null) continue
        const sourceLayer = tile.layers[layerName]!
        const margin = toleranceUnits + (layer.type === 'line' || layer.type === 'circle' ? MAXIMUM_QUERY_RADIUS_PIXELS * unitsPerPixel : 0)
        const factor = TILE_EXTENT / sourceLayer.extent
        for (const featureIndex of index.query(...queryBounds(clipped, margin))) {
          const vectorFeature = sourceLayer.feature(featureIndex)
          const id = this.featureId(tileRequest.sourceId, layerName, vectorFeature)
          const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id }
          if (!accepts(layer, feature)) continue
          const state = id === undefined ? NO_STATE : (this.featureStates.get(featureKey(tileRequest.sourceId, this.stateLayerOf(tileRequest.sourceId, layerName), id)) ?? NO_STATE)
          const geometry = scaleGeometry(vectorFeature.loadGeometry(), factor)
          if (hitTest({ layer, feature, state, type: vectorFeature.type, geometry, query: clipped, zoom, unitsPerPixel, toleranceUnits })) add(layer, tileRequest, tile, layerName, featureIndex, false)
        }
      }
    }
    // The style changed while tiles loaded: the answer would mix two styles. Ask again, once or twice.
    if (this.layers !== layers && attempt < 3) return this.queryRenderedFeatures(query, attempt + 1)
    hits.sort((a, b) => Number(b.label) - Number(a.label) || b.layerIndex - a.layerIndex || a.order - b.order)
    return hits.map(hit => hit.feature)
  }

  /**
   * Every feature of a source in the given tiles (MapLibre's `querySourceFeatures`), whether drawn or not, in tile
   * order. A feature crossing tiles is listed once per tile, clipped to each, as in MapLibre.
   */
  async querySourceFeatures(query: SourceFeatureQuery): Promise<SourceFeature[]> {
    const filter = compileQueryFilter(query.filter)
    const features: SourceFeature[] = []
    for (const { x, y, z } of query.tiles) {
      const tile = await this.getRawTile(query.sourceId, x, y, z)
      if (tile === null) continue
      const names = query.sourceLayer === null ? Object.keys(tile.layers) : [query.sourceLayer]
      for (const name of names) {
        const layer = tile.layers[name]
        if (layer === undefined) continue
        for (let index = 0; index < layer.length; index++) {
          const vectorFeature = layer.feature(index)
          const id = this.featureId(query.sourceId, name, vectorFeature)
          if (filter !== null && !filter.filter({ zoom: z }, { type: vectorFeature.type, properties: vectorFeature.properties, id })) continue
          features.push(this.toSourceFeature({ sourceId: query.sourceId, x, y, z }, name, vectorFeature, id))
          if (features.length >= MAXIMUM_SOURCE_FEATURES) return features
        }
      }
    }
    return features
  }

  /** The tile layer a style layer reads: the source's single layer (GeoJSON), or its `source-layer`. */
  protected layerNameOf(layer: CompiledStyleLayer): string | undefined {
    return (layer.source === undefined ? undefined : this.fetchers.get(layer.source)?.singleLayer) ?? layer.sourceLayer
  }

  /** The source layer feature-state keys use: none for a single-layer (GeoJSON) source. */
  protected stateLayerOf(sourceId: string, layerName: string): string | undefined {
    return this.fetchers.get(sourceId)?.singleLayer === undefined ? layerName : undefined
  }

  /** The feature's id: its own, or the property `promoteId` names. */
  protected featureId(sourceId: string, sourceLayer: string, feature: VectorTileFeatureLike): string | number | undefined {
    const promoteId = (this.document.sources[sourceId] as VectorSourceSpecification | undefined)?.promoteId
    const promoted = typeof promoteId === 'string' ? promoteId : promoteId?.[sourceLayer]
    return promoted === undefined ? feature.id : asFeatureId(feature.properties[promoted])
  }

  protected toSourceFeature(tile: { sourceId: string; x: number; y: number; z: number }, sourceLayer: string, feature: VectorTileFeatureLike, id: string | number | undefined): SourceFeature {
    const state = id === undefined ? NO_STATE : (this.featureStates.get(featureKey(tile.sourceId, this.stateLayerOf(tile.sourceId, sourceLayer), id)) ?? NO_STATE)
    return {
      type: 'Feature',
      id,
      geometry: feature.toGeoJSON(tile.x, tile.y, tile.z).geometry as FeatureGeometry,
      properties: { ...feature.properties },
      source: tile.sourceId,
      sourceLayer,
      state: { ...state },
    }
  }

  /**
   * Forgets raw tiles overlapping the rectangles (`null`: every tile), so the next request fetches them again.
   * Requests already waiting on a forgotten tile still get it.
   */
  invalidate(rectangles: readonly MercatorRectangle[] | null): void {
    for (const [key, tile] of this.fetchedTiles) if (tileOverlaps(tile.x, tile.y, tile.z, rectangles)) this.revalidatedTiles.add(key)
    for (const fetcher of this.fetchers.values()) fetcher.invalidate?.()
    for (const [key, entry] of this.rawTiles) {
      if (tileOverlaps(entry.x, entry.y, entry.z, rectangles)) this.rawTiles.delete(key)
    }
  }

  /**
   * `fetch`, through the main thread when it asked to see requests (`transformRequest`) or for a URL scheme only a
   * protocol added there can load. The main thread answers where to fetch, or the bytes.
   */
  protected async resolveAndFetch(url: string, init: RequestInit, kind: Parameters<ResourceFetch>[2]): Promise<Response> {
    const resolve = this.hooks.resolveResource
    const custom = !/^(https?|data|blob):/i.test(url)
    if (resolve === undefined || (this.options.transformsRequests !== true && !custom)) return this.networkFetch(url, init)
    const answer = await resolve({ url, kind, headers: headersToRecord(init.headers) }, init.signal ?? undefined)
    if ('data' in answer) return answer.data === null ? new Response(null, { status: 404 }) : new Response(answer.data as BlobPart, { status: 200 })
    return this.networkFetch(answer.url, { ...init, headers: answer.headers })
  }

  /** Fetches and decodes a tile once, shared by concurrent requests; aborted only when every waiter is. */
  protected getRawTile(sourceId: string, x: number, y: number, z: number, signal?: AbortSignal): Promise<VectorTileLike | null> {
    const fetcher = this.fetchers.get(sourceId)
    if (fetcher === undefined) return Promise.resolve(null)
    const key = `${sourceId}/${z}/${x}/${y}`
    let entry = this.rawTiles.get(key)
    if (entry === undefined) {
      const controller = new AbortController()
      const revalidate = this.revalidatedTiles.delete(key)
      const created: RawTileEntry = {
        x,
        y,
        z,
        controller,
        waiters: 0,
        promise: fetcher.loadTile(x, y, z, controller.signal, revalidate),
      }
      created.promise.catch(() => {
        if (revalidate) this.revalidatedTiles.add(key) // an aborted or failed refetch must not use up the revalidation
        if (this.rawTiles.get(key) === created) this.rawTiles.delete(key) // retry next time
      })
      this.rawTiles.set(key, created)
      this.fetchedTiles.delete(key)
      this.fetchedTiles.set(key, { x, y, z })
      if (this.fetchedTiles.size > 4096) this.fetchedTiles.delete(this.fetchedTiles.keys().next().value!)
      entry = created
      if (this.rawTiles.size > RAW_TILE_CACHE_SIZE) {
        for (const [oldKey, old] of this.rawTiles) {
          if (this.rawTiles.size <= RAW_TILE_CACHE_SIZE) break
          if (old.waiters === 0) this.rawTiles.delete(oldKey)
        }
      }
    } else {
      // Most recently used last.
      this.rawTiles.delete(key)
      this.rawTiles.set(key, entry)
    }
    const shared = entry
    shared.waiters++
    const onAbort = () => {
      shared.waiters--
      if (shared.waiters === 0) {
        shared.controller.abort(signal?.reason)
        if (this.rawTiles.get(key) === shared) this.rawTiles.delete(key)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    return shared.promise.finally(() => {
      if (signal?.aborted !== true) {
        signal?.removeEventListener('abort', onAbort)
        shared.waiters--
      }
    })
  }
}

/**
 * A gradient along one line of a tile: the line runs from progress `start` to `end` of the whole feature (geojson-vt's
 * clip metrics), so its colours continue across tiles.
 */
function lineGradientAlong(line: readonly Point[], start: number, end: number, ramp: readonly Rgba[], opacity: number): LineGradient {
  let length = 0
  for (let index = 1; index < line.length; index++) length += Math.hypot(line[index]!.x - line[index - 1]!.x, line[index]!.y - line[index - 1]!.y)
  const span = end - start
  const last = ramp.length - 1
  return {
    colorAt: distance => {
      const progress = Math.min(Math.max(start + (length > 0 ? (span * distance) / length : 0), 0), 1)
      const [r, g, b, a] = ramp[Math.round(progress * last)]!
      return [r, g, b, Math.round(a * opacity)]
    },
    stepUnits: length / Math.max(1, Math.ceil(Math.abs(span) / LINE_GRADIENT_STEP)),
  }
}

const tileSerials = new WeakMap<VectorTileLike, number>()
let nextTileSerial = 1

/** A number naming a decoded tile, without keeping it alive. */
function tileSerial(tile: VectorTileLike): number {
  let serial = tileSerials.get(tile)
  if (serial === undefined) tileSerials.set(tile, (serial = nextTileSerial++))
  return serial
}

/** The same key as `bucketKey` on the main thread. */
function bucketKeyOf({ sourceId, x, y, z, zoom }: TileRequest): string {
  return `${zoom}/${z}/${x}/${y}/${sourceId}`
}

/** A query's `filter` option, compiled; null without one. Throws, stating the problem, when it does not compile. */
function compileQueryFilter(filter: unknown): FeatureFilter | null {
  if (filter === null || filter === undefined) return null
  try {
    return featureFilter(filter as never, 'filter')
  } catch (error) {
    throw new Error(`MapStyleSource: the query's \`filter\` is not a valid MapLibre filter expression; check it against the style specification. ${(error as Error).message}`)
  }
}

/** A promoted id is usable when it is a number or a string, as in MapLibre. */
function asFeatureId(value: unknown): string | number | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers } as Record<string, string>
}

/** The image a `*-pattern` property names, or null when it is not set or empty. */
function patternName(layer: CompiledStyleLayer, property: string, zoom: number, feature?: StyleFeature, state?: FeatureState): string | null {
  if (!layer.has('paint', property)) return null
  const value = layer.evaluate<{ name: string } | string | undefined | null>('paint', property, zoom, feature, state)
  const name = typeof value === 'string' ? value : value?.name
  return name === undefined || name === '' ? null : name
}

/**
 * A fill pattern's mapping for one tile: `pixelRatio` image pixels per map pixel, anchored to the world's
 * top-left corner so patterns continue across tiles. The tile's offset into the repeating image is reduced
 * here, in 64-bit, so 32-bit vertex coordinates stay small at any zoom.
 */
export function planePatternMapping(rectangle: PatternRectangle, placement: TilePlacement, unitsPerPixel: number) {
  const imagePixelsPerMapPixel = rectangle.pixelRatio
  const originX = positiveModulo(placement.x * placement.tileSizePixels * imagePixelsPerMapPixel, rectangle.width)
  const originY = positiveModulo(placement.y * placement.tileSizePixels * imagePixelsPerMapPixel, rectangle.height)
  return { kind: 'plane' as const, imagePixelsPerUnit: imagePixelsPerMapPixel / unitsPerPixel, originX, originY }
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

function scaleGeometry(geometry: Point[][], factor: number): Point[][] {
  if (factor === 1) return geometry
  return geometry.map(ring => ring.map(point => ({ x: point.x * factor, y: point.y * factor })))
}

/** Where a point-placed label goes: the point itself, the middle of a line, the centre of a polygon's box. */
function representativePoint(type: VectorTileFeatureLike['type'], geometry: Point[][]): Point | null {
  const first = geometry[0]
  if (first === undefined || first.length === 0) return null
  if (type === 1) return first[0]!
  if (type === 2) {
    let total = 0
    for (let index = 1; index < first.length; index++) total += Math.hypot(first[index]!.x - first[index - 1]!.x, first[index]!.y - first[index - 1]!.y)
    let remaining = total / 2
    for (let index = 1; index < first.length; index++) {
      const a = first[index - 1]!
      const b = first[index]!
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (remaining <= length && length > 0) return { x: a.x + ((b.x - a.x) * remaining) / length, y: a.y + ((b.y - a.y) * remaining) / length }
      remaining -= length
    }
    return first.at(-1)!
  }
  let minimumX = Infinity
  let minimumY = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  for (const { x, y } of first) {
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x)
    maximumY = Math.max(maximumY, y)
  }
  return { x: (minimumX + maximumX) / 2, y: (minimumY + maximumY) / 2 }
}

function firstAnchor(layer: CompiledStyleLayer, zoom: number, feature: StyleFeature): TextAnchor {
  if (layer.has('layout', 'text-variable-anchor')) {
    const anchors = layer.evaluate<TextAnchor[] | undefined>('layout', 'text-variable-anchor', zoom, feature)
    if (anchors !== undefined && anchors.length > 0) return anchors[0]!
  }
  return layer.evaluate<TextAnchor>('layout', 'text-anchor', zoom, feature)
}

/** Replaces `{name}` with the feature's `name` property (empty when missing). */
export function resolveTokens(text: string, properties: Record<string, unknown>): string {
  return text.replace(/{([^{}]+)}/g, (_, key: string) => {
    const value = properties[key]
    return value === undefined || value === null ? '' : String(value)
  })
}
