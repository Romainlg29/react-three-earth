import type { Earth } from '../core/Earth.js'
import { holdContainerPosition, releaseContainerPosition } from '../core/containerPosition.js'

/**
 * The attribute that marks map UI: presses inside an element with it are not the user taking the map (a following
 * `GeolocateControl` keeps following, cooperative gestures leave its touches and wheel alone). `Controls` puts it on
 * its element; put it on your own buttons when they sit over the map outside a `Controls`
 * (`<button data-earthkit-controls>`). It carries no styles.
 */
export const CONTROLS_ATTRIBUTE = 'data-earthkit-controls'

export interface ControlsOptions {
  /** The element the controls go in: the one around the canvas. It is made `position: relative` if it is static. */
  container: HTMLElement
}

function stop(event: Event): void {
  event.stopPropagation()
}

const STOPPED_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart'] as const

/**
 * An unstyled element over the map for your controls: a `<div data-earthkit-controls>` added to the
 * container, with no class and no CSS of its own. Presses, clicks and wheel turns inside it never reach the map. Place and style it
 * yourself (`element.style`, or a class), and put your buttons in it.
 *
 * ```ts
 * const controls = new Controls({ container: canvas.parentElement! })
 * controls.element.className += ' my-top-right-corner'
 * controls.element.append(zoomInButton)
 * ```
 */
export class Controls {
  readonly container: HTMLElement
  /** The element to put your controls in. */
  readonly element: HTMLElement
  protected disposed = false

  constructor({ container }: ControlsOptions) {
    this.container = container
    holdContainerPosition(container)
    this.element = container.ownerDocument.createElement('div')
    this.element.setAttribute(CONTROLS_ATTRIBUTE, '')
    for (const type of STOPPED_EVENTS) this.element.addEventListener(type, stop, { passive: true })
    container.append(this.element)
  }

  /** Removes the element. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const type of STOPPED_EVENTS) this.element.removeEventListener(type, stop)
    this.element.remove()
    releaseContainerPosition(this.container)
  }
}

/** Called with the new state whenever a control's state changes. */
export type ControlStateListener<State> = (state: State) => void

/**
 * Base of the headless controls: a state object, the actions that change the map, and nothing drawn. Read the state
 * with `getState()` and follow it with `subscribe(listener)`; the control listens to the earth only while it has a
 * listener. The state object is replaced, never changed in place, so it can be compared by identity (React's
 * `useSyncExternalStore` takes `subscribe` and `getState` as they are).
 *
 * A subclass computes its state in `computeState`, and subscribes to the earth in `attach` and lets go in `detach`.
 */
export abstract class MapControl<State extends object> {
  readonly earth: Earth
  protected state: State
  protected readonly listeners = new Set<ControlStateListener<State>>()
  protected attached = false

  constructor(earth: Earth) {
    this.earth = earth
    // Subclasses set their fields before reading the first state: see `initializeState`
    this.state = undefined as unknown as State
  }

  /** Call at the end of the subclass constructor, once the fields `computeState` reads are set. */
  protected initializeState(): void {
    this.state = this.computeState()
  }

  /** The current state. The same object until something changes. */
  getState = (): State => this.state

  /** Calls `listener` on every change of state, and returns the function that stops it. */
  subscribe = (listener: ControlStateListener<State>): (() => void) => {
    this.listeners.add(listener)
    if (!this.attached) {
      this.attached = true
      this.attach()
      this.update()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0 || !this.attached) return
      this.attached = false
      this.detach()
    }
  }

  /** Recomputes the state, and tells the listeners when it changed. Called for you when the earth changes. */
  update = (): void => {
    this.setState(this.computeState())
  }

  /** Stops every listener and lets go of the earth. */
  dispose(): void {
    this.listeners.clear()
    if (!this.attached) return
    this.attached = false
    this.detach()
  }

  protected setState(next: State): void {
    if (shallowEqual(this.state, next)) return
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }

  /** The state from the earth and the control's own fields. */
  protected abstract computeState(): State
  /** The first listener arrived: subscribe to the earth. */
  protected abstract attach(): void
  /** The last listener left: unsubscribe. */
  protected abstract detach(): void
}

function shallowEqual(a: object, b: object): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  return true
}
