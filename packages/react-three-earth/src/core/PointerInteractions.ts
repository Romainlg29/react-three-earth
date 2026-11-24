import type { GeographicPosition } from './camera.js'
import type { EarthCamera } from './EarthCamera.js'
import type { ScreenPosition } from './projection.js'
import { SYNTHETIC_TOUCH_EVENTS } from './TouchGestures.js'

/** A press, move or release handed to a `PointerInteraction`. */
export interface PointerInteractionEvent {
  /** The DOM pointer id: a press and its moves and release share it. */
  pointerId: number
  /** `'mouse'`, `'touch'` or `'pen'`. */
  pointerType: string
  /** Where the pointer is, in CSS pixels from the canvas's top-left corner. */
  screen: ScreenPosition
  /**
   * The position under the pointer, on the loaded terrain (`earth.camera.unproject`), or null on sky. Computed when
   * first read.
   */
  readonly geographic: (GeographicPosition & { heightMeters: number }) | null
  /** The DOM event. */
  originalEvent: PointerEvent
}

/**
 * Something that can take presses on the map from the camera controls: a vertex being dragged, a gizmo handle. Add it
 * with `earth.interactions.add(interaction)`, or `context.addPointerInteraction` in a plugin.
 *
 * Every press on the map is offered to `pointerDown`, the interaction added last first. The first one that returns true
 * takes the press: its moves and release go to that interaction only, and the camera controls, `BoxZoom` and the
 * earth's `click`, `doubleclick` and `pointermove` events never see them. Presses nobody takes reach the map as before. A second finger
 * landing during a taken touch press cancels it (`pointerCancel`), so pinching still zooms.
 */
export interface PointerInteraction {
  /** A press on the map. Return true to take it (and every move until its release). Keep it fast: it runs on each press. */
  pointerDown(event: PointerInteractionEvent): boolean
  /** The taken press moved. */
  pointerMove?(event: PointerInteractionEvent): void
  /** The taken press was released. */
  pointerUp?(event: PointerInteractionEvent): void
  /** The taken press was cancelled: the browser took it, a second finger landed, the interaction or earth was removed. */
  pointerCancel?(): void
}

/** How long after a taken press's release its `click` may still arrive (touch screens send it late). */
const CLICK_AFTER_RELEASE_MILLISECONDS = 600
/** How long after a taken release a `dblclick` (fired after the next press) still belongs to the interaction. */
const DOUBLE_CLICK_AFTER_RELEASE_MILLISECONDS = 1000

interface TakenPress {
  pointerId: number
  pointerType: string
  interaction: PointerInteraction
}

/**
 * The pointer interactions on one earth (`earth.interactions`): presses that plugins and apps take from the camera
 * controls. `earth.attachPointerEvents` (which `<Earth>` calls) connects it to the canvas.
 *
 * It listens on the window in the capture phase and stops a taken press's events there, so they never reach the
 * element the controls listen to. Window listeners (the controls' two-finger `TouchGestures`) still see them.
 */
export class PointerInteractions {
  protected readonly interactions: PointerInteraction[] = []
  protected element: HTMLElement | null = null
  protected canvas: HTMLElement | null = null
  protected taken: TakenPress | null = null
  /** Touch pointers down on the map, to cancel a taken touch press when a second finger lands. */
  protected readonly touches = new Set<number>()
  /** Until when a `click` is the release of a taken press, in `performance.now()` milliseconds. */
  protected swallowClickUntil = 0
  protected swallowDoubleClickUntil = 0
  protected doubleClickZoomHolds = 0

  constructor(protected readonly camera: EarthCamera) {}

  /** Adds an interaction, offered presses before the ones added earlier. Returns a function that removes it. */
  add(interaction: PointerInteraction): () => void {
    this.interactions.push(interaction)
    return () => this.remove(interaction)
  }

  /** Removes an interaction, cancelling its press if it holds one. */
  remove(interaction: PointerInteraction): void {
    const index = this.interactions.indexOf(interaction)
    if (index < 0) return
    this.interactions.splice(index, 1)
    if (this.taken?.interaction === interaction) this.cancel()
  }

  /**
   * Turns double-click and double-tap zoom off until the returned function is called (several holds add up). For
   * tools where taps place things: two quick taps add two vertices rather than zooming. `EarthViewControls` reads it.
   */
  holdDoubleClickZoom(): () => void {
    this.doubleClickZoomHolds++
    let released = false
    return () => {
      if (released) return
      released = true
      this.doubleClickZoomHolds--
    }
  }

  /** False while something holds double-click zoom off (`holdDoubleClickZoom`). */
  get doubleClickZoomAllowed(): boolean {
    return this.doubleClickZoomHolds === 0
  }

  /** The number of interactions added. */
  get size(): number {
    return this.interactions.length
  }

  /** True while an interaction holds a press. */
  get active(): boolean {
    return this.taken !== null
  }

  /** Listens to presses on `element` (the canvas, or the element that receives its events); positions are measured from `canvas`. */
  attach(element: HTMLElement, canvas: HTMLElement = element): void {
    this.detach()
    this.element = element
    this.canvas = canvas
    const view = windowOf(element)
    if (view === null) return
    view.addEventListener('pointerdown', this.onPointerDown, { capture: true })
    view.addEventListener('pointermove', this.onPointerMove, { capture: true })
    view.addEventListener('pointerup', this.onPointerUp, { capture: true })
    view.addEventListener('pointercancel', this.onPointerCancel, { capture: true })
    view.addEventListener('click', this.onClick, { capture: true })
    view.addEventListener('dblclick', this.onDoubleClick, { capture: true })
  }

  detach(): void {
    const element = this.element
    if (element === null) return
    this.cancel()
    const view = windowOf(element)
    view?.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
    view?.removeEventListener('pointermove', this.onPointerMove, { capture: true })
    view?.removeEventListener('pointerup', this.onPointerUp, { capture: true })
    view?.removeEventListener('pointercancel', this.onPointerCancel, { capture: true })
    view?.removeEventListener('click', this.onClick, { capture: true })
    view?.removeEventListener('dblclick', this.onDoubleClick, { capture: true })
    this.element = null
    this.canvas = null
    this.touches.clear()
  }

  /** Cancels the press an interaction holds, if any. */
  cancel(): void {
    const taken = this.taken
    if (taken === null) return
    this.taken = null
    callSafely(() => taken.interaction.pointerCancel?.())
  }

  /** Cancels the press an interaction holds if a finger made it: the controls call it when a pinch starts. */
  cancelTouch(): void {
    if (this.taken?.pointerType === 'touch') this.cancel()
  }

  protected toEvent(event: PointerEvent): PointerInteractionEvent {
    const rectangle = (this.canvas ?? this.element)!.getBoundingClientRect()
    const screen = { xPixels: event.clientX - rectangle.left, yPixels: event.clientY - rectangle.top }
    const camera = this.camera
    let geographic: PointerInteractionEvent['geographic'] | undefined
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      screen,
      originalEvent: event,
      get geographic() {
        if (geographic === undefined) geographic = camera.ready ? camera.unproject(screen) : null
        return geographic
      },
    }
  }

  /** A press on the map's own surface (the element or its canvas), not on an overlay such as a marker or a control. */
  protected onMapSurface(target: EventTarget | null): boolean {
    const element = this.element
    if (element === null || !(target instanceof Node) || !element.contains(target)) return false
    return target === element || target === this.canvas || (typeof HTMLCanvasElement !== 'undefined' && target instanceof HTMLCanvasElement)
  }

  protected onPointerDown = (event: PointerEvent): void => {
    // Any new press, on the map or not (a toolbar button), ends the window in which a click belongs to a release.
    this.swallowClickUntil = 0
    // The first finger of a new touch: fingers whose lift other listeners hid (after a pinch) no longer count.
    if (event.pointerType === 'touch' && event.isPrimary) this.touches.clear()
    if (!this.onMapSurface(event.target)) return
    if (event.pointerType === 'touch') {
      this.touches.add(event.pointerId)
      // A second finger: the press becomes a pinch, which belongs to the map.
      if (this.taken !== null) {
        if (this.taken.pointerType === 'touch') this.cancel()
        return
      }
      if (this.touches.size > 1) return
    }
    if (this.taken !== null || this.interactions.length === 0) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // The finger left on the glass after a pinch, handed back to the controls: it carries on the pinch, it is no new press.
    if (SYNTHETIC_TOUCH_EVENTS.has(event)) return
    if (!this.camera.ready) return
    const interactionEvent = this.toEvent(event)
    for (let index = this.interactions.length - 1; index >= 0; index--) {
      const interaction = this.interactions[index]!
      let takes = false
      callSafely(() => (takes = interaction.pointerDown(interactionEvent) === true))
      if (!takes) continue
      this.taken = { pointerId: event.pointerId, pointerType: event.pointerType, interaction }
      // Hidden from the element's listeners (the controls), not from other window listeners.
      event.stopPropagation()
      event.preventDefault()
      return
    }
  }

  protected onPointerMove = (event: PointerEvent): void => {
    const taken = this.taken
    if (taken === null || event.pointerId !== taken.pointerId) return
    event.stopPropagation()
    event.preventDefault()
    const interactionEvent = this.toEvent(event)
    callSafely(() => taken.interaction.pointerMove?.(interactionEvent))
  }

  protected onPointerUp = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId)
    const taken = this.taken
    if (taken === null || event.pointerId !== taken.pointerId) return
    this.taken = null
    event.stopPropagation()
    const interactionEvent = this.toEvent(event)
    callSafely(() => taken.interaction.pointerUp?.(interactionEvent))
    // The release still fires `click` (late on touch screens): it belongs to the interaction, not to the map.
    this.swallowClickUntil = performance.now() + CLICK_AFTER_RELEASE_MILLISECONDS
    this.swallowDoubleClickUntil = performance.now() + DOUBLE_CLICK_AFTER_RELEASE_MILLISECONDS
  }

  protected onClick = (event: MouseEvent): void => {
    if (performance.now() > this.swallowClickUntil) return
    this.swallowClickUntil = 0
    event.stopPropagation()
    event.preventDefault()
  }

  // Two presses in a row fire `dblclick` after the second: it belongs to the interaction if it took either.
  protected onDoubleClick = (event: MouseEvent): void => {
    if (performance.now() > this.swallowDoubleClickUntil) return
    this.swallowDoubleClickUntil = 0
    event.stopPropagation()
    event.preventDefault()
  }

  protected onPointerCancel = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId)
    if (this.taken === null || event.pointerId !== this.taken.pointerId) return
    event.stopPropagation()
    this.cancel()
  }
}

/** The window an element lives in, or null outside a browser. */
function windowOf(element: HTMLElement): Window | null {
  return element.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? null : window)
}

function callSafely(callback: () => void): void {
  try {
    callback()
  } catch (error) {
    console.error('PointerInteractions: an interaction threw.', error)
  }
}
