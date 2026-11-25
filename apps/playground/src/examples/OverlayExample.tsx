import type { GeoreferencedCorners } from '@earthkit/globe'
import { ImageSource, Imagery, RasterTileSource } from '@earthkit/globe/react'
import { useEffect, useState } from 'react'

import { rasterAttribution, rasterTilesUrl, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'

/** Clockwise from the top-left, as `[longitude, latitude]`: the Low Countries, or the fixture peak's slopes. */
const CORNERS: GeoreferencedCorners = useFixtures
  ? [[-90.6, 0.5], [-89.4, 0.5], [-89.4, -0.5], [-90.6, -0.5]]
  : [[1.5, 54.0], [8.5, 54.0], [8.5, 49.3], [1.5, 49.3]]

const FRAME_COUNT = 12
const FRAME_SIZE_PIXELS = 160

/** A deterministic pseudo-random sequence, so every visit shows the same storm. */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

/** Radar colours by rain intensity (0 to 1): light green drizzle to purple downpour. */
const RADAR_STOPS: Array<[number, [number, number, number]]> = [
  [0.12, [120, 220, 140]],
  [0.35, [40, 170, 80]],
  [0.55, [250, 220, 60]],
  [0.75, [240, 110, 40]],
  [0.9, [210, 30, 60]],
  [1.0, [170, 60, 200]],
]
const DRY_INTENSITY = RADAR_STOPS[0]![0]

/** The colour of a rain intensity, transparent where dry; opacity grows with the rain. */
function radarColor(intensity: number): [number, number, number, number] {
  if (intensity < DRY_INTENSITY) return [0, 0, 0, 0]
  const alpha = 150 + (70 * (intensity - DRY_INTENSITY)) / (1 - DRY_INTENSITY)
  const upper = Math.max(1, RADAR_STOPS.findIndex(([at]) => at >= intensity))
  const [fromAt, from] = RADAR_STOPS[upper - 1]!
  const [toAt, to] = RADAR_STOPS[upper]!
  const fraction = (intensity - fromAt) / (toAt - fromAt)
  return [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction, from[2] + (to[2] - from[2]) * fraction, alpha]
}

/** Deterministic rain cells: they drift east, swell and fade. */
function createRainCells() {
  const random = sequence(42)
  return Array.from({ length: 34 }, () => ({
    x: random() * 1.2 - 0.3,
    y: 0.15 + random() * 0.75,
    radius: 0.03 + random() ** 2 * 0.09,
    strength: 0.4 + random() * 0.8,
    phase: random() * Math.PI * 2,
  }))
}

/**
 * One frame of a rain radar loop, drawn here rather than downloaded, as a PNG data URL. A real app would point
 * `url` at its radar service's frames.
 */
function drawRadarFrame(cells: ReturnType<typeof createRainCells>, frame: number, context: CanvasRenderingContext2D): string {
  const time = frame / FRAME_COUNT
  const image = context.createImageData(FRAME_SIZE_PIXELS, FRAME_SIZE_PIXELS)
  const moved = cells.map(cell => ({
    x: cell.x + time * 0.25,
    y: cell.y - time * 0.06,
    radius: cell.radius,
    strength: cell.strength * (0.75 + 0.25 * Math.sin(cell.phase + time * Math.PI * 2)),
  }))
  for (let row = 0; row < FRAME_SIZE_PIXELS; row++) {
    for (let column = 0; column < FRAME_SIZE_PIXELS; column++) {
      const x = column / FRAME_SIZE_PIXELS
      const y = row / FRAME_SIZE_PIXELS
      let intensity = 0
      for (const cell of moved) {
        const distanceSquared = ((x - cell.x) ** 2 + (y - cell.y) ** 2) / (cell.radius * cell.radius)
        if (distanceSquared < 9) intensity += cell.strength * Math.exp(-distanceSquared)
      }
      const offset = (row * FRAME_SIZE_PIXELS + column) * 4
      image.data.set(radarColor(Math.min(1, intensity)), offset)
    }
  }
  context.putImageData(image, 0, 0)
  return context.canvas.toDataURL('image/png')
}

/**
 * The loop's frames, drawn one per task after mount so the map never waits for them: null until the first, then a
 * growing list. (Drawn during the first render, the picture also stayed undrawn when the terrain loaded fast.)
 */
function useRadarFrames(): string[] | null {
  const [frames, setFrames] = useState<string[] | null>(null)
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = FRAME_SIZE_PIXELS
    const context = canvas.getContext('2d')!
    const cells = createRainCells()
    let frame = 0
    let timeout = 0
    const drawNext = () => {
      const url = drawRadarFrame(cells, frame, context)
      setFrames(current => [...(current ?? []), url])
      if (++frame < FRAME_COUNT) timeout = window.setTimeout(drawNext, 30)
    }
    timeout = window.setTimeout(drawNext, 100)
    return () => clearTimeout(timeout)
  }, [])
  return frames
}

/**
 * `?example=overlay`: a georeferenced picture (`<ImageSource>`) over OpenStreetMap, its `url` stepped through the
 * frames of a radar loop, in a layer of its own whose opacity the slider sets.
 */
export function OverlayExample() {
  const frames = useRadarFrames()
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(!useFixtures)
  const [opacity, setOpacity] = useState(0.85)
  useEffect(() => {
    if (!playing) return
    const interval = setInterval(() => setFrame(current => current + 1), 400)
    return () => clearInterval(interval)
  }, [playing])
  return (
    <ExampleShell
      title="Image overlay"
      description="A picture pinned to four corners on the map, here the frames of a rain radar loop drawn by the page. Swap its URL to animate it."
      camera={
        useFixtures
          ? { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 0, distanceMeters: 250_000, headingDegrees: 0, pitchDegrees: -70 }
          : { longitudeDegrees: 5, latitudeDegrees: 51.6, heightMeters: 0, distanceMeters: 700_000, headingDegrees: 0, pitchDegrees: -55 }
      }
      panel={
        <>
          <div className="example-buttons">
            <button type="button" aria-pressed={playing} onClick={() => setPlaying(value => !value)}>
              {playing ? 'Pause' : 'Play'}
            </button>
          </div>
          <label className="example-field">
            Opacity
            <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={event => setOpacity(Number(event.target.value))} />
            <output>{Math.round(opacity * 100)} %</output>
          </label>
        </>
      }
    >
      <Imagery>
        <RasterTileSource url={rasterTilesUrl} levels={19} attribution={rasterAttribution} />
      </Imagery>
      <Imagery opacity={opacity}>
        {frames === null ? null : <ImageSource url={frames[frame % frames.length]!} coordinates={CORNERS} attribution="Radar: synthetic" />}
      </Imagery>
    </ExampleShell>
  )
}
