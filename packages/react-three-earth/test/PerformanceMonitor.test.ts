import { describe, expect, it } from 'vitest'

import { PerformanceMonitor } from '../src/core/PerformanceMonitor.js'

function fakeRenderer() {
  return {
    info: {
      render: { drawCalls: 12, triangles: 34_000 },
      memory: { textures: 5, geometries: 7, total: 64 * 1048576 },
    },
    resolveTimestampsAsync: async () => 3.5,
  } as never
}

describe('PerformanceMonitor', () => {
  it('reports the frame rate and the worst gap over the last second', () => {
    const monitor = new PerformanceMonitor(fakeRenderer())
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
    const monitor = new PerformanceMonitor(fakeRenderer())
    for (let frame = 0; frame < 10; frame++) monitor.beginFrame(frame * 16)
    expect(monitor.sample(5000).framesPerSecond).toBe(0)
  })

  it('picks up the GPU time three resolves from timestamp queries', async () => {
    const monitor = new PerformanceMonitor(fakeRenderer())
    monitor.gpuResolveIntervalFrames = 1
    monitor.beginFrame(0)
    monitor.endFrame(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(monitor.sample(2).gpuFrameMilliseconds).toBe(3.5)
  })
})
