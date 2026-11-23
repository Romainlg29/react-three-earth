// The terrain worker: decodes raster-dem tiles and builds their meshes off the main thread.
import { runDemTask, surfaceTransferables, type DemTaskRequest, type DemTaskResponse } from './demTasks.js'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DemTaskRequest>) => void) | null
  postMessage(message: DemTaskResponse, transfer?: Transferable[]): void
}

scope.onmessage = ({ data: { id, ...request } }) => {
  runDemTask(request).then(
    result => scope.postMessage({ id, result }, surfaceTransferables(result)),
    (error: unknown) => scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  )
}
