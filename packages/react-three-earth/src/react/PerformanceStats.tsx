import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import type { EarthInspection } from '../core/Earth.js'
import { PerformanceMonitor, type PerformanceSample } from '../core/PerformanceMonitor.js'
import { useEarth } from './context.js'

export interface PerformanceStatsProps {
  /** Overlay refreshes per second, clamped to 0.5–30. Default: 4. */
  refreshesPerSecond?: number
  /** Corner of the canvas to sit in. Default: `'top-left'`. */
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}

/**
 * A small overlay over the canvas: frame rate, CPU and GPU frame times, stutters, memory, tiles and imagery
 * work. Put it inside `<Earth>`. It never re-renders React: it writes text into its own element a few times a
 * second. GPU time needs the canvas renderer created with `trackTimestamp: true`.
 */
export function PerformanceStats({ refreshesPerSecond = 4, corner = 'top-left' }: PerformanceStatsProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const [monitor] = useState(() => new PerformanceMonitor(renderer))

  useLayoutEffect(() => {
    monitor.start()
    return () => monitor.dispose()
  }, [monitor])

  // No ids: the scheduler generates unique ones, so several overlays can coexist.
  useFrame(() => monitor.beginFrame(), { phase: 'start' })
  useFrame(() => monitor.endFrame(), { phase: 'finish' })

  useLayoutEffect(() => {
    const element = createOverlay(renderer.domElement, corner)
    const refresh = () => {
      element.textContent = formatStatistics(monitor.sample(), earth.inspect())
    }
    refresh()
    const interval = setInterval(refresh, 1000 / Math.min(Math.max(refreshesPerSecond, 0.5), 30))
    return () => {
      clearInterval(interval)
      element.remove()
    }
  }, [earth, monitor, renderer, corner, refreshesPerSecond])

  return null
}

function createOverlay(canvas: HTMLCanvasElement, corner: NonNullable<PerformanceStatsProps['corner']>): HTMLElement {
  // R3F wraps the canvas in two divs; the outer one is already position: relative, so nothing is restyled.
  const container = canvas.parentElement?.parentElement ?? canvas.parentElement ?? document.body
  const element = document.createElement('pre')
  const [vertical, horizontal] = corner.split('-') as ['top' | 'bottom', 'left' | 'right']
  Object.assign(element.style, {
    position: 'absolute',
    [vertical]: '8px',
    [horizontal]: '8px',
    margin: '0',
    padding: '6px 8px',
    font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#e8ecf1',
    background: 'rgba(10, 14, 20, 0.72)',
    borderRadius: '6px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    zIndex: '10',
  })
  container.appendChild(element)
  return element
}

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`
const milliseconds = (value: number) => `${value.toFixed(1)} ms`

/** The overlay's text. Exported so tests and agents can log the same summary. */
export function formatStatistics(sample: PerformanceSample, inspection: EarthInspection): string {
  const lines = [
    `${sample.framesPerSecond.toFixed(0)} fps   worst gap ${milliseconds(sample.frameIntervalMillisecondsWorst)}   long tasks ${sample.longTasks}`,
    `CPU ${milliseconds(sample.cpuFrameMillisecondsAverage)} (worst ${milliseconds(sample.cpuFrameMillisecondsWorst)})   ` +
      `GPU ${sample.gpuFrameMilliseconds === null ? 'n/a' : milliseconds(sample.gpuFrameMilliseconds)}`,
    `earth.update ${milliseconds(inspection.updateMilliseconds)}`,
    `draws ${sample.drawCalls}   triangles ${(sample.triangles / 1000).toFixed(0)}k`,
    `GPU memory ${megabytes(sample.gpuMemoryBytes)}   textures ${sample.textures}   geometries ${sample.geometries}` +
      (sample.javascriptHeapBytes === null ? '' : `   JS heap ${megabytes(sample.javascriptHeapBytes)}`),
  ]
  const { terrain, atmosphere } = inspection
  if (terrain !== null) {
    lines.push(
      `tiles ${terrain.tilesVisible} visible / ${terrain.tilesLoaded} loaded   downloading ${terrain.tilesDownloading}   parsing ${terrain.tilesParsing}`,
      `tile cache ${megabytes(terrain.memoryUsedBytes)} / ${megabytes(terrain.memoryBudgetBytes)}`,
      `imagery ${milliseconds(terrain.imageryMainThreadMilliseconds)} (${terrain.imageryTilesComposited} composed, ${terrain.imageryCompositionsPending} pending)`,
    )
  }
  if (atmosphere !== null) {
    lines.push(
      atmosphere.ready
        ? `atmosphere ready (${((atmosphere.generationTimeMilliseconds ?? 0) / 1000).toFixed(1)} s to generate)`
        : 'atmosphere generating…',
    )
  }
  return lines.join('\n')
}
