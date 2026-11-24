import type { Earth } from '../core/Earth.js'
import { MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'
import { compassIsReset, compassRotation, compassTransform } from './navigation.js'

export interface NavigationControlOptions {
  earth: Earth
  /** Tilt the compass needle with the camera, and make the compass reset the pitch too. Default: false. */
  visualizePitch?: boolean
  /** Zoom levels `zoomIn` and `zoomOut` change. Default: 1. */
  zoomStep?: number
  /** Length of the animation of a press. Default: 0.3. */
  durationSeconds?: number
  locale?: Partial<ControlsLocale>
}

export interface NavigationControlState {
  /** False until the camera has a view: the buttons do nothing yet. */
  ready: boolean
  headingDegrees: number
  pitchDegrees: number
  /** Turn the compass needle by this, clockwise, so it points north. */
  compassRotateDegrees: number
  /** Tilt the needle back by this (only with `visualizePitch`, otherwise 0). */
  compassTiltDegrees: number
  /** A CSS `transform` for the needle that applies both. */
  compassTransform: string
  /** True when the map already faces north (and looks straight down, with `visualizePitch`): the compass has nothing to reset. */
  north: boolean
  /** Accessible names of the zoom in, zoom out and compass buttons, and of their group. */
  zoomInLabel: string
  zoomOutLabel: string
  compassLabel: string
  groupLabel: string
}

/**
 * Zoom in, zoom out and compass, as MapLibre's `NavigationControl`, without any DOM: the state a compass needs (the
 * heading, a ready-made needle transform, whether it faces north), the accessible names, and the actions. Draw the
 * buttons yourself and call `zoomIn`, `zoomOut` and `resetNorth` from them.
 *
 * ```ts
 * const navigation = new NavigationControl({ earth, visualizePitch: true })
 * zoomInButton.onclick = () => navigation.zoomIn()
 * navigation.subscribe(state => (needle.style.transform = state.compassTransform))
 * ```
 *
 * Repeated zooms add up while the camera is still easing to the last one.
 */
export class NavigationControl extends MapControl<NavigationControlState> {
  protected readonly visualizePitch: boolean
  protected readonly zoomStep: number
  protected readonly durationSeconds: number
  protected readonly locale: ControlsLocale
  protected pendingZoom: number | null = null

  constructor({ earth, visualizePitch = false, zoomStep = 1, durationSeconds = 0.3, locale }: NavigationControlOptions) {
    super(earth)
    this.visualizePitch = visualizePitch
    this.zoomStep = zoomStep
    this.durationSeconds = durationSeconds
    this.locale = resolveLocale(locale)
    this.initializeState()
  }

  protected attach(): void {
    // `rotate` and `pitch` fire every frame while the heading or pitch changes, and never otherwise
    this.earth.addEventListener('rotate', this.update)
    this.earth.addEventListener('pitch', this.update)
    this.earth.addEventListener('moveend', this.update)
  }

  protected detach(): void {
    this.earth.removeEventListener('rotate', this.update)
    this.earth.removeEventListener('pitch', this.update)
    this.earth.removeEventListener('moveend', this.update)
    this.pendingZoom = null
  }

  /** Eases the zoom in by `zoomStep`. */
  zoomIn = (): void => this.zoomBy(this.zoomStep)

  /** Eases the zoom out by `zoomStep`. */
  zoomOut = (): void => this.zoomBy(-this.zoomStep)

  /** Eases the zoom by `levels` (negative zooms out). Calls made during the ease add to its target. */
  zoomBy = (levels: number): void => {
    const earth = this.earth
    if (!earth.camera.ready) return
    const camera = earth.camera
    const base = camera.animating && this.pendingZoom !== null ? this.pendingZoom : camera.getView().zoom
    const target = base + levels
    this.pendingZoom = target
    void camera.zoomTo(target, { durationSeconds: this.durationSeconds }).then(() => {
      if (this.pendingZoom === target) this.pendingZoom = null
    })
    earth.requestFrame()
  }

  /** What pressing the compass does: north, and straight down with `visualizePitch`. */
  resetNorth = (): void => {
    const earth = this.earth
    if (!earth.camera.ready) return
    const options = { durationSeconds: this.durationSeconds }
    void (this.visualizePitch ? earth.camera.resetNorthPitch(options) : earth.camera.resetNorth(options))
    earth.requestFrame()
  }

  protected computeState(): NavigationControlState {
    const { locale, visualizePitch } = this
    const ready = this.earth.camera.ready
    const { headingDegrees, pitchDegrees } = ready ? this.earth.camera.getView() : { headingDegrees: 0, pitchDegrees: -90 }
    const { rotateDegrees, tiltDegrees } = compassRotation(headingDegrees, pitchDegrees, visualizePitch)
    return {
      ready,
      // Rounded so a heading that drifts in the last digits does not count as a change
      headingDegrees: Math.round(headingDegrees * 10) / 10,
      pitchDegrees: Math.round(pitchDegrees * 10) / 10,
      compassRotateDegrees: Math.round(rotateDegrees * 10) / 10,
      compassTiltDegrees: Math.round(tiltDegrees * 10) / 10,
      compassTransform: compassTransform(headingDegrees, pitchDegrees, visualizePitch),
      north: compassIsReset(headingDegrees, pitchDegrees, visualizePitch),
      zoomInLabel: locale.zoomIn,
      zoomOutLabel: locale.zoomOut,
      compassLabel: visualizePitch ? locale.resetNorthAndPitch : locale.resetNorth,
      groupLabel: locale.navigation,
    }
  }
}
