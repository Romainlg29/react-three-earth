import type { Renderer } from 'three/webgpu'

/** Waits until the GPU has finished everything submitted so far. */
export interface GpuIdleWaiter {
  wait(): Promise<void>
}

interface WebGPUBackendLike {
  isWebGPUBackend?: boolean
  device?: { queue: { onSubmittedWorkDone(): Promise<undefined> } }
}

interface WebGLBackendLike {
  isWebGLBackend?: boolean
  gl?: WebGL2RenderingContext
}

/** Resolves on the next macrotask without the 4 ms clamp nested `setTimeout` calls get. */
function nextTask(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0))
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** WebGPU: the queue reports when submitted work is done. */
class WebGPUIdleWaiter implements GpuIdleWaiter {
  protected readonly queue: { onSubmittedWorkDone(): Promise<undefined> }

  constructor(queue: { onSubmittedWorkDone(): Promise<undefined> }) {
    this.queue = queue
  }

  async wait(): Promise<void> {
    await this.queue.onSubmittedWorkDone()
  }
}

/** WebGL 2: a fence, polled between tasks (never blocking the main thread). */
class WebGLIdleWaiter implements GpuIdleWaiter {
  protected readonly gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  async wait(): Promise<void> {
    const gl = this.gl
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (sync === null) return
    gl.flush()
    try {
      // Give up after a second, as if the GPU were idle: a lost context never signals.
      const deadline = performance.now() + 1000
      while (performance.now() < deadline) {
        const status = gl.clientWaitSync(sync, 0, 0)
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED || status === gl.WAIT_FAILED) return
        await nextTask()
      }
    } finally {
      gl.deleteSync(sync)
    }
  }
}

/** The waiter for this renderer's backend, or null where neither applies (then work cannot be timed). */
export function createGpuIdleWaiter(renderer: Renderer): GpuIdleWaiter | null {
  const backend = renderer.backend as unknown as WebGPUBackendLike & WebGLBackendLike
  if (backend.isWebGPUBackend === true && backend.device !== undefined) return new WebGPUIdleWaiter(backend.device.queue)
  if (backend.isWebGLBackend === true && backend.gl !== undefined) return new WebGLIdleWaiter(backend.gl)
  return null
}
