import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react'

import type { Geocoder, GeocoderEventMap, GeocoderState } from '../Geocoder.js'

/**
 * The state of a `Geocoder` (query, results, picked result, selection), re-rendering on each change. Works anywhere,
 * inside or outside `<Earth>`.
 *
 * ```tsx
 * const { results, status } = useGeocoderState(geocoder)
 * ```
 */
export function useGeocoderState(geocoder: Geocoder): GeocoderState
/** A part of the state, re-rendering only when it changes (compared with `Object.is`). */
export function useGeocoderState<T>(geocoder: Geocoder, selector: (state: GeocoderState) => T): T
export function useGeocoderState<T>(geocoder: Geocoder, selector?: (state: GeocoderState) => T): T | GeocoderState {
  const latestSelector = useRef(selector)
  latestSelector.current = selector
  const memory = useRef<{ state: GeocoderState; select: ((state: GeocoderState) => T) | undefined; selected: T | GeocoderState } | null>(null)
  const getSnapshot = useCallback((): T | GeocoderState => {
    const state = geocoder.getState()
    const select = latestSelector.current
    const previous = memory.current
    // A new selector (one closing over a prop) selects again from the same state.
    if (previous !== null && previous.state === state && previous.select === select) return previous.selected
    const next = select === undefined ? state : select(state)
    const selected = previous !== null && Object.is(previous.selected, next) ? previous.selected : next
    memory.current = { state, select, selected }
    return selected
  }, [geocoder])
  return useSyncExternalStore(geocoder.subscribe, getSnapshot, getSnapshot)
}

/** Listens to a `Geocoder` event (`results`, `select`, `clear`, `error`, `reverse`) while mounted. The latest handler is called. */
export function useGeocoderEvent<T extends keyof GeocoderEventMap>(geocoder: Geocoder, type: T, handler: (event: GeocoderEventMap[T] & { type: T; target: Geocoder }) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const listener = (event: GeocoderEventMap[T] & { type: T; target: Geocoder }) => latest.current(event)
    geocoder.addEventListener(type, listener as never)
    return () => geocoder.removeEventListener(type, listener as never)
  }, [geocoder, type])
}

/** Props for the search box: spread them on an `<input>`. */
export interface GeocoderInputProps {
  id: string
  type: 'search'
  role: 'combobox'
  value: string
  autoComplete: 'off'
  spellCheck: false
  'aria-autocomplete': 'list'
  'aria-expanded': boolean
  'aria-controls': string
  'aria-activedescendant': string | undefined
  'aria-busy': boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onFocus: () => void
  onBlur: () => void
}

/** Props for the list of results: spread them on a `<ul>`. */
export interface GeocoderListboxProps {
  id: string
  role: 'listbox'
  hidden: boolean
}

/** Props for one result: spread them on an `<li>`. */
export interface GeocoderOptionProps {
  id: string
  role: 'option'
  'aria-selected': boolean
  onMouseDown: (event: MouseEvent) => void
  onMouseMove: () => void
  onClick: () => void
}

/** What `useGeocoder` returns: the state, and the props of an accessible combobox. */
export interface UseGeocoderResult extends GeocoderState {
  inputProps: GeocoderInputProps
  listboxProps: GeocoderListboxProps
  /** The props of the result at `index` in `results`. */
  getOptionProps: (index: number) => GeocoderOptionProps
  geocoder: Geocoder
}

/**
 * A search box on a `Geocoder`, headless: the state and the props of a WAI-ARIA combobox (an input, a listbox and its
 * options), wired to typing, the arrow keys, Enter, Escape, hover and clicks. You render the elements and style them.
 *
 * ```tsx
 * const { inputProps, listboxProps, getOptionProps, results } = useGeocoder(geocoder)
 * return (
 *   <div>
 *     <input {...inputProps} placeholder="Search places" />
 *     <ul {...listboxProps}>
 *       {results.map((result, index) => <li key={result.id} {...getOptionProps(index)}>{result.name}</li>)}
 *     </ul>
 *   </div>
 * )
 * ```
 */
export function useGeocoder(geocoder: Geocoder): UseGeocoderResult {
  const state = useGeocoderState(geocoder)
  const baseId = useId()
  const inputId = `${baseId}-input`
  const listboxId = `${baseId}-listbox`
  const optionId = useCallback((index: number) => `${baseId}-option-${index}`, [baseId])
  const listShown = state.open && state.results.length > 0

  const handlers = useMemo(
    () => ({
      onChange: (event: ChangeEvent<HTMLInputElement>) => geocoder.setQuery(event.target.value),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void geocoder.handleKeyDown(event),
      onFocus: () => geocoder.open(),
      onBlur: () => geocoder.close(),
    }),
    [geocoder],
  )

  const getOptionProps = useCallback(
    (index: number): GeocoderOptionProps => ({
      id: optionId(index),
      role: 'option',
      'aria-selected': index === state.activeIndex,
      // Keeps the focus in the input, so its blur does not close the list before the click lands.
      onMouseDown: event => event.preventDefault(),
      onMouseMove: () => {
        if (geocoder.getState().activeIndex !== index) geocoder.setActiveIndex(index)
      },
      onClick: () => void geocoder.select(index),
    }),
    [geocoder, optionId, state.activeIndex],
  )

  return {
    ...state,
    geocoder,
    inputProps: {
      id: inputId,
      type: 'search',
      role: 'combobox',
      value: state.query,
      autoComplete: 'off',
      spellCheck: false,
      'aria-autocomplete': 'list',
      'aria-expanded': listShown,
      'aria-controls': listboxId,
      'aria-activedescendant': listShown && state.activeIndex >= 0 ? optionId(state.activeIndex) : undefined,
      'aria-busy': state.status === 'loading',
      ...handlers,
    },
    listboxProps: { id: listboxId, role: 'listbox', hidden: !listShown },
    getOptionProps,
  }
}
