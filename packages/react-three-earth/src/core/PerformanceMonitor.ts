import type { WebGPURenderer } from 'three/webgpu'

/** One reading of `PerformanceMonitor`, plain JSON. Times in milliseconds, sizes in bytes. */
export interface PerformanceSample {
  framesPerSecond: number
  /** Time between frames, averaged over the window. 16.7 at 60 fps. */
  frameIntervalMillisecondsAverage: number
  /** The longest gap between two frames in the window: what you feel as a stutter. */
  frameIntervalMillisecondsWorst: number
  /** Main-thread time from the start of a frame's callbacks to the end of its render submission. */
  cpuFrameMillisecondsAverage: number
  cpuFrameMillisecondsWorst: number
  /** GPU time of the last resolved frame. Null unless the renderer was created with `trackTimestamp: true` on a device with timestamp queries. */
  gpuFrameMilliseconds: number | null
  /** Main-thread tasks over 50 ms during the window (Chromium only; 0 elsewhere). */
  longTasks: number
  drawCalls: number
  triangles: number
  textures: number
  geometries: number
  /** GPU memory three tracks: textures, buffers, render targets. */
  gpuMemoryBytes: number
  /** JavaScript heap in use (Chromium only), or null. */
  javascriptHeapBytes: number | null
}

interface ChromiumPerformance {
  memory?: { usedJSHeapSize: number }
}

/**
 * Frame-rate, frame-time, GPU-time and memory statistics over a sliding window, for a performance overlay or
 * an agent checking a scene. Call `beginFrame()` at the start of each frame and `endFrame()` after the render
 * is submitted; read `sample()` as often as you like (it allocates one small object).
 */
export class PerformanceMonitor {
  /** How far back `sample()` looks, in milliseconds. */
  windowMilliseconds = 1000
  /** GPU timestamps are resolved this often, in frames: each resolve reads back from the GPU. */
  gpuResolveIntervalFrames = 30

  protected readonly renderer: WebGPURenderer
  protected readonly frameStarts: number[] = []
  protected readonly cpuFrameMilliseconds: number[] = []
  protected readonly longTaskEnds: number[] = []
  protected currentFrameStart = 0
  protected framesSinceGpuResolve = 0
  protected gpuFrameMilliseconds: number | null = null
  protected gpuResolvePending = false
  protected longTaskObserver: PerformanceObserver | null = null

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer
    this.observeLongTasks()
  }

  beginFrame(now = performance.now()): void {
    this.currentFrameStart = now
    this.frameStarts.push(now)
    this.trim(now)
  }

  endFrame(now = performance.now()): void {
    this.cpuFrameMilliseconds.push(now - this.currentFrameStart)
    this.resolveGpuTimeEveryFewFrames()
  }

  sample(now = performance.now()): PerformanceSample {
    this.trim(now)
    const intervals = this.frameIntervals()
    const { render, memory } = this.renderer.info
    return {
      framesPerSecond: (this.frameStarts.length * 1000) / this.windowMilliseconds,
      frameIntervalMillisecondsAverage: average(intervals),
      frameIntervalMillisecondsWorst: maximum(intervals),
      cpuFrameMillisecondsAverage: average(this.cpuFrameMilliseconds),
      cpuFrameMillisecondsWorst: maximum(this.cpuFrameMilliseconds),
      gpuFrameMilliseconds: this.gpuFrameMilliseconds,
      longTasks: this.longTaskEnds.length,
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      textures: memory.textures,
      geometries: memory.geometries,
      gpuMemoryBytes: memory.total,
      javascriptHeapBytes: (performance as ChromiumPerformance).memory?.usedJSHeapSize ?? null,
    }
  }

  dispose(): void {
    this.longTaskObserver?.disconnect()
    this.longTaskObserver = null
  }

  protected frameIntervals(): number[] {
    const intervals: number[] = []
    for (let index = 1; index < this.frameStarts.length; index++) {
      intervals.push(this.frameStarts[index]! - this.frameStarts[index - 1]!)
    }
    return intervals
  }

  /** Drops samples older than the window. CPU frame times are kept in step with frame starts. */
  protected trim(now: number): void {
    const oldest = now - this.windowMilliseconds
    while (this.frameStarts.length > 0 && this.frameStarts[0]! < oldest) this.frameStarts.shift()
    while (this.cpuFrameMilliseconds.length > this.frameStarts.length) this.cpuFrameMilliseconds.shift()
    while (this.longTaskEnds.length > 0 && this.longTaskEnds[0]! < oldest) this.longTaskEnds.shift()
  }

  protected resolveGpuTimeEveryFewFrames(): void {
    if (this.gpuResolvePending || ++this.framesSinceGpuResolve < this.gpuResolveIntervalFrames) return
    this.framesSinceGpuResolve = 0
    this.gpuResolvePending = true
    this.renderer
      .resolveTimestampsAsync('render')
      .then(milliseconds => {
        // three returns undefined when timestamps aren't tracked
        if (typeof milliseconds === 'number' && milliseconds > 0) this.gpuFrameMilliseconds = milliseconds
      })
      .catch(() => {})
      .finally(() => {
        this.gpuResolvePending = false
      })
  }

  protected observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
    this.longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) this.longTaskEnds.push(entry.startTime + entry.duration)
    })
    this.longTaskObserver.observe({ type: 'longtask' })
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function maximum(values: readonly number[]): number {
  let result = 0
  for (const value of values) if (value > result) result = value
  return result
}
