/// <reference lib="webworker" />
// The vector tile worker: loads one MapLibre style and tessellates its tiles off the main thread.
import { MapStyleProcessor } from './MapStyleProcessor.js'
import { collectImageAtlasTransferables, collectTransferables, type TileBucket, type WorkerRequest, type WorkerResponse } from './types.js'

const scope = self as unknown as DedicatedWorkerGlobalScope
let processor: Promise<MapStyleProcessor> | null = null
const controllers = new Map<number, AbortController>()

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer)
}

/** Answers a request, with the image atlas changes made so far: they reach the main thread before the value. */
function answer(created: MapStyleProcessor, id: number, value: unknown, transfer: Transferable[] = []): void {
  const imageAtlas = created.takeImageAtlasUpdate()
  post({ type: 'result', id, value, imageAtlas }, [...transfer, ...collectImageAtlasTransferables(imageAtlas)])
}

function fail(id: number, error: unknown): void {
  const { name = 'Error', message = String(error) } = error instanceof Error || error instanceof DOMException ? error : {}
  post({ type: 'error', id, name, message })
}

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init') {
    processor = MapStyleProcessor.create(data.options)
    processor.then(
      created => answer(created, data.id, created.summary),
      error => fail(data.id, error),
    )
    return
  }
  if (data.type === 'invalidate') {
    // Messages arrive in order: tile requests sent after this one fetch again.
    processor?.then(created => created.invalidate(data.rectangles)).catch(() => {})
    return
  }
  if (data.type === 'image') {
    const { id, imageId, image } = data
    ;(processor ?? Promise.reject(new Error('MapStyleSource worker: image changed before init')))
      .then(created => answer(created, id, created.setImage(imageId, image)))
      .catch(error => fail(id, error))
    return
  }
  if (data.type === 'cancel') {
    controllers.get(data.id)?.abort(new DOMException('cancelled', 'AbortError'))
    controllers.delete(data.id)
    return
  }
  const controller = new AbortController()
  controllers.set(data.id, controller)
  const { id, request } = data
  ;(processor ?? Promise.reject(new Error('MapStyleSource worker: tile requested before init')))
    .then(async created => {
      const bucket: TileBucket = await created.processTile(request, controller.signal)
      // Taken right before posting, so a bucket always arrives after the glyphs it uses.
      bucket.atlas = created.takeAtlasUpdate()
      answer(created, id, bucket, collectTransferables(bucket))
    })
    .catch(error => fail(id, error))
    .finally(() => controllers.delete(id))
}
