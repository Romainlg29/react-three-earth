import type { MapStyleProcessor } from './worker/MapStyleProcessor.js'
import type { AtlasUpdate, MapStyleProcessorOptions, MapStyleSummary, TileBucket, TileRequest, WorkerRequest, WorkerResponse } from './worker/types.js'

/** Where a style's tiles are processed: a worker by default, the main thread as a fallback. */
export interface MapStyleBackend {
  init(options: MapStyleProcessorOptions): Promise<MapStyleSummary>
  /** Resolves after the bucket's glyph atlas changes were handed to `onAtlasUpdate`. */
  processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket>
  dispose(): void
}

export type AtlasUpdateListener = (update: AtlasUpdate) => void

/**
 * Starts the vector tile worker shipped with the library. Bundlers that do not follow
 * `new Worker(new URL(…, import.meta.url))` can pass their own factory as `createWorker`.
 */
export function createVectorTileWorker(): Worker {
  // The build rewrites this path to the bundled worker (dist/vector-worker.js).
  return new Worker(new URL('./worker/vectorTileWorker.ts', import.meta.url), { type: 'module', name: 'react-three-earth vector tiles' })
}

interface Pending {
  resolve: (value: never) => void
  reject: (reason: unknown) => void
}

/** Runs the processor in a dedicated worker; typed arrays come back transferred, not copied. */
export class WorkerMapStyleBackend implements MapStyleBackend {
  protected readonly worker: Worker
  protected readonly pending = new Map<number, Pending>()
  protected nextId = 1
  /** Rejects when the worker script cannot start, so the caller can fall back to the main thread. */
  protected readonly failed: Promise<never>

  constructor(
    worker: Worker,
    protected readonly onAtlasUpdate: AtlasUpdateListener,
  ) {
    this.worker = worker
    let fail: (reason: unknown) => void = () => {}
    this.failed = new Promise<never>((_, reject) => (fail = reject))
    this.failed.catch(() => {})
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => this.receive(data)
    worker.onerror = event => {
      event.preventDefault()
      const error = new Error(`MapStyleSource worker failed: ${event.message || 'the script could not load'}`)
      fail(error)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
  }

  init(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    return Promise.race([this.call<MapStyleSummary>({ type: 'init', id: this.nextId++, options }), this.failed])
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

  dispose(): void {
    this.worker.terminate()
    const error = new DOMException('MapStyleSource: disposed', 'AbortError')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  protected call<T>(message: WorkerRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as (value: never) => void, reject })
      this.worker.postMessage(message)
    })
  }

  protected receive(response: WorkerResponse): void {
    // Glyphs first, even for a request that was cancelled meanwhile: later buckets rely on them.
    if (response.type === 'result') {
      const atlas = (response.value as Partial<TileBucket> | null)?.atlas
      if (atlas !== undefined && atlas !== null) this.onAtlasUpdate(atlas)
    }
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    this.pending.delete(response.id)
    if (response.type === 'result') pending.resolve(response.value as never)
    else pending.reject(response.name === 'AbortError' ? new DOMException(response.message, 'AbortError') : new Error(response.message))
  }
}

/** Runs the processor on the main thread: for environments without module workers, and tests. */
export class InlineMapStyleBackend implements MapStyleBackend {
  protected processor: MapStyleProcessor | null = null

  constructor(protected readonly onAtlasUpdate: AtlasUpdateListener) {}

  async init(options: MapStyleProcessorOptions): Promise<MapStyleSummary> {
    const { MapStyleProcessor } = await import('./worker/MapStyleProcessor.js')
    this.processor = await MapStyleProcessor.create(options)
    return this.processor.summary
  }

  async processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket> {
    if (this.processor === null) throw new Error('MapStyleSource: tile requested before init')
    const bucket = await this.processor.processTile(request, signal)
    const atlas = this.processor.takeAtlasUpdate()
    if (atlas !== null) this.onAtlasUpdate(atlas)
    return bucket
  }

  dispose(): void {
    this.processor = null
  }
}
