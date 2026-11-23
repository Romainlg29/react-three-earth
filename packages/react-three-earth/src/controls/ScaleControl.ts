import type { Earth } from '../core/Earth.js'
import { Controls, MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'
import { computeScaleBar, formatScaleBar, type ScaleUnit } from './scale.js'

export interface ScaleControlOptions {
  /** The units of the bar. Default: 'metric'. */
  unit?: ScaleUnit
  /** The longest the bar may be, in CSS pixels. Default: 100. */
  maximumWidthPixels?: number
  locale?: Partial<ControlsLocale>
}

/**
 * A scale bar at the centre of the screen, as MapLibre's `ScaleControl`: its length is a round number (1, 2, 3 or 5
 * times a power of ten) of metres, kilometres, feet, miles or nautical miles. It follows the zoom and the latitude,
 * and is hidden until the camera has a view.
 */
export class ScaleControl extends MapControl {
  readonly element: HTMLElement
  protected unit: ScaleUnit
  protected maximumWidthPixels: number
  protected readonly locale: ControlsLocale
  protected listeningTo: Earth | null = null
  protected lastLabel = ''
  protected lastWidthPixels = -1

  constructor({ unit = 'metric', maximumWidthPixels = 100, locale }: ScaleControlOptions = {}) {
    super()
    this.unit = unit
    this.maximumWidthPixels = maximumWidthPixels
    this.locale = resolveLocale(locale)
    this.element = globalThis.document.createElement('div')
    this.element.className = 'react-three-earth-scale'
    this.element.setAttribute('role', 'img')
    this.element.hidden = true
  }

  /** Changes the unit and redraws. */
  setUnit(unit: ScaleUnit): void {
    this.unit = unit
    this.update()
  }

  /** Changes the longest the bar may be, and redraws. */
  setMaximumWidthPixels(maximumWidthPixels: number): void {
    this.maximumWidthPixels = maximumWidthPixels
    this.update()
  }

  protected attach(controls: Controls): void {
    this.listeningTo = controls.earth
    for (const type of ['move', 'zoom', 'moveend', 'zoomend'] as const) controls.earth.addEventListener(type, this.update)
    this.update()
  }

  protected detach(): void {
    for (const type of ['move', 'zoom', 'moveend', 'zoomend'] as const) this.listeningTo?.removeEventListener(type, this.update)
    this.listeningTo = null
  }

  /** Reads the scale at the centre and redraws the bar. Called for you whenever the camera moves. */
  update = (): void => {
    const earth = this.earth
    if (earth === null || !earth.camera.ready) return
    const bar = computeScaleBar(earth.camera.getGroundResolutionMetersPerPixel(), this.maximumWidthPixels, this.unit)
    const width = Math.round(bar.widthPixels)
    const label = bar.widthPixels > 0 ? formatScaleBar(bar, this.locale) : ''
    if (width === this.lastWidthPixels && label === this.lastLabel) return
    this.lastWidthPixels = width
    this.lastLabel = label
    this.element.hidden = bar.widthPixels === 0
    this.element.style.width = `${width}px`
    this.element.textContent = label
    this.element.setAttribute('aria-label', `${this.locale.scale}: ${label}`)
  }

  /** Removes the control and its listeners for good. */
  dispose(): void {
    this.remove()
    this.element.remove()
  }
}
