import { Marker, PLUGIN_API_VERSION, type Earth, type EarthPlugin, type FitBoundsOptions, type FlyToOptions, type GeographicBounds, type GeographicPosition, type MarkerOptions, type PluginContext } from '@earthkit/globe'
import { EventDispatcher } from 'three'

import type { GeocoderProvider, GeocoderResult, GeocoderSearchOptions } from './types.js'

/** `idle`: nothing asked. `loading`: waiting for the providers. `success`: they answered (maybe with no place). `error`: every provider failed. */
export type GeocoderStatus = 'idle' | 'loading' | 'success' | 'error'

/** How the camera moves to a selected place: `fitBounds` options for places with an extent, `flyTo` options for points. */
export type GeocoderFlyToOptions = FitBoundsOptions & FlyToOptions

export interface GeocoderOptions {
  /** Where places come from: one provider, or several asked together, their results listed in this order. */
  provider: GeocoderProvider | readonly GeocoderProvider[]
  /** The plugin's name, unique on an earth. Change it to install two geocoders. Default: 'geocoder'. */
  name?: string
  /** How long typing must pause before a search as you type starts. Default: 250. */
  debounceMilliseconds?: number
  /** Shorter queries (after trimming) search nothing. Default: 2. */
  minimumQueryLength?: number
  /** The most results each provider returns. Default: 5. */
  limit?: number
  /** Preferred language of the names, a BCP 47 tag (`'fr'`). Default: the provider's (often the local names). */
  language?: string
  /** Rank places near the view's centre first, once zoomed in to `proximityMinimumZoom`. Default: true. */
  proximity?: boolean
  /** The zoom from which `proximity` applies: farther out, the whole world ranks the same. Default: 9. */
  proximityMinimumZoom?: number
  /** Keep to places inside this box. Default: null (anywhere). */
  bounds?: GeographicBounds | null
  /**
   * Move the camera to a selected place: true fits its extent (or flies to a point at `pointZoom`), an object does
   * so with these options, false leaves the camera (move it yourself in the `select` event). Default: true, with
   * `paddingPixels: 48` and `maximumZoom: 17`.
   */
  flyTo?: boolean | GeocoderFlyToOptions
  /** The zoom to fly to for a place with no extent (an address, a peak). Default: 16. */
  pointZoom?: number
  /**
   * Put a `Marker` on the selected place, removed on `clear` or the next selection: true for the default pin, a
   * function for marker options of your own (an element, a colour, a popup). Default: false (draw it yourself from
   * `getState().selected`).
   */
  marker?: boolean | ((result: GeocoderResult) => Partial<MarkerOptions>)
  /** The element markers are measured from (the canvas's parent). Default: the element `<Earth>` listens to. */
  markerContainer?: HTMLElement | null
  /** Reverse geocode each click on the map (`reverse` event, `getState().reverse`). Default: false. */
  reverseOnClick?: boolean
  /** How many answers (query, provider, language, proximity) to keep, so backspacing or retyping asks nothing. Default: 64. */
  cacheSize?: number
}

/** A reverse search: the clicked position and what is there. */
export interface GeocoderReverseState {
  status: GeocoderStatus
  /** The position asked about, or null before the first reverse search. */
  position: GeographicPosition | null
  /** The most precise place first. */
  results: readonly GeocoderResult[]
  error: Error | null
}

/** What `getState()` returns: a new object on each change, so it can be compared by identity. */
export interface GeocoderState {
  /** The text in the search box. */
  query: string
  status: GeocoderStatus
  /** The places for `resultsQuery`, while a newer search runs too (so the list does not flicker). */
  results: readonly GeocoderResult[]
  /** The query `results` answer. */
  resultsQuery: string
  /** The result the arrow keys picked, for `aria-activedescendant`, or -1. */
  activeIndex: number
  /** Whether to show the list of results: true when results arrive, false on Escape, selection, `close()`. */
  open: boolean
  /** The place chosen last, until `clear()`. */
  selected: GeocoderResult | null
  /** Why the last search failed, when every provider failed. */
  error: Error | null
  reverse: GeocoderReverseState
}

/** Events a `Geocoder` fires (`geocoder.addEventListener('select', listener)`). */
export interface GeocoderEventMap {
  /** A search answered. `autocomplete` is true for search as you type. */
  results: { query: string; results: GeocoderResult[]; autocomplete: boolean }
  /** A place was selected (the camera starts moving to it unless `flyTo` is false). */
  select: { result: GeocoderResult }
  /** The query, the results and the selection were cleared. */
  clear: object
  /** A provider failed. The other providers' results still show. */
  error: { error: Error; query: string; provider: string }
  /** A reverse search answered. */
  reverse: { position: GeographicPosition; results: GeocoderResult[] }
}

/** The keyboard event `handleKeyDown` reads: a DOM or a React one. */
export interface GeocoderKeyboardEvent {
  key: string
  preventDefault(): void
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}

/** Called with the new state on each change. */
export type GeocoderStateListener = (state: GeocoderState) => void

const IDLE_REVERSE: GeocoderReverseState = { status: 'idle', position: null, results: [], error: null }
const NO_RESULTS: readonly GeocoderResult[] = []
const DEFAULT_FIT: GeocoderFlyToOptions = { paddingPixels: 48, maximumZoom: 17 }

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Headless place search, as an earthkit plugin: the user types, the providers answer, the arrow keys pick a result,
 * Enter flies the camera there. It draws nothing and ships no CSS: build the search box from `getState()` and
 * `subscribe` (or `useGeocoder` in React), and pass the box's keys to `handleKeyDown`.
 *
 * ```ts
 * const geocoder = new Geocoder({ provider: new PhotonProvider({ url: 'https://photon.komoot.io' }) })
 * earth.addPlugin(geocoder)
 * input.oninput = () => geocoder.setQuery(input.value)
 * input.onkeydown = event => geocoder.handleKeyDown(event)
 * geocoder.subscribe(state => renderList(state.results, state.activeIndex))
 * ```
 *
 * Search as you type waits for a pause (`debounceMilliseconds`), drops answers to older queries, aborts their
 * requests and caches answers. Providers whose terms forbid autocomplete (the public Nominatim server) are asked only
 * on Enter. It works before it is installed too, without moving a camera.
 */
export class Geocoder extends EventDispatcher<GeocoderEventMap> implements EarthPlugin {
  readonly name: string
  readonly apiVersion = PLUGIN_API_VERSION
  readonly providers: readonly GeocoderProvider[]
  protected readonly options: GeocoderOptions
  protected readonly listeners = new Set<GeocoderStateListener>()
  protected state: GeocoderState
  protected earth: Earth | null = null
  protected marker: Marker | null = null
  protected debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** The running search's requests, aborted when a newer search starts. */
  protected searchController: AbortController | null = null
  protected reverseController: AbortController | null = null
  /** Counts searches, so an answer to an older one is dropped. */
  protected searchNumber = 0
  protected reverseNumber = 0
  protected readonly cache = new Map<string, GeocoderResult[]>()

  constructor(options: GeocoderOptions) {
    super()
    this.options = options
    this.name = options.name ?? 'geocoder'
    this.providers = Array.isArray(options.provider) ? [...(options.provider as readonly GeocoderProvider[])] : [options.provider as GeocoderProvider]
    if (this.providers.length === 0) throw new Error('Geocoder: no provider; pass one in `provider`, for example `new PhotonProvider({ url })`.')
    const names = new Set<string>()
    for (const provider of this.providers) {
      if (names.has(provider.name)) throw new Error(`Geocoder: two providers are named "${provider.name}"; give one another \`name\` in its options.`)
      names.add(provider.name)
    }
    this.state = { query: '', status: 'idle', results: NO_RESULTS, resultsQuery: '', activeIndex: -1, open: false, selected: null, error: null, reverse: IDLE_REVERSE }
  }

  // ---- Plugin ----

  install(context: PluginContext): void {
    this.earth = context.earth
    if (this.options.reverseOnClick === true) {
      context.addEventListener('click', event => {
        const position = event.geographic
        if (position !== null) void this.reverse(position)
      })
    }
    context.onDispose(() => {
      this.removeMarker()
      this.earth = null
    })
  }

  uninstall(): void {
    this.cancelSearch()
    this.reverseController?.abort()
  }

  inspect(): unknown {
    const { query, status, results, selected, open } = this.state
    return { query, status, results: results.map(result => result.name), open, selected: selected?.name ?? null, providers: this.providers.map(provider => provider.name) }
  }

  // ---- State ----

  /** The current state. The same object until something changes. */
  getState = (): GeocoderState => this.state

  /** Calls `listener` on each change of state, and returns the function that stops it. */
  subscribe = (listener: GeocoderStateListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected setState(change: Partial<GeocoderState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of [...this.listeners]) listener(this.state)
  }

  // ---- Searching ----

  /**
   * Sets the search box's text (call it on each input): searches as you type after a pause, with the providers
   * that allow it. A query shorter than `minimumQueryLength` clears the results.
   */
  setQuery(query: string): void {
    if (query === this.state.query) return
    this.cancelSearch()
    const typed = query.trim().length >= this.minimumQueryLength && this.providers.some(provider => provider.autocomplete)
    if (!typed) {
      this.setState({ query, status: 'idle', results: NO_RESULTS, resultsQuery: query, activeIndex: -1, open: false, error: null })
      return
    }
    this.setState({ query, activeIndex: -1 })
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runSearch(query, true)
    }, this.options.debounceMilliseconds ?? 250)
  }

  /**
   * Searches now, with every provider (Nominatim's public server too), for `query` or the current one. Resolves to
   * the results, and sets them in the state unless a newer search started.
   */
  search(query: string = this.state.query): Promise<GeocoderResult[]> {
    this.cancelSearch()
    if (query !== this.state.query) this.setState({ query, activeIndex: -1 })
    return this.runSearch(query, false)
  }

  /** What Enter does with no result picked: searches now with every provider, then selects the best result. */
  async submit(query: string = this.state.query): Promise<GeocoderResult | null> {
    const searching = this.search(query)
    // `search` numbered its search before its first await.
    const number = this.searchNumber
    const results = await searching
    // A newer search or a clear since: leave them be.
    if (number !== this.searchNumber || results[0] === undefined) return null
    return this.select(results[0])
  }

  protected get minimumQueryLength(): number {
    return this.options.minimumQueryLength ?? 2
  }

  /** Stops the pending search as you type and the requests in flight. */
  protected cancelSearch(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.searchController?.abort()
    this.searchController = null
    this.searchNumber++
  }

  protected async runSearch(query: string, autocomplete: boolean): Promise<GeocoderResult[]> {
    const number = ++this.searchNumber
    const trimmed = query.trim()
    const providers = autocomplete ? this.providers.filter(provider => provider.autocomplete) : this.providers
    if (trimmed.length < this.minimumQueryLength || providers.length === 0) {
      this.setState({ status: 'idle', results: NO_RESULTS, resultsQuery: query, activeIndex: -1, open: false, error: null })
      return []
    }
    const controller = new AbortController()
    this.searchController = controller
    if (this.state.status !== 'loading') this.setState({ status: 'loading' })
    const options: GeocoderSearchOptions = {
      signal: controller.signal,
      limit: this.options.limit ?? 5,
      autocomplete,
      language: this.options.language,
      proximity: this.proximity(),
      bounds: this.options.bounds ?? null,
    }
    const settled = await Promise.allSettled(providers.map(provider => this.searchProvider(provider, trimmed, options)))
    const results = settled.flatMap(outcome => (outcome.status === 'fulfilled' ? outcome.value : []))
    if (number !== this.searchNumber) return results
    this.searchController = null
    const failures = settled.flatMap((outcome, index) => (outcome.status === 'rejected' && !isAbortError(outcome.reason) ? [{ error: toError(outcome.reason), provider: providers[index]?.name ?? '' }] : []))
    const failed = failures.length === providers.length
    this.setState({
      status: failed ? 'error' : 'success',
      results: failed ? NO_RESULTS : results,
      resultsQuery: query,
      activeIndex: -1,
      open: !failed,
      error: failed ? (failures[0]?.error ?? null) : null,
    })
    for (const failure of failures) this.dispatchEvent({ type: 'error', query, ...failure })
    if (!failed) this.dispatchEvent({ type: 'results', query, results, autocomplete })
    return results
  }

  protected async searchProvider(provider: GeocoderProvider, query: string, options: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const { proximity } = options
    const key = JSON.stringify([provider.name, options.autocomplete, query, options.limit, options.language ?? '', proximity === null || proximity === undefined ? null : [proximity.longitudeDegrees.toFixed(2), proximity.latitudeDegrees.toFixed(2)]])
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      // Most recently used last.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const results = await provider.search(query, options)
    const size = this.options.cacheSize ?? 64
    if (size > 0) {
      this.cache.set(key, results)
      while (this.cache.size > size) this.cache.delete(this.cache.keys().next().value as string)
    }
    return results
  }

  /** The view's centre when zoomed in enough for `proximity`, or null. */
  protected proximity(): GeographicPosition | null {
    const earth = this.earth
    if (this.options.proximity === false || earth === null || !earth.camera.ready) return null
    const view = earth.camera.readEllipsoidView()
    if (view.zoom < (this.options.proximityMinimumZoom ?? 9)) return null
    return { longitudeDegrees: view.longitudeDegrees, latitudeDegrees: view.latitudeDegrees }
  }

  // ---- Picking a result ----

  /** Picks a result for the arrow keys (`aria-activedescendant`), -1 for none, and shows the list. */
  setActiveIndex(index: number): void {
    const activeIndex = index >= 0 && index < this.state.results.length ? index : -1
    if (activeIndex !== this.state.activeIndex || (activeIndex >= 0 && !this.state.open)) this.setState({ activeIndex, open: activeIndex >= 0 ? true : this.state.open })
  }

  /** Moves the picked result down (1) or up (-1), wrapping around, and shows the list. */
  moveActive(step: number): void {
    const count = this.state.results.length
    if (count === 0) return
    if (!this.state.open) {
      this.setState({ open: true, activeIndex: step > 0 ? 0 : count - 1 })
      return
    }
    const from = this.state.activeIndex
    const next = from < 0 ? (step > 0 ? 0 : count - 1) : (((from + step) % count) + count) % count
    this.setState({ activeIndex: next })
  }

  /** Shows the list of results, if there are any (on focus). */
  open(): void {
    if (!this.state.open && this.state.results.length > 0) this.setState({ open: true })
  }

  /** Hides the list of results, keeping them (on Escape, on blur). */
  close(): void {
    if (this.state.open || this.state.activeIndex !== -1) this.setState({ open: false, activeIndex: -1 })
  }

  /**
   * Handles a key in the search box: Down and Up pick a result, Enter selects it (or, with none picked, searches
   * with every provider and selects the best), Escape closes the list, then clears the query. Returns true when it
   * handled the key, after calling `preventDefault`.
   */
  handleKeyDown(event: GeocoderKeyboardEvent): boolean {
    // Keys typed into an input method editor (Japanese, Chinese) belong to it.
    if (event.isComposing === true || event.nativeEvent?.isComposing === true) return false
    switch (event.key) {
      case 'ArrowDown':
        this.moveActive(1)
        break
      case 'ArrowUp':
        this.moveActive(-1)
        break
      case 'Enter':
        if (this.state.open && this.state.activeIndex >= 0) this.select()
        else if (this.state.query.trim() !== '') void this.submit()
        break
      case 'Escape':
        if (this.state.open) this.close()
        else if (this.state.query !== '') this.clear()
        else return false
        break
      default:
        return false
    }
    event.preventDefault()
    return true
  }

  /**
   * Selects a result (an index in the results, or the result itself; default: the picked one): puts its name in the
   * query, closes the list, moves the camera there (`flyTo`), places the marker (`marker`) and fires `select`.
   * Returns the result, or null when there is none to select.
   */
  select(target: GeocoderResult | number = this.state.activeIndex): GeocoderResult | null {
    const result = typeof target === 'number' ? this.state.results[target] : target
    if (result === undefined) return null
    this.cancelSearch()
    this.setState({ selected: result, query: result.name, open: false, activeIndex: -1, status: this.state.status === 'loading' ? 'success' : this.state.status })
    if (this.options.flyTo !== false) void this.flyTo(result, this.options.flyTo === true ? undefined : this.options.flyTo)
    this.placeMarker(result)
    this.dispatchEvent({ type: 'select', result })
    return result
  }

  /**
   * Moves the camera to a place: fits its extent, or flies to a point at `pointZoom`. Resolves like `flyTo`: true at
   * the end, false when interrupted or not installed on an earth.
   */
  flyTo(result: GeocoderResult, options: GeocoderFlyToOptions = {}): Promise<boolean> {
    const earth = this.earth
    if (earth === null) return Promise.resolve(false)
    const merged = { ...DEFAULT_FIT, ...options }
    const moved =
      result.bounds === null
        ? earth.camera.flyTo({ longitudeDegrees: result.longitudeDegrees, latitudeDegrees: result.latitudeDegrees, zoom: Math.min(this.options.pointZoom ?? 16, merged.maximumZoom ?? Number.POSITIVE_INFINITY) }, merged)
        : earth.camera.fitBounds(result.bounds, merged)
    earth.requestFrame()
    return moved
  }

  /** Clears the query, the results, the selection and its marker, and fires `clear`. */
  clear(): void {
    this.cancelSearch()
    this.removeMarker()
    this.setState({ query: '', status: 'idle', results: NO_RESULTS, resultsQuery: '', activeIndex: -1, open: false, selected: null, error: null })
    this.dispatchEvent({ type: 'clear' })
  }

  // ---- Marker ----

  /** The marker on the selected place, or null. */
  getMarker(): Marker | null {
    return this.marker
  }

  protected placeMarker(result: GeocoderResult): void {
    const option = this.options.marker
    const earth = this.earth
    if (option === undefined || option === false || earth === null) return
    const container = this.options.markerContainer ?? earth.pointerEventsElement
    if (container === null) {
      console.warn('Geocoder: no element to put the marker in; pass `markerContainer` (the canvas\'s parent), or call `earth.attachPointerEvents` (`<Earth>` does).')
      return
    }
    this.removeMarker()
    const custom = typeof option === 'function' ? option(result) : {}
    this.marker = new Marker({ label: result.name, ...custom, longitudeDegrees: result.longitudeDegrees, latitudeDegrees: result.latitudeDegrees }).addTo(earth, container)
    earth.requestFrame()
  }

  protected removeMarker(): void {
    this.marker?.dispose()
    this.marker = null
  }

  // ---- Reverse geocoding ----

  /**
   * The places at a position, from every provider that can reverse geocode, the most precise first. Sets
   * `getState().reverse` (unless a newer reverse search started) and fires `reverse`.
   */
  async reverse(position: GeographicPosition): Promise<GeocoderResult[]> {
    const providers = this.providers.filter(provider => provider.reverse !== undefined)
    if (providers.length === 0) throw new Error(`Geocoder.reverse: none of the providers (${this.providers.map(provider => provider.name).join(', ')}) can reverse geocode; add one with a \`reverse\` method.`)
    this.reverseController?.abort()
    const controller = new AbortController()
    this.reverseController = controller
    const number = ++this.reverseNumber
    const point = { longitudeDegrees: position.longitudeDegrees, latitudeDegrees: position.latitudeDegrees }
    this.setState({ reverse: { status: 'loading', position: point, results: this.state.reverse.results, error: null } })
    const earth = this.earth
    const zoom = earth !== null && earth.camera.ready ? earth.camera.readEllipsoidView().zoom : undefined
    const options = { signal: controller.signal, limit: this.options.limit ?? 5, language: this.options.language, zoom }
    const settled = await Promise.allSettled(providers.map(provider => provider.reverse!(point, options)))
    const results = settled.flatMap(outcome => (outcome.status === 'fulfilled' ? outcome.value : []))
    if (number !== this.reverseNumber) return results
    this.reverseController = null
    const failures = settled.flatMap((outcome, index) => (outcome.status === 'rejected' && !isAbortError(outcome.reason) ? [{ error: toError(outcome.reason), provider: providers[index]?.name ?? '' }] : []))
    const failed = failures.length === providers.length
    this.setState({ reverse: { status: failed ? 'error' : 'success', position: point, results: failed ? NO_RESULTS : results, error: failed ? (failures[0]?.error ?? null) : null } })
    for (const failure of failures) this.dispatchEvent({ type: 'error', query: '', ...failure })
    if (!failed) this.dispatchEvent({ type: 'reverse', position: point, results })
    return results
  }
}
