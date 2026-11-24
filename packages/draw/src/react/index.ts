import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { Draw, DrawEventMap, DrawState } from '../Draw.js'

/**
 * The state of a `Draw` (mode, features, whether the feature in progress can finish), re-rendering on each change.
 * Works anywhere, inside or outside `<Earth>`: install the draw with `<Earth plugins={[draw]}>` or `usePlugin(draw)`.
 *
 * ```tsx
 * const draw = useMemo(() => new Draw(), [])
 * const { mode, canFinish } = useDrawState(draw)
 * ```
 */
export function useDrawState(draw: Draw): DrawState
/** A part of the state, re-rendering only when it changes (compared with `Object.is`). */
export function useDrawState<T>(draw: Draw, selector: (state: DrawState) => T): T
export function useDrawState<T>(draw: Draw, selector?: (state: DrawState) => T): T | DrawState {
  const latestSelector = useRef(selector)
  latestSelector.current = selector
  // The last state and what was selected from it: a new state whose selected part is unchanged returns the same value,
  // so React skips the render.
  const memory = useRef<{ state: DrawState; selected: T | DrawState } | null>(null)
  const getSnapshot = useCallback((): T | DrawState => {
    const state = draw.getState()
    const previous = memory.current
    if (previous !== null && previous.state === state) return previous.selected
    const select = latestSelector.current
    const next = select === undefined ? state : select(state)
    const selected = previous !== null && Object.is(previous.selected, next) ? previous.selected : next
    memory.current = { state, selected }
    return selected
  }, [draw])
  return useSyncExternalStore(draw.subscribe, getSnapshot, getSnapshot)
}

/** Listens to a `Draw` event (`create`, `update`, `delete`, `modechange`, `change`) while mounted. The latest handler is called. */
export function useDrawEvent<T extends keyof DrawEventMap>(draw: Draw, type: T, handler: (event: DrawEventMap[T] & { type: T; target: Draw }) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const listener = (event: DrawEventMap[T] & { type: T; target: Draw }) => latest.current(event)
    draw.addEventListener(type, listener as never)
    return () => draw.removeEventListener(type, listener as never)
  }, [draw, type])
}
