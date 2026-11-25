import type { WorkerLayerTypeDescriptor } from '../plugins/styleLayerTypes.js'
import type { MapStyleProcessor } from './worker/MapStyleProcessor.js'
import type { MercatorRectangle } from './worker/rectangles.js'
import type {
  AtlasUpdate,
  FeatureColorUpdate,
  FeatureStateChange,
  GeoJsonSourceQuery,
  ImageAtlasUpdate,
  ImageChange,
  MapStyleProcessorOptions,
  MapStyleSummary,
  RenderedFeatureQuery,
  RenderedSourceFeature,
  ResourceAnswer,
  ResourceRequest,
  StyleCommand,
  StyleImage,
  SourceFeature,
  SourceFeatureQuery,
  StyleUpdateResult,
  TileBucket,
  TileRequest,
  WorkerRequest,
  WorkerResponse,
} from './worker/types.js'

/** Where a style's tiles are processed: a worker by default, the main thread as a fallback. */
export interface MapStyleBackend {
  init(options: MapStyleProcessorOptions): Promise<MapStyleSummary>
  /** Replaces the whole style (when no diff applies), keeping the glyph atlas and colour slots. */
  reload(options: MapStyleProcessorOptions): Promise<MapStyleSummary>
  /** Resolves after the bucket's glyph atlas changes were handed to `onAtlasUpdate`. */
  processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket>
  /** Forgets cached raw tiles overlapping the rectangles (`null`: all); later `processTile` calls fetch again. */
  invalidate(rectangles: MercatorRectangle[] | null): void
  /** Applies style commands; tiles requested after this call see them. */
  updateStyle(commands: StyleCommand[]): Promise<StyleUpdateResult>
  /** Applies feature-state changes; resolves after their slot colours were handed to `onFeatureColorUpdate`. */
  updateFeatureStates(changes: FeatureStateChange[]): Promise<void>
  /** Adds, replaces (`image`) or removes (`null`) a runtime image; requests sent after it see the change. */
  setImage(id: string, image: StyleImage | null): Promise<ImageChange>
  /** Replaces the custom layer types (plugins), keeping the raw tiles; requests sent after it see them. */
  setLayerTypes(layerTypes: WorkerLayerTypeDescriptor[]): Promise<StyleUpdateResult>
  /** Asks a source a question (the clusters of a `geojson` source); sees every change sent before it. */
  querySource(sourceId: string, query: GeoJsonSourceQuery): Promise<unknown>
  /** Hit-tests the features drawn under a point or polygon, top-most first. */
  queryRenderedFeatures(query: RenderedFeatureQuery): Promise<RenderedSourceFeature[]>
  /** Reads every feature of a source in the given tiles. */
  querySourceFeatures(query: SourceFeatureQuery): Promise<SourceFeature[]>
  dispose(): void
}

export type AtlasUpdateListener = (update: AtlasUpdate) => void
export type ImageAtlasUpdateListener = (update: ImageAtlasUpdate) => void

/** What a backend reports to, and asks of, the overlay. */
export interface MapStyleBackendHost {
  onAtlasUpdate: AtlasUpdateListener
  onFeatureColorUpdate: (update: FeatureColorUpdate) => void
  onImageAtlasUpdate?: ImageAtlasUpdateListener
  /** Resolves a request through `transformRequest` and protocols (requests the worker routes here). */
  resolveResource?: (request: ResourceRequest, signal?: AbortSignal) => Promise<ResourceAnswer>
}

/**
 * Starts the vector tile worker shipped with the library. Bundlers that do not follow
 * `new Worker(new URL(…, import.meta.url))` can pass their own factory as `createWorker`.
 */
export function createVectorTileWorker(): Worker {
  // The build rewrites this path to the bundled worker (dist/vector-worker.js).
  return new Worker(new URL('./worker/vectorTileWorker.ts', import.meta.url), { type: 'module', name: 'earthkit vector tiles' })
}

interface Pending {
  resolve: (value: never) => void
  reject: (reason: unknown) => void
}

/** Runs the processor in a dedicated worker; typed arrays come back transferred, not copied. */
export class WorkerMapStyleBackend implements MapStyleBackend {
  protected readonly worker: Worker
  protected readonly pending = new Map<number, Pending>()
  /** Resource requests of the worker being resolved here, by the worker's id. */
  protected readonly resources = new Map<number, AbortController>()
  protected nextId = 1
  /** Rejects when the worker script cannot start, so the caller can fall back to the main thread. */
  protected readonly failed: Promise<never>
  /** Set once the worker failed: later calls reject at once instead of waiting on a dead worker. */
  protected failure: Error | null = null

  constructor(
    worker: Worker,
    protected readonly host: MapStyleBackendHost,
  ) {
    this.worker = worker
    let fail: (reason: unknown) => void = () => {}
    this.failed = new Promise<never>((_, reject) => (fail = reject))
    this.failed.catch(() => {})
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => this.receive(data)
    worker.onerror = event => {
      event.preventDefault()
      const error = new Error(`MapStyleSource worker failed: ${event.message || 'the script could not load'}`)
      this.failure = error
      fail(error)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }

  init(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    return Promise.race([this.call<MapStyleSummary>({ type: 'init', id: this.nextId++, options }), this.failed])
  }

  reload(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    return this.call<MapStyleSummary>({ type: 'reload', id: this.nextId++, options })
  }

  processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket> {
    signal?.throwIfAborted()
    const id = this.nextId++
    const result = this.call<TileBucket>({ type: 'tile', id, request })
    if (signal === undefined) return result
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      result.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  invalidate(rectangles: MercatorRectangle[] | null): void {
    this.worker.postMessage({ type: 'invalidate', rectangles } satisfies WorkerRequest)
  }

  updateStyle(commands: StyleCommand[]): Promise<StyleUpdateResult> {
    return this.call<StyleUpdateResult>({ type: 'style', id: this.nextId++, commands })
  }

  setLayerTypes(layerTypes: WorkerLayerTypeDescriptor[]): Promise<StyleUpdateResult> {
    return this.call<StyleUpdateResult>({ type: 'layerTypes', id: this.nextId++, layerTypes })
  }

  querySource(sourceId: string, query: GeoJsonSourceQuery): Promise<unknown> {
    return this.call<unknown>({ type: 'sourceQuery', id: this.nextId++, sourceId, query })
  }

  async updateFeatureStates(changes: FeatureStateChange[]): Promise<void> {
    await this.call<null>({ type: 'featureState', id: this.nextId++, changes })
  }

  queryRenderedFeatures(query: RenderedFeatureQuery): Promise<RenderedSourceFeature[]> {
    return this.call<RenderedSourceFeature[]>({ type: 'queryRendered', id: this.nextId++, query })
  }

  querySourceFeatures(query: SourceFeatureQuery): Promise<SourceFeature[]> {
    return this.call<SourceFeature[]>({ type: 'querySource', id: this.nextId++, query })
  }

  setImage(imageId: string, image: StyleImage | null): Promise<ImageChange> {
    // A copy: the caller keeps its pixels for overlays created later.
    const copy = image === null ? null : { ...image, data: image.data.slice() }
    return this.call<ImageChange>({ type: 'image', id: this.nextId++, imageId, image: copy }, copy === null ? [] : [copy.data.buffer as ArrayBuffer])
  }

  dispose(): void {
    this.worker.terminate()
    const error = new DOMException('MapStyleSource: disposed', 'AbortError')
    this.failure = error as Error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const controller of this.resources.values()) controller.abort(error)
    this.resources.clear()
  }

  protected call<T>(message: Extract<WorkerRequest, { id: number }>, transfer: Transferable[] = []): Promise<T> {
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as (value: never) => void, reject })
      this.worker.postMessage(message, transfer)
    })
  }

  protected receive(response: WorkerResponse): void {
    if (response.type === 'resource') {
      this.resolveResource(response.id, response.request)
      return
    }
    if (response.type === 'resource-cancel') {
      this.resources.get(response.id)?.abort(new DOMException('cancelled', 'AbortError'))
      this.resources.delete(response.id)
      return
    }
    // Glyphs, images and slot colours first, even for a request that was cancelled meanwhile: later buckets rely on them.
    if (response.featureColors !== undefined && response.featureColors !== null) this.host.onFeatureColorUpdate(response.featureColors)
    if (response.type === 'result') {
      const atlas = (response.value as Partial<TileBucket> | null)?.atlas
      if (atlas !== undefined && atlas !== null) this.host.onAtlasUpdate(atlas)
      if (response.imageAtlas != null) this.host.onImageAtlasUpdate?.(response.imageAtlas)
    }
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (response.type === 'result') pending.resolve(response.value as never)
    else pending.reject(response.name === 'AbortError' ? new DOMException(response.message, 'AbortError') : new Error(response.message))
  }

  protected resolveResource(id: number, request: ResourceRequest): void {
    const controller = new AbortController()
    this.resources.set(id, controller)
    const resolve = this.host.resolveResource ?? (async ({ url, headers }: ResourceRequest) => ({ url, headers }))
    resolve(request, controller.signal).then(
      answer => {
        if (this.resources.get(id) !== controller) return
        this.resources.delete(id)
        const transfer = 'data' in answer && answer.data !== null ? [answer.data.buffer as ArrayBuffer] : []
        this.worker.postMessage({ type: 'resource', id, answer } satisfies WorkerRequest, transfer)
      },
      (error: unknown) => {
        if (this.resources.get(id) !== controller) return
        this.resources.delete(id)
        this.worker.postMessage({ type: 'resource', id, answer: null, error: (error as Error)?.message ?? String(error) } satisfies WorkerRequest)
      },
    )
  }
}

/** Runs the processor on the main thread: for environments without module workers, and tests. */
export class InlineMapStyleBackend implements MapStyleBackend {
  protected processor: Promise<MapStyleProcessor> | null = null
  /** The last processor that loaded: a reload after a failed one still keeps its atlases and slots. */
  protected loaded: MapStyleProcessor | undefined

  constructor(protected readonly host: MapStyleBackendHost) {}

  init(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    return this.reload(options)
  }

  async reload(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    const previous = this.processor?.catch(() => this.loaded) ?? this.loaded
    const resolveResource = this.host.resolveResource
    this.processor = (async () => {
      const [{ MapStyleProcessor }, old] = await Promise.all([import('./worker/MapStyleProcessor.js'), previous])
      return MapStyleProcessor.create(options, resolveResource === undefined ? {} : { resolveResource }, old)
    })()
    const next = this.processor
    let processor: MapStyleProcessor
    try {
      processor = await next
    } catch (error) {
      // A failed reload leaves the last style drawing: later requests go to it.
      if (this.processor === next && this.loaded !== undefined) this.processor = Promise.resolve(this.loaded)
      throw error
    }
    this.loaded = processor
    this.flushUpdates(processor)
    return processor.summary
  }

  async processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket> {
    const processor = await this.requireProcessor()
    const bucket = await processor.processTile(request, signal)
    const atlas = processor.takeAtlasUpdate()
    if (atlas !== null) this.host.onAtlasUpdate(atlas)
    this.flushUpdates(processor)
    return bucket
  }

  invalidate(rectangles: MercatorRectangle[] | null): void {
    void this.processor?.then(processor => processor.invalidate(rectangles)).catch(() => {})
  }

  async updateStyle(commands: StyleCommand[]): Promise<StyleUpdateResult> {
    const processor = await this.requireProcessor()
    const result = await processor.applyCommands(commands)
    this.flushUpdates(processor)
    return result
  }

  async updateFeatureStates(changes: FeatureStateChange[]): Promise<void> {
    const processor = await this.requireProcessor()
    processor.applyFeatureStates(changes)
    this.flushUpdates(processor)
  }

  async setImage(id: string, image: StyleImage | null): Promise<ImageChange> {
    const processor = await this.requireProcessor()
    const change = processor.setImage(id, image === null ? null : { ...image, data: image.data.slice() })
    this.flushUpdates(processor)
    return change
  }

  async setLayerTypes(layerTypes: WorkerLayerTypeDescriptor[]): Promise<StyleUpdateResult> {
    const processor = await this.requireProcessor()
    const result = await processor.setLayerTypes(layerTypes)
    this.flushUpdates(processor)
    return result
  }

  async querySource(sourceId: string, query: GeoJsonSourceQuery): Promise<unknown> {
    const processor = await this.requireProcessor()
    return processor.querySource(sourceId, query)
  }

  async queryRenderedFeatures(query: RenderedFeatureQuery): Promise<RenderedSourceFeature[]> {
    const processor = await this.requireProcessor()
    // Copies, as a worker's answer would be: the caller may change them.
    const features = structuredClone(await processor.queryRenderedFeatures(query))
    this.flushQueryUpdates(processor)
    return features
  }

  async querySourceFeatures(query: SourceFeatureQuery): Promise<SourceFeature[]> {
    const processor = await this.requireProcessor()
    const features = await processor.querySourceFeatures(query)
    this.flushQueryUpdates(processor)
    return features
  }

  dispose(): void {
    this.processor = null
  }

  protected requireProcessor(): Promise<MapStyleProcessor> {
    if (this.processor === null) return Promise.reject(new DOMException('MapStyleSource: disposed, or tile requested before init', 'AbortError'))
    return this.processor
  }

  /** A query may lay out a tile's labels again: hand over the glyphs, slot colours and images it added. */
  protected flushQueryUpdates(processor: MapStyleProcessor): void {
    const atlas = processor.takeAtlasUpdate()
    if (atlas !== null) this.host.onAtlasUpdate(atlas)
    this.flushUpdates(processor)
  }

  /** Hands slot colour and image atlas changes to the host. */
  protected flushUpdates(processor: MapStyleProcessor): void {
    const colors = processor.takeFeatureColorUpdate()
    if (colors !== null) this.host.onFeatureColorUpdate(colors)
    const images = processor.takeImageAtlasUpdate()
    if (images !== null) this.host.onImageAtlasUpdate?.(images)
  }
}
