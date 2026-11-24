import { EventDispatcher } from 'three'

import type { Earth } from '../core/Earth.js'
import type { ViewMode, ViewTransitionOptions } from '../view/ViewMorph.js'
import { MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface ViewControlOptions {
  earth: Earth
  /** Options of the morph `toggle` starts, such as `durationSeconds`. */
  transition?: ViewTransitionOptions
  locale?: Partial<ControlsLocale>
}

export interface ViewControlEventMap {
  /** `toggle` was called: the view it asked for. Apps that keep the view in state set it here. */
  viewchange: { mode: ViewMode }
}

export interface ViewControlState {
  /** The view the earth shows (or is morphing to). */
  mode: ViewMode
  /** The view `toggle` switches to. */
  nextMode: ViewMode
  /** The short text of a button that switches to `nextMode`: "2D" while the globe shows, "3D" while the flat map does. */
  label: string
  /** The accessible name of that button, "Switch to the flat map". */
  accessibleLabel: string
}

/**
 * Switches between the globe and the flat map, MapLibre's `GlobeControl` for both ways, without any DOM. It follows
 * the earth's view when other code changes it.
 *
 * ```ts
 * const view = new ViewControl({ earth })
 * button.onclick = view.toggle
 * view.subscribe(state => (button.textContent = state.label))
 * ```
 */
export class ViewControl extends MapControl<ViewControlState> {
  /** Fires `viewchange` when `toggle` is called. */
  readonly events = new EventDispatcher<ViewControlEventMap>()
  protected readonly transition: ViewTransitionOptions | undefined
  protected readonly locale: ControlsLocale

  constructor({ earth, transition, locale }: ViewControlOptions) {
    super(earth)
    this.transition = transition
    this.locale = resolveLocale(locale)
    this.initializeState()
  }

  protected attach(): void {
    // The mode changes inside `earth.update`, which always ends with this event
    this.earth.addEventListener('update', this.update)
  }

  protected detach(): void {
    this.earth.removeEventListener('update', this.update)
  }

  /** Switches to the other view. */
  toggle = (): void => {
    const mode: ViewMode = this.earth.view.mode === '3d' ? '2d' : '3d'
    this.earth.setView(mode, this.transition)
    this.earth.requestFrame()
    this.events.dispatchEvent({ type: 'viewchange', mode })
    this.update()
  }

  protected computeState(): ViewControlState {
    const mode = this.earth.view.mode
    const toFlat = mode === '3d'
    return {
      mode,
      nextMode: toFlat ? '2d' : '3d',
      label: toFlat ? this.locale.view2D : this.locale.view3D,
      accessibleLabel: toFlat ? this.locale.switchTo2D : this.locale.switchTo3D,
    }
  }
}
