import type { Earth } from '../core/Earth.js'
import { Controls, MapControl } from './Controls.js'
import { createControlButton, createIcon } from './controlsStyle.js'
import { resolveLocale, type ControlsLocale } from './locale.js'
import { compassIsReset, compassTransform } from './navigation.js'

export interface NavigationControlOptions {
  /** Show the zoom in and zoom out buttons. Default: true. */
  showZoom?: boolean
  /** Show the compass button. Default: true. */
  showCompass?: boolean
  /** Tilt the compass needle with the camera, and make the compass reset the pitch too. Default: false. */
  visualizePitch?: boolean
  /** Zoom levels a button press changes. Default: 1. */
  zoomStep?: number
  /** Length of the animation of a button press. Default: 0.3. */
  durationSeconds?: number
  locale?: Partial<ControlsLocale>
}

const PLUS = 'M9 3h2v6h6v2h-6v6H9v-6H3V9h6z'
const MINUS = 'M3 9h14v2H3z'
const NEEDLE_NORTH = 'M10 1.5 14 10H6z'
const NEEDLE_SOUTH = 'M10 18.5 6 10h8z'

/**
 * Zoom in, zoom out and compass buttons, as MapLibre's `NavigationControl`. The compass turns with the map and
 * resets it to north when pressed (`visualizePitch` also tilts it and looks straight down). Every button is a
 * real `<button>` with an accessible name, so it works with the keyboard and screen readers.
 *
 * Repeated presses add up while the camera is still easing to the last one.
 */
export class NavigationControl extends MapControl {
  readonly element: HTMLElement
  protected readonly showZoom: boolean
  protected readonly showCompass: boolean
  protected readonly visualizePitch: boolean
  protected readonly zoomStep: number
  protected readonly durationSeconds: number
  protected readonly locale: ControlsLocale
  protected readonly zoomInButton: HTMLButtonElement | null = null
  protected readonly zoomOutButton: HTMLButtonElement | null = null
  protected readonly compassButton: HTMLButtonElement | null = null
  protected readonly needle: SVGSVGElement | null = null
  protected listeningTo: Earth | null = null
  protected pendingZoom: number | null = null
  protected lastTransform = ''
  protected lastNorth: boolean | null = null

  constructor({ showZoom = true, showCompass = true, visualizePitch = false, zoomStep = 1, durationSeconds = 0.3, locale }: NavigationControlOptions = {}) {
    super()
    this.showZoom = showZoom
    this.showCompass = showCompass
    this.visualizePitch = visualizePitch
    this.zoomStep = zoomStep
    this.durationSeconds = durationSeconds
    this.locale = resolveLocale(locale)
    const document = globalThis.document
    this.element = document.createElement('div')
    this.element.className = 'react-three-earth-control-group'
    this.element.setAttribute('role', 'group')
    this.element.setAttribute('aria-label', this.locale.navigation)
    this.element.hidden = !showZoom && !showCompass

    if (showZoom) {
      this.zoomInButton = createControlButton(document, this.locale.zoomIn)
      this.zoomInButton.append(createIcon(document, PLUS))
      this.zoomInButton.addEventListener('click', this.onZoomIn)
      this.zoomOutButton = createControlButton(document, this.locale.zoomOut)
      this.zoomOutButton.append(createIcon(document, MINUS))
      this.zoomOutButton.addEventListener('click', this.onZoomOut)
      this.element.append(this.zoomInButton, this.zoomOutButton)
    }
    if (showCompass) {
      this.compassButton = createControlButton(document, visualizePitch ? this.locale.resetNorthAndPitch : this.locale.resetNorth)
      this.needle = createIcon(document, NEEDLE_NORTH, NEEDLE_SOUTH)
      this.needle.classList.add('react-three-earth-compass-needle')
      this.needle.firstElementChild?.setAttribute('fill', '#e2574c')
      this.needle.lastElementChild?.setAttribute('fill', '#8a8a8a')
      this.compassButton.append(this.needle)
      this.compassButton.addEventListener('click', this.onCompass)
      this.element.append(this.compassButton)
    }
  }

  protected attach(controls: Controls): void {
    this.listeningTo = controls.earth
    // `rotate` and `pitch` fire every frame while the heading or pitch changes, and never otherwise
    controls.earth.addEventListener('rotate', this.updateCompass)
    controls.earth.addEventListener('pitch', this.updateCompass)
    controls.earth.addEventListener('moveend', this.updateCompass)
    this.updateCompass()
  }

  protected detach(): void {
    this.listeningTo?.removeEventListener('rotate', this.updateCompass)
    this.listeningTo?.removeEventListener('pitch', this.updateCompass)
    this.listeningTo?.removeEventListener('moveend', this.updateCompass)
    this.listeningTo = null
    this.pendingZoom = null
  }

  /** Eases the zoom by `levels` (negative zooms out). Presses made during the ease add to its target. */
  zoomBy(levels: number): void {
    const earth = this.earth
    if (earth === null || !earth.camera.ready) return
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
  resetNorth(): void {
    const earth = this.earth
    if (earth === null || !earth.camera.ready) return
    void (this.visualizePitch ? earth.camera.resetNorthPitch({ durationSeconds: this.durationSeconds }) : earth.camera.resetNorth({ durationSeconds: this.durationSeconds }))
    earth.requestFrame()
  }

  protected onZoomIn = (): void => this.zoomBy(this.zoomStep)
  protected onZoomOut = (): void => this.zoomBy(-this.zoomStep)
  protected onCompass = (): void => this.resetNorth()

  protected updateCompass = (): void => {
    const earth = this.earth
    if (earth === null || this.needle === null || this.compassButton === null || !earth.camera.ready) return
    const { headingDegrees, pitchDegrees } = earth.camera.getView()
    const transform = compassTransform(headingDegrees, pitchDegrees, this.visualizePitch)
    if (transform !== this.lastTransform) {
      this.lastTransform = transform
      this.needle.style.transform = transform
    }
    const north = compassIsReset(headingDegrees, pitchDegrees, this.visualizePitch)
    if (north !== this.lastNorth) {
      this.lastNorth = north
      this.compassButton.dataset.north = String(north)
    }
  }

  /** Removes the control and its listeners for good. */
  dispose(): void {
    this.remove()
    this.zoomInButton?.removeEventListener('click', this.onZoomIn)
    this.zoomOutButton?.removeEventListener('click', this.onZoomOut)
    this.compassButton?.removeEventListener('click', this.onCompass)
    this.element.remove()
  }
}
