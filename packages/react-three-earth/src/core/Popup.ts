import { EventDispatcher, Vector3 } from 'three'

import type { Earth } from './Earth.js'
import type { Marker, MarkerHeight } from './Marker.js'
import { anchoredTransform, CLICK_TOLERANCE_PIXELS, popupOffset, popupPointOnBox, resolvePopupAnchor, type ScreenAnchor, type ScreenOffset } from './markerLayout.js'
import type { ScreenPosition } from './projection.js'
import {
  acquireScreenLayer,
  isBehindHorizon,
  releaseScreenLayer,
  sceneToScreen,
  ScreenOverlay,
  staleTerrainCheck,
  startTerrainCheck,
  TERRAIN_CHECK_INTERVAL_MILLISECONDS,
  type ScreenOverlayFrame,
  type ScreenOverlayItem,
} from './ScreenOverlay.js'

export interface PopupOptions {
  /** Where the popup points, unless it belongs to a marker or tracks the pointer. Set it later with `setPosition`. */
  longitudeDegrees?: number
  latitudeDegrees?: number
  /** Ellipsoidal height in metres, or 'terrain' to point at the loaded terrain. Default: 'terrain'. */
  heightMeters?: MarkerHeight
  /** The text or element to show. Set it later with `setContent`. */
  content?: Node | string
  /**
   * The side of the popup on its point: `'bottom'` opens it above. `'auto'` opens it above, or wherever it fits
   * inside the container. Default: 'auto'.
   */
  anchor?: ScreenAnchor | 'auto'
  /**
   * Distance from the point in CSS pixels, away from it on the anchor's side, or a shift of your own. On a
   * marker it adds to the marker's edge. Default: 0.
   */
  offsetPixels?: number | ScreenOffset
  /** Shows a × button in the top-right corner. Default: true. */
  closeButton?: boolean
  /** Closes when the user clicks the map (not after a drag). Default: true. */
  closeOnClick?: boolean
  /** Closes when the camera starts moving. Default: false. */
  closeOnMove?: boolean
  /** Moves keyboard focus into the popup when it opens, and back where it was when it closes. Default: true. */
  focusAfterOpen?: boolean
  /** The widest the popup gets, in CSS pixels; Infinity for no limit. Default: 240. */
  maximumWidthPixels?: number
  /** Extra class names for the popup's root element, space-separated. */
  className?: string
  /** The accessible name of the dialog screen readers announce. Default: 'Map popup'. */
  label?: string
}

export interface PopupEventMap {
  /** The popup was added to a map. */
  open: object
  /** The popup was taken off the map: by `remove`, its close button, `Escape`, a click on the map or a camera move. */
  close: object
}

const scenePoint = new Vector3()
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A box of HTML pointing at a place, as MapLibre's `Popup`: at a position, on a `Marker` (which opens it on
 * click), or following the pointer (`trackPointer`). Chooses the side it fits on, has a close button, closes
 * on `Escape` and on a click on the map, and moves keyboard focus in and back.
 *
 * ```ts
 * const popup = new Popup({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, content: 'Paris' })
 * popup.addTo(earth, canvas.parentElement!)
 * ```
 *
 * Content given as a string is shown as text, never parsed as HTML. Pass an element for rich content.
 */
export class Popup extends EventDispatcher<PopupEventMap> implements ScreenOverlayItem {
  /** The popup's root element. */
  readonly element: HTMLElement
  /** The element holding the content: put your own nodes in it, or render into it. */
  readonly contentElement: HTMLElement
  /** The anchor used in the last frame (resolved when the option is 'auto'). */
  currentAnchor: ScreenAnchor = 'bottom'

  protected earth: Earth | null = null
  protected container: HTMLElement | null = null
  protected marker: Marker | null = null
  protected position: { longitudeDegrees: number; latitudeDegrees: number } | null
  protected heightOption: MarkerHeight
  protected terrainHeightMeters: number | null = null
  protected terrainHeightCheck = staleTerrainCheck()
  protected anchorOption: ScreenAnchor | 'auto'
  protected offsetOption: number | ScreenOffset
  protected closeOnClick: boolean
  protected closeOnMove: boolean
  protected focusAfterOpen: boolean
  protected readonly boxElement: HTMLElement
  protected readonly closeButtonElement: HTMLButtonElement | null
  protected readonly screenPoint: ScreenPosition = { xPixels: 0, yPixels: 0 }
  protected size: { widthPixels: number; heightPixels: number } | null = null
  protected readonly resizeObserver: ResizeObserver | null
  protected lastTransform = ''
  protected hidden = true
  protected trackingPointer = false
  protected pointerPosition: ScreenPosition | null = null
  protected pointerDownPosition: { clientX: number; clientY: number } | null = null
  protected openedAtMilliseconds = 0
  protected focusBeforeOpen: Element | null = null
  /** Focus moves in at the first frame the popup shows (an element hidden with `visibility` cannot take it). */
  protected focusPending = false
  protected focusWhenContentArrives = false
  /** Milliseconds between two reads of the terrain under the popup's position. */
  terrainCheckIntervalMilliseconds = TERRAIN_CHECK_INTERVAL_MILLISECONDS

  constructor(options: PopupOptions = {}) {
    super()
    this.position =
      options.longitudeDegrees !== undefined && options.latitudeDegrees !== undefined
        ? { longitudeDegrees: options.longitudeDegrees, latitudeDegrees: options.latitudeDegrees }
        : null
    this.heightOption = options.heightMeters ?? 'terrain'
    this.anchorOption = options.anchor ?? 'auto'
    this.offsetOption = options.offsetPixels ?? 0
    this.closeOnClick = options.closeOnClick ?? true
    this.closeOnMove = options.closeOnMove ?? false
    this.focusAfterOpen = options.focusAfterOpen ?? true

    this.element = document.createElement('div')
    this.element.className = 'react-three-earth-popup'
    if (options.className) this.element.classList.add(...options.className.split(/\s+/).filter(Boolean))
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', options.label ?? 'Map popup')
    this.element.dataset.visibility = 'hidden'
    this.element.dataset.anchor = 'bottom'
    const tip = document.createElement('div')
    tip.className = 'react-three-earth-popup-tip'
    this.boxElement = document.createElement('div')
    this.boxElement.className = 'react-three-earth-popup-content'
    this.boxElement.tabIndex = -1
    this.contentElement = document.createElement('div')
    this.contentElement.className = 'react-three-earth-popup-body'
    this.boxElement.append(this.contentElement)
    this.closeButtonElement = null
    if (options.closeButton ?? true) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'react-three-earth-popup-close'
      button.setAttribute('aria-label', 'Close popup')
      button.textContent = '×'
      button.addEventListener('click', this.onCloseButton)
      this.boxElement.append(button)
      this.closeButtonElement = button
      this.element.toggleAttribute('data-close-button', true)
    }
    this.element.append(tip, this.boxElement)
    this.setMaximumWidth(options.maximumWidthPixels ?? 240)
    if (options.content !== undefined) this.setContent(options.content)

    // Presses and keys inside the popup are the popup's: they must not pan the map or fly the camera.
    this.element.addEventListener('pointerdown', stopPropagation)
    this.element.addEventListener('keydown', this.onKeyDown)
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.size = { widthPixels: this.element.offsetWidth, heightPixels: this.element.offsetHeight }
            if (this.focusWhenContentArrives && this.contentElement.childNodes.length > 0) {
              this.focusWhenContentArrives = false
              this.focusPending = this.contentElement.querySelector(FOCUSABLE) !== null
              if (!this.hidden) this.focusInside()
            }
            // Content that arrives after opening (a React root renders later) may need the other side.
            if (this.earth !== null) ScreenOverlay.of(this.earth).refresh(this)
          })
  }

  /**
   * Opens the popup over an earth's canvas. `container` is the element the canvas fills (its parent in a
   * React Three Fiber `<Canvas>`). On a marker, prefer `marker.togglePopup()`, which passes its own.
   */
  addTo(earth: Earth, container: HTMLElement, { focus = false }: { focus?: boolean } = {}): this {
    if (this.earth !== null) this.remove()
    this.earth = earth
    this.container = container
    this.openedAtMilliseconds = performance.now()
    // On a marker, focus goes back to it: a press on the map may have kept it from taking focus.
    this.focusBeforeOpen = this.marker?.element ?? container.ownerDocument.activeElement
    acquireScreenLayer(container).append(this.element)
    this.resizeObserver?.observe(this.element, { box: 'border-box' })
    container.addEventListener('pointerdown', this.onContainerPointerDown, true)
    // Capture: a click on another marker closes this popup before that marker opens its own (or asks the app to).
    container.addEventListener('click', this.onContainerClick, true)
    if (this.trackingPointer) this.listenToPointer(container)
    earth.addEventListener('movestart', this.onMoveStart)
    this.marker?.element.setAttribute('aria-expanded', 'true')
    ScreenOverlay.of(earth).add(this, 'popup')
    earth.requestFrame()
    this.dispatchEvent({ type: 'open' })
    // Opened by the user (a marker click): focus moves in. Opened by the app: focus moves only to a control in
    // the content, never away from what the user is typing in to an empty box. A tooltip never takes it.
    const mayFocus = this.focusAfterOpen && !this.trackingPointer
    this.focusPending = mayFocus && (focus || this.contentElement.querySelector(FOCUSABLE) !== null)
    // Content rendered after opening (a React root renders later) gets one look for a control when it arrives.
    this.focusWhenContentArrives = mayFocus && !this.focusPending && this.contentElement.childNodes.length === 0
    if (!this.hidden) this.focusInside()
    return this
  }

  /** Closes the popup. It can be opened again. */
  remove(): this {
    const earth = this.earth
    const container = this.container
    if (earth === null || container === null) return this
    const focusWasInside = this.element.contains(container.ownerDocument.activeElement)
    ScreenOverlay.of(earth).delete(this)
    this.resizeObserver?.unobserve(this.element)
    container.removeEventListener('pointerdown', this.onContainerPointerDown, true)
    container.removeEventListener('click', this.onContainerClick, true)
    this.stopListeningToPointer(container)
    earth.removeEventListener('movestart', this.onMoveStart)
    this.element.remove()
    releaseScreenLayer(container)
    this.earth = null
    this.container = null
    this.hidden = true
    this.element.dataset.visibility = 'hidden'
    this.lastTransform = ''
    this.marker?.element.setAttribute('aria-expanded', 'false')
    // Back where the user was (usually the marker), unless they already moved on.
    if (this.focusAfterOpen && focusWasInside) {
      const back = this.focusBeforeOpen as HTMLElement | null
      if (back?.isConnected === true && typeof back.focus === 'function') back.focus({ preventScroll: true })
    }
    this.focusBeforeOpen = null
    this.focusPending = false
    this.focusWhenContentArrives = false
    this.dispatchEvent({ type: 'close' })
    return this
  }

  /** Closes the popup, detaches it from its marker and removes its listeners for good. */
  dispose(): void {
    this.remove()
    this.marker?.setPopup(null)
    this.resizeObserver?.disconnect()
    this.closeButtonElement?.removeEventListener('click', this.onCloseButton)
    this.element.removeEventListener('pointerdown', stopPropagation)
    this.element.removeEventListener('keydown', this.onKeyDown)
  }

  isOpen(): boolean {
    return this.earth !== null
  }

  /** Replaces the content: a string is shown as text, a node is inserted as it is. */
  setContent(content: Node | string): this {
    if (typeof content === 'string') this.contentElement.textContent = content
    else this.contentElement.replaceChildren(content)
    return this
  }

  /**
   * Points the popup at a place (no longer at the pointer). Leave `heightMeters` out to keep the height
   * setting. On a marker, the marker's place wins.
   */
  setPosition({ longitudeDegrees, latitudeDegrees, heightMeters }: { longitudeDegrees: number; latitudeDegrees: number; heightMeters?: MarkerHeight }): this {
    const moved = this.position?.longitudeDegrees !== longitudeDegrees || this.position?.latitudeDegrees !== latitudeDegrees
    this.position = { longitudeDegrees, latitudeDegrees }
    if (heightMeters !== undefined) this.heightOption = heightMeters
    if (moved) this.terrainHeightCheck = staleTerrainCheck()
    if (this.trackingPointer) {
      this.trackingPointer = false
      this.element.removeAttribute('data-tracking-pointer')
      if (this.container !== null) this.stopListeningToPointer(this.container)
    }
    return this.refresh()
  }

  /** The place the popup points at: its marker's, its own, or null when it has none or tracks the pointer. */
  getPosition(): { longitudeDegrees: number; latitudeDegrees: number } | null {
    if (this.marker !== null) {
      const { longitudeDegrees, latitudeDegrees } = this.marker.getPosition()
      return { longitudeDegrees, latitudeDegrees }
    }
    return this.trackingPointer ? null : this.position
  }

  /**
   * Follows the pointer over the container instead of a place, hiding while the pointer is outside it, as a
   * tooltip. The popup lets pointer events through to the map. `setPosition` stops it.
   */
  trackPointer(): this {
    if (this.trackingPointer) return this
    this.trackingPointer = true
    this.element.toggleAttribute('data-tracking-pointer', true)
    if (this.container !== null) this.listenToPointer(this.container)
    return this.refresh()
  }

  isTrackingPointer(): boolean {
    return this.trackingPointer
  }

  setAnchor(anchor: ScreenAnchor | 'auto'): this {
    this.anchorOption = anchor
    return this.refresh()
  }

  setOffset(offsetPixels: number | ScreenOffset): this {
    this.offsetOption = offsetPixels
    return this.refresh()
  }

  setMaximumWidth(maximumWidthPixels: number): this {
    this.element.style.maxWidth = Number.isFinite(maximumWidthPixels) ? `${maximumWidthPixels}px` : 'none'
    return this.refresh()
  }

  setCloseOnClick(closeOnClick: boolean): this {
    this.closeOnClick = closeOnClick
    return this
  }

  setCloseOnMove(closeOnMove: boolean): this {
    this.closeOnMove = closeOnMove
    return this
  }

  setFocusAfterOpen(focusAfterOpen: boolean): this {
    this.focusAfterOpen = focusAfterOpen
    return this
  }

  /** The accessible name of the dialog. */
  setLabel(label: string): this {
    this.element.setAttribute('aria-label', label)
    return this
  }

  getMarker(): Marker | null {
    return this.marker
  }

  /** Called by `marker.setPopup`: the popup then opens beside the marker. Use `marker.setPopup` rather than this. */
  setMarker(marker: Marker | null): this {
    if (this.marker === marker) return this
    this.remove()
    this.marker = marker
    return this
  }

  /** Places the popup for a frame. Called by `ScreenOverlay` after the markers, at the end of every `earth.update`. */
  updateScreen(frame: ScreenOverlayFrame): void {
    if (this.earth === null) return
    const box = this.marker?.getScreenBox() ?? null
    let point: ScreenPosition | null = null
    if (this.marker !== null) {
      if (box !== null) point = popupPointOnBox(box, 'bottom')
    } else if (this.trackingPointer) {
      point = this.pointerPosition
    } else if (this.position !== null) {
      point = this.project(frame)
    }
    if (point === null) {
      this.setHidden(true)
      return
    }
    if (this.size === null) this.size = { widthPixels: this.element.offsetWidth, heightPixels: this.element.offsetHeight }
    const anchor =
      this.anchorOption === 'auto'
        ? resolvePopupAnchor(point, this.size.widthPixels, this.size.heightPixels, frame.widthPixels, frame.heightPixels, this.offsetOption)
        : this.anchorOption
    if (box !== null) point = popupPointOnBox(box, anchor)
    if (anchor !== this.currentAnchor || this.element.dataset.anchor !== anchor) {
      this.currentAnchor = anchor
      this.element.dataset.anchor = anchor
    }
    const transform = anchoredTransform(point, anchor, popupOffset(anchor, this.offsetOption))
    if (transform !== this.lastTransform) {
      this.element.style.transform = transform
      this.lastTransform = transform
    }
    this.setHidden(false)
  }

  /** The popup's own position on the screen, or null when it is behind the camera or the globe's horizon. */
  protected project(frame: ScreenOverlayFrame): ScreenPosition | null {
    const earth = frame.earth
    const position = this.position!
    if (this.heightOption === 'terrain' && earth.terrain !== null && startTerrainCheck(frame, this.terrainHeightCheck, this.terrainCheckIntervalMilliseconds)) {
      this.terrainHeightMeters = earth.camera.queryTerrainElevation(position) ?? this.terrainHeightMeters
    }
    const heightMeters = this.heightOption === 'terrain' ? (this.terrainHeightMeters ?? 0) : this.heightOption
    const point = earth.camera.toScenePosition({ ...position, heightMeters }, scenePoint)
    if (!sceneToScreen(frame, point, this.screenPoint) || isBehindHorizon(frame, point)) return null
    return this.screenPoint
  }

  protected setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    this.element.dataset.visibility = hidden ? 'hidden' : 'visible'
    if (!hidden && this.focusPending) this.focusInside()
  }

  protected refresh(): this {
    if (this.earth === null) return this
    ScreenOverlay.of(this.earth).refresh(this)
    this.earth.requestFrame()
    return this
  }

  /** Focuses the first control in the content, or the content box, so screen readers read it. */
  protected focusInside(): void {
    if (!this.focusPending) return
    this.focusPending = false
    const target = this.contentElement.querySelector<HTMLElement>(FOCUSABLE) ?? this.boxElement
    target.focus({ preventScroll: true })
  }

  protected listenToPointer(container: HTMLElement): void {
    container.addEventListener('pointermove', this.onPointerMove)
    container.addEventListener('pointerleave', this.onPointerLeave)
  }

  protected stopListeningToPointer(container: HTMLElement): void {
    container.removeEventListener('pointermove', this.onPointerMove)
    container.removeEventListener('pointerleave', this.onPointerLeave)
    this.pointerPosition = null
  }

  protected onPointerMove = (event: PointerEvent): void => {
    const rectangle = this.container!.getBoundingClientRect()
    this.pointerPosition = { xPixels: event.clientX - rectangle.left, yPixels: event.clientY - rectangle.top }
    if (this.earth !== null) ScreenOverlay.of(this.earth).refresh(this)
  }

  protected onPointerLeave = (): void => {
    this.pointerPosition = null
    this.setHidden(true)
  }

  protected onContainerPointerDown = (event: PointerEvent): void => {
    this.pointerDownPosition = { clientX: event.clientX, clientY: event.clientY }
  }

  protected onContainerClick = (event: MouseEvent): void => {
    if (!this.closeOnClick) return
    // The click that opened the popup (on the map or a marker) is still on its way up: not a click to close.
    if (event.timeStamp < this.openedAtMilliseconds) return
    const target = event.target as Element | null
    if (target === null || this.marker?.element.contains(target) === true) return
    // Only clicks on the map close it: the canvas, or another marker. Not this popup or another, nor a control.
    if (target.closest?.('.react-three-earth-popup') != null) return
    const onMap = target instanceof HTMLCanvasElement || target.closest?.('.react-three-earth-markers') != null
    if (!onMap) return
    const down = this.pointerDownPosition
    if (down !== null && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > CLICK_TOLERANCE_PIXELS) return
    this.remove()
  }

  protected onMoveStart = (): void => {
    if (this.closeOnMove) this.remove()
  }

  protected onCloseButton = (): void => {
    this.remove()
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      this.remove()
    }
  }
}

function stopPropagation(event: Event): void {
  event.stopPropagation()
}
