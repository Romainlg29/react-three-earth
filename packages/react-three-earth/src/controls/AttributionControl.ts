import type { Earth } from '../core/Earth.js'
import { normalizeAttributions, parseAttribution, resolveCompact } from '../core/attribution.js'
import { holdContainerPosition, releaseContainerPosition } from '../core/containerPosition.js'

export interface AttributionControlOptions {
  /** The earth whose `getAttributions()` the control shows and whose `attributionchange` event it follows. */
  earth: Earth
  /** The element the control's DOM is added to, in its bottom-right corner. It is made `position: relative` if it is static. */
  container: HTMLElement
  /**
   * `true` shows only a "ⓘ" button that expands the credits, `false` always shows them. Default: automatic, compact
   * while the container is narrower than 640 CSS pixels.
   */
  compact?: boolean
  /** Credits of your own, shown after the earth's (text, or HTML where only `<a href="https://…">` links are kept). */
  customAttribution?: string | readonly string[]
}

const STYLE_ELEMENT_ATTRIBUTE = 'data-react-three-earth-attribution-style'

/**
 * The CSS, injected once per document. Colours and sizes come from CSS variables, so an app restyles the control
 * without a stylesheet import:
 * `--react-three-earth-attribution-background`, `-color`, `-link-color`, `-font-size`.
 */
const STYLE = `
.react-three-earth-attribution {
  position: absolute; right: 0; bottom: 0; z-index: 2; box-sizing: border-box; max-width: 100%;
  display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 2px 6px;
  font: var(--react-three-earth-attribution-font-size, 11px) / 1.4 system-ui, sans-serif;
  color: var(--react-three-earth-attribution-color, #333);
  background: var(--react-three-earth-attribution-background, rgba(255, 255, 255, 0.75));
  border-top-left-radius: 4px; pointer-events: auto;
}
.react-three-earth-attribution[hidden] { display: none; }
.react-three-earth-attribution a { color: var(--react-three-earth-attribution-link-color, inherit); text-decoration: underline; }
.react-three-earth-attribution-text { min-width: 0; text-align: right; }
.react-three-earth-attribution-text[hidden], .react-three-earth-attribution-toggle[hidden] { display: none; }
.react-three-earth-attribution-toggle {
  all: unset; box-sizing: border-box; cursor: pointer; font-size: 15px; line-height: 1; width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
}
.react-three-earth-attribution-toggle:focus-visible { outline: 2px solid currentColor; }
`

function ensureStyle(document: Document): void {
  if (document.head.querySelector(`style[${STYLE_ELEMENT_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_ELEMENT_ATTRIBUTE, '')
  style.textContent = STYLE
  document.head.append(style)
}

/**
 * Shows the credits of an `Earth` in a corner of a container: terrain, then imagery, de-duplicated, with
 * links. Compact on small screens (a "ⓘ" button expands it). Updates itself on the earth's `attributionchange`.
 *
 * Credits are text from tile servers, styles and metadata, so they are never put through `innerHTML`: they are
 * reduced by `parseAttribution` to text nodes and `http(s)` links.
 */
export class AttributionControl {
  /** The control's root element, inside `container`. */
  readonly element: HTMLElement
  protected readonly earth: Earth
  protected readonly container: HTMLElement
  protected readonly textElement: HTMLElement
  protected readonly toggleButton: HTMLButtonElement
  protected readonly resizeObserver: ResizeObserver | null
  protected compactOption: boolean | undefined
  protected customAttributions: readonly string[]
  protected expanded = false
  protected containerWidthPixels: number
  protected readonly onChange = () => this.update()

  constructor({ earth, container, compact, customAttribution }: AttributionControlOptions) {
    const document = container.ownerDocument
    this.earth = earth
    this.container = container
    this.compactOption = compact
    this.customAttributions = typeof customAttribution === 'string' ? [customAttribution] : [...(customAttribution ?? [])]
    ensureStyle(document)

    // The first overlay makes a static container positioned; the last one to go puts it back
    holdContainerPosition(container)

    this.element = document.createElement('div')
    this.element.className = 'react-three-earth-attribution'
    this.element.setAttribute('role', 'group')
    this.element.setAttribute('aria-label', 'Map attribution')
    this.toggleButton = document.createElement('button')
    this.toggleButton.type = 'button'
    this.toggleButton.className = 'react-three-earth-attribution-toggle'
    this.toggleButton.textContent = 'ⓘ'
    this.toggleButton.title = 'Show attribution'
    this.toggleButton.setAttribute('aria-label', 'Show attribution')
    this.toggleButton.addEventListener('click', this.onToggle)
    this.textElement = document.createElement('span')
    this.textElement.className = 'react-three-earth-attribution-text'
    this.element.append(this.textElement, this.toggleButton)
    container.append(this.element)

    this.containerWidthPixels = container.clientWidth
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // Rebuild only when the container crosses the compact threshold
            const wasCompact = this.compact
            this.containerWidthPixels = container.clientWidth
            if (this.compact !== wasCompact) this.update()
          })
    this.resizeObserver?.observe(container)
    earth.addEventListener('attributionchange', this.onChange)
    this.update()
  }

  /** Whether the control currently shows only its button (before it is expanded). */
  get compact(): boolean {
    return resolveCompact(this.compactOption, this.containerWidthPixels)
  }

  /** `undefined` goes back to automatic. */
  setCompact(compact: boolean | undefined): void {
    this.compactOption = compact
    this.update()
  }

  /** Replaces the credits of your own. */
  setCustomAttribution(customAttribution: string | readonly string[] | undefined): void {
    this.customAttributions = typeof customAttribution === 'string' ? [customAttribution] : [...(customAttribution ?? [])]
    this.update()
  }

  /** Rebuilds the DOM from the earth's current credits. Called for you on every change. */
  update(): void {
    const entries = normalizeAttributions([this.earth.getAttributions(), this.customAttributions])
    this.textElement.replaceChildren()
    entries.forEach((entry, index) => {
      if (index > 0) this.textElement.append(' | ')
      for (const segment of parseAttribution(entry)) {
        if (segment.href === undefined) {
          this.textElement.append(segment.text)
          continue
        }
        const link = this.element.ownerDocument.createElement('a')
        link.href = segment.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = segment.text
        this.textElement.append(link)
      }
    })
    const compact = this.compact
    this.element.hidden = entries.length === 0
    this.toggleButton.hidden = !compact
    this.textElement.hidden = compact && !this.expanded
    this.toggleButton.setAttribute('aria-expanded', String(!this.textElement.hidden))
    const label = this.expanded ? 'Hide attribution' : 'Show attribution'
    this.toggleButton.title = label
    this.toggleButton.setAttribute('aria-label', label)
  }

  /** Removes the DOM and the listeners. */
  dispose(): void {
    this.earth.removeEventListener('attributionchange', this.onChange)
    this.toggleButton.removeEventListener('click', this.onToggle)
    this.resizeObserver?.disconnect()
    this.element.remove()
    releaseContainerPosition(this.container)
  }

  protected onToggle = (): void => {
    this.expanded = !this.expanded
    this.update()
  }
}
