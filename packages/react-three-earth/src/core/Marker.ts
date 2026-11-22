import { EventDispatcher, Vector3 } from 'three'

import type { GeographicPosition } from './camera.js'
import type { Earth } from './Earth.js'
import {
  anchoredBox,
  anchoredTransform,
  anchorTransformOrigin,
  CLICK_TOLERANCE_PIXELS,
  markerRotation,
  type MarkerAlignment,
  type ScreenAnchor,
  type ScreenBox,
  type ScreenOffset,
} from './markerLayout.js'
import type { Popup } from './Popup.js'
import {
  acquireScreenLayer,
  isBehindHorizon,
  isBehindTerrain,
  localHeadingAndPitch,
  releaseScreenLayer,
  sceneToScreen,
  ScreenOverlay,
  takeRaycast,
  type ScreenOverlayFrame,
  type ScreenOverlayItem,
  type ScreenVisibility,
} from './ScreenOverlay.js'

/** A height above the WGS84 ellipsoid in metres, or `'terrain'` to sit on the loaded terrain. */
export type MarkerHeight = number | 'terrain'

export interface MarkerOptions {
  longitudeDegrees: number
  latitudeDegrees: number
  /**
   * Ellipsoidal height in metres, or `'terrain'` to sit on the loaded terrain (0 until a tile is loaded there,
   * then re-read a few times a second as finer tiles arrive). Default: 'terrain'.
   */
  heightMeters?: MarkerHeight
  /**
   * The element to show. It becomes the marker's root: it gets the `react-three-earth-marker` class, an
   * absolute position and a transform. Default: a pin (27 × 41 pixels) in `color`.
   */
  element?: HTMLElement
  /** Colour of the default pin, any CSS colour. Ignored with `element`. Default: '#3fb1ce'. */
  color?: string
  /** The point of the element on the position. Default: 'bottom' for the default pin, 'center' for an element of your own. */
  anchor?: ScreenAnchor
  /** Shift on the screen after anchoring, in CSS pixels. Default: none. */
  offsetPixels?: ScreenOffset
  /** Clockwise turn, in degrees. Default: 0. */
  rotationDegrees?: number
  /** `'map'` turns the marker with the map's heading. Default: 'viewport'. */
  rotationAlignment?: MarkerAlignment
  /** `'map'` lays the marker on the ground as the camera tilts. Default: 'viewport'. */
  pitchAlignment?: MarkerAlignment
  /** Lets the user drag the marker to a new place (`dragstart`, `drag`, `dragend` events). Default: false. */
  draggable?: boolean
  /** Opacity while terrain hides the marker; 0 hides it. Behind the globe's horizon it is always hidden. Default: 0.2. */
  occludedOpacity?: number
  /** The accessible name screen readers announce, for example the place's name. Default: 'Map marker'. */
  label?: string
  /** Extra class names for the marker's element, space-separated. */
  className?: string
  /** A popup the marker opens and closes when clicked or activated with the keyboard. */
  popup?: Popup | null
}

/** What `dragstart`, `drag` and `dragend` carry. */
export interface MarkerDragEvent {
  /** Where the marker is now, its height on the loaded terrain when it follows it. */
  position: GeographicPosition & { heightMeters: number }
}

export interface MarkerEventMap {
  /** The user started dragging. */
  dragstart: MarkerDragEvent
  /** The marker moved under the pointer. Fires on every pointer move while dragging. */
  drag: MarkerDragEvent
  /** The user let go: `position` is the marker's new place. */
  dragend: MarkerDragEvent
  /** The marker was clicked or activated with Enter or Space (not after a drag, and not after panning the map from it). */
  click: object
}

const PIN_SVG =
  '<svg viewBox="0 0 27 41" aria-hidden="true" focusable="false">' +
  '<ellipse cx="13.5" cy="38.6" rx="6.5" ry="2.4" fill="rgba(0,0,0,0.22)"/>' +
  '<path d="M13.5 0.5C6.32 0.5 0.5 6.32 0.5 13.5c0 9.7 13 25.5 13 25.5s13-15.8 13-25.5C26.5 6.32 20.68 0.5 13.5 0.5z" fill="currentColor" stroke="rgba(0,0,0,0.25)"/>' +
  '<circle cx="13.5" cy="13.5" r="5" fill="#fff"/></svg>'

const scenePoint = new Vector3()

/**
 * An HTML element pinned to a place on the earth, as MapLibre's `Marker`. It follows the map in the frame
 * that draws it, hides behind the globe's horizon, fades behind terrain (`occludedOpacity`), and can sit on
 * the terrain, open a `Popup`, be dragged, turn and tilt with the map.
 *
 * ```ts
 * const marker = new Marker({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, label: 'Mount Fuji' })
 * marker.setPopup(new Popup({ content: 'Mount Fuji, 3776 m' }))
 * marker.addTo(earth, canvas.parentElement!)
 * ```
 *
 * Markers are DOM elements, fine for tens to a few hundred places; draw thousands as map symbols instead.
 */
export class Marker extends EventDispatcher<MarkerEventMap> implements ScreenOverlayItem {
  /** The marker's root element (the `element` option, or the default pin). */
  readonly element: HTMLElement
  /** Whether the marker shows, as of the last frame. */
  visibility: ScreenVisibility = 'hidden'
  /** Where the anchor sits on the screen, in CSS pixels from the container's top-left corner, as of the last frame. */
  readonly screenPosition = { xPixels: 0, yPixels: 0 }
  /** Milliseconds between two reads of the terrain under the marker, and between two terrain occlusion tests. */
  terrainCheckIntervalMilliseconds = 250

  protected earth: Earth | null = null
  protected container: HTMLElement | null = null
  protected longitudeDegrees: number
  protected latitudeDegrees: number
  protected heightOption: MarkerHeight
  /** The terrain's height under the marker, last read; null before the first read. */
  protected terrainHeightMeters: number | null = null
  protected anchor: ScreenAnchor
  protected offset: ScreenOffset
  protected rotationDegrees: number
  protected rotationAlignment: MarkerAlignment
  protected pitchAlignment: MarkerAlignment
  protected draggable = false
  protected occludedOpacity: number
  protected popup: Popup | null = null
  protected occludedByTerrain = false
  protected lastTerrainHeightCheckMilliseconds = -Infinity
  protected lastOcclusionCheckMilliseconds = -Infinity
  protected lastTransform = ''
  protected lastOpacity = ''
  /** The element's size, kept current by a ResizeObserver; null until measured. */
  protected elementSize: { widthPixels: number; heightPixels: number } | null = null
  protected readonly resizeObserver: ResizeObserver | null
  protected pointerDown: { pointerId: number; clientX: number; clientY: number; grabXPixels: number; grabYPixels: number; containerLeft: number; containerTop: number } | null = null
  protected dragging = false
  protected suppressNextClick = false

  constructor(options: MarkerOptions) {
    super()
    this.longitudeDegrees = options.longitudeDegrees
    this.latitudeDegrees = options.latitudeDegrees
    this.heightOption = options.heightMeters ?? 'terrain'
    this.anchor = options.anchor ?? (options.element === undefined ? 'bottom' : 'center')
    this.offset = options.offsetPixels ?? { xPixels: 0, yPixels: 0 }
    this.rotationDegrees = options.rotationDegrees ?? 0
    this.rotationAlignment = options.rotationAlignment ?? 'viewport'
    this.pitchAlignment = options.pitchAlignment ?? 'viewport'
    this.occludedOpacity = options.occludedOpacity ?? 0.2

    this.element = options.element ?? this.createPin(options.color)
    this.element.classList.add('react-three-earth-marker')
    if (options.className) this.element.classList.add(...options.className.split(/\s+/).filter(Boolean))
    this.element.style.transformOrigin = anchorTransformOrigin(this.anchor)
    this.element.dataset.visibility = 'hidden'
    this.makeAccessible(options.label)
    this.setDraggable(options.draggable ?? false)
    if (options.popup) this.setPopup(options.popup)

    this.element.addEventListener('pointerdown', this.onPointerDown)
    this.element.addEventListener('pointermove', this.onPointerMove)
    this.element.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('pointercancel', this.onPointerUp)
    this.element.addEventListener('click', this.onClick)
    this.element.addEventListener('keydown', this.onKeyDown)
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(([entry]) => {
            const box = entry?.borderBoxSize?.[0]
            this.elementSize = box ? { widthPixels: box.inlineSize, heightPixels: box.blockSize } : null
          })
  }

  /**
   * Shows the marker over an earth's canvas. `container` is the element the canvas fills (its parent in a
   * React Three Fiber `<Canvas>`): positions are measured from its top-left corner. Moving it to another
   * earth or container takes it off the first.
   */
  addTo(earth: Earth, container: HTMLElement): this {
    if (this.earth !== null) this.remove()
    this.earth = earth
    this.container = container
    acquireScreenLayer(container).append(this.element)
    this.resizeObserver?.observe(this.element, { box: 'border-box' })
    ScreenOverlay.of(earth).add(this, 'marker')
    return this
  }

  /** Takes the marker (and its open popup) off the map. It can be added again. */
  remove(): this {
    this.popup?.remove()
    if (this.earth === null || this.container === null) return this
    ScreenOverlay.of(this.earth).delete(this)
    this.resizeObserver?.unobserve(this.element)
    this.element.remove()
    releaseScreenLayer(this.container)
    this.earth = null
    this.container = null
    this.visibility = 'hidden'
    this.element.dataset.visibility = 'hidden'
    this.lastTransform = ''
    return this
  }

  /** Removes the marker and its listeners for good. */
  dispose(): void {
    this.remove()
    this.setPopup(null)
    this.resizeObserver?.disconnect()
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    this.element.removeEventListener('pointermove', this.onPointerMove)
    this.element.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('pointercancel', this.onPointerUp)
    this.element.removeEventListener('click', this.onClick)
    this.element.removeEventListener('keydown', this.onKeyDown)
  }

  /** The earth the marker is on, or null. */
  getEarth(): Earth | null {
    return this.earth
  }

  /** The container the marker is in, or null. */
  getContainer(): HTMLElement | null {
    return this.container
  }

  /** The marker's place. `heightMeters` is the terrain's height under it when it follows the terrain. */
  getPosition(): GeographicPosition & { heightMeters: number } {
    return { longitudeDegrees: this.longitudeDegrees, latitudeDegrees: this.latitudeDegrees, heightMeters: this.resolvedHeightMeters }
  }

  /**
   * Moves the marker. Leave `heightMeters` out to keep the current height setting (a number, or following
   * the terrain).
   */
  setPosition({ longitudeDegrees, latitudeDegrees, heightMeters }: { longitudeDegrees: number; latitudeDegrees: number; heightMeters?: MarkerHeight }): this {
    const moved = longitudeDegrees !== this.longitudeDegrees || latitudeDegrees !== this.latitudeDegrees
    this.longitudeDegrees = longitudeDegrees
    this.latitudeDegrees = latitudeDegrees
    if (heightMeters !== undefined) this.heightOption = heightMeters
    // A new place needs its own terrain height: read it on the next frame with budget.
    if (moved) this.lastTerrainHeightCheckMilliseconds = -Infinity
    this.refresh()
    return this
  }

  /** The height setting: metres, or 'terrain'. */
  getHeight(): MarkerHeight {
    return this.heightOption
  }

  setAnchor(anchor: ScreenAnchor): this {
    this.anchor = anchor
    this.element.style.transformOrigin = anchorTransformOrigin(anchor)
    return this.refresh()
  }

  getAnchor(): ScreenAnchor {
    return this.anchor
  }

  setOffset(offsetPixels: ScreenOffset): this {
    this.offset = offsetPixels
    return this.refresh()
  }

  getOffset(): ScreenOffset {
    return this.offset
  }

  setRotation(rotationDegrees: number): this {
    this.rotationDegrees = rotationDegrees
    return this.refresh()
  }

  getRotation(): number {
    return this.rotationDegrees
  }

  setRotationAlignment(alignment: MarkerAlignment): this {
    this.rotationAlignment = alignment
    return this.refresh()
  }

  getRotationAlignment(): MarkerAlignment {
    return this.rotationAlignment
  }

  setPitchAlignment(alignment: MarkerAlignment): this {
    this.pitchAlignment = alignment
    return this.refresh()
  }

  getPitchAlignment(): MarkerAlignment {
    return this.pitchAlignment
  }

  setOccludedOpacity(opacity: number): this {
    this.occludedOpacity = opacity
    return this.refresh()
  }

  getOccludedOpacity(): number {
    return this.occludedOpacity
  }

  setDraggable(draggable: boolean): this {
    this.draggable = draggable
    this.element.toggleAttribute('data-draggable', draggable)
    return this
  }

  isDraggable(): boolean {
    return this.draggable
  }

  /** The accessible name screen readers announce. */
  setLabel(label: string): this {
    this.element.setAttribute('aria-label', label)
    return this
  }

  /** Attaches a popup the marker toggles on click, Enter or Space; null detaches it (closing it). */
  setPopup(popup: Popup | null): this {
    if (this.popup === popup) return this
    const previous = this.popup
    this.popup = null
    if (previous !== null) {
      previous.remove()
      if (previous.getMarker() === this) previous.setMarker(null)
    }
    this.popup = popup
    popup?.setMarker(this)
    if (popup === null) {
      this.element.removeAttribute('aria-haspopup')
      this.element.removeAttribute('aria-expanded')
    } else {
      this.element.setAttribute('aria-haspopup', 'dialog')
      this.element.setAttribute('aria-expanded', String(popup.isOpen()))
    }
    return this
  }

  getPopup(): Popup | null {
    return this.popup
  }

  /** Opens the popup when it is closed, closes it when it is open. Needs the marker to be on a map. */
  togglePopup(): this {
    const popup = this.popup
    if (popup === null || this.earth === null || this.container === null) return this
    if (popup.isOpen()) popup.remove()
    else popup.addTo(this.earth, this.container)
    return this
  }

  /**
   * The element's box on the screen as of the last frame, in CSS pixels from the container's top-left corner
   * (rotation and tilt left out). Null while hidden. Popups open beside it.
   */
  getScreenBox(): ScreenBox | null {
    if (this.visibility === 'hidden' || this.earth === null) return null
    if (this.elementSize === null) this.elementSize = { widthPixels: this.element.offsetWidth, heightPixels: this.element.offsetHeight }
    return anchoredBox(this.screenPosition, this.elementSize.widthPixels, this.elementSize.heightPixels, this.anchor, this.offset)
  }

  /** The height the marker is drawn at: its own, or the terrain's last read (0 before the first). */
  protected get resolvedHeightMeters(): number {
    return this.heightOption === 'terrain' ? (this.terrainHeightMeters ?? 0) : this.heightOption
  }

  /** Places the marker for a frame. Called by `ScreenOverlay` at the end of every `earth.update`. */
  updateScreen(frame: ScreenOverlayFrame): void {
    const earth = this.earth
    if (earth === null) return
    const now = frame.timeMilliseconds
    const dueForTerrain = now - this.lastTerrainHeightCheckMilliseconds >= this.terrainCheckIntervalMilliseconds
    if (this.heightOption === 'terrain' && earth.terrain !== null && !this.dragging && dueForTerrain && takeRaycast(frame)) {
      this.lastTerrainHeightCheckMilliseconds = now
      // Where no tile is loaded yet, keep the last height rather than dropping to the ellipsoid.
      this.terrainHeightMeters = earth.camera.queryTerrainElevation({ longitudeDegrees: this.longitudeDegrees, latitudeDegrees: this.latitudeDegrees }) ?? this.terrainHeightMeters
    }

    const position = { longitudeDegrees: this.longitudeDegrees, latitudeDegrees: this.latitudeDegrees, heightMeters: this.resolvedHeightMeters }
    const point = earth.camera.toScenePosition(position, scenePoint)
    const inFront = sceneToScreen(frame, point, this.screenPosition)
    const hidden = !inFront || isBehindHorizon(frame, point)
    if (hidden) {
      this.setVisibility('hidden')
      return
    }
    if (now - this.lastOcclusionCheckMilliseconds >= this.terrainCheckIntervalMilliseconds && takeRaycast(frame)) {
      this.lastOcclusionCheckMilliseconds = now
      const distanceMeters = point.distanceTo(frame.cameraPosition)
      // The marker's own ground, read at the level of detail loaded, must not hide it.
      this.occludedByTerrain = isBehindTerrain(frame, point, Math.max(5, distanceMeters * 0.002))
    }
    this.setVisibility(this.occludedByTerrain ? 'occluded' : 'visible')

    let rotation = this.rotationDegrees
    let tilt = 0
    if (this.rotationAlignment === 'map' || this.pitchAlignment === 'map') {
      const { headingDegrees, pitchDegrees } = localHeadingAndPitch(frame, this.longitudeDegrees, this.latitudeDegrees)
      ;({ rotationDegrees: rotation, tiltDegrees: tilt } = markerRotation(this.rotationDegrees, this.rotationAlignment, this.pitchAlignment, headingDegrees, pitchDegrees))
    }
    const transform = anchoredTransform(this.screenPosition, this.anchor, this.offset, rotation, tilt)
    if (transform !== this.lastTransform) {
      this.element.style.transform = transform
      this.lastTransform = transform
    }
  }

  protected setVisibility(visibility: ScreenVisibility): void {
    if (visibility !== this.visibility) {
      this.visibility = visibility
      this.element.dataset.visibility = visibility
    }
    const opacity = visibility === 'occluded' ? String(this.occludedOpacity) : ''
    if (opacity !== this.lastOpacity) {
      this.element.style.opacity = opacity
      this.lastOpacity = opacity
    }
  }

  /** Re-places the marker now from the last frame's camera, and asks for a frame. */
  protected refresh(): this {
    if (this.earth === null) return this
    ScreenOverlay.of(this.earth).refresh(this)
    this.earth.requestFrame()
    return this
  }

  protected createPin(color: string | undefined): HTMLElement {
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'react-three-earth-marker-pin'
    pin.innerHTML = PIN_SVG // a constant: no outside text
    if (color !== undefined) pin.style.setProperty('--react-three-earth-marker-color', color)
    return pin
  }

  protected makeAccessible(label: string | undefined): void {
    const element = this.element
    const natural = element instanceof HTMLButtonElement || (element instanceof HTMLAnchorElement && element.hasAttribute('href'))
    if (!natural) {
      if (!element.hasAttribute('role')) element.setAttribute('role', 'button')
      if (!element.hasAttribute('tabindex')) element.tabIndex = 0
    }
    if (label !== undefined || !element.hasAttribute('aria-label')) element.setAttribute('aria-label', label ?? 'Map marker')
  }

  protected isNativeButton(): boolean {
    return this.element instanceof HTMLButtonElement
  }

  protected dragEvent(): MarkerDragEvent {
    return { position: this.getPosition() }
  }

  protected onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.suppressNextClick = false
    const rectangle = this.container?.getBoundingClientRect()
    const containerLeft = rectangle?.left ?? 0
    const containerTop = rectangle?.top ?? 0
    this.pointerDown = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      // Where in the marker it was grabbed, so it does not jump to the pointer.
      grabXPixels: event.clientX - containerLeft - this.screenPosition.xPixels,
      grabYPixels: event.clientY - containerTop - this.screenPosition.yPixels,
      containerLeft,
      containerTop,
    }
    if (!this.draggable) return // the press reaches the map: dragging from a marker pans, as in MapLibre
    event.stopPropagation()
    event.preventDefault() // no text selection or native drag
    this.element.setPointerCapture?.(event.pointerId)
  }

  protected onPointerMove = (event: PointerEvent): void => {
    const down = this.pointerDown
    if (!this.draggable || down === null || down.pointerId !== event.pointerId || this.earth === null) return
    if (!this.dragging) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) <= CLICK_TOLERANCE_PIXELS) return
      this.dragging = true
      this.element.toggleAttribute('data-dragging', true)
      this.dispatchEvent({ type: 'dragstart', ...this.dragEvent() })
    }
    const ground = this.earth.camera.unproject({
      xPixels: event.clientX - down.containerLeft - down.grabXPixels,
      yPixels: event.clientY - down.containerTop - down.grabYPixels,
    })
    if (ground === null) return // over the sky: stay at the last place on the ground
    this.longitudeDegrees = ground.longitudeDegrees
    this.latitudeDegrees = ground.latitudeDegrees
    if (this.heightOption === 'terrain') this.terrainHeightMeters = ground.heightMeters
    this.refresh()
    this.dispatchEvent({ type: 'drag', ...this.dragEvent() })
  }

  protected onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown
    if (down === null || down.pointerId !== event.pointerId) return
    this.pointerDown = null
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture(event.pointerId)
    // Moved past the tolerance: a drag of the marker or a pan of the map, not a click.
    this.suppressNextClick = Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > CLICK_TOLERANCE_PIXELS
    if (!this.dragging) return
    this.dragging = false
    this.element.removeAttribute('data-dragging')
    this.dispatchEvent({ type: 'dragend', ...this.dragEvent() })
  }

  protected onClick = (): void => {
    if (this.suppressNextClick) {
      this.suppressNextClick = false
      return
    }
    this.dispatchEvent({ type: 'click' })
    this.togglePopup()
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.popup?.isOpen() === true) {
      event.stopPropagation()
      this.popup.remove()
      return
    }
    // A native button turns Enter and Space into a click by itself.
    if ((event.key === 'Enter' || event.key === ' ') && !this.isNativeButton()) {
      event.preventDefault()
      event.stopPropagation()
      this.onClick()
    }
  }
}
