import { EventDispatcher } from 'three'

import type { Earth } from '../core/Earth.js'
import type { ViewMode, ViewTransitionOptions } from '../view/ViewMorph.js'
import { Controls, MapControl } from './Controls.js'
import { createControlButton, setButtonLabel } from './controlsStyle.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface ViewControlOptions {
  /** Options of the morph a press starts, such as `durationSeconds`. */
  transition?: ViewTransitionOptions
  locale?: Partial<ControlsLocale>
}

export interface ViewControlEventMap {
  /** The user pressed the button: the view it asked for. Apps that keep the view in state set it here. */
  viewchange: { mode: ViewMode }
}

/**
 * A button that switches between the globe and the flat map, MapLibre's `GlobeControl` for both ways. It shows
 * the view it switches to ("2D" while the globe shows, "3D" while the flat map does) and follows the earth's
 * view when other code changes it.
 */
export class ViewControl extends MapControl {
  readonly element: HTMLElement
  /** Fires `viewchange` when the user presses the button. */
  readonly events = new EventDispatcher<ViewControlEventMap>()
  protected readonly button: HTMLButtonElement
  protected readonly textElement: HTMLSpanElement
  protected readonly transition: ViewTransitionOptions | undefined
  protected readonly locale: ControlsLocale
  protected listeningTo: Earth | null = null
  protected shownMode: ViewMode | null = null

  constructor({ transition, locale }: ViewControlOptions = {}) {
    super()
    this.transition = transition
    this.locale = resolveLocale(locale)
    const document = globalThis.document
    this.element = document.createElement('div')
    this.element.className = 'react-three-earth-control-group'
    this.button = createControlButton(document, this.locale.switchTo2D)
    this.textElement = document.createElement('span')
    this.button.append(this.textElement)
    this.button.addEventListener('click', this.onClick)
    this.element.append(this.button)
  }

  protected attach(controls: Controls): void {
    this.listeningTo = controls.earth
    // The mode changes inside `earth.update`, which always ends with this event
    controls.earth.addEventListener('update', this.update)
    this.update()
  }

  protected detach(): void {
    this.listeningTo?.removeEventListener('update', this.update)
    this.listeningTo = null
    this.shownMode = null
  }

  /** Switches to the other view, as pressing the button does. */
  toggle(): void {
    const earth = this.earth
    if (earth === null) return
    const mode: ViewMode = earth.view.mode === '3d' ? '2d' : '3d'
    earth.setView(mode, this.transition)
    earth.requestFrame()
    this.events.dispatchEvent({ type: 'viewchange', mode })
    this.update()
  }

  protected onClick = (): void => this.toggle()

  protected update = (): void => {
    const earth = this.earth
    if (earth === null || earth.view.mode === this.shownMode) return
    this.shownMode = earth.view.mode
    const toFlat = earth.view.mode === '3d'
    this.textElement.textContent = toFlat ? this.locale.view2D : this.locale.view3D
    setButtonLabel(this.button, toFlat ? this.locale.switchTo2D : this.locale.switchTo3D)
    this.button.dataset.view = earth.view.mode
  }

  /** Removes the control and its listeners for good. */
  dispose(): void {
    this.remove()
    this.button.removeEventListener('click', this.onClick)
    this.element.remove()
  }
}

