import type { Earth } from '../core/Earth.js'
import { MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'
import { computeScaleBar, formatScaleBar, type ScaleBar, type ScaleUnit } from './scale.js'

export interface ScaleControlOptions {
  earth: Earth
  /** The units of the bar. Default: 'metric'. */
  unit?: ScaleUnit
  /** The longest the bar may be, in CSS pixels. Default: 100. */
  maximumWidthPixels?: number
  locale?: Partial<ControlsLocale>
}

export interface ScaleControlState extends ScaleBar {
  /** False before the camera has a view or where no scale can be drawn: hide the bar. */
  visible: boolean
  /** The text of the bar, "5 km". */
  label: string
  /** The accessible name of the bar, "Map scale: 5 km" (give it `role="img"`). */
  accessibleLabel: string
}

/**
 * A scale bar at the centre of the screen, as MapLibre's `ScaleControl`, without any DOM: its width in pixels (rounded)
 * and its label, a round number (1, 2, 3 or 5 times a power of ten) of metres, kilometres, feet, miles or nautical
 * miles. It follows the zoom and the latitude.
 *
 * ```ts
 * const scale = new ScaleControl({ earth, unit: 'imperial' })
 * scale.subscribe(state => {
 *   bar.hidden = !state.visible
 *   bar.style.width = `${state.widthPixels}px`
 *   bar.textContent = state.label
 * })
 * ```
 */
export class ScaleControl extends MapControl<ScaleControlState> {
  protected unit: ScaleUnit
  protected maximumWidthPixels: number
  protected readonly locale: ControlsLocale

  constructor({ earth, unit = 'metric', maximumWidthPixels = 100, locale }: ScaleControlOptions) {
    super(earth)
    this.unit = unit
    this.maximumWidthPixels = maximumWidthPixels
    this.locale = resolveLocale(locale)
    this.initializeState()
  }

  /** Changes the unit. */
  setUnit(unit: ScaleUnit): void {
    this.unit = unit
    this.update()
  }

  /** Changes the longest the bar may be. */
  setMaximumWidthPixels(maximumWidthPixels: number): void {
    this.maximumWidthPixels = maximumWidthPixels
    this.update()
  }

  protected attach(): void {
    for (const type of ['move', 'zoom', 'moveend', 'zoomend'] as const) this.earth.addEventListener(type, this.update)
  }

  protected detach(): void {
    for (const type of ['move', 'zoom', 'moveend', 'zoomend'] as const) this.earth.removeEventListener(type, this.update)
  }

  protected computeState(): ScaleControlState {
    const camera = this.earth.camera
    const bar = camera.ready ? computeScaleBar(camera.getGroundResolutionMetersPerPixel(), this.maximumWidthPixels, this.unit) : computeScaleBar(0, 0, this.unit)
    const visible = bar.widthPixels > 0
    const label = visible ? formatScaleBar(bar, this.locale) : ''
    return { ...bar, widthPixels: Math.round(bar.widthPixels), visible, label, accessibleLabel: `${this.locale.scale}: ${label}` }
  }
}
