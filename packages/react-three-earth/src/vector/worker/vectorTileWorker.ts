/// <reference lib="webworker" />
// The vector tile worker: loads one MapLibre style and tessellates its tiles off the main thread.
import { MapStyleProcessor, type MapStyleProcessorHooks } from './MapStyleProcessor.js'
import { collectImageAtlasTransferables, collectTransferables, type ResourceAnswer, type TileBucket, type WorkerRequest, type WorkerResponse } from './types.js'

const scope = self as unknown as DedicatedWorkerGlobalScope
let processor: Promise<MapStyleProcessor> | null = null
/** The last processor that loaded: a reload after a failed one still keeps its atlases and slots. */
let loaded: MapStyleProcessor | undefined
const controllers = new Map<number, AbortController>()

/** Requests waiting for the main thread's `resource` answer. */
const resourceRequests = new Map<number, { resolve: (answer: ResourceAnswer) => void; reject: (reason: unknown) => void }>()
let nextResourceId = 1

const hooks: MapStyleProcessorHooks = {
  resolveResource: (request, signal) =>
    new Promise<ResourceAnswer>((resolve, reject) => {
      signal?.throwIfAborted()
      const id = nextResourceId++
      resourceRequests.set(id, { resolve, reject })
      scope.postMessage({ type: 'resource', id, request } satisfies WorkerResponse)
      signal?.addEventListener(
        'abort',
        () => {
          if (!resourceRequests.delete(id)) return
          scope.postMessage({ type: 'resource-cancel', id } satisfies WorkerResponse)
          reject(signal.reason)
        },
        { once: true },
      )
    }),
}

/**
 * Posts a result with the image atlas changes and colour slots made since the last post, so they always arrive
 * before what uses them.
 */
function post(created: MapStyleProcessor | null, response: WorkerResponse, transfer: Transferable[] = []): void {
  if (created !== null && response.type === 'result') {
    const imageAtlas = created.takeImageAtlasUpdate()
    if (imageAtlas !== null) {
      response.imageAtlas = imageAtlas
      transfer.push(...collectImageAtlasTransferables(imageAtlas))
    }
  }
  if (created !== null && (response.type === 'result' || response.type === 'error')) {
    const featureColors = created.takeFeatureColorUpdate()
    if (featureColors !== null) {
      response.featureColors = featureColors
      transfer.push(featureColors.slots.buffer as ArrayBuffer, featureColors.colors.buffer as ArrayBuffer)
    }
  }
  try {
    scope.postMessage(response, transfer)
  } catch (error) {
    // A buffer that cannot be transferred: post copies instead, so the atlas and colour updates taken above
    // are not lost.
    console.warn('vector tile worker: a result could not be transferred, so it was copied.', error)
    scope.postMessage(response)
  }
}

function fail(id: number, error: unknown): void {
  const { name = 'Error', message = String(error) } = error instanceof Error || error instanceof DOMException ? error : {}
  post(null, { type: 'error', id, name, message })
}

function requireProcessor(): Promise<MapStyleProcessor> {
  return processor ?? Promise.reject(new Error('MapStyleSource worker: request before init'))
}

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  switch (data.type) {
    case 'init':
    case 'reload': {
      // A reload keeps the glyph atlas and colour slots of the processor it replaces: buckets still drawn use them.
      const previous = data.type === 'reload' ? (processor?.catch(() => loaded) ?? Promise.resolve(loaded)) : Promise.resolve(undefined)
      const next = previous.then(old => MapStyleProcessor.create(data.options, hooks, old))
      processor = next
      next.then(
        created => {
          loaded = created
          post(created, { type: 'result', id: data.id, value: created.summary })
        },
        error => {
          // A failed reload leaves the last style drawing: later requests go to it.
          if (processor === next && loaded !== undefined) processor = Promise.resolve(loaded)
          fail(data.id, error)
        },
      )
      return
    }
    case 'invalidate':
      // Messages arrive in order: tile requests sent after this one fetch again.
      processor?.then(created => created.invalidate(data.rectangles)).catch(() => {})
      return
    case 'style':
      requireProcessor()
        .then(async created => post(created, { type: 'result', id: data.id, value: await created.applyCommands(data.commands) }))
        .catch(error => fail(data.id, error))
      return
    case 'layerTypes':
      requireProcessor()
        .then(async created => post(created, { type: 'result', id: data.id, value: await created.setLayerTypes(data.layerTypes) }))
        .catch(error => fail(data.id, error))
      return
    case 'featureState':
      requireProcessor()
        .then(created => {
          created.applyFeatureStates(data.changes)
          post(created, { type: 'result', id: data.id, value: null })
        })
        .catch(error => fail(data.id, error))
      return
    case 'queryRendered':
      requireProcessor()
        .then(async created => post(created, { type: 'result', id: data.id, value: await created.queryRenderedFeatures(data.query) }))
        .catch(error => fail(data.id, error))
      return
    case 'querySource':
      requireProcessor()
        .then(async created => post(created, { type: 'result', id: data.id, value: await created.querySourceFeatures(data.query) }))
        .catch(error => fail(data.id, error))
      return
    case 'image': {
      const { id, imageId, image } = data
      requireProcessor()
        .then(created => post(created, { type: 'result', id, value: created.setImage(imageId, image) }))
        .catch(error => fail(id, error))
      return
    }
    case 'resource': {
      const pending = resourceRequests.get(data.id)
      if (pending === undefined) return
      resourceRequests.delete(data.id)
      if (data.answer === null) pending.reject(new Error(data.error ?? 'MapStyleSource: the request was refused'))
      else pending.resolve(data.answer)
      return
    }
    case 'cancel':
      controllers.get(data.id)?.abort(new DOMException('cancelled', 'AbortError'))
      controllers.delete(data.id)
      return
    case 'tile': {
      const controller = new AbortController()
      controllers.set(data.id, controller)
      const { id, request } = data
      requireProcessor()
        .then(async created => {
          const bucket: TileBucket = await created.processTile(request, controller.signal)
          // Taken right before posting, so a bucket always arrives after the glyphs it uses.
          bucket.atlas = created.takeAtlasUpdate()
          post(created, { type: 'result', id, value: bucket }, collectTransferables(bucket))
        })
        .catch(error => fail(id, error))
        .finally(() => controllers.delete(id))
    }
  }
}
