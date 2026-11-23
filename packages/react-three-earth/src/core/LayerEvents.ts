import type { Earth } from './Earth.js'
import type { EarthPointerEvent } from './events.js'
import type { RenderedFeature } from './featureQuery.js'

/**
 * Pointer events scoped to style layers, as MapLibre's `map.on(type, layerId, listener)`. `pointerenter` and
 * `pointerleave` are MapLibre's `mouseenter` and `mouseleave`.
 */
export type LayerEventType = 'click' | 'doubleclick' | 'contextmenu' | 'pointermove' | 'pointerenter' | 'pointerleave'

/** A pointer event over features of the layers a listener asked for. */
export interface LayerPointerEvent<T extends LayerEventType = LayerEventType> extends EarthPointerEvent {
  type: T
  /** The features under the pointer in the listener's layers, top-most first. Empty for `pointerleave`. */
  features: RenderedFeature[]
  target: Earth
}

export interface LayerEventOptions {
  /** Style layer ids (of any `MapStyleSource` on the earth). The listener runs only over their features. */
  layers: readonly string[]
  /** Extra distance, in pixels, within which a feature counts as under the pointer. Default: 0. */
  tolerancePixels?: number
}

export type LayerEventListener<T extends LayerEventType = LayerEventType> = (event: LayerPointerEvent<T>) => void

interface Registration {
  type: LayerEventType
  layers: ReadonlySet<string>
  listener: LayerEventListener<never>
  tolerancePixels: number
  /** For `pointerenter` and `pointerleave`: whether the pointer was over the layers at the last query. */
  inside: boolean
}

type EarthPointerType = 'click' | 'doubleclick' | 'contextmenu' | 'pointermove' | 'pointerout'
const DISCRETE_TYPES = ['click', 'doubleclick', 'contextmenu'] as const
const HOVER_TYPES: readonly LayerEventType[] = ['pointermove', 'pointerenter', 'pointerleave']

/**
 * Layer-scoped pointer events, cursors and hover state for an `Earth` (`earth.layerEvents`). Each pointer event is
 * answered by one `earth.queryRenderedFeatures` for every listener of its type; pointer moves keep at most one
 * query in flight, and a move that arrives meanwhile is queried next (moves in between are skipped).
 *
 * Listeners run once the worker answered, a few milliseconds after the DOM event: `originalEvent.preventDefault()`
 * comes too late there. Listen on the earth itself (`earth.addEventListener('click', …)`) for that.
 */
export class LayerEvents {
  protected readonly registrations = new Set<Registration>()
  /** What this listens to on the earth, while some registration needs it. */
  protected readonly earthListeners = new Map<EarthPointerType, (event: never) => void>()
  protected pendingMove: EarthPointerEvent | null = null
  protected moveQueryRunning = false
  /** Counts pointer exits: a move query that started before one is out of date. */
  protected exitCount = 0
  /** Cursors asked for by `addCursor` while the pointer is over their layers, most recent last. */
  protected readonly cursorRequests = new Map<object, string>()
  /** The element's own cursor, restored when no request remains. */
  protected savedCursor: { element: HTMLElement; cursor: string } | null = null
  protected readonly warnings = new Set<string>()

  constructor(protected readonly earth: Earth) {}

  /**
   * Calls `listener` for pointer events over features of `layers`. Returns a function that removes it.
   * @example
   * earth.layerEvents.addEventListener('click', event => console.log(event.features[0]?.properties), { layers: ['roads'] })
   */
  addEventListener<T extends LayerEventType>(type: T, listener: LayerEventListener<T>, { layers, tolerancePixels = 0 }: LayerEventOptions): () => void {
    if (layers.length === 0) throw new Error(`LayerEvents.addEventListener("${type}"): pass at least one style layer id in \`layers\`; for events anywhere on the map, use earth.addEventListener.`)
    const registration: Registration = { type, layers: new Set(layers), listener: listener as LayerEventListener<never>, tolerancePixels, inside: false }
    this.registrations.add(registration)
    this.updateEarthListeners()
    return () => this.remove(registration)
  }

  /** Removes every registration of `listener` for `type`. */
  removeEventListener<T extends LayerEventType>(type: T, listener: LayerEventListener<T>): void {
    for (const registration of [...this.registrations]) if (registration.type === type && registration.listener === listener) this.remove(registration)
  }

  /**
   * Shows `cursor` on the map's element while the pointer is over features of `layers`, MapLibre's usual
   * `mouseenter` / `mouseleave` pair. Returns a function that removes it (and restores the cursor).
   * @example earth.layerEvents.addCursor(['countries'])
   */
  addCursor(layers: readonly string[], cursor = 'pointer', options: Omit<LayerEventOptions, 'layers'> = {}): () => void {
    const request = {}
    const removeEnter = this.addEventListener('pointerenter', () => this.requestCursor(request, cursor), { ...options, layers })
    const removeLeave = this.addEventListener('pointerleave', () => this.requestCursor(request, null), { ...options, layers })
    return () => {
      removeEnter()
      removeLeave()
      this.requestCursor(request, null)
    }
  }

  /**
   * Sets feature-state `{ [stateKey]: true }` on the top-most feature of `layers` under the pointer, and `false` again
   * when the pointer leaves it: paint it with `['boolean', ['feature-state', 'hover'], false]`. Features need ids
   * (the tile's, or the source's `promoteId`). Returns a function that removes it and clears the state.
   * @example
   * source.setPaintProperty('countries', 'fill-color', ['case', ['boolean', ['feature-state', 'hover'], false], '#ffcc00', '#cccccc'])
   * earth.layerEvents.addHoverState(['countries'])
   */
  addHoverState(layers: readonly string[], { stateKey = 'hover', ...options }: Omit<LayerEventOptions, 'layers'> & { stateKey?: string } = {}): () => void {
    let hovered: RenderedFeature | null = null
    const setState = (feature: RenderedFeature, value: boolean) => feature.mapStyleSource.setFeatureState({ source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id! }, { [stateKey]: value })
    const clear = () => {
      if (hovered !== null) setState(hovered, false)
      hovered = null
    }
    const removeMove = this.addEventListener(
      'pointermove',
      event => {
        const top = event.features.find(feature => feature.id !== undefined)
        if (top === undefined) {
          const layer = event.features[0]?.layer.id
          if (layer !== undefined) this.warnOnce(`hover:${layer}`, `LayerEvents.addHoverState: features of layer "${layer}" have no id, so they cannot hold feature-state; set the source's \`promoteId\` to a property holding a unique id.`)
          return
        }
        if (hovered !== null && isSameFeature(hovered, top)) return
        clear()
        hovered = top
        setState(top, true)
      },
      { ...options, layers },
    )
    const removeLeave = this.addEventListener('pointerleave', clear, { ...options, layers })
    return () => {
      removeMove()
      removeLeave()
      clear()
    }
  }

  /** Removes every listener, cursor and hover state, and restores the cursor. */
  dispose(): void {
    for (const registration of [...this.registrations]) this.remove(registration)
    this.cursorRequests.clear()
    this.applyCursor()
  }

  protected remove(registration: Registration): void {
    if (!this.registrations.delete(registration)) return
    this.updateEarthListeners()
  }

  /** Listens on the earth to what the registrations need, and to nothing else (pointer moves are frequent). */
  protected updateEarthListeners(): void {
    const needed = new Set<EarthPointerType>()
    for (const { type } of this.registrations) {
      if (HOVER_TYPES.includes(type)) needed.add('pointermove').add('pointerout')
      else needed.add(type as EarthPointerType)
    }
    for (const [type, listener] of this.earthListeners) {
      if (needed.has(type)) continue
      this.earth.removeEventListener(type, listener as never)
      this.earthListeners.delete(type)
    }
    for (const type of needed) {
      if (this.earthListeners.has(type)) continue
      const listener =
        type === 'pointermove'
          ? (event: EarthPointerEvent) => this.onPointerMove(event)
          : type === 'pointerout'
            ? (event: EarthPointerEvent) => this.onPointerOut(event)
            : (event: EarthPointerEvent) => void this.onDiscreteEvent(type, event)
      this.earth.addEventListener(type, listener as never)
      this.earthListeners.set(type, listener as never)
    }
    if (!needed.has('pointermove')) this.pendingMove = null
  }

  protected async onDiscreteEvent(type: (typeof DISCRETE_TYPES)[number], event: EarthPointerEvent): Promise<void> {
    const registrations = [...this.registrations].filter(registration => registration.type === type)
    if (registrations.length === 0) return
    try {
      const features = await this.query(event, registrations)
      for (const registration of registrations) {
        if (!this.registrations.has(registration)) continue
        const matching = features.filter(feature => registration.layers.has(feature.layer.id))
        if (matching.length > 0) this.call(registration, event, matching)
      }
    } catch (error) {
      console.error(error)
    }
  }

  protected onPointerMove(event: EarthPointerEvent): void {
    this.pendingMove = event
    if (!this.moveQueryRunning) void this.runMoveQueries()
  }

  /** Queries the latest pointer move, one at a time, until none is waiting. */
  protected async runMoveQueries(): Promise<void> {
    this.moveQueryRunning = true
    try {
      while (this.pendingMove !== null) {
        const event = this.pendingMove
        this.pendingMove = null
        const registrations = [...this.registrations].filter(registration => HOVER_TYPES.includes(registration.type))
        if (registrations.length === 0) break
        const exitCount = this.exitCount
        let features: RenderedFeature[]
        try {
          features = await this.query(event, registrations)
        } catch (error) {
          console.error(error)
          continue
        }
        if (exitCount !== this.exitCount) continue // the pointer left the map meanwhile
        for (const registration of registrations) {
          if (!this.registrations.has(registration)) continue
          const matching = features.filter(feature => registration.layers.has(feature.layer.id))
          const inside = matching.length > 0
          if (registration.type === 'pointermove') {
            if (inside) this.call(registration, event, matching)
            continue
          }
          const was = registration.inside
          registration.inside = inside
          if (registration.type === 'pointerenter' && inside && !was) this.call(registration, event, matching)
          else if (registration.type === 'pointerleave' && !inside && was) this.call(registration, event, [])
        }
      }
    } finally {
      this.moveQueryRunning = false
    }
  }

  protected onPointerOut(event: EarthPointerEvent): void {
    this.exitCount++
    this.pendingMove = null
    for (const registration of [...this.registrations]) {
      if (!registration.inside) continue
      registration.inside = false
      if (registration.type === 'pointerleave') this.call(registration, event, [])
    }
  }

  protected query(event: EarthPointerEvent, registrations: readonly Registration[]): Promise<RenderedFeature[]> {
    const layers = new Set<string>()
    let tolerancePixels = 0
    for (const registration of registrations) {
      for (const layer of registration.layers) layers.add(layer)
      tolerancePixels = Math.max(tolerancePixels, registration.tolerancePixels)
    }
    return this.earth.queryRenderedFeatures(event.screen, { layers: [...layers], tolerancePixels })
  }

  protected call(registration: Registration, source: EarthPointerEvent, features: RenderedFeature[]): void {
    const earth = this.earth
    const event: LayerPointerEvent = {
      type: registration.type,
      screen: source.screen,
      originalEvent: source.originalEvent,
      get geographic() {
        return source.geographic
      },
      features,
      target: earth,
    }
    try {
      ;(registration.listener as LayerEventListener)(event)
    } catch (error) {
      console.error(error)
    }
  }

  protected requestCursor(request: object, cursor: string | null): void {
    this.cursorRequests.delete(request)
    if (cursor !== null) this.cursorRequests.set(request, cursor)
    this.applyCursor()
  }

  protected applyCursor(): void {
    const element = this.earth.pointerEventsElement
    if (this.savedCursor !== null && this.savedCursor.element !== element) {
      this.savedCursor.element.style.cursor = this.savedCursor.cursor
      this.savedCursor = null
    }
    if (element === null) return
    const cursor = [...this.cursorRequests.values()].at(-1)
    if (cursor === undefined) {
      if (this.savedCursor !== null) element.style.cursor = this.savedCursor.cursor
      this.savedCursor = null
      return
    }
    this.savedCursor ??= { element, cursor: element.style.cursor }
    element.style.cursor = cursor
  }

  protected warnOnce(key: string, message: string): void {
    if (this.warnings.has(key)) return
    this.warnings.add(key)
    console.warn(message)
  }
}

function isSameFeature(a: RenderedFeature, b: RenderedFeature): boolean {
  return a.mapStyleSource === b.mapStyleSource && a.source === b.source && a.sourceLayer === b.sourceLayer && a.id === b.id
}
