import type { Earth } from '../core/Earth.js'
import { MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface FullscreenControlOptions {
  earth: Earth
  /** The element that goes fullscreen, which must hold the canvas and your controls: usually the one around the canvas. */
  container: HTMLElement
  /**
   * What to do where the browser has no Fullscreen API for elements, as iPhone Safari: `'fixed'` makes the container
   * cover the whole page (`position: fixed`, the visible viewport's height), `'hide'` reports `available: false` so you
   * hide the button. Default: 'fixed'.
   */
  unsupported?: 'fixed' | 'hide'
  locale?: Partial<ControlsLocale>
}

export interface FullscreenControlState {
  /** True while the map is fullscreen, natively or by covering the page. */
  active: boolean
  /** False where a button would do nothing (no Fullscreen API and `unsupported: 'hide'`): hide it. */
  available: boolean
  /** The accessible name of a fullscreen button: "Enter fullscreen" or "Exit fullscreen". Give the button `aria-pressed={active}`. */
  label: string
}

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void }
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

/** The inline style that makes the container cover the page where the browser cannot fullscreen it. */
const PAGE_COVER_STYLE: ReadonlyArray<readonly [string, string]> = [
  ['position', 'fixed'],
  ['top', '0'],
  ['right', '0'],
  ['bottom', '0'],
  ['left', '0'],
  ['width', '100%'],
  ['height', '100dvh'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['z-index', '2147483000'],
]

/** True where the document can fullscreen an element (Chrome, Firefox, desktop Safari, iPad). False on iPhone Safari. */
export function fullscreenSupported(document: Document): boolean {
  const target = document as FullscreenDocument
  return target.fullscreenEnabled === true || target.webkitFullscreenEnabled === true
}

/**
 * Makes the map fill the screen, as MapLibre's `FullscreenControl`, without drawing a button. It uses the browser's
 * Fullscreen API where there is one. iPhone Safari has none for elements, so by default the container covers the page
 * instead (an inline `position: fixed` and `100dvh`; the container's own values of those properties come back when it leaves), and `Escape` or `toggle` brings
 * it back: put the map's container directly in the page, not inside an ancestor with a `transform`, which would trap
 * a fixed element.
 */
export class FullscreenControl extends MapControl<FullscreenControlState> {
  readonly container: HTMLElement
  protected readonly unsupported: 'fixed' | 'hide'
  protected readonly locale: ControlsLocale
  protected readonly document: Document
  protected pageCovered = false
  /** The container's own inline values of the cover's properties, put back on exit. */
  protected styleBeforeCover: Array<{ property: string; value: string; priority: string }> = []

  constructor({ earth, container, unsupported = 'fixed', locale }: FullscreenControlOptions) {
    super(earth)
    this.container = container
    this.unsupported = unsupported
    this.locale = resolveLocale(locale)
    this.document = container.ownerDocument
    this.initializeState()
  }

  protected attach(): void {
    this.document.addEventListener('fullscreenchange', this.onFullscreenChange)
    this.document.addEventListener('webkitfullscreenchange', this.onFullscreenChange)
  }

  protected detach(): void {
    if (this.state.active) this.exit()
    this.document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    this.document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange)
  }

  /** Makes the map fullscreen. Resolves once the browser agreed (covering the page is immediate). */
  enter = async (): Promise<void> => {
    if (this.isActive()) return
    const element = this.container as FullscreenElement
    if (fullscreenSupported(this.document)) {
      // The browser can refuse (a user gesture is needed), which leaves the page as it was
      try {
        await (element.requestFullscreen?.() ?? element.webkitRequestFullscreen?.())
      } catch {
        // Not fullscreen: the state stays as it is
      }
    } else if (this.unsupported === 'fixed') {
      this.pageCovered = true
      const style = this.container.style
      this.styleBeforeCover = PAGE_COVER_STYLE.map(([property]) => ({ property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) }))
      for (const [property, value] of PAGE_COVER_STYLE) this.container.style.setProperty(property, value, 'important')
      this.document.addEventListener('keydown', this.onKeyDown)
    }
    this.changed()
  }

  /** Leaves fullscreen. */
  exit = (): void => {
    if (this.pageCovered) {
      this.pageCovered = false
      // Only the cover's properties: anything else set on the container meanwhile stays
      for (const { property, value, priority } of this.styleBeforeCover) {
        if (value === '') this.container.style.removeProperty(property)
        else this.container.style.setProperty(property, value, priority)
      }
      this.styleBeforeCover = []
      this.document.removeEventListener('keydown', this.onKeyDown)
    } else if (this.fullscreenElement() !== null) {
      const document = this.document as FullscreenDocument
      void (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.())
    }
    this.changed()
  }

  /** Enters or leaves, as a fullscreen button does. */
  toggle = (): void => {
    if (this.isActive()) this.exit()
    else void this.enter()
  }

  /** Leaves fullscreen and lets go for good. */
  override dispose(): void {
    if (this.isActive()) this.exit()
    super.dispose()
  }

  protected isActive(): boolean {
    return this.pageCovered || this.fullscreenElement() === this.container
  }

  protected fullscreenElement(): Element | null {
    const document = this.document as FullscreenDocument
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.exit()
  }

  protected onFullscreenChange = (): void => this.changed()

  protected changed(): void {
    this.update()
    // The canvas changes size: draw the next frame at the new size
    this.earth.requestFrame()
  }

  protected computeState(): FullscreenControlState {
    const active = this.isActive()
    return {
      active,
      available: fullscreenSupported(this.document) || this.unsupported === 'fixed',
      label: active ? this.locale.exitFullscreen : this.locale.enterFullscreen,
    }
  }
}
