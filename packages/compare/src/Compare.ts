import { PLUGIN_API_VERSION, type Earth, type EarthPlugin, type Imagery, type PluginContext, type ScreenClipSide } from '@earthkit/globe'
import { EventDispatcher } from 'three'

/**
 * How the canvas is split. `'vertical'`: a vertical line, `before` on its left and `after` on its right (the slider moves
 * left and right). `'horizontal'`: a horizontal line, `before` above and `after` below.
 */
export type CompareOrientation = 'vertical' | 'horizontal'

/** Which side of the line a layer shows on. */
export type CompareSide = 'before' | 'after'

export interface CompareOptions {
  /** Unique on an earth, as every plugin's (`earth.addPlugin`). Default: `'compare'`. */
  name?: string
  /** Layers shown only before the line (left, or above). More can be added with `addImagery`. Default: none. */
  before?: readonly Imagery[]
  /** Layers shown only after the line (right, or below). Default: none. */
  after?: readonly Imagery[]
  /** Default: `'vertical'`. */
  orientation?: CompareOrientation
  /** Where the line crosses the canvas, from 0 to 1 of its width (or height), from the left (or top). Default: 0.5. */
  positionFraction?: number
  /** The line follows the pointer over the map, as maplibre-gl-compare's `mousemove` option. Default: false. */
  followPointer?: boolean
  /** How far one arrow key moves the line on a handle (`attachHandle`); Page Up and Page Down move ten times as far. Default: 0.01. */
  keyboardStepFraction?: number
}

/** What a `Compare` shows, as one immutable snapshot: a new object after every change. */
export interface CompareState {
  readonly orientation: CompareOrientation
  readonly positionFraction: number
  readonly followPointer: boolean
  /** True while a handle is dragged. */
  readonly dragging: boolean
  /** Layers on each side, in the order they were added. */
  readonly before: readonly Imagery[]
  readonly after: readonly Imagery[]
}

export type CompareStateListener = (state: CompareState) => void

/** How the line moved: by dragging a handle, a key on it, the pointer (`followPointer`) or code (`setPosition`). */
export type CompareInput = 'drag' | 'keyboard' | 'pointer' | 'code'

export interface CompareEventMap {
  /** After every change of state (position, orientation, layers, dragging). */
  change: { state: CompareState }
  /** A handle drag starts. */
  slidestart: { positionFraction: number }
  /** The line moved. */
  slide: { positionFraction: number; input: CompareInput }
  /** A handle drag ends. */
  slideend: { positionFraction: number }
}

export interface AttachHandleOptions {
  /** The handle's accessible name, unless it has one (`aria-label`, `aria-labelledby`). Default: `'Comparison position'`. */
  label?: string
}

/** The CSS custom property `attachHandle` sets on the handle: the line's position, as a percentage (`'37.5%'`). */
export const COMPARE_POSITION_PROPERTY = '--compare-position'

const DEFAULT_LABEL = 'Comparison position'

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function validateFraction(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new Error(`Compare: ${what} must be a number from 0 to 1, not ${String(value)}.`)
  return clampFraction(value)
}

function validateOrientation(value: CompareOrientation): CompareOrientation {
  if (value !== 'vertical' && value !== 'horizontal') throw new Error(`Compare: orientation must be 'vertical' or 'horizontal', not ${JSON.stringify(value)}.`)
  return value
}

/**
 * A swipe comparison on one earth: `before` layers show on one side of a line across the canvas, `after` layers on the
 * other, as maplibre-gl-compare does with two maps. Both sides share the terrain, the camera, the atmosphere and every
 * layer not listed, so they are always in sync and cost one render, not two: each listed layer is clipped per pixel
 * (`Imagery.screenClip`), which moving the line never rebuilds.
 *
 * Headless: it ships no slider. Draw your own handle and pass it to `attachHandle`, which drags it, moves it with the
 * keyboard, sets its ARIA slider attributes and the `--compare-position` CSS property to place it.
 *
 * @example
 * const compare = new Compare({ before: [streets], after: [satellite] })
 * earth.addPlugin(compare)
 * const detach = compare.attachHandle(document.querySelector('#swiper')!)
 */
export class Compare extends EventDispatcher<CompareEventMap> implements EarthPlugin {
  readonly name: string
  readonly apiVersion = PLUGIN_API_VERSION
  protected state: CompareState
  protected readonly listeners = new Set<CompareStateListener>()
  protected readonly keyboardStepFraction: number
  /** The earth while installed. */
  protected earth: Earth | null = null
  protected readonly handles = new Set<HTMLElement>()
  /** Layers clipped by this comparison: their clip is cleared when they leave it or the plugin is removed. */
  protected readonly clipped = new Set<Imagery>()
  protected removePointerListener: (() => void) | null = null

  constructor({ name = 'compare', before = [], after = [], orientation = 'vertical', positionFraction = 0.5, followPointer = false, keyboardStepFraction = 0.01 }: CompareOptions = {}) {
    super()
    this.name = name
    this.keyboardStepFraction = validateFraction(keyboardStepFraction, 'keyboardStepFraction')
    this.state = {
      orientation: validateOrientation(orientation),
      positionFraction: validateFraction(positionFraction, 'positionFraction'),
      followPointer,
      dragging: false,
      before: [],
      after: [],
    }
    for (const imagery of before) this.addImagery(imagery, 'before')
    for (const imagery of after) this.addImagery(imagery, 'after')
  }

  /** The current state. The same object until something changes, so it works as a `useSyncExternalStore` snapshot. */
  getState(): CompareState {
    return this.state
  }

  /** Calls `listener` after every change. Returns a function that removes it. */
  subscribe = (listener: CompareStateListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get positionFraction(): number {
    return this.state.positionFraction
  }

  set positionFraction(value: number) {
    this.setPosition(value)
  }

  /** Moves the line, from 0 to 1 of the canvas's width (or height); values outside are clamped. */
  setPosition(positionFraction: number, input: CompareInput = 'code'): void {
    const next = validateFraction(positionFraction, 'positionFraction')
    if (next === this.state.positionFraction) return
    this.setState({ positionFraction: next })
    this.dispatchEvent({ type: 'slide', positionFraction: next, input })
  }

  /**
   * Moves the line under a point on the canvas, in CSS pixels from its top-left corner (an earth pointer event's
   * `screen`). Needs the plugin installed and one frame drawn, for the canvas's size; does nothing before.
   */
  setPositionFromScreen(screen: { xPixels: number; yPixels: number }, input: CompareInput = 'code'): void {
    const length = this.canvasLength()
    if (length <= 0) return
    this.setPosition((this.state.orientation === 'vertical' ? screen.xPixels : screen.yPixels) / length, input)
  }

  get orientation(): CompareOrientation {
    return this.state.orientation
  }

  set orientation(value: CompareOrientation) {
    if (validateOrientation(value) === this.state.orientation) return
    this.setState({ orientation: value })
  }

  get followPointer(): boolean {
    return this.state.followPointer
  }

  /** While true, the line follows the pointer over the map. */
  set followPointer(value: boolean) {
    if (value === this.state.followPointer) return
    this.setState({ followPointer: value })
    this.updatePointerListener()
  }

  /** Shows `imagery` on one side only. A layer already on the other side moves. Takes effect at once when installed. */
  addImagery(imagery: Imagery, side: CompareSide): void {
    const other = side === 'before' ? 'after' : 'before'
    if (this.state[side].includes(imagery)) return
    this.setState({ [other]: this.state[other].filter(layer => layer !== imagery), [side]: [...this.state[side], imagery] })
  }

  /** Shows `imagery` on the whole canvas again. */
  removeImagery(imagery: Imagery): void {
    if (!this.state.before.includes(imagery) && !this.state.after.includes(imagery)) return
    this.setState({ before: this.state.before.filter(layer => layer !== imagery), after: this.state.after.filter(layer => layer !== imagery) })
  }

  /**
   * Makes `element` the slider's handle: dragging it moves the line (pointer capture, so it never pans the map), the
   * arrow keys move it by `keyboardStepFraction` (Page Up and Page Down ten times as far, Home and End to the edges),
   * and it gets the ARIA slider role and values, a tab stop, `touch-action: none`, and the `--compare-position` CSS
   * property (`'37.5%'`) to place it with, kept current. Returns a function that undoes it all.
   *
   * @example
   * // CSS: #swiper { position: absolute; top: 0; bottom: 0; left: var(--compare-position); }
   * const detach = compare.attachHandle(document.querySelector('#swiper')!)
   */
  attachHandle(element: HTMLElement, { label = DEFAULT_LABEL }: AttachHandleOptions = {}): () => void {
    if (this.handles.has(element)) throw new Error('Compare: this element is already a handle. Call the function attachHandle returned before attaching it again.')
    const previous = {
      role: element.getAttribute('role'),
      tabIndex: element.getAttribute('tabindex'),
      label: element.getAttribute('aria-label'),
      touchAction: element.style.touchAction,
    }
    element.setAttribute('role', 'slider')
    if (previous.tabIndex === null) element.tabIndex = 0
    if (previous.label === null && !element.hasAttribute('aria-labelledby')) element.setAttribute('aria-label', label)
    element.style.touchAction = 'none'
    this.handles.add(element)
    this.updateHandle(element)

    let drag: { pointerId: number; startClient: number; startFraction: number; length: number } | null = null
    const clientAlong = (event: PointerEvent) => (this.state.orientation === 'vertical' ? event.clientX : event.clientY)
    const onPointerDown = (event: PointerEvent) => {
      if (drag !== null || (event.pointerType === 'mouse' && event.button !== 0)) return
      // Measured once per drag: the canvas's size, else the handle's container (before the first frame).
      const container = element.offsetParent ?? element.parentElement
      const length = this.canvasLength() || (this.state.orientation === 'vertical' ? container?.clientWidth : container?.clientHeight) || 0
      if (length <= 0) return
      event.preventDefault()
      event.stopPropagation()
      element.setPointerCapture?.(event.pointerId)
      drag = { pointerId: event.pointerId, startClient: clientAlong(event), startFraction: this.state.positionFraction, length }
      this.setState({ dragging: true })
      this.dispatchEvent({ type: 'slidestart', positionFraction: this.state.positionFraction })
    }
    const onPointerMove = (event: PointerEvent) => {
      if (drag === null || event.pointerId !== drag.pointerId) return
      event.stopPropagation()
      this.setPosition(drag.startFraction + (clientAlong(event) - drag.startClient) / drag.length, 'drag')
    }
    const onPointerEnd = (event: PointerEvent) => {
      if (drag === null || event.pointerId !== drag.pointerId) return
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
      drag = null
      this.setState({ dragging: false })
      this.dispatchEvent({ type: 'slideend', positionFraction: this.state.positionFraction })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const step = this.keyboardStepFraction
      const position = this.state.positionFraction
      const next = (
        {
          ArrowLeft: position - step,
          ArrowDown: position - step,
          ArrowRight: position + step,
          ArrowUp: position + step,
          PageDown: position - step * 10,
          PageUp: position + step * 10,
          Home: 0,
          End: 1,
        } as Record<string, number>
      )[event.key]
      if (next === undefined) return
      // The arrows move the map too (keyboard controls): this key is the slider's.
      event.preventDefault()
      event.stopPropagation()
      this.setPosition(next, 'keyboard')
    }
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerEnd)
    element.addEventListener('pointercancel', onPointerEnd)
    element.addEventListener('lostpointercapture', onPointerEnd)
    element.addEventListener('keydown', onKeyDown)

    return () => {
      if (!this.handles.delete(element)) return
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerEnd)
      element.removeEventListener('pointercancel', onPointerEnd)
      element.removeEventListener('lostpointercapture', onPointerEnd)
      element.removeEventListener('keydown', onKeyDown)
      if (drag !== null) {
        drag = null
        this.setState({ dragging: false })
      }
      restoreAttribute(element, 'role', previous.role)
      restoreAttribute(element, 'tabindex', previous.tabIndex)
      restoreAttribute(element, 'aria-label', previous.label)
      for (const name of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-orientation']) element.removeAttribute(name)
      element.style.touchAction = previous.touchAction
      element.style.removeProperty(COMPARE_POSITION_PROPERTY)
    }
  }

  install(context: PluginContext): void {
    this.earth = context.earth
    context.onDispose(() => {
      this.earth = null
      this.updatePointerListener()
      this.applyClips()
    })
    this.updatePointerListener()
    this.applyClips()
  }

  inspect(): unknown {
    const { orientation, positionFraction, followPointer, dragging, before, after } = this.state
    return { orientation, positionFraction, followPointer, dragging, beforeLayers: before.length, afterLayers: after.length }
  }

  protected setState(change: Partial<CompareState>): void {
    this.state = { ...this.state, ...change }
    this.applyClips()
    for (const handle of this.handles) this.updateHandle(handle)
    for (const listener of [...this.listeners]) listener(this.state)
    this.dispatchEvent({ type: 'change', state: this.state })
  }

  /** Clips each listed layer to its side while installed; clears the clip of layers no longer listed, or all when removed. */
  protected applyClips(): void {
    const { orientation, positionFraction, before, after } = this.state
    const installed = this.earth !== null
    const sides: Array<[readonly Imagery[], ScreenClipSide]> = orientation === 'vertical' ? [[before, 'left'], [after, 'right']] : [[before, 'top'], [after, 'bottom']]
    const listed = new Set<Imagery>()
    if (installed) {
      for (const [layers, side] of sides) {
        for (const imagery of layers) {
          imagery.screenClip = { side, positionFraction }
          this.clipped.add(imagery)
          listed.add(imagery)
        }
      }
    }
    for (const imagery of this.clipped) {
      if (listed.has(imagery)) continue
      imagery.screenClip = null
      this.clipped.delete(imagery)
    }
    this.earth?.requestFrame()
  }

  protected updateHandle(element: HTMLElement): void {
    const { orientation, positionFraction } = this.state
    const percent = Math.round(positionFraction * 1000) / 10
    element.setAttribute('aria-valuemin', '0')
    element.setAttribute('aria-valuemax', '100')
    element.setAttribute('aria-valuenow', String(percent))
    element.setAttribute('aria-valuetext', `${percent}%`)
    // The slider moves across the line: sideways for a vertical line.
    element.setAttribute('aria-orientation', orientation === 'vertical' ? 'horizontal' : 'vertical')
    element.style.setProperty(COMPARE_POSITION_PROPERTY, `${positionFraction * 100}%`)
  }

  /** The canvas's width (vertical line) or height, in CSS pixels; 0 before the first frame. */
  protected canvasLength(): number {
    const camera = this.earth?.camera
    if (camera === undefined) return 0
    return this.state.orientation === 'vertical' ? camera.viewportWidthPixels : camera.viewportHeightPixels
  }

  protected updatePointerListener(): void {
    const wanted = this.earth !== null && this.state.followPointer
    if (wanted === (this.removePointerListener !== null)) return
    if (!wanted) {
      this.removePointerListener?.()
      this.removePointerListener = null
      return
    }
    const earth = this.earth!
    const listener = ({ screen }: { screen: { xPixels: number; yPixels: number } }) => {
      if (!this.state.dragging) this.setPositionFromScreen(screen, 'pointer')
    }
    earth.addEventListener('pointermove', listener)
    this.removePointerListener = () => earth.removeEventListener('pointermove', listener)
  }
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}
