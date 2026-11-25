import { runDemTask, type DemImageDecoder, type DemTask, type DemTaskRequest, type DemTaskResponse, type DemTaskResult } from './demTasks.js'
import type { DemUnpackFactors } from '../../vector/raster/rasterTiles.js'

/**
 * Starts the terrain worker shipped with the library. Bundlers that do not follow
 * `new Worker(new URL(…, import.meta.url))` can pass their own factory as `createWorker`.
 */
export function createRasterDemWorker(): Worker {
  // The build rewrites this path to the bundled worker (dist/terrain-worker.js).
  return new Worker(new URL('./rasterDemWorker.ts', import.meta.url), { type: 'module', name: 'earthkit terrain' })
}

interface Pending {
  resolve: (result: DemTaskResult) => void
  reject: (reason: unknown) => void
  /** A copy of the bytes sent, to build on the main thread if the worker fails before answering. */
  bytes: ArrayBuffer
  task: DemTask
}

/**
 * Builds terrain meshes from raster-dem tiles: in a worker, or on the main thread when `createWorker` is null (or the
 * worker cannot start). One builder per terrain; `dispose` ends its worker.
 */
export class DemMeshBuilder {
  protected worker: Worker | null = null
  protected readonly pending = new Map<number, Pending>()
  protected nextId = 0

  constructor(
    protected readonly factors: DemUnpackFactors,
    createWorker: (() => Worker) | null = createRasterDemWorker,
    /** Decoder for the main-thread path. Default: the browser's. */
    protected readonly decode?: DemImageDecoder,
  ) {
    if (createWorker === null) return
    try {
      this.worker = createWorker()
    } catch (error) {
      console.warn(`RasterDemSource: the terrain worker did not start (${(error as Error).message}); decoding on the main thread. Pass createWorker to start it yourself.`)
      return
    }
    this.worker.onmessage = ({ data }: MessageEvent<DemTaskResponse>) => {
      const pending = this.pending.get(data.id)
      if (pending === undefined) return
      this.pending.delete(data.id)
      if ('error' in data) pending.reject(new Error(data.error))
      else pending.resolve(data.result)
    }
    // A module worker that cannot load (a bundler that does not follow `new URL(…, import.meta.url)`, a CSP) fails here,
    // after construction: its pending tiles are built on the main thread instead of failing for good.
    this.worker.onerror = event => {
      console.warn(
        `RasterDemSource: the terrain worker failed (${event.message ?? 'it did not load'}); building terrain on the main thread from now on. ` +
          'Pass createWorker to start your bundler\'s worker, or createWorker: null to skip it.',
      )
      const pending = [...this.pending.values()]
      this.stopWorker(null)
      for (const { bytes, task, resolve, reject } of pending) runDemTask({ bytes, factors: this.factors, task }, this.decode).then(resolve, reject)
    }
  }

  /** Decodes `bytes` and builds the task's mesh. `bytes` is transferred to the worker: pass a copy to keep it. */
  build(bytes: ArrayBuffer, task: DemTask): Promise<DemTaskResult> {
    const worker = this.worker
    if (worker === null) return runDemTask({ bytes, factors: this.factors, task }, this.decode)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bytes: bytes.slice(0), task })
      const request: DemTaskRequest = { id, bytes, factors: this.factors, task }
      worker.postMessage(request, [bytes])
    })
  }

  dispose(): void {
    this.stopWorker(Object.assign(new Error('the terrain was disposed'), { name: 'AbortError' }))
  }

  /** Ends the worker; pending tasks are rejected with `reason`, or left to the caller when it is null. */
  protected stopWorker(reason: Error | null): void {
    this.worker?.terminate()
    this.worker = null
    if (reason !== null) for (const { reject } of this.pending.values()) reject(reason)
    this.pending.clear()
  }
}
