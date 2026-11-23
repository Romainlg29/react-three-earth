import type { Earth } from '../core/Earth.js'
import { holdContainerPosition, releaseContainerPosition } from '../core/containerPosition.js'
import { ensureControlsStyle } from './controlsStyle.js'

export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** What `Controls.add` takes: a piece of map UI with a root element. Extend `MapControl` for the common parts. */
export interface ControlsItem {
  /** The control's root element, put in the corner. */
  readonly element: HTMLElement
  /** Called after the element is in the corner. */
  onAdd?(controls: Controls): void
  /** Called before the element is taken out. Release listeners here. */
  onRemove?(controls: Controls): void
}

export interface ControlsOptions {
  earth: Earth
  /** The element the controls go in: the one around the canvas. It is made `position: relative` if it is static. */
  container: HTMLElement
  /** The corner. Default: 'top-right'. */
  position?: ControlPosition
}

interface Corner {
  element: HTMLElement
  count: number
}
const corners = new WeakMap<HTMLElement, Map<ControlPosition, Corner>>()

function acquireCorner(container: HTMLElement, position: ControlPosition): HTMLElement {
  let byPosition = corners.get(container)
  if (byPosition === undefined) corners.set(container, (byPosition = new Map()))
  let corner = byPosition.get(position)
  if (corner === undefined) {
    const element = container.ownerDocument.createElement('div')
    element.className = 'react-three-earth-controls'
    element.dataset.position = position
    // Buttons never start a map gesture or count as a click on the map
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart']) {
      element.addEventListener(type, stop, { passive: true })
    }
    container.append(element)
    byPosition.set(position, (corner = { element, count: 0 }))
  }
  corner.count++
  return corner.element
}

function releaseCorner(container: HTMLElement, position: ControlPosition): void {
  const byPosition = corners.get(container)
  const corner = byPosition?.get(position)
  if (byPosition === undefined || corner === undefined) return
  if (--corner.count > 0) return
  corner.element.remove()
  byPosition.delete(position)
}

function stop(event: Event): void {
  event.stopPropagation()
}

/**
 * A corner of the map that holds controls (`NavigationControl`, `ScaleControl`, `GeolocateControl`,
 * `FullscreenControl`, `ViewControl`, or your own), stacked in the order they were added. Two `Controls` in the same
 * corner of the same container share it, so they stack instead of overlapping. Clicks on the controls do not reach the
 * map, and the corners keep clear of the notch and home indicator on phones.
 *
 * ```ts
 * const controls = new Controls({ earth, container: canvas.parentElement!, position: 'top-right' })
 * new NavigationControl().addTo(controls)
 * new ViewControl().addTo(controls)
 * ```
 */
export class Controls {
  readonly earth: Earth
  readonly container: HTMLElement
  readonly position: ControlPosition
  protected readonly corner: HTMLElement
  protected readonly items: ControlsItem[] = []
  protected disposed = false

  constructor({ earth, container, position = 'top-right' }: ControlsOptions) {
    this.earth = earth
    this.container = container
    this.position = position
    ensureControlsStyle(container.ownerDocument)
    holdContainerPosition(container)
    this.corner = acquireCorner(container, position)
  }

  /** Puts a control in the corner, after the ones already there. */
  add(item: ControlsItem): void {
    if (this.disposed) throw new Error('Controls.add: these Controls were disposed. Create new Controls first.')
    if (this.items.includes(item)) return
    this.items.push(item)
    this.corner.append(item.element)
    item.onAdd?.(this)
  }

  /** Takes a control out. It can be added again. */
  remove(item: ControlsItem): void {
    const index = this.items.indexOf(item)
    if (index < 0) return
    this.items.splice(index, 1)
    item.onRemove?.(this)
    item.element.remove()
  }

  /** The controls in this corner that were added through this object. */
  getControls(): readonly ControlsItem[] {
    return this.items
  }

  /** Removes every control it added, and the corner when nothing else uses it. */
  dispose(): void {
    if (this.disposed) return
    for (const item of [...this.items]) this.remove(item)
    this.disposed = true
    releaseCorner(this.container, this.position)
    releaseContainerPosition(this.container)
  }
}

/**
 * Base for controls: it owns the root element and the add and remove steps. A subclass builds `element` in its
 * constructor and listens in `onAdd` (where `this.earth` is set), and lets go in `onRemove`.
 */
export abstract class MapControl implements ControlsItem {
  abstract readonly element: HTMLElement
  protected controls: Controls | null = null

  /** The earth of the `Controls` this control is in, or null before `addTo`. */
  protected get earth(): Earth | null {
    return this.controls?.earth ?? null
  }

  /** Puts the control in `controls`. A control in one place moves. */
  addTo(controls: Controls): this {
    this.controls?.remove(this)
    controls.add(this)
    return this
  }

  /** Takes the control out of its `Controls`. */
  remove(): this {
    this.controls?.remove(this)
    return this
  }

  onAdd(controls: Controls): void {
    this.controls = controls
    this.attach(controls)
  }

  onRemove(): void {
    this.detach()
    this.controls = null
  }

  /** The control is in a corner: subscribe to the earth and draw the first state. */
  protected abstract attach(controls: Controls): void
  /** The control is leaving: unsubscribe. */
  protected abstract detach(): void
}
