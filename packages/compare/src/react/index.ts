import type { Imagery } from '@earthkit/globe'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { AttachHandleOptions, Compare, CompareEventMap, CompareSide, CompareState } from '../Compare.js'

/**
 * The state of a `Compare` (position, orientation, dragging, layers), re-rendering on each change. Works anywhere,
 * inside or outside `<Earth>`. The position changes every frame of a drag: read it with a selector in a small component
 * (or place the handle with the `--compare-position` CSS property that `useCompareHandle` keeps current).
 *
 * ```tsx
 * const dragging = useCompareState(compare, state => state.dragging)
 * ```
 */
export function useCompareState(compare: Compare): CompareState
/** A part of the state, re-rendering only when it changes (compared with `Object.is`). */
export function useCompareState<T>(compare: Compare, selector: (state: CompareState) => T): T
export function useCompareState<T>(compare: Compare, selector?: (state: CompareState) => T): T | CompareState {
  const latestSelector = useRef(selector)
  latestSelector.current = selector
  const memory = useRef<{ state: CompareState; select: ((state: CompareState) => T) | undefined; selected: T | CompareState } | null>(null)
  const getSnapshot = useCallback((): T | CompareState => {
    const state = compare.getState()
    const previous = memory.current
    const select = latestSelector.current
    if (previous !== null && previous.state === state && previous.select === select) return previous.selected
    const next = select === undefined ? state : select(state)
    const selected = previous !== null && Object.is(previous.selected, next) ? previous.selected : next
    memory.current = { state, select, selected }
    return selected
  }, [compare])
  return useSyncExternalStore(compare.subscribe, getSnapshot, getSnapshot)
}

/**
 * A ref for `<Imagery ref>`: the layer shows on `side` of the line only, for as long as it is mounted (a layer rebuilt
 * after its sources change is followed).
 *
 * ```tsx
 * const beforeRef = useCompareImagery(compare, 'before')
 * <Imagery ref={beforeRef}><MapStyleSource url={streets} /></Imagery>
 * ```
 */
export function useCompareImagery(compare: Compare, side: CompareSide): (imagery: Imagery | null) => () => void {
  return useCallback(
    (imagery: Imagery | null) => {
      if (imagery !== null) compare.addImagery(imagery, side)
      return () => {
        if (imagery !== null) compare.removeImagery(imagery)
      }
    },
    [compare, side],
  )
}

/**
 * A ref for the slider's handle element (`compare.attachHandle`): dragging and the keyboard move the line, and the
 * element gets the ARIA slider attributes and the `--compare-position` CSS property (`'37.5%'`) to place it with, so
 * a drag re-renders nothing.
 *
 * ```tsx
 * const handleRef = useCompareHandle(compare)
 * <div ref={handleRef} className="swiper" /> // .swiper { left: var(--compare-position) }
 * ```
 */
export function useCompareHandle(compare: Compare, { label }: AttachHandleOptions = {}): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLElement | null) => (element === null ? undefined : compare.attachHandle(element, label === undefined ? {} : { label })), [compare, label])
}

/** Listens to a `Compare` event (`change`, `slidestart`, `slide`, `slideend`) while mounted. The latest handler is called. */
export function useCompareEvent<T extends keyof CompareEventMap>(compare: Compare, type: T, handler: (event: CompareEventMap[T] & { type: T; target: Compare }) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const listener = (event: CompareEventMap[T] & { type: T; target: Compare }) => latest.current(event)
    compare.addEventListener(type, listener as never)
    return () => compare.removeEventListener(type, listener as never)
  }, [compare, type])
}
