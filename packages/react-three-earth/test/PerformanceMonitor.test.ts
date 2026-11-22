import { describe, expect, it } from 'vitest'

import { PerformanceMonitor } from '../src/core/PerformanceMonitor.js'

function fakeRenderer({ trackTimestamp = true } = {}) {
  const calls = { resolve: 0 }
  const renderer = {
    backend: { trackTimestamp },
    info: {
      render: { drawCalls: 12, triangles: 34_000 },
      memory: { textures: 5, geometries: 7, total: 64 * 1048576 },
    },
    resolveTimestampsAsync: async () => {
      calls.resolve++
      return 3.5
    },
  }
  return Object.assign(renderer as never, { calls }) as never as typeof renderer & { calls: typeof calls }
}

describe('PerformanceMonitor', () => {
  it('reports the frame rate and the worst gap over the last second', () => {
    const monitor = new PerformanceMonitor(fakeRenderer() as never)
    // 59 frames 15 ms apart, then one 100 ms stutter, all within one second
    let time = 0
    for (let frame = 0; frame < 59; frame++) {
      monitor.beginFrame(time)
      monitor.endFrame(time + 4)
      time += 15
    }
    time += 85
    monitor.beginFrame(time)
    monitor.endFrame(time + 4)
    const sample = monitor.sample(time + 1)
    expect(sample.framesPerSecond).toBe(60)
    expect(sample.frameIntervalMillisecondsWorst).toBe(100)
    expect(sample.cpuFrameMillisecondsAverage).toBe(4)
    expect(sample).toMatchObject({ drawCalls: 12, triangles: 34_000, textures: 5, geometries: 7, gpuMemoryBytes: 64 * 1048576 })
  })

  it('forgets frames older than the window', () => {
    const monitor = new PerformanceMonitor(fakeRenderer() as never)
    for (let frame = 0; frame < 10; frame++) monitor.beginFrame(frame * 16)
    expect(monitor.sample(5000).framesPerSecond).toBe(0)
  })

  it('picks up the GPU time three resolves from timestamp queries', async () => {
    const monitor = new PerformanceMonitor(fakeRenderer() as never)
    monitor.gpuResolveIntervalFrames = 1
    monitor.beginFrame(0)
    monitor.endFrame(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(monitor.sample(2).gpuFrameMilliseconds).toBe(3.5)
  })

  it('never asks for GPU time when the renderer does not record timestamps (three would warn)', async () => {
    const renderer = fakeRenderer({ trackTimestamp: false })
    const monitor = new PerformanceMonitor(renderer as never)
    monitor.gpuResolveIntervalFrames = 1
    monitor.beginFrame(0)
    monitor.endFrame(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(renderer.calls.resolve).toBe(0)
    expect(monitor.sample(2).gpuFrameMilliseconds).toBeNull()
  })

  it('ignores a frame end without a frame start', () => {
    const monitor = new PerformanceMonitor(fakeRenderer() as never)
    monitor.endFrame(5000)
    monitor.beginFrame(5000)
    monitor.endFrame(5003)
    monitor.endFrame(5010)
    expect(monitor.sample(5011).cpuFrameMillisecondsWorst).toBe(3)
  })
})
