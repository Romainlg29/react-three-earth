import { EventDispatcher } from 'three'

import type { Earth } from '../core/Earth.js'
import { Marker } from '../core/Marker.js'
import { groundMetersPerPixelToZoom } from '../core/zoom.js'
import { Controls, MapControl } from './Controls.js'
import { createControlButton, createIcon, setButtonLabel } from './controlsStyle.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface GeolocateControlOptions {
  /** Keep following the user: the map re-centres on every new position until the user moves it or presses again. Default: false. */
  trackUser?: boolean
  /** Options of the browser's Geolocation API. Default: `{ enableHighAccuracy: false, maximumAge: 0, timeout: 6000 }`. */
  positionOptions?: PositionOptions
  /** The highest zoom the camera goes to when it flies to the user. Default: 15. */
  fitMaximumZoom?: number
  /** Draw a dot at the user's position. Default: true. */
  showUserLocation?: boolean
  /** Draw a circle of the position's accuracy around the dot. Default: true. */
  showAccuracyCircle?: boolean
  locale?: Partial<ControlsLocale>
}

/** `off`: not following. `waiting`: asked, no position yet. `tracking`: the map follows. `background`: the dot follows, the map does not. */
export type GeolocateState = 'off' | 'waiting' | 'tracking' | 'background' | 'error'

export interface GeolocateEventMap {
  /** A position arrived. */
  geolocate: { coordinates: GeolocationCoordinates; timestamp: number }
  /** The browser could not tell the position: `error.code` 1 is "permission denied", 2 "unavailable", 3 "timeout". */
  error: { error: GeolocationPositionError }
  /** The map started following the user. */
  trackuserlocationstart: object
  /** The map stopped following the user. */
  trackuserlocationend: object
}

const USER_INPUT_EVENTS = ['pointerdown', 'wheel', 'touchstart'] as const

const CROSSHAIR = 'M9 1h2v2.07A7 7 0 0 1 16.93 9H19v2h-2.07A7 7 0 0 1 11 16.93V19H9v-2.07A7 7 0 0 1 3.07 11H1V9h2.07A7 7 0 0 1 9 3.07zM10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'

/**
 * A button that finds the user with the browser's Geolocation API and flies there, as MapLibre's `GeolocateControl`.
 * The library asks for the position only when the button is pressed (browsers need that gesture, iPhone Safari
 * too, and require HTTPS). The position never leaves the page.
 *
 * With `trackUser`, the first press follows the user, a second press stops, and moving the map yourself pauses
 * the following (the dot stays; press again to resume). A dot and an accuracy circle sit on the map as markers.
 * Events: `geolocate`, `error`, `trackuserlocationstart`, `trackuserlocationend` on `control.events`.
 */
export class GeolocateControl extends MapControl {
  readonly element: HTMLElement
  readonly events = new EventDispatcher<GeolocateEventMap>()
  protected readonly button: HTMLButtonElement
  protected readonly trackUser: boolean
  protected readonly positionOptions: PositionOptions
  protected readonly fitMaximumZoom: number
  protected readonly showUserLocation: boolean
  protected readonly showAccuracyCircle: boolean
  protected readonly locale: ControlsLocale
  protected state: GeolocateState = 'off'
  protected watchIdentifier: number | null = null
  protected dot: Marker | null = null
  protected circle: Marker | null = null
  protected circleElement: HTMLElement | null = null
  protected lastPosition: GeolocationPosition | null = null
  protected permissionDenied = false
  protected permissionStatus: PermissionStatus | null = null
  protected listeningTo: Earth | null = null
  protected flightToken = 0
  protected firstFixPending = false
  protected trackingStarted = false
  protected stateBeforeError: GeolocateState = 'off'

  constructor({ trackUser = false, positionOptions, fitMaximumZoom = 15, showUserLocation = true, showAccuracyCircle = true, locale }: GeolocateControlOptions = {}) {
    super()
    this.trackUser = trackUser
    this.positionOptions = { enableHighAccuracy: false, maximumAge: 0, timeout: 6000, ...positionOptions }
    this.fitMaximumZoom = fitMaximumZoom
    this.showUserLocation = showUserLocation
    this.showAccuracyCircle = showAccuracyCircle
    this.locale = resolveLocale(locale)
    const document = globalThis.document
    this.element = document.createElement('div')
    this.element.className = 'react-three-earth-control-group'
    this.button = createControlButton(document, this.locale.geolocate)
    this.button.append(createIcon(document, CROSSHAIR))
    this.button.addEventListener('click', this.onClick)
    this.element.append(this.button)
    if (trackUser) this.button.setAttribute('aria-pressed', 'false')
    this.element.hidden = !geolocationAvailable()
    this.render()
  }

  get currentState(): GeolocateState {
    return this.state
  }

  protected attach(controls: Controls): void {
    this.listeningTo = controls.earth
    // In the capture phase, so gestures that stop these events from the pointer controls (box zoom) still count
    for (const type of USER_INPUT_EVENTS) controls.container.addEventListener(type, this.onUserInput, { passive: true, capture: true })
    controls.earth.addEventListener('zoom', this.updateCircle)
    controls.earth.addEventListener('moveend', this.updateCircle)
    void this.watchPermission()
  }

  protected detach(): void {
    this.stop()
    for (const type of USER_INPUT_EVENTS) this.controls?.container.removeEventListener(type, this.onUserInput, { capture: true })
    this.listeningTo?.removeEventListener('zoom', this.updateCircle)
    this.listeningTo?.removeEventListener('moveend', this.updateCircle)
    this.listeningTo = null
    this.permissionStatus?.removeEventListener('change', this.onPermissionChange)
    this.permissionStatus = null
    this.removeMarkers()
  }

  /** What pressing the button does. */
  trigger(): void {
    if (!geolocationAvailable() || this.permissionDenied) return
    if (this.trackUser) {
      if (this.state === 'tracking') {
        this.stop()
        this.removeMarkers()
        return
      }
      if (this.state === 'waiting') {
        this.stop()
        return
      }
      if (this.state === 'error' && this.watchIdentifier !== null) {
        // The watch is alive after a lost fix: carry on following
        this.setState('tracking')
        if (this.lastPosition !== null) this.flyToPosition(this.lastPosition, false)
        return
      }
      // 'background' and 'off' start (or resume) following
      if (this.state === 'background' && this.lastPosition !== null) {
        this.setState('tracking')
        this.flyToPosition(this.lastPosition, false)
        return
      }
      this.start()
      return
    }
    // One fix per press: the dot stays, the map goes there
    this.firstFixPending = true
    this.setState('waiting')
    navigator.geolocation.getCurrentPosition(this.onPosition, this.onError, this.positionOptions)
  }

  /** Stops following and watching. The dot stays until the next press, or `removeMarkers`. */
  stop(): void {
    this.clearWatch()
    if (this.trackingStarted) {
      this.trackingStarted = false
      this.events.dispatchEvent({ type: 'trackuserlocationend' })
    }
    this.flightToken++
    this.setState('off')
  }

  protected start(): void {
    this.clearWatch()
    this.firstFixPending = true
    this.setState('waiting')
    this.trackingStarted = true
    this.events.dispatchEvent({ type: 'trackuserlocationstart' })
    this.watchIdentifier = navigator.geolocation.watchPosition(this.onPosition, this.onError, this.positionOptions)
  }

  protected clearWatch(): void {
    if (this.watchIdentifier === null) return
    navigator.geolocation.clearWatch(this.watchIdentifier)
    this.watchIdentifier = null
  }

  protected onClick = (): void => this.trigger()

  protected onPosition = (position: GeolocationPosition): void => {
    if (this.controls === null) return
    this.lastPosition = position
    this.updateMarkers(position)
    this.events.dispatchEvent({ type: 'geolocate', coordinates: position.coords, timestamp: position.timestamp })
    if (this.trackUser) {
      if (this.state === 'waiting') this.setState('tracking')
      else if (this.state === 'error') this.setState(this.stateBeforeError === 'background' ? 'background' : 'tracking')
      if (this.state === 'tracking') this.flyToPosition(position, !this.firstFixPending)
    } else {
      this.flyToPosition(position, false)
      this.setState('off')
    }
    this.firstFixPending = false
  }

  protected onError = (error: GeolocationPositionError): void => {
    if (error.code === 1) {
      this.permissionDenied = true
      this.stop()
    } else if (this.trackUser && this.watchIdentifier !== null && this.state !== 'waiting') {
      // A lost fix while following: the dot is stale, the watch carries on
      this.dot?.element.setAttribute('data-stale', 'true')
      if (this.state !== 'error') this.stateBeforeError = this.state
    } else {
      this.stop()
    }
    this.setState('error')
    this.events.dispatchEvent({ type: 'error', error })
  }

  /** Moves the camera to a position: a flight on the first fix, otherwise a short ease keeping the zoom. */
  protected flyToPosition(position: GeolocationPosition, keepZoom: boolean): void {
    const earth = this.earth
    if (earth === null || !earth.camera.ready) return
    const { longitude, latitude, accuracy } = position.coords
    const camera = earth.camera
    ++this.flightToken
    const target = { longitudeDegrees: longitude, latitudeDegrees: latitude }
    let motion: Promise<boolean>
    if (keepZoom) {
      motion = camera.easeTo(target, { durationSeconds: 0.5, easing: t => t })
    } else {
      const view = camera.getView()
      // Zoom in enough to see the accuracy circle, never closer than `fitMaximumZoom`, never farther out than now
      const metersPerPixelWanted = Math.max(accuracy, 1) / 60
      const zoom = Math.min(this.fitMaximumZoom, Math.max(view.zoom, groundMetersPerPixelToZoom(metersPerPixelWanted, latitude)))
      motion = camera.flyTo({ ...target, zoom }, {})
    }
    earth.requestFrame()
    void motion
  }

  /** The user touched the map while it followed: they took it, so following pauses (the dot stays). */
  protected onUserInput = (event: Event): void => {
    // A press on a control (this button among them) is not the user taking the map
    const target = event.target as Element | null
    if (typeof target?.closest === 'function' && target.closest('.react-three-earth-controls') !== null) return
    if (this.state === 'tracking') {
      this.flightToken++
      this.setState('background')
    }
  }

  protected updateMarkers(position: GeolocationPosition): void {
    const earth = this.earth
    const container = this.controls?.container
    if (earth === null || container === undefined || !this.showUserLocation) return
    const { longitude, latitude } = position.coords
    if (this.dot === null) {
      const element = container.ownerDocument.createElement('div')
      element.className = 'react-three-earth-user-dot'
      this.dot = new Marker({ longitudeDegrees: longitude, latitudeDegrees: latitude, element, anchor: 'center', label: this.locale.userLocation, occludedOpacity: 1 })
      if (this.showAccuracyCircle) {
        this.circleElement = container.ownerDocument.createElement('div')
        this.circleElement.className = 'react-three-earth-accuracy-circle'
        this.circle = new Marker({
          longitudeDegrees: longitude,
          latitudeDegrees: latitude,
          element: this.circleElement,
          anchor: 'center',
          pitchAlignment: 'map',
          rotationAlignment: 'map',
          label: this.locale.userLocationAccuracy,
        })
        this.circleElement.setAttribute('aria-hidden', 'true')
        this.circleElement.removeAttribute('tabindex')
        this.circleElement.removeAttribute('role')
        this.circle.addTo(earth, container)
      }
      this.dot.addTo(earth, container)
      this.dot.element.removeAttribute('tabindex')
      this.dot.element.setAttribute('role', 'img')
    } else {
      this.dot.setPosition({ longitudeDegrees: longitude, latitudeDegrees: latitude })
      this.circle?.setPosition({ longitudeDegrees: longitude, latitudeDegrees: latitude })
    }
    this.dot.element.removeAttribute('data-stale')
    this.updateCircle()
  }

  /** Sizes the accuracy circle to the current zoom: metres of accuracy over metres per pixel at the centre of the screen (exact there, approximate toward the edges). */
  protected updateCircle = (): void => {
    const earth = this.earth
    if (earth === null || this.circleElement === null || this.lastPosition === null || !earth.camera.ready) return
    const metersPerPixel = earth.camera.getGroundResolutionMetersPerPixel()
    const diameterPixels = Math.min(Math.max((this.lastPosition.coords.accuracy * 2) / metersPerPixel, 0), 4096)
    const size = `${Math.round(diameterPixels)}px`
    if (this.circleElement.style.width !== size) {
      this.circleElement.style.width = size
      this.circleElement.style.height = size
      // Hidden while smaller than the dot
      this.circleElement.style.visibility = diameterPixels < 16 ? 'hidden' : 'visible'
    }
  }

  protected removeMarkers(): void {
    this.dot?.remove()
    this.circle?.remove()
    this.dot = null
    this.circle = null
    this.circleElement = null
    this.lastPosition = null
  }

  protected setState(state: GeolocateState): void {
    if (state === this.state) return
    this.state = state
    this.render()
  }

  protected render(): void {
    const { locale, state } = this
    const label = this.permissionDenied
      ? locale.geolocateDenied
      : !geolocationAvailable()
        ? locale.geolocateUnavailable
        : state === 'waiting'
          ? locale.geolocateWaiting
          : state === 'error'
            ? locale.geolocateFailed
            : this.trackUser
              ? state === 'tracking'
                ? locale.geolocateStopTracking
                : state === 'background'
                  ? locale.geolocateFollow
                  : locale.geolocate
              : locale.geolocate
    setButtonLabel(this.button, label)
    this.button.disabled = this.permissionDenied || !geolocationAvailable()
    this.button.dataset.state = this.permissionDenied ? 'error' : state === 'tracking' ? 'active' : state
    if (this.trackUser) this.button.setAttribute('aria-pressed', String(state === 'tracking' || state === 'background'))
    this.button.setAttribute('aria-busy', String(state === 'waiting'))
  }

  /** Disables the button before the first press when the user already blocked the site's location access. */
  protected async watchPermission(): Promise<void> {
    try {
      const forControls = this.controls
      const status = await navigator.permissions?.query({ name: 'geolocation' })
      if (status === undefined || this.controls === null || this.controls !== forControls) return
      this.permissionStatus?.removeEventListener('change', this.onPermissionChange)
      this.permissionStatus = status
      status.addEventListener('change', this.onPermissionChange)
      this.onPermissionChange()
    } catch {
      // Safari before 16 and some webviews lack the Permissions API for geolocation: the first press will tell
    }
  }

  protected onPermissionChange = (): void => {
    const denied = this.permissionStatus?.state === 'denied'
    if (denied === this.permissionDenied) return
    this.permissionDenied = denied
    if (denied) this.stop()
    this.render()
  }

  /** Removes the control, its watch and its markers for good. */
  dispose(): void {
    this.remove()
    this.button.removeEventListener('click', this.onClick)
    this.element.remove()
  }
}

function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
}
