import { EventDispatcher } from 'three'

import type { Earth } from '../core/Earth.js'
import { groundMetersPerPixelToZoom } from '../core/zoom.js'
import { CONTROLS_ATTRIBUTE, MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface GeolocateControlOptions {
  earth: Earth
  /**
   * The element around the map: pressing, wheeling or touching it while the map follows the user pauses the
   * following, while the control has a listener (`subscribe`). Presses inside an element with the
   * `data-earthkit-controls` attribute (a `Controls`) do not count. Without it, only `trigger` pauses and resumes.
   */
  container?: HTMLElement
  /** Keep following the user: the map re-centres on every new position until the user moves it or triggers again. Default: false. */
  trackUser?: boolean
  /** Options of the browser's Geolocation API. Default: `{ enableHighAccuracy: false, maximumAge: 0, timeout: 6000 }`. */
  positionOptions?: PositionOptions
  /** The highest zoom the camera goes to when it flies to the user. Default: 15. */
  fitMaximumZoom?: number
  locale?: Partial<ControlsLocale>
}

/** `off`: not following. `waiting`: asked, no position yet. `tracking`: the map follows. `background`: the position follows, the map does not. `error`: the last request failed. */
export type GeolocateStatus = 'off' | 'waiting' | 'tracking' | 'background' | 'error'

/** The user's last known place. */
export interface UserLocation {
  longitudeDegrees: number
  latitudeDegrees: number
  /** Radius of the 95% confidence circle, in metres, as the browser reports it. */
  accuracyMeters: number
  /** When the browser took the fix, in milliseconds since 1970. */
  timestamp: number
}

export interface GeolocateControlState {
  status: GeolocateStatus
  /** False where the browser has no Geolocation API: hide the button. */
  available: boolean
  /** True once the user blocked the site's location access: disable the button (`label` says why). */
  permissionDenied: boolean
  /** True where pressing a button would do nothing: geolocation is missing or denied. */
  disabled: boolean
  /** The accessible name of a geolocate button, which explains the status ("Finding your location", "Location access is turned off for this site"…). */
  label: string
  /** With `trackUser`, whether the button is pressed in (`aria-pressed`): following or paused. Undefined without `trackUser`. */
  pressed: boolean | undefined
  /** True while waiting for a position (`aria-busy`). */
  busy: boolean
  /** Where the user is, for a dot of your own (a `Marker`). Null before the first fix and after stopping. */
  userLocation: UserLocation | null
  /** True when the last fix is old because the newer ones failed: draw the dot greyed out. */
  stale: boolean
  /** The accuracy circle's diameter on the screen at the current zoom, in CSS pixels (at most 4096). 0 without a position. */
  accuracyDiameterPixels: number
  /** Accessible names for the user's dot and its accuracy circle. */
  userLocationLabel: string
  userLocationAccuracyLabel: string
}

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

/**
 * Finds the user with the browser's Geolocation API and flies there, as MapLibre's `GeolocateControl`, without drawing
 * anything: you draw the button from the state (its `label` explains every status, for screen readers too) and the
 * user's dot from `userLocation` (a `Marker`), and call `trigger` when the button is pressed. The position is asked for
 * only in `trigger` (browsers need a user gesture, iPhone Safari too, and HTTPS), and never leaves the page.
 *
 * With `trackUser`, the first trigger follows the user, a second stops, and moving the map yourself pauses the
 * following (the position stays; trigger again to resume). The control listens for that, and checks whether the site's
 * location access is already blocked, only while it has a listener: subscribe, even with an empty function. Events: `geolocate`, `error`, `trackuserlocationstart`,
 * `trackuserlocationend` on `control.events`.
 */
export class GeolocateControl extends MapControl<GeolocateControlState> {
  readonly events = new EventDispatcher<GeolocateEventMap>()
  protected readonly container: HTMLElement | undefined
  protected readonly trackUser: boolean
  protected readonly positionOptions: PositionOptions
  protected readonly fitMaximumZoom: number
  protected readonly locale: ControlsLocale
  protected status: GeolocateStatus = 'off'
  protected watchIdentifier: number | null = null
  protected lastPosition: GeolocationPosition | null = null
  protected positionStale = false
  protected permissionDenied = false
  protected permissionStatus: PermissionStatus | null = null
  protected firstFixPending = false
  protected trackingStarted = false
  protected statusBeforeError: GeolocateStatus = 'off'
  /** Goes up on `stop`, so a one-off request answered after it is ignored. */
  protected requestToken = 0

  constructor({ earth, container, trackUser = false, positionOptions, fitMaximumZoom = 15, locale }: GeolocateControlOptions) {
    super(earth)
    this.container = container
    this.trackUser = trackUser
    this.positionOptions = { enableHighAccuracy: false, maximumAge: 0, timeout: 6000, ...positionOptions }
    this.fitMaximumZoom = fitMaximumZoom
    this.locale = resolveLocale(locale)
    this.initializeState()
  }

  protected attach(): void {
    // In the capture phase, so gestures that stop these events from the pointer controls (box zoom) still count
    for (const type of USER_INPUT_EVENTS) this.container?.addEventListener(type, this.onUserInput, { passive: true, capture: true })
    this.earth.addEventListener('zoom', this.update)
    this.earth.addEventListener('moveend', this.update)
    void this.watchPermission()
  }

  protected detach(): void {
    this.stop()
    for (const type of USER_INPUT_EVENTS) this.container?.removeEventListener(type, this.onUserInput, { capture: true })
    this.earth.removeEventListener('zoom', this.update)
    this.earth.removeEventListener('moveend', this.update)
    this.permissionStatus?.removeEventListener('change', this.onPermissionChange)
    this.permissionStatus = null
    this.clearPosition()
  }

  /** What pressing the button does. */
  trigger = (): void => {
    if (!geolocationAvailable() || this.permissionDenied) return
    if (this.trackUser) {
      if (this.status === 'tracking') {
        this.stop()
        this.clearPosition()
        return
      }
      if (this.status === 'waiting') {
        this.stop()
        return
      }
      if (this.status === 'error' && this.watchIdentifier !== null) {
        // The watch is alive after a lost fix: carry on following
        this.setStatus('tracking')
        if (this.lastPosition !== null) this.flyToPosition(this.lastPosition, false)
        return
      }
      // 'background' and 'off' start (or resume) following
      if (this.status === 'background' && this.lastPosition !== null) {
        this.setStatus('tracking')
        this.flyToPosition(this.lastPosition, false)
        return
      }
      this.start()
      return
    }
    // One fix per press: the position stays, the map goes there
    this.firstFixPending = true
    this.setStatus('waiting')
    const token = ++this.requestToken
    navigator.geolocation.getCurrentPosition(
      position => token === this.requestToken && this.onPosition(position),
      error => token === this.requestToken && this.onError(error),
      this.positionOptions,
    )
  }

  /** Stops following and watching. The position stays until the next trigger, or `clearPosition`. */
  stop = (): void => {
    this.requestToken++
    this.clearWatch()
    if (this.trackingStarted) {
      this.trackingStarted = false
      this.events.dispatchEvent({ type: 'trackuserlocationend' })
    }
    this.setStatus('off')
  }

  /** Forgets the last position: `userLocation` becomes null. */
  clearPosition = (): void => {
    this.lastPosition = null
    this.positionStale = false
    this.update()
  }

  /** Leaves off following and lets go for good. */
  override dispose(): void {
    super.dispose()
    // Never attached (no listener): a watch started by `trigger` must still stop
    this.stop()
  }

  protected start(): void {
    this.clearWatch()
    this.firstFixPending = true
    this.setStatus('waiting')
    this.trackingStarted = true
    this.events.dispatchEvent({ type: 'trackuserlocationstart' })
    this.watchIdentifier = navigator.geolocation.watchPosition(this.onPosition, this.onError, this.positionOptions)
  }

  protected clearWatch(): void {
    if (this.watchIdentifier === null) return
    navigator.geolocation.clearWatch(this.watchIdentifier)
    this.watchIdentifier = null
  }

  protected onPosition = (position: GeolocationPosition): void => {
    this.lastPosition = position
    this.positionStale = false
    this.events.dispatchEvent({ type: 'geolocate', coordinates: position.coords, timestamp: position.timestamp })
    if (this.trackUser) {
      if (this.status === 'waiting') this.status = 'tracking'
      else if (this.status === 'error') this.status = this.statusBeforeError === 'background' ? 'background' : 'tracking'
      if (this.status === 'tracking') this.flyToPosition(position, !this.firstFixPending)
    } else {
      this.flyToPosition(position, false)
      this.status = 'off'
    }
    this.firstFixPending = false
    this.update()
  }

  protected onError = (error: GeolocationPositionError): void => {
    if (error.code === 1) {
      this.permissionDenied = true
      this.stop()
    } else if (this.trackUser && this.watchIdentifier !== null && this.status !== 'waiting') {
      // A lost fix while following: the position is stale, the watch carries on
      this.positionStale = true
      if (this.status !== 'error') this.statusBeforeError = this.status
    } else {
      this.stop()
    }
    this.setStatus('error')
    this.events.dispatchEvent({ type: 'error', error })
  }

  /** Moves the camera to a position: a flight on the first fix, otherwise a short ease keeping the zoom. */
  protected flyToPosition(position: GeolocationPosition, keepZoom: boolean): void {
    const earth = this.earth
    if (!earth.camera.ready) return
    const { longitude, latitude, accuracy } = position.coords
    const camera = earth.camera
    const target = { longitudeDegrees: longitude, latitudeDegrees: latitude }
    if (keepZoom) {
      void camera.easeTo(target, { durationSeconds: 0.5, easing: t => t })
    } else {
      const view = camera.getView()
      // Zoom in enough to see the accuracy circle, never closer than `fitMaximumZoom`, never farther out than now
      const metersPerPixelWanted = Math.max(accuracy, 1) / 60
      const zoom = Math.min(this.fitMaximumZoom, Math.max(view.zoom, groundMetersPerPixelToZoom(metersPerPixelWanted, latitude)))
      void camera.flyTo({ ...target, zoom }, {})
    }
    earth.requestFrame()
  }

  /** The user touched the map while it followed: they took it, so following pauses (the position stays). */
  protected onUserInput = (event: Event): void => {
    // A press on a control (the geolocate button among them) is not the user taking the map
    const target = event.target as Element | null
    if (typeof target?.closest === 'function' && target.closest(`[${CONTROLS_ATTRIBUTE}]`) !== null) return
    if (this.status === 'tracking') this.setStatus('background')
  }

  protected setStatus(status: GeolocateStatus): void {
    this.status = status
    this.update()
  }

  protected computeState(): GeolocateControlState {
    const { locale, status, permissionDenied, trackUser, lastPosition } = this
    const available = geolocationAvailable()
    const label = permissionDenied
      ? locale.geolocateDenied
      : !available
        ? locale.geolocateUnavailable
        : status === 'waiting'
          ? locale.geolocateWaiting
          : status === 'error'
            ? locale.geolocateFailed
            : trackUser && status === 'tracking'
              ? locale.geolocateStopTracking
              : trackUser && status === 'background'
                ? locale.geolocateFollow
                : locale.geolocate
    const camera = this.earth.camera
    let accuracyDiameterPixels = 0
    if (lastPosition !== null && camera.ready) {
      const metersPerPixel = camera.getGroundResolutionMetersPerPixel()
      accuracyDiameterPixels = Math.round(Math.min(Math.max((lastPosition.coords.accuracy * 2) / metersPerPixel, 0), 4096))
    }
    return {
      status,
      available,
      permissionDenied,
      disabled: permissionDenied || !available,
      label,
      pressed: trackUser ? status === 'tracking' || status === 'background' : undefined,
      busy: status === 'waiting',
      userLocation: this.userLocation(),
      stale: this.positionStale,
      accuracyDiameterPixels,
      userLocationLabel: locale.userLocation,
      userLocationAccuracyLabel: locale.userLocationAccuracy,
    }
  }

  /** The same object while the position does not change, so the state compares by identity. */
  protected userLocation(): UserLocation | null {
    const position = this.lastPosition
    if (position === null) return null
    const previous = this.state?.userLocation
    if (previous !== undefined && previous !== null && previous.timestamp === position.timestamp && previous.longitudeDegrees === position.coords.longitude && previous.latitudeDegrees === position.coords.latitude && previous.accuracyMeters === position.coords.accuracy) return previous
    return { longitudeDegrees: position.coords.longitude, latitudeDegrees: position.coords.latitude, accuracyMeters: position.coords.accuracy, timestamp: position.timestamp }
  }

  /** Disables the button before the first press when the user already blocked the site's location access. */
  protected async watchPermission(): Promise<void> {
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' })
      if (status === undefined || !this.attached) return
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
    this.update()
  }
}

function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
}
