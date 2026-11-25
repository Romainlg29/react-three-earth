import { holdContainerPosition, releaseContainerPosition } from './containerPosition.js'

/** The hints `CooperativeGestures` shows. */
export interface CooperativeGesturesLocale {
  /** Shown when the wheel turns without `Ctrl`. */
  wheel: string
  /** Shown instead of `wheel` on Apple systems, where the key is `⌘`. */
  wheelApple: string
  /** Shown when one finger moves over the map. */
  touch: string
}

export const DEFAULT_COOPERATIVE_GESTURES_LOCALE: CooperativeGesturesLocale = {
  wheel: 'Use Ctrl + scroll to zoom the map',
  wheelApple: 'Use ⌘ + scroll to zoom the map',
  touch: 'Use two fingers to move the map',
}

export interface CooperativeGesturesOptions {
  locale?: Partial<CooperativeGesturesLocale>
  /** How long a hint stays. Default: 1.5. */
  hintDurationSeconds?: number
}

/** What a gesture does with cooperative gestures on. */
export type CooperativeDecision = 'map' | 'page'

/** A wheel turn moves the map only with `Ctrl` (or `⌘`); otherwise it scrolls the page. */
export function wheelDecision(event: Pick<WheelEvent, 'ctrlKey' | 'metaKey'>): CooperativeDecision {
  return event.ctrlKey || event.metaKey ? 'map' : 'page'
}

/** Touches move the map with two fingers or more; one finger scrolls the page. */
export function touchDecision(touchCount: number): CooperativeDecision {
  return touchCount >= 2 ? 'map' : 'page'
}

/** Overlays that take the wheel themselves: a popup's or a control's scrolling. */
const WHEEL_OVERLAYS = '[data-earthkit-popup], [data-earthkit-controls]'
/** Overlays that take touches themselves: a draggable marker, a popup's content, a control. */
const TOUCH_OVERLAYS = '[data-earthkit-marker][data-draggable], [data-earthkit-popup], [data-earthkit-controls]'

/** True for targets inside one of the overlays over the map that `selector` names. */
function isInsideOverlay(target: EventTarget | null, selector: string): boolean {
  const element = target as Element | null
  if (element === null || typeof element.closest !== 'function') return false
  return element.closest(selector) !== null
}

/** True on macOS, iOS and iPadOS, where the modifier is `⌘`. */
function isApplePlatform(): boolean {
  const navigatorWithData = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined
  const platform = navigatorWithData?.userAgentData?.platform ?? navigatorWithData?.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/**
 * MapLibre's cooperative gestures, for a map inside a scrolling page: the wheel scrolls the page unless `Ctrl`
 * (`⌘` on Apple systems) is held, and one finger scrolls the page while two move the map. A hint over the map
 * says so, and is announced by screen readers. Mouse drags and the keyboard are unchanged. `EarthViewControls`
 * owns one, off by default; attach it before the touch gestures and pointer controls.
 */
export class CooperativeGestures {
  readonly locale: CooperativeGesturesLocale
  hintDurationSeconds: number
  protected domElement: HTMLElement | null = null
  protected hint: HTMLDivElement | null = null
  protected hintTimer: ReturnType<typeof setTimeout> | null = null
  protected savedTouchAction = ''
  protected isEnabled = false

  constructor({ locale, hintDurationSeconds = 1.5 }: CooperativeGesturesOptions = {}) {
    this.locale = { ...DEFAULT_COOPERATIVE_GESTURES_LOCALE, ...locale }
    this.hintDurationSeconds = hintDurationSeconds
  }

  /** Turns cooperative gestures on or off; it can change while attached. Default: false. */
  get enabled(): boolean {
    return this.isEnabled
  }

  set enabled(value: boolean) {
    if (value === this.isEnabled) return
    const domElement = this.domElement
    if (domElement !== null) this.stop(domElement)
    this.isEnabled = value
    if (domElement !== null) this.start(domElement)
  }

  /** Changes the hints given; the others keep their text. */
  setLocale(locale: Partial<CooperativeGesturesLocale>): void {
    Object.assign(this.locale, locale)
  }

  attach(domElement: HTMLElement): void {
    this.detach()
    this.domElement = domElement
    this.start(domElement)
  }

  detach(): void {
    if (this.domElement === null) return
    this.stop(this.domElement)
    this.domElement = null
  }

  protected start(domElement: HTMLElement): void {
    if (!this.isEnabled) return
    // Capture on the element, so the wheel and the first finger are stopped before the pointer controls see them
    domElement.addEventListener('wheel', this.onWheel, { capture: true, passive: true })
    domElement.addEventListener('pointerdown', this.onPointerDown, { capture: true })
    domElement.addEventListener('touchstart', this.onTouch, { passive: false })
    domElement.addEventListener('touchmove', this.onTouch, { passive: false })
    // One finger pans the page; two fingers stay with the map (`onTouch` cancels the page's panning)
    this.savedTouchAction = domElement.style.touchAction
    domElement.style.touchAction = 'pan-x pan-y'
    const hint = domElement.ownerDocument.createElement('div')
    hint.className = 'earthkit-cooperative-hint'
    hint.setAttribute('role', 'status')
    hint.setAttribute('aria-live', 'polite')
    Object.assign(hint.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      boxSizing: 'border-box',
      textAlign: 'center',
      pointerEvents: 'none',
      zIndex: '3',
      font: 'var(--earthkit-cooperative-hint-font, 500 20px/1.3 system-ui, sans-serif)',
      color: 'var(--earthkit-cooperative-hint-color, #fff)',
      background: 'var(--earthkit-cooperative-hint-background, rgba(0, 0, 0, 0.6))',
      opacity: '0',
      transition: 'opacity 0.3s',
    })
    holdContainerPosition(domElement)
    domElement.append(hint)
    this.hint = hint
  }

  protected stop(domElement: HTMLElement): void {
    if (!this.isEnabled) return
    domElement.removeEventListener('wheel', this.onWheel, { capture: true })
    domElement.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
    domElement.removeEventListener('touchstart', this.onTouch)
    domElement.removeEventListener('touchmove', this.onTouch)
    domElement.style.touchAction = this.savedTouchAction
    if (this.hintTimer !== null) clearTimeout(this.hintTimer)
    this.hintTimer = null
    if (this.hint !== null) {
      this.hint.remove()
      releaseContainerPosition(domElement)
    }
    this.hint = null
  }

  /** Shows a hint for `hintDurationSeconds`. */
  showHint(text: string): void {
    const hint = this.hint
    if (hint === null) return
    if (hint.textContent !== text) hint.textContent = text
    hint.style.opacity = '1'
    if (this.hintTimer !== null) clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null
      hint.style.opacity = '0'
      // Emptied once hidden: screen readers find no stale hint, and the next one is announced again
      hint.textContent = ''
    }, this.hintDurationSeconds * 1000)
  }

  protected onWheel = (event: WheelEvent): void => {
    // A popup or control scrolls itself
    if (wheelDecision(event) === 'map' || isInsideOverlay(event.target, WHEEL_OVERLAYS)) return
    // Not prevented: the page scrolls. Stopped: the pointer controls do not zoom.
    event.stopImmediatePropagation()
    this.showHint(isApplePlatform() ? this.locale.wheelApple : this.locale.wheel)
  }

  /**
   * The touch gestures (listening on the window, before this) see every finger and take over at the second one.
   * Here every touch that reaches the pointer controls is stopped, so one finger never drags the map.
   */
  protected onPointerDown = (event: PointerEvent): void => {
    // A draggable marker, a popup or a control keeps its touches (a slider in a popup); a plain marker does not, so a
    // finger on it never drags the map (its tap still opens its popup: `click` is not stopped)
    if (event.pointerType === 'touch' && !isInsideOverlay(event.target, TOUCH_OVERLAYS)) event.stopImmediatePropagation()
  }

  protected onTouch = (event: TouchEvent): void => {
    if (touchDecision(event.touches.length) === 'map') {
      // Two fingers: the map's, so the page neither pans nor zooms
      if (event.cancelable) event.preventDefault()
      return
    }
    if (event.type === 'touchmove') this.showHint(this.locale.touch)
  }

  dispose(): void {
    this.detach()
  }
}
