import { Controls, MapControl } from './Controls.js'
import { createControlButton, createIcon, setButtonLabel } from './controlsStyle.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface FullscreenControlOptions {
  /** The element that goes fullscreen, which must hold the canvas and the controls. Default: the controls' container. */
  container?: HTMLElement
  /**
   * What to do where the browser has no Fullscreen API for elements, as iPhone Safari: `'fixed'` makes the container
   * cover the whole page (`position: fixed`, the visible viewport's height), `'hide'` hides the button. Default: 'fixed'.
   */
  unsupported?: 'fixed' | 'hide'
  locale?: Partial<ControlsLocale>
}

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void }
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const ENTER = 'M3 3h5v2H5v3H3zM12 3h5v5h-2V5h-3zM3 12h2v3h3v2H3zM15 12h2v5h-5v-2h3z'
const EXIT = 'M7 3h2v5H4V6h3zM11 3h2v3h3v2h-5zM4 12h5v5H7v-3H4zM11 12h5v2h-3v3h-2z'

/** True where the document can fullscreen an element (Chrome, Firefox, desktop Safari, iPad). False on iPhone Safari. */
export function fullscreenSupported(document: Document): boolean {
  const target = document as FullscreenDocument
  return target.fullscreenEnabled === true || target.webkitFullscreenEnabled === true
}

/**
 * A button that makes the map fill the screen, as MapLibre's `FullscreenControl`. It uses the browser's Fullscreen
 * API where there is one. iPhone Safari has none for elements, so by default the container covers the page instead
 * (`position: fixed`, `100dvh`), and the button or `Escape` brings it back: put the map's container directly in
 * the page, not inside an ancestor with a `transform`, which would trap a fixed element.
 */
export class FullscreenControl extends MapControl {
  readonly element: HTMLElement
  protected readonly button: HTMLButtonElement
  protected readonly enterIcon: SVGSVGElement
  protected readonly exitIcon: SVGSVGElement
  protected readonly fullscreenContainer: HTMLElement | undefined
  protected readonly unsupported: 'fixed' | 'hide'
  protected readonly locale: ControlsLocale
  protected target: HTMLElement | null = null
  protected pseudo = false
  protected document: Document

  constructor({ container, unsupported = 'fixed', locale }: FullscreenControlOptions = {}) {
    super()
    this.fullscreenContainer = container
    this.unsupported = unsupported
    this.locale = resolveLocale(locale)
    this.document = globalThis.document
    this.element = this.document.createElement('div')
    this.element.className = 'react-three-earth-control-group'
    this.button = createControlButton(this.document, this.locale.enterFullscreen)
    this.enterIcon = createIcon(this.document, ENTER)
    this.exitIcon = createIcon(this.document, EXIT)
    this.button.append(this.enterIcon)
    this.button.setAttribute('aria-pressed', 'false')
    this.button.addEventListener('click', this.onClick)
    this.element.append(this.button)
    this.element.hidden = !fullscreenSupported(this.document) && unsupported === 'hide'
  }

  /** True while the map is fullscreen, natively or by covering the page. */
  get active(): boolean {
    return this.pseudo || (this.target !== null && this.fullscreenElement() === this.target)
  }

  protected attach(controls: Controls): void {
    this.target = this.fullscreenContainer ?? controls.container
    this.document = this.target.ownerDocument
    this.document.addEventListener('fullscreenchange', this.sync)
    this.document.addEventListener('webkitfullscreenchange', this.sync)
    this.sync()
  }

  protected detach(): void {
    if (this.active) this.exit()
    this.document.removeEventListener('fullscreenchange', this.sync)
    this.document.removeEventListener('webkitfullscreenchange', this.sync)
    this.target = null
  }

  /** Makes the map fullscreen. Resolves once the browser agreed (the page-covering fallback is immediate). */
  async enter(): Promise<void> {
    const target = this.target
    if (target === null || this.active) return
    const element = target as FullscreenElement
    if (fullscreenSupported(this.document)) {
      // The browser can refuse (a user gesture is needed), which leaves the page as it was
      try {
        await (element.requestFullscreen?.() ?? element.webkitRequestFullscreen?.())
      } catch {
        // Not fullscreen: the button stays as it is
      }
    } else if (this.unsupported === 'fixed') {
      this.pseudo = true
      target.classList.add('react-three-earth-pseudo-fullscreen')
      this.document.addEventListener('keydown', this.onKeyDown)
    }
    this.sync()
  }

  /** Leaves fullscreen. */
  exit(): void {
    if (this.pseudo) {
      this.pseudo = false
      this.target?.classList.remove('react-three-earth-pseudo-fullscreen')
      this.document.removeEventListener('keydown', this.onKeyDown)
    } else if (this.fullscreenElement() !== null) {
      const document = this.document as FullscreenDocument
      void (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.())
    }
    this.sync()
  }

  protected fullscreenElement(): Element | null {
    const document = this.document as FullscreenDocument
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null
  }

  protected onClick = (): void => {
    if (this.active) this.exit()
    else void this.enter()
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.exit()
  }

  protected sync = (): void => {
    const active = this.active
    this.button.setAttribute('aria-pressed', String(active))
    setButtonLabel(this.button, active ? this.locale.exitFullscreen : this.locale.enterFullscreen)
    this.button.replaceChildren(active ? this.exitIcon : this.enterIcon)
    this.controls?.earth.requestFrame()
  }

  /** Removes the control and its listeners for good. */
  dispose(): void {
    this.remove()
    this.button.removeEventListener('click', this.onClick)
    this.element.remove()
  }
}
