import { usePlugin } from '@earthkit/globe/react'
import { useEffect, useImperativeHandle, useLayoutEffect, useState, type Ref } from 'react'

import { Water as WaterImpl, type WaterOptions } from '../Water.js'
import type { WaveProbe, WaveProbeOptions, WaveProbePoint } from '../waves/WaveProbe.js'

export interface WaterProps extends WaterOptions {
  /** The `Water` plugin, for `water.state` or `setSettings` outside React. */
  ref?: Ref<WaterImpl>
}

/**
 * A physically based sea on the terrain, inside `<Earth>`: installs a `Water` plugin while mounted and applies its props
 * as they change (uniforms only, no reload). `name` is read once.
 *
 * ```tsx
 * <Earth>
 *   <Terrain><QuantizedMeshSource url={url} /></Terrain>
 *   <Atmosphere />
 *   <Water preset="open-ocean" />
 * </Earth>
 * ```
 */
export function Water({ ref, name, ...settings }: WaterProps) {
  const [water] = useState(() => new WaterImpl({ name, ...settings }))
  usePlugin(water)
  const key = JSON.stringify(settings)
  useLayoutEffect(() => {
    water.setSettings(settings)
  }, [water, key])
  useImperativeHandle(ref, () => water, [water])
  return null
}

/**
 * Samples the sea at `points` while mounted, to float a boat: a `WaveProbe` on `water` (the `<Water>`'s ref), its points
 * kept in step with the argument. Read `probe.samples` in a frame callback, never in render: they change every frame.
 * Null until `water` is set.
 *
 * ```tsx
 * const probe = useWaveProbe(water, [{ longitudeDegrees: 0.19, latitudeDegrees: 49.71 }])
 * useFrame(() => {
 *   const sample = probe?.samples[0]
 *   if (sample?.ready) anchor.setPosition({ longitudeDegrees: 0.19, latitudeDegrees: 49.71, heightMeters: sample.heightMeters })
 * })
 * ```
 */
export function useWaveProbe(water: WaterImpl | null, points: ReadonlyArray<WaveProbePoint>, options?: WaveProbeOptions): WaveProbe | null {
  const [probe, setProbe] = useState<WaveProbe | null>(null)
  const capacity = options?.capacity
  useEffect(() => {
    if (water === null) return
    const created = water.createProbe(capacity === undefined ? undefined : { capacity })
    setProbe(created)
    return () => {
      created.dispose()
      setProbe(current => (current === created ? null : current))
    }
  }, [water, capacity])
  const key = JSON.stringify(points.map(({ longitudeDegrees, latitudeDegrees }) => [longitudeDegrees, latitudeDegrees]))
  useLayoutEffect(() => {
    probe?.setPoints(points)
  }, [probe, key])
  return probe
}
