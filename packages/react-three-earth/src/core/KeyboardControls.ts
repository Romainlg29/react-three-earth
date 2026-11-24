import type { MapViewChange } from './EarthCamera.js'
import type { Earth } from './Earth.js'

export interface KeyboardControlsOptions {
  /** How far an arrow key moves the map, in CSS pixels. Default: 100. */
  panStepPixels?: number
  /** Zoom levels `+` and `-` change; twice as many with `Shift`. Default: 1. */
  zoomStep?: number
  /** How far `Shift` + left or right turns the map. Default: 15. */
  rotateStepDegrees?: number
  /** How far `Shift` + up or down tilts the map. Default: 10. */
  pitchStepDegrees?: number
  /** Length of the ease after each key press. Default: 0.3. */
  durationSeconds?: number
}

/** The keyboard steps MapLibre uses. */
export const DEFAULT_KEYBOARD_OPTIONS: Required<KeyboardControlsOptions> = {
  panStepPixels: 100,
  zoomStep: 1,
  rotateStepDegrees: 15,
  pitchStepDegrees: 10,
  durationSeconds: 0.3,
}

/** What a key press does to the camera. */
export type KeyboardAction =
  | { type: 'pan'; xPixels: number; yPixels: number }
  | { type: 'zoom'; levels: number }
  | { type: 'rotate'; degrees: number }
  | { type: 'pitch'; degrees: number }

/** The parts of a `KeyboardEvent` that choose the action. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

/**
 * MapLibre's keyboard bindings: arrows pan, `+` / `-` zoom (twice as far with `Shift`), `Shift` + left / right
 * turns, `Shift` + up / down tilts. Null for any other key, and with `Ctrl`, `Alt` or `Cmd` held, which belong to
 * the browser and the system.
 */
export function keyboardAction(press: KeyPress, steps: Required<Omit<KeyboardControlsOptions, 'durationSeconds'>>): KeyboardAction | null {
  if (press.ctrlKey || press.metaKey || press.altKey) return null
  const { panStepPixels, zoomStep, rotateStepDegrees, pitchStepDegrees } = steps
  const zoomLevels = press.shiftKey ? zoomStep * 2 : zoomStep
  switch (press.key) {
    case '+':
    case '=':
      return { type: 'zoom', levels: zoomLevels }
    case '-':
    case '_':
      return { type: 'zoom', levels: -zoomLevels }
    case 'ArrowLeft':
      return press.shiftKey ? { type: 'rotate', degrees: -rotateStepDegrees } : { type: 'pan', xPixels: -panStepPixels, yPixels: 0 }
    case 'ArrowRight':
      return press.shiftKey ? { type: 'rotate', degrees: rotateStepDegrees } : { type: 'pan', xPixels: panStepPixels, yPixels: 0 }
    case 'ArrowUp':
      return press.shiftKey ? { type: 'pitch', degrees: pitchStepDegrees } : { type: 'pan', xPixels: 0, yPixels: -panStepPixels }
    case 'ArrowDown':
      return press.shiftKey ? { type: 'pitch', degrees: -pitchStepDegrees } : { type: 'pan', xPixels: 0, yPixels: panStepPixels }
    default:
      return null
  }
}

/** True for elements that take typing of their own (a form field in a popup), where keys must not move the map. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null
  if (element === null || typeof element.tagName !== 'string') return false
  if (element.isContentEditable === true) return true
  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/** Slows down to the end, so held keys move the map smoothly from one ease into the next. MapLibre's keyboard easing. */
const easeOut = (time: number) => time * (2 - time)

/**
 * Moves the camera with the keyboard while the map's element has focus, as MapLibre's keyboard handler:
 * see `keyboardAction` for the keys. Each press eases the camera through `earth.camera`, so it honours
 * `prefers-reduced-motion`; presses made during the ease add to its target, a held key moves on from where
 * the camera is. Keys typed into a form field inside the map are left alone. `EarthViewControls` owns one.
 */
export class KeyboardControls {
  enabled = true
  panStepPixels: number
  zoomStep: number
  rotateStepDegrees: number
  pitchStepDegrees: number
  durationSeconds: number
  /** Steepest tilt away from looking straight down, in degrees, for the view shown. Set by `EarthViewControls`. */
  maximumTiltDegrees = 80
  /** Called before a key press moves the camera: `EarthViewControls` stops the pointer controls' inertia here. */
  onStart: (() => void) | null = null
  protected domElement: HTMLElement | null = null
  /** Where the running keyboard ease is headed, so quick presses add up. */
  protected target: MapViewChange | null = null

  constructor(
    protected readonly earth: Earth,
    options: KeyboardControlsOptions = {},
  ) {
    const { panStepPixels, zoomStep, rotateStepDegrees, pitchStepDegrees, durationSeconds } = { ...DEFAULT_KEYBOARD_OPTIONS, ...options }
    this.panStepPixels = panStepPixels
    this.zoomStep = zoomStep
    this.rotateStepDegrees = rotateStepDegrees
    this.pitchStepDegrees = pitchStepDegrees
    this.durationSeconds = durationSeconds
  }

  /** Changes the options given; the others keep their value. */
  setOptions(options: KeyboardControlsOptions): void {
    if (options.panStepPixels !== undefined) this.panStepPixels = options.panStepPixels
    if (options.zoomStep !== undefined) this.zoomStep = options.zoomStep
    if (options.rotateStepDegrees !== undefined) this.rotateStepDegrees = options.rotateStepDegrees
    if (options.pitchStepDegrees !== undefined) this.pitchStepDegrees = options.pitchStepDegrees
    if (options.durationSeconds !== undefined) this.durationSeconds = options.durationSeconds
  }

  attach(domElement: HTMLElement): void {
    this.detach()
    this.domElement = domElement
    domElement.addEventListener('keydown', this.onKeyDown)
  }

  detach(): void {
    this.domElement?.removeEventListener('keydown', this.onKeyDown)
    this.domElement = null
    this.target = null
  }

  /** The action for a key press, or null to leave it to the page. Override to change the bindings. */
  protected actionFor(press: KeyPress): KeyboardAction | null {
    return keyboardAction(press, this)
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.defaultPrevented || isEditableTarget(event.target)) return
    const action = this.actionFor(event)
    if (action === null) return
    // The key is the map's even while it cannot move (a morph runs), so it never scrolls the page instead.
    event.preventDefault()
    const earth = this.earth
    if (!earth.camera.ready || earth.view.transitioning) return
    this.onStart?.()
    this.apply(action, event.repeat)
    earth.requestFrame()
  }

  /** Starts the ease for an action. A repeated (held) key moves on from the camera, not from the last target. */
  protected apply(action: KeyboardAction, repeat: boolean): void {
    const camera = this.earth.camera
    const options = { durationSeconds: this.durationSeconds, easing: easeOut }
    if (action.type === 'pan') {
      this.target = null
      void camera.panBy({ xPixels: action.xPixels, yPixels: action.yPixels }, options)
      return
    }
    const view = camera.getView()
    const base = !repeat && camera.animating && this.target !== null ? this.target : {}
    const change: MapViewChange = {}
    if (action.type === 'zoom') change.zoom = (base.zoom ?? view.zoom) + action.levels
    if (action.type === 'rotate') change.headingDegrees = (base.headingDegrees ?? view.headingDegrees) + action.degrees
    if (action.type === 'pitch') {
      const pitch = (base.pitchDegrees ?? view.pitchDegrees) + action.degrees
      change.pitchDegrees = Math.min(Math.max(pitch, -90), -90 + this.maximumTiltDegrees)
    }
    const target = { ...base, ...change }
    this.target = target
    void camera.easeTo(target, options).then(() => {
      if (this.target === target) this.target = null
    })
  }

  dispose(): void {
    this.detach()
  }
}
