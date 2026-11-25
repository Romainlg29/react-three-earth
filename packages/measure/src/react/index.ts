import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { Measurement } from '../Measure.js'

import type { Measure, MeasureState } from '../Measure.js'
import type { ElevationProfile, ElevationProfileOptions } from '../profile.js'

/**
 * The state of a `Measure` (mode, finished measurements, the one being drawn), re-rendering on each change. Works
 * anywhere, inside or outside `<Earth>`: install the measure with `<Earth plugins={[measure]}>` or `usePlugin(measure)`.
 *
 * ```tsx
 * const measure = useMemo(() => new Measure(), [])
 * const live = useMeasureState(measure, state => state.live)
 * ```
 */
export function useMeasureState(measure: Measure): MeasureState
/** A part of the state, re-rendering only when it changes (compared with `Object.is`). */
export function useMeasureState<T>(measure: Measure, selector: (state: MeasureState) => T): T
export function useMeasureState<T>(measure: Measure, selector?: (state: MeasureState) => T): T | MeasureState {
  const latestSelector = useRef(selector)
  latestSelector.current = selector
  // The last state, the selector that read it and what it selected: a selector of a new render (new props) reads the
  // state again, while an unchanged selected part returns the same value, so React skips the render.
  const memory = useRef<{ state: MeasureState; selector: ((state: MeasureState) => T) | undefined; selected: T | MeasureState } | null>(null)
  const getSnapshot = useCallback((): T | MeasureState => {
    const state = measure.getState()
    const select = latestSelector.current
    const previous = memory.current
    if (previous !== null && previous.state === state && previous.selector === select) return previous.selected
    const next = select === undefined ? state : select(state)
    const selected = previous !== null && Object.is(previous.selected, next) ? previous.selected : next
    memory.current = { state, selector: select, selected }
    return selected
  }, [measure])
  return useSyncExternalStore(measure.subscribe, getSnapshot, getSnapshot)
}

/**
 * The terrain's elevation profile along a measurement (by id), or null without one (no id, an unknown id, or the
 * measure not installed yet). Sampled again when the measurement changes and whenever the earth settles
 * (`terrainchange`), so it gets finer as terrain loads. `sampleCount` defaults to 256.
 *
 * ```tsx
 * const profile = useElevationProfile(measure, selectedId, { sampleCount: 128 })
 * if (profile !== null) chart(profile.samples.map(sample => [sample.distanceMeters, sample.heightMeters]))
 * ```
 */
export function useElevationProfile(measure: Measure, id: string | null | undefined, { sampleCount }: ElevationProfileOptions = {}): ElevationProfile | null {
  // The measurement itself: a new object whenever it changes, so the profile follows edits.
  const select = useCallback((state: MeasureState): Measurement | null => (id === null || id === undefined ? null : id === state.live?.id ? state.live : (state.measurements.find(each => each.id === id) ?? null)), [id])
  const measurement = useMeasureState(measure, select)
  const [terrainVersion, setTerrainVersion] = useState(0)
  useEffect(() => {
    const onTerrain = () => setTerrainVersion(version => version + 1)
    measure.addEventListener('terrainchange', onTerrain)
    return () => measure.removeEventListener('terrainchange', onTerrain)
  }, [measure])
  const [profile, setProfile] = useState<ElevationProfile | null>(null)
  useEffect(() => {
    if (measurement === null) {
      setProfile(null)
      return
    }
    // Not installed yet: install fires terrainchange, which samples it then.
    setProfile(measure.installed ? measure.elevationProfile(measurement.id, { sampleCount }) : null)
  }, [measure, measurement, sampleCount, terrainVersion])
  return profile
}
