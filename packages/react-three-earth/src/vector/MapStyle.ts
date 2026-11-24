import type { GeoJSON } from 'geojson'
import { EventDispatcher } from 'three'

import { featureKey, parseFeatureKey, type FeatureIdentifier } from './worker/featureState.js'
import type { GeoJsonSourceDiff } from './worker/geoJsonData.js'
import { APPLICABLE_COMMANDS, applyStyleCommand, copyStyleDocument, IGNORED_COMMANDS, type StyleDocument, type StyleDocumentLayer } from './worker/styleDocument.js'
import type { FeatureState, GeoJsonSourceQuery, ResourceAnswer, ResourceKind, ResourceRequest, StyleCommand } from './worker/types.js'

/**
 * Rewrites a request before it is made: another URL, extra headers (on top of `requestHeaders`). Return nothing to
 * keep it as it is. Runs on the main thread, for the style, TileJSON, tiles, glyphs and sprites.
 * @example (url, kind) => (kind === 'Tile' ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
 */
export type TransformRequest = (url: string, kind: ResourceKind) => { url?: string; headers?: Record<string, string> } | undefined | void

/** What a protocol loader receives. */
export interface ProtocolRequest {
  url: string
  kind: ResourceKind
  headers: Record<string, string>
  signal: AbortSignal
}

/**
 * Loads URLs of a custom scheme (`addProtocol('offline', loader)` serves `offline://…`): the response body, or null
 * when there is nothing there (a missing tile). JSON resources (style, TileJSON) are returned as their bytes.
 */
export type ProtocolLoader = (request: ProtocolRequest) => Promise<ArrayBuffer | Uint8Array | null>

export interface MapStyleOptions {
  /** A style URL, or the style document itself. */
  style: string | object
  /** Base URL for relative URLs inside a style passed as an object. Default: the page's URL. */
  baseUrl?: string
  /** Headers for every request. Default: none. */
  requestHeaders?: Record<string, string>
  transformRequest?: TransformRequest
  /** Custom URL schemes and their loaders, by scheme (without `://`). More with `addProtocol`. */
  protocols?: Record<string, ProtocolLoader>
}

/**
 * Events of a style: `styledata` after it loaded or changed, `sourcedata` when a source was added, removed or replaced,
 * or its data (GeoJSON) changed, `error`.
 */
export interface MapStyleEventMap {
  styledata: object
  sourcedata: { sourceId: string; change: 'add' | 'remove' | 'data' }
  error: { error: Error }
}

/** One change, as the overlays drawing the style receive it. */
export type MapStyleChange =
  | { type: 'command'; command: StyleCommand }
  | { type: 'featureState'; key: string; state: FeatureState | null }
  /** The style changed in a way commands cannot express (new glyphs, sprite, base URL): start again from a snapshot. */
  | { type: 'reload' }

export interface SequencedStyleChange {
  /** Increases by one per change; compare with `sequence` at the time of a `snapshot`. */
  sequence: number
  change: MapStyleChange
}

/** Everything a renderer needs to start drawing the style as it is now. */
export interface StyleSnapshot {
  style: StyleDocument
  baseUrl: string
  featureStates: Array<[string, FeatureState]>
  globalState: Record<string, unknown>
  transformsRequests: boolean
}

/** A layer kept across `setStyle` (layers added by `StyleLayer`), with where to put it back. */
export interface ManagedStyleLayer {
  readonly id: string
  readonly beforeId: string | undefined
}

/** A source kept across `setStyle` (sources added by `GeoJsonSource`): it replaces a source of the same id. */
export interface ManagedStyleSource {
  readonly id: string
}

/** Answers source queries (cluster lookups) through a renderer's worker. */
export type SourceQueryHandler = (sourceId: string, query: GeoJsonSourceQuery) => Promise<unknown>

const NO_STATE: FeatureState = Object.freeze({}) as FeatureState

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** A copy of a source object, keeping its GeoJSON `data` by reference (it can be large, and is treated as immutable). */
function cloneSource(source: object): object {
  const { data, ...rest } = source as { data?: unknown }
  return data === undefined ? clone(rest) : { ...clone(rest), data }
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The main thread's model of a MapLibre style: the document as it is now, feature-state, `global-state` values,
 * request rewriting and protocols. Setters check their arguments against the document (and throw an error that
 * states the fix), apply the change, and hand it to the overlays drawing the style, batched per microtask.
 * Changes made before the style has loaded are kept and applied once it has.
 *
 * `MapStyleSource` exposes it as its style API; a `MapStyleOverlay` created on its own makes its own.
 */
/** Root properties MapLibre's style diff sets with commands the renderer skips (`IGNORED_COMMANDS`). */
const ROOT_PROPERTIES = ['center', 'centerAltitude', 'zoom', 'bearing', 'pitch', 'roll', 'transition', 'light', 'terrain', 'sky', 'projection'] as const

export class MapStyle extends EventDispatcher<MapStyleEventMap> {
  /** The style as it is now; null until it has loaded. */
  protected document: StyleDocument | null = null
  protected baseUrl: string | null = null
  protected source: string | object
  protected loading: Promise<void> | null = null
  protected loadError: unknown = null
  /** The fetch the style loaded with (the overlay's, through `preprocessURL`); `setStyle` fetches with it too. */
  protected fetchFunction: typeof fetch | undefined = globalThis.fetch?.bind(globalThis)
  /** Counts `setStyle` calls: a call whose style resolves after a later call started is dropped. */
  protected styleGeneration = 0
  /** `setStyle` calls in progress; commands made meanwhile wait in `held`, then apply to the new style. */
  protected stylesPending = 0
  /** `whenSettled` calls waiting for the load or the pending `setStyle` calls. */
  protected settleWaiters: Array<() => void> = []
  protected readonly held: StyleCommand[] = []
  protected readonly options: MapStyleOptions
  protected readonly protocols = new Map<string, ProtocolLoader>()
  /** Commands made before the style loaded, applied in order once it has. */
  protected readonly early: StyleCommand[] = []
  protected readonly featureStates = new Map<string, FeatureState>()
  protected readonly globalStateOverrides = new Map<string, unknown>()
  protected readonly managed = new Map<string, ManagedStyleLayer>()
  protected readonly managedSources = new Map<string, ManagedStyleSource>()
  /** Renderers able to answer source queries, oldest first; queries wait in `queryWaiters` until one is there. */
  protected readonly queryHandlers: SourceQueryHandler[] = []
  protected queryWaiters: Array<() => void> = []
  protected readonly listeners = new Set<(changes: SequencedStyleChange[]) => void>()
  protected pending: SequencedStyleChange[] = []
  protected pendingEvents: Array<{ type: keyof MapStyleEventMap; event: MapStyleEventMap[keyof MapStyleEventMap] }> = []
  protected flushScheduled = false
  protected currentSequence = 0

  constructor(options: MapStyleOptions) {
    super()
    this.options = options
    this.source = options.style
    for (const [scheme, loader] of Object.entries(options.protocols ?? {})) this.addProtocol(scheme, loader)
  }

  /** The number of the latest change. */
  get sequence(): number {
    return this.currentSequence
  }

  get isLoaded(): boolean {
    return this.document !== null
  }

  /** Loaded, with no `setStyle` in progress: the document reflects every change made so far. */
  get isSettled(): boolean {
    return this.document !== null && this.stylesPending === 0
  }

  /** Resolves once the style is settled (loaded, no `setStyle` in progress); never when it fails to load. */
  whenSettled(): Promise<void> {
    if (this.isSettled) return Promise.resolve()
    return new Promise(resolve => this.settleWaiters.push(resolve))
  }

  protected resolveSettled(): void {
    if (this.isSettled) for (const resolve of this.settleWaiters.splice(0)) resolve()
  }

  /** Whether loading the style failed (a wrong URL, for example): `MapStyleSource` must be created again. */
  get loadFailed(): boolean {
    return this.loadError !== null
  }

  /** Loads the style once (fetching its URL through `transformRequest` and protocols); later calls share it. */
  load(fetchFunction: typeof fetch = globalThis.fetch?.bind(globalThis)): Promise<void> {
    this.loading ??= (async () => {
      this.fetchFunction = fetchFunction
      try {
        const { style, baseUrl } = await this.resolve(this.source, fetchFunction)
        this.adopt(copyStyleDocument(style), baseUrl)
      } catch (error) {
        this.loadError = error
        throw error
      }
      this.replay(this.early)
      this.queueEvent('styledata', {})
      this.resolveSettled()
    })()
    return this.loading
  }

  /** The style now, with the feature-state and `global-state` values set so far. Needs the style loaded. */
  snapshot(): StyleSnapshot {
    if (this.document === null || this.baseUrl === null) throw new Error('MapStyle: snapshot() needs the style loaded; await load() first.')
    return {
      style: clone(this.document),
      baseUrl: this.baseUrl,
      featureStates: [...this.featureStates],
      globalState: Object.fromEntries(this.globalStateOverrides),
      transformsRequests: this.options.transformRequest !== undefined,
    }
  }

  /** Receives every change from now on, batched per microtask. Returns a function that stops it. */
  subscribe(listener: (changes: SequencedStyleChange[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Reading

  /** A copy of the style as it is now (null before it has loaded). */
  getStyle(): StyleDocument | null {
    return this.document === null ? null : clone(this.document)
  }

  /** The URL the style's relative URLs resolve against (null before it has loaded). */
  getBaseUrl(): string | null {
    return this.baseUrl
  }

  /** A copy of a layer, or undefined (also before the style has loaded). */
  getLayer(layerId: string): StyleDocumentLayer | undefined {
    return clone(this.document?.layers.find(layer => layer.id === layerId))
  }

  /** A copy of a layer's `metadata`, or undefined: cheaper than `getLayer` for renderers reading it per tile. */
  getLayerMetadata(layerId: string): unknown {
    return clone(this.document?.layers.find(layer => layer.id === layerId)?.metadata)
  }

  /** The ids of the style's layers, bottom first. */
  getLayerIds(): string[] {
    return this.document?.layers.map(layer => layer.id) ?? []
  }

  /** Whether the style has a source of this id (without copying it, unlike `getSource`). */
  hasSource(sourceId: string): boolean {
    return this.document?.sources[sourceId] !== undefined
  }

  /** The ids of the layers reading a source, bottom first. */
  getLayerIdsReadingSource(sourceId: string): string[] {
    return this.document?.layers.filter(layer => layer.source === sourceId).map(layer => layer.id) ?? []
  }

  getSource(sourceId: string): object | undefined {
    return clone(this.document?.sources[sourceId])
  }

  getPaintProperty(layerId: string, name: string): unknown {
    return clone(this.document?.layers.find(layer => layer.id === layerId)?.paint?.[name])
  }

  getLayoutProperty(layerId: string, name: string): unknown {
    return clone(this.document?.layers.find(layer => layer.id === layerId)?.layout?.[name])
  }

  getFilter(layerId: string): unknown {
    return clone(this.document?.layers.find(layer => layer.id === layerId)?.filter)
  }

  /** The `global-state` values: the style root `state` defaults, overridden by `setGlobalStateProperty`. */
  getGlobalState(): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(this.document?.state ?? {})) if (entry?.default !== undefined) values[name] = clone(entry.default)
    for (const [name, value] of this.globalStateOverrides) values[name] = clone(value)
    return values
  }

  // Changing layers and sources

  setPaintProperty(layerId: string, name: string, value: unknown): void {
    this.command({ command: 'setPaintProperty', args: [layerId, name, value] })
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    this.command({ command: 'setLayoutProperty', args: [layerId, name, value] })
  }

  /** `null` or `undefined` removes the filter. */
  setFilter(layerId: string, filter: unknown): void {
    this.command({ command: 'setFilter', args: [layerId, filter ?? undefined] })
  }

  /** MapLibre's zoom range: the minimum is inclusive, the maximum exclusive. `undefined` removes a bound. */
  setLayerZoomRange(layerId: string, minimumZoom: number | undefined, maximumZoom: number | undefined): void {
    this.command({ command: 'setLayerZoomRange', args: [layerId, minimumZoom, maximumZoom] })
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    this.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  }

  /** Adds a layer (a MapLibre layer object) below `beforeId`, or on top. */
  addLayer(layer: object, beforeId?: string): void {
    this.command({ command: 'addLayer', args: [clone(layer), beforeId] })
  }

  removeLayer(layerId: string): void {
    this.command({ command: 'removeLayer', args: [layerId] })
  }

  /** Moves a layer below `beforeId`, or on top. */
  moveLayer(layerId: string, beforeId?: string): void {
    this.command({ command: 'moveLayer', args: [layerId, beforeId] })
  }

  /** Adds a source (a MapLibre source object; `vector` sources are drawn). Layers can read it once added. */
  addSource(sourceId: string, source: object): void {
    this.command({ command: 'addSource', args: [sourceId, cloneSource(source)] })
  }

  /** Removes a source; remove the layers reading it first. */
  removeSource(sourceId: string): void {
    this.command({ command: 'removeSource', args: [sourceId] })
  }

  /** Adds a source, or replaces the source of that id while its layers keep reading it (used by `GeoJsonSource`). */
  setSource(sourceId: string, source: object): void {
    this.command({ command: 'setSource', args: [sourceId, cloneSource(source)] })
  }

  /**
   * Replaces a `geojson` source's data: GeoJSON, or a URL (fetched through `transformRequest` and protocols). The
   * object is kept, not copied: treat it as immutable from then on (pass a new object for the next change). Only
   * the regions where the old or the new data lie are redrawn.
   */
  setGeoJsonSourceData(sourceId: string, data: GeoJSON | string): void {
    this.command({ command: 'setGeoJSONSourceData', args: [sourceId, data] })
  }

  /**
   * Changes a `geojson` source's features by id (MapLibre's `updateData`): add, remove or update some features
   * without sending the whole data again. Every feature needs an id (`id`, or the `promoteId` property). Only the
   * regions around the changed features are redrawn (around the whole data when points are clustered).
   */
  updateGeoJsonSourceData(sourceId: string, diff: GeoJsonSourceDiff): void {
    this.command({ command: 'updateGeoJSONSourceData', args: [sourceId, clone(diff)] })
  }

  /**
   * Asks a `geojson` source about its clusters, after every change made so far. Resolves once a renderer (an
   * `Imagery` layer drawing the style) has loaded the style.
   */
  async querySource(sourceId: string, query: GeoJsonSourceQuery): Promise<unknown> {
    // A pending setStyle holds the changes made meanwhile: answer from the data once they are applied.
    await this.whenSettled()
    const source = this.document?.sources[sourceId]
    if (this.document !== null && source === undefined) throw new Error(`GeoJsonSource: there is no source "${sourceId}" in the style; use a source id from getStyle().sources.`)
    if (source !== undefined && source.type !== 'geojson') throw new Error(`GeoJsonSource: source "${sourceId}" is a ${source.type} source; clusters belong to geojson sources.`)
    // After the changes made so far reach the renderers (they are handed over in a microtask queued before this one)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    while (this.queryHandlers.length === 0) await new Promise<void>(resolve => this.queryWaiters.push(resolve))
    return this.queryHandlers[0]!(sourceId, query)
  }

  /** Lets a renderer answer source queries; returns a function that stops it. */
  attachSourceQueryHandler(handler: SourceQueryHandler): () => void {
    this.queryHandlers.push(handler)
    for (const resolve of this.queryWaiters.splice(0)) resolve()
    return () => {
      const position = this.queryHandlers.indexOf(handler)
      if (position !== -1) this.queryHandlers.splice(position, 1)
    }
  }

  /** Sets a `global-state` value read by `['global-state', name]`; `undefined` returns it to the style's default. */
  setGlobalStateProperty(name: string, value: unknown): void {
    if (sameValue(this.globalStateOverrides.get(name), value) && this.globalStateOverrides.has(name) === (value !== undefined)) return
    if (value === undefined) this.globalStateOverrides.delete(name)
    else this.globalStateOverrides.set(name, clone(value))
    // Before load, the snapshot carries the value: nothing to send.
    if (this.document !== null) this.emit({ type: 'command', command: { command: 'setGlobalStateProperty', args: [name, clone(value)] } })
    this.queueEvent('styledata', {})
  }

  /**
   * Replaces the style. With `diff` (the default), only what differs is applied (the style specification's
   * `diff`, as MapLibre does), so unchanged tiles are not processed again; a change no command expresses (glyphs,
   * sprite, another base URL) reloads it. Layers added with `StyleLayer` are kept.
   *
   * The new style applies asynchronously (a URL is fetched, the diff is loaded on first use). Changes made
   * meanwhile (`setPaintProperty`, `addLayer`…) apply after it, to the new style; when calls overlap, the last
   * one wins.
   */
  async setStyle(style: string | object, { diff = true }: { diff?: boolean } = {}): Promise<void> {
    const generation = ++this.styleGeneration
    if (this.document === null && this.loading === null) {
      this.source = style // not loading yet: load this one instead
      return
    }
    this.stylesPending++
    try {
      if (this.document === null) await this.loading
      const [{ style: next, baseUrl }, diffStyles] = await Promise.all([
        this.resolve(style, this.fetchFunction),
        diff ? import('@maplibre/maplibre-gl-style-spec').then(module => module.diff) : null,
      ])
      if (generation !== this.styleGeneration) return // a later call replaced it
      this.replaceStyle(copyStyleDocument(next), baseUrl, diffStyles)
    } finally {
      if (--this.stylesPending === 0) {
        // The first style never loaded: the source must be created again, so the held changes have nowhere to go.
        if (this.document === null) this.held.length = 0
        else this.replay(this.held, { skipRemovedLayers: true })
        this.resolveSettled()
      }
    }
  }

  /** Applies a resolved style: the diff's commands when they express it, a reload otherwise. Synchronous. */
  protected replaceStyle(next: StyleDocument, baseUrl: string, diffStyles: ((before: never, after: never) => unknown[]) | null): void {
    const current = this.document!
    const target = this.withManagedLayers(next, current)
    let commands: StyleCommand[] | null = null
    if (diffStyles !== null && baseUrl === this.baseUrl) {
      const all = diffStyles(current as never, target as never) as Array<{ command: string; args: unknown[] }>
      const relevant = all.filter(command => !IGNORED_COMMANDS.has(command.command))
      if (relevant.every(command => APPLICABLE_COMMANDS.has(command.command))) commands = relevant as StyleCommand[]
    }
    if (commands !== null) {
      // Applied to a copy first: if one does not apply, reload instead of stopping halfway.
      const scratch = copyStyleDocument(current)
      try {
        for (const command of commands) applyStyleCommand(scratch, command)
      } catch {
        commands = null
      }
    }
    if (commands === null) {
      this.adopt(target, baseUrl)
      this.emit({ type: 'reload' })
      for (const id of Object.keys(current.sources)) if (target.sources[id] === undefined) this.queueEvent('sourcedata', { sourceId: id, change: 'remove' })
      for (const id of Object.keys(target.sources)) if (current.sources[id] === undefined) this.queueEvent('sourcedata', { sourceId: id, change: 'add' })
    } else {
      for (const command of commands) this.applyLocally(command)
      // MapLibre's diff ignores `metadata`, which the renderer reads too (symbol effects): take the new values.
      const targetLayers = new Map(target.layers.map(layer => [layer.id, layer]))
      for (const layer of this.document!.layers) {
        const metadata = targetLayers.get(layer.id)?.metadata
        if (metadata === undefined) delete layer.metadata
        else layer.metadata = clone(metadata)
      }
      // The diff's root commands draw nothing (`IGNORED_COMMANDS`), but `getStyle` and the earth read the new values.
      for (const key of ROOT_PROPERTIES) {
        if (target[key] === undefined) delete this.document![key]
        else this.document![key] = clone(target[key])
      }
    }
    this.queueEvent('styledata', {})
  }

  // Feature-state

  /** Merges `state` into the feature's state, as MapLibre does. Paint properties read it with `['feature-state', name]`. */
  setFeatureState(feature: FeatureIdentifier, state: FeatureState): void {
    this.checkFeature(feature, 'setFeatureState', true)
    const key = featureKey(feature.source, this.stateLayer(feature), feature.id)
    const previous = this.featureStates.get(key) ?? NO_STATE
    const next = { ...previous, ...clone(state) }
    if (sameValue(previous, next)) return
    this.featureStates.set(key, next)
    this.emit({ type: 'featureState', key, state: next })
  }

  /**
   * Removes one key of a feature's state, the whole state of a feature (no `key`), or every feature's state of the
   * source (no `id`; of the source layer when given).
   */
  removeFeatureState(feature: Omit<FeatureIdentifier, 'id'> & { id?: string | number }, key?: string): void {
    this.checkFeature(feature, 'removeFeatureState', false)
    if (feature.id === undefined) {
      if (key !== undefined) throw new Error('MapStyleSource.removeFeatureState: removing one key needs a feature `id` too.')
      for (const existing of [...this.featureStates.keys()]) {
        const parsed = parseFeatureKey(existing)
        const sourceLayer = this.stateLayer(feature)
        if (parsed.source !== feature.source || (sourceLayer !== undefined && parsed.sourceLayer !== sourceLayer)) continue
        this.featureStates.delete(existing)
        this.emit({ type: 'featureState', key: existing, state: null })
      }
      return
    }
    const id = featureKey(feature.source, this.stateLayer(feature), feature.id)
    const previous = this.featureStates.get(id)
    if (previous === undefined) return
    if (key === undefined || Object.keys(previous).length === 1 && key in previous) {
      this.featureStates.delete(id)
      this.emit({ type: 'featureState', key: id, state: null })
      return
    }
    if (!(key in previous)) return
    const { [key]: _removed, ...rest } = previous
    this.featureStates.set(id, rest)
    this.emit({ type: 'featureState', key: id, state: rest })
  }

  /** A copy of the feature's state (empty when none was set). */
  getFeatureState(feature: FeatureIdentifier): FeatureState {
    return clone(this.featureStates.get(featureKey(feature.source, this.stateLayer(feature), feature.id)) ?? {})
  }

  // Requests

  /** Serves URLs of a custom scheme (`scheme://…`) with `loader`, for every request the style makes. */
  addProtocol(scheme: string, loader: ProtocolLoader): void {
    const name = scheme.replace(/:\/\/$|:$/, '').toLowerCase()
    if (['http', 'https', 'data', 'blob', 'pmtiles'].includes(name)) throw new Error(`MapStyleSource.addProtocol: "${name}" is built in; pick another scheme.`)
    this.protocols.set(name, loader)
  }

  removeProtocol(scheme: string): void {
    this.protocols.delete(scheme.replace(/:\/\/$|:$/, '').toLowerCase())
  }

  /**
   * Applies `transformRequest`, then a protocol loader for the URL's scheme: answers the bytes, or where to fetch.
   * The worker routes its requests here when needed.
   */
  async resolveResource(request: ResourceRequest, signal: AbortSignal = new AbortController().signal): Promise<ResourceAnswer> {
    let { url } = request
    let headers = { ...(this.options.requestHeaders ?? {}), ...request.headers }
    const transformed = this.options.transformRequest?.(url, request.kind)
    if (transformed) {
      url = transformed.url ?? url
      headers = { ...headers, ...(transformed.headers ?? {}) }
    }
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    const loader = scheme === undefined ? undefined : this.protocols.get(scheme)
    if (loader !== undefined) {
      const data = await loader({ url, kind: request.kind, headers, signal })
      // A copy: the bytes are transferred to the worker, which would empty the loader's own buffer.
      return { data: data === null ? null : data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)) }
    }
    if (scheme !== undefined && !['http', 'https', 'data', 'blob'].includes(scheme)) {
      throw new Error(`MapStyleSource: nothing loads "${scheme}://" URLs (${url}); register a loader with addProtocol('${scheme}', loader).`)
    }
    return { url, headers }
  }

  // Layers kept across setStyle

  /** Keeps a layer across `setStyle` (used by `StyleLayer`). */
  manageLayer(layer: ManagedStyleLayer): void {
    this.managed.set(layer.id, layer)
  }

  unmanageLayer(layer: ManagedStyleLayer): void {
    if (this.managed.get(layer.id) === layer) this.managed.delete(layer.id)
  }

  /** Keeps a source across `setStyle`, over a source of the same id in the new style (used by `GeoJsonSource`). */
  manageSource(source: ManagedStyleSource): void {
    this.managedSources.set(source.id, source)
  }

  unmanageSource(source: ManagedStyleSource): void {
    if (this.managedSources.get(source.id) === source) this.managedSources.delete(source.id)
  }

  /** Whether a `GeoJsonSource` (or another managed source) holds this source id. */
  isSourceManaged(sourceId: string): boolean {
    return this.managedSources.has(sourceId)
  }

  /** Reports an error: an `error` event, and a console warning when nothing listens. */
  reportError(error: Error): void {
    this.queueEvent('error', { error })
  }

  // Internals

  protected command(command: StyleCommand): void {
    // A pending setStyle first: a change made while it waits for the first load belongs to the new style.
    if (this.stylesPending > 0) this.held.push(command)
    else if (this.document === null) this.early.push(command)
    else this.applyLocally(command)
  }

  /** Applies queued commands in order; one that no longer applies is reported, not thrown. */
  protected replay(commands: StyleCommand[], { skipRemovedLayers = false } = {}): void {
    for (const command of commands.splice(0)) {
      // A layer removed while queued may be gone already (setStyle dropped it): nothing left to do.
      if (skipRemovedLayers && command.command === 'removeLayer' && !this.document!.layers.some(layer => layer.id === command.args[0])) continue
      try {
        this.applyLocally(command)
      } catch (error) {
        this.reportError(error as Error)
      }
    }
  }

  protected applyLocally(command: StyleCommand): void {
    applyStyleCommand(this.document!, command)
    this.emit({ type: 'command', command })
    this.queueEvent('styledata', {})
    if (command.command === 'addSource' || command.command === 'removeSource' || command.command === 'setSource') {
      this.queueEvent('sourcedata', { sourceId: command.args[0], change: command.command === 'removeSource' ? 'remove' : 'add' })
    }
    if (command.command === 'setGeoJSONSourceData' || command.command === 'updateGeoJSONSourceData') this.queueEvent('sourcedata', { sourceId: command.args[0], change: 'data' })
  }

  protected adopt(document: StyleDocument, baseUrl: string): void {
    this.document = document
    this.baseUrl = baseUrl
  }

  protected async resolve(style: string | object, fetchFunction: typeof fetch | undefined): Promise<{ style: unknown; baseUrl: string }> {
    const pageUrl = typeof location === 'undefined' ? undefined : location.href
    if (typeof style !== 'string') {
      const baseUrl = this.options.baseUrl ?? pageUrl
      if (baseUrl === undefined) throw new Error('MapStyleSource: pass `baseUrl` with a style object outside a browser page.')
      return { style, baseUrl }
    }
    const url = /^[a-z][a-z0-9+.-]*:/i.test(style) ? style : new URL(style, pageUrl).href
    const answer = await this.resolveResource({ url, kind: 'Style', headers: {} })
    if ('data' in answer) {
      if (answer.data === null) throw new Error(`MapStyleSource: the protocol loader found no style at ${url}.`)
      return { style: JSON.parse(new TextDecoder().decode(answer.data)), baseUrl: url }
    }
    if (fetchFunction === undefined) throw new Error('MapStyleSource: no fetch to load the style with.')
    const response = await fetchFunction(answer.url, { headers: answer.headers })
    if (!response.ok) throw new Error(`MapStyleSource: style ${answer.url} answered ${response.status}.`)
    return { style: await response.json(), baseUrl: url }
  }

  /** Puts the managed layers missing from `next` back, where they were relative to `beforeId`, as they are now. */
  protected withManagedLayers(next: StyleDocument, current: StyleDocument): StyleDocument {
    for (const { id } of this.managedSources.values()) if (current.sources[id] !== undefined) next.sources[id] = current.sources[id]!
    for (const { id, beforeId } of this.managed.values()) {
      const layer = current.layers.find(existing => existing.id === id)
      if (layer === undefined || next.layers.some(existing => existing.id === id)) continue
      if (layer.source !== undefined && next.sources[layer.source] === undefined && current.sources[layer.source] !== undefined) {
        next.sources[layer.source] = current.sources[layer.source]!
      }
      const position = beforeId === undefined ? -1 : next.layers.findIndex(existing => existing.id === beforeId)
      next.layers.splice(position === -1 ? next.layers.length : position, 0, layer)
    }
    return next
  }

  /** The source layer a feature's state is keyed by: none for a geojson source (its tiles have one layer). */
  protected stateLayer(feature: { source: string; sourceLayer?: string }): string | undefined {
    return this.document?.sources[feature.source]?.type === 'geojson' ? undefined : feature.sourceLayer
  }

  protected checkFeature(feature: { source: string; sourceLayer?: string; id?: string | number }, method: string, needsId: boolean): void {
    if (needsId && (feature.id === undefined || feature.id === null || feature.id === '')) {
      throw new Error(`MapStyleSource.${method}: the feature needs an \`id\`. Vector tiles without ids need \`promoteId\` on their source.`)
    }
    if (this.document === null) return
    const source = this.document.sources[feature.source]
    if (source === undefined) throw new Error(`MapStyleSource.${method}: there is no source "${feature.source}" in the style; use a source id from getStyle().sources.`)
    if (source.type === 'vector' && feature.sourceLayer === undefined) {
      throw new Error(`MapStyleSource.${method}: source "${feature.source}" is a vector source; pass \`sourceLayer\` too.`)
    }
  }

  protected emit(change: MapStyleChange): void {
    this.currentSequence++
    this.pending.push({ sequence: this.currentSequence, change })
    this.scheduleFlush()
  }

  protected queueEvent<T extends keyof MapStyleEventMap>(type: T, event: MapStyleEventMap[T]): void {
    if (type === 'styledata' && this.pendingEvents.some(pending => pending.type === 'styledata')) return
    this.pendingEvents.push({ type, event })
    this.scheduleFlush()
  }

  protected scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  protected flush(): void {
    this.flushScheduled = false
    const changes = this.pending
    const events = this.pendingEvents
    this.pending = []
    this.pendingEvents = []
    if (changes.length > 0) for (const listener of [...this.listeners]) listener(changes)
    for (const { type, event } of events) {
      if (type === 'error' && !this.hasListeners('error')) console.warn((event as MapStyleEventMap['error']).error.message)
      this.dispatchEvent({ type, ...event } as never)
    }
  }

  protected hasListeners(type: keyof MapStyleEventMap): boolean {
    const listeners = (this as unknown as { _listeners?: Record<string, unknown[]> })._listeners
    return (listeners?.[type]?.length ?? 0) > 0
  }
}
