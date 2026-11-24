import type { Earth } from '../core/Earth.js'
import { normalizeAttributions, parseAttribution, resolveCompact, type AttributionSegment } from '../core/attribution.js'
import { MapControl } from './Controls.js'
import { resolveLocale, type ControlsLocale } from './locale.js'

export interface AttributionControlOptions {
  /** The earth whose `getAttributions()` the control reports and whose `attributionchange` event it follows. */
  earth: Earth
  /** The element whose width decides the automatic compact mode: usually the one around the canvas. Without it, the window's width. */
  container?: HTMLElement
  /**
   * `true` reports `compact` always (show a button that expands the credits), `false` never. Default: automatic, compact
   * while the container is narrower than 640 CSS pixels.
   */
  compact?: boolean
  /** Credits of your own, after the earth's (text, or HTML where only `<a href="https://…">` links are kept). */
  customAttribution?: string | readonly string[]
  locale?: Partial<ControlsLocale>
}

export interface AttributionControlState {
  /** The credits, de-duplicated, each parsed into text and safe `http(s)` links. Render them as text nodes and `<a>`s, never as HTML. */
  entries: readonly (readonly AttributionSegment[])[]
  /** False when there is nothing to credit: hide the control. */
  visible: boolean
  /** True on narrow containers (or with `compact: true`): show a toggle button, and the text only while `expanded`. */
  compact: boolean
  /** Whether the user expanded the credits with `toggle`. */
  expanded: boolean
  /** Whether to show the credits' text now: not compact, or expanded. Give the toggle `aria-expanded={textVisible}`. */
  textVisible: boolean
  /** The accessible name of the toggle: "Show attribution" or "Hide attribution". */
  toggleLabel: string
  /** The accessible name of the control's group, "Map attribution". */
  groupLabel: string
}

/**
 * The credits of an `Earth` (terrain, then imagery, de-duplicated) and a compact mode for small screens, without any
 * DOM: draw them yourself, or use `appendAttribution` to build the text and links safely. Most tile providers require
 * the credits to be visible. Follows the earth's `attributionchange`, and the container's width while it has a listener.
 *
 * Credits are text from tile servers, styles and metadata: `entries` holds them parsed by `parseAttribution` into text
 * and `http(s)` links, so they never need `innerHTML`.
 *
 * ```ts
 * const attribution = new AttributionControl({ earth, container })
 * const draw = (state = attribution.getState()) => {
 *   credits.hidden = !state.visible
 *   appendAttribution(credits, state.entries)
 * }
 * draw() // `subscribe` calls the listener on changes only
 * attribution.subscribe(draw)
 * ```
 */
export class AttributionControl extends MapControl<AttributionControlState> {
  protected readonly container: HTMLElement | undefined
  protected compactOption: boolean | undefined
  protected customAttributions: readonly string[]
  protected expanded = false
  protected resizeObserver: ResizeObserver | null = null
  protected containerWidthPixels: number
  protected readonly locale: ControlsLocale

  constructor({ earth, container, compact, customAttribution, locale }: AttributionControlOptions) {
    super(earth)
    this.locale = resolveLocale(locale)
    this.container = container
    this.compactOption = compact
    this.customAttributions = toList(customAttribution)
    this.containerWidthPixels = this.measureWidth()
    this.initializeState()
  }

  /** `undefined` goes back to automatic. */
  setCompact(compact: boolean | undefined): void {
    this.compactOption = compact
    this.update()
  }

  /** Replaces the credits of your own. */
  setCustomAttribution(customAttribution: string | readonly string[] | undefined): void {
    this.customAttributions = toList(customAttribution)
    this.update()
  }

  /** Expands or collapses the credits in compact mode, as the "ⓘ" button does. */
  toggle = (): void => {
    this.expanded = !this.expanded
    this.update()
  }

  protected attach(): void {
    this.earth.addEventListener('attributionchange', this.update)
    this.containerWidthPixels = this.measureWidth()
    if (this.container !== undefined && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize)
      this.resizeObserver.observe(this.container)
    } else {
      globalThis.window?.addEventListener('resize', this.onResize)
    }
  }

  protected detach(): void {
    this.earth.removeEventListener('attributionchange', this.update)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    globalThis.window?.removeEventListener('resize', this.onResize)
  }

  protected onResize = (): void => {
    this.containerWidthPixels = this.measureWidth()
    this.update()
  }

  protected measureWidth(): number {
    return this.container?.clientWidth ?? globalThis.window?.innerWidth ?? Infinity
  }

  protected computeState(): AttributionControlState {
    const strings = normalizeAttributions([this.earth.getAttributions(), this.customAttributions])
    const previous = this.state?.entries
    // The same array while the credits do not change, so the state compares by identity
    const key = strings.join('\0')
    const entries = previous !== undefined && this.entriesKey === key ? previous : strings.map(parseAttribution)
    this.entriesKey = key
    const compact = resolveCompact(this.compactOption, this.containerWidthPixels)
    return {
      entries,
      visible: strings.length > 0,
      compact,
      expanded: this.expanded,
      textVisible: !compact || this.expanded,
      toggleLabel: this.expanded ? this.locale.hideAttribution : this.locale.showAttribution,
      groupLabel: this.locale.attribution,
    }
  }

  protected entriesKey: string | null = null
}

function toList(customAttribution: string | readonly string[] | undefined): readonly string[] {
  return typeof customAttribution === 'string' ? [customAttribution] : [...(customAttribution ?? [])]
}

/**
 * Replaces the children of `element` with the credits: text nodes, `<a target="_blank" rel="noopener noreferrer">`
 * links, and `separator` between entries. Never uses `innerHTML`.
 */
export function appendAttribution(element: HTMLElement, entries: AttributionControlState['entries'], separator = ' | '): void {
  const document = element.ownerDocument
  element.replaceChildren()
  entries.forEach((entry, index) => {
    if (index > 0) element.append(separator)
    for (const segment of entry) {
      if (segment.href === undefined) {
        element.append(segment.text)
        continue
      }
      const link = document.createElement('a')
      link.href = segment.href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = segment.text
      element.append(link)
    }
  })
}
