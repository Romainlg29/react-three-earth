/** Anything that credits the data it shows: a source, a layer, or your own class. */
export interface AttributionProvider {
  /** The credits as strings of text, optionally with `<a href>` links. Cheap to call: it runs on every change. */
  getAttributions(): readonly string[]
  /** Optional: call `listener` when `getAttributions()` would answer differently. Returns a function that removes it. */
  addAttributionListener?(listener: () => void): () => void
}

/** What an app passes as `attribution`: one string or several. */
export type AttributionInput = string | readonly string[] | undefined

/** One run of attribution text: plain, or a link (always http or https). */
export interface AttributionSegment {
  text: string
  href?: string
}

/** Trims, drops empty strings and de-duplicates (whitespace-insensitively), keeping the first of each. */
export function normalizeAttributions(input: AttributionInput | readonly AttributionInput[]): string[] {
  const strings = typeof input === 'string' ? [input] : input === undefined ? [] : input.flatMap(entry => (entry === undefined ? [] : typeof entry === 'string' ? [entry] : [...entry]))
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of strings) {
    const trimmed = entry.trim()
    const key = trimmed.replace(/\s+/g, ' ')
    if (trimmed === '' || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/** The de-duplicated attributions of `providers`, in the order given. */
export function collectAttributions(providers: Iterable<AttributionProvider>): string[] {
  const all: string[] = []
  for (const provider of providers) all.push(...provider.getAttributions())
  return normalizeAttributions(all)
}

/**
 * Holds the attribution of a source: what the app passed plus what the source learned from its data (a style's
 * or TileJSON's `attribution`). Source classes extend it, which makes them `AttributionProvider`s.
 */
export class AttributionTracker implements AttributionProvider {
  protected provided: string[]
  protected loaded: string[] = []
  protected readonly attributionListeners = new Set<() => void>()

  constructor(attribution?: AttributionInput) {
    this.provided = normalizeAttributions(attribution)
  }

  getAttributions(): readonly string[] {
    return normalizeAttributions([this.provided, this.loaded])
  }

  /** Replaces the attribution the app provided. Notifies listeners only when it changed. */
  setAttribution(attribution: AttributionInput): void {
    const next = normalizeAttributions(attribution)
    if (next.join('\0') === this.provided.join('\0')) return
    this.provided = next
    this.notifyAttributionChange()
  }

  addAttributionListener(listener: () => void): () => void {
    this.attributionListeners.add(listener)
    return () => {
      this.attributionListeners.delete(listener)
    }
  }

  /** For subclasses: the attribution found in loaded metadata. */
  protected setLoadedAttributions(attribution: AttributionInput): void {
    const next = normalizeAttributions(attribution)
    if (next.join('\0') === this.loaded.join('\0')) return
    this.loaded = next
    this.notifyAttributionChange()
  }

  protected notifyAttributionChange(): void {
    for (const listener of [...this.attributionListeners]) listener()
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  ndash: '–',
  mdash: '—',
}

/** Decodes the common named and numeric character references. Unknown ones stay as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (match, decimal?: string, hexadecimal?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match
    const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hexadecimal!, 16)
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : match
  })
}

const TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
/** Elements whose content is code, not text: dropped with their content. */
const OPAQUE_ELEMENTS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'textarea'])

/** The `href` of an `<a>` tag's attribute text if it is an absolute http(s) URL, else undefined. */
function readSafeHref(attributes: string): string | undefined {
  for (const match of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1]!.toLowerCase() !== 'href') continue
    // Browsers ignore tabs, newlines and other control characters inside a URL: strip them before checking the scheme.
    // eslint-disable-next-line no-control-regex
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '').replace(/[\u0000- \u007f-\u009f]/g, '')
    if (!/^https?:\/\//i.test(value)) return undefined
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Reduces attribution HTML (from an app, a style, TileJSON or PMTiles metadata: all untrusted) to text and
 * links. Only `<a href="http(s)://…">` survives, as a segment with `href`; every other tag is dropped but its text
 * stays, except the content of `<script>`, `<style>` and similar, which goes too. Entities are decoded into plain
 * text. The result is for `textContent` and `<a>` elements, never `innerHTML`, and needs no DOM to compute.
 */
export function parseAttribution(html: string): AttributionSegment[] {
  const segments: AttributionSegment[] = []
  let href: string | undefined
  let skipping: string | null = null
  let buffer = ''

  const flush = () => {
    if (buffer === '') return
    const text = decodeEntities(buffer)
    buffer = ''
    const last = segments[segments.length - 1]
    if (last !== undefined && last.href === href) last.text += text
    else segments.push(href === undefined ? { text } : { text, href })
  }

  let index = 0
  while (index < html.length) {
    if (html[index] !== '<') {
      const next = html.indexOf('<', index)
      const end = next === -1 ? html.length : next
      if (skipping === null) buffer += html.slice(index, end)
      index = end
      continue
    }
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4)
      index = end === -1 ? html.length : end + 3
      continue
    }
    const tag = TAG_PATTERN.exec(html.slice(index))
    if (tag === null) {
      // A lone "<" that starts no tag is text (or a half-written tag: its remaining text shows, harmlessly).
      if (skipping === null) buffer += '<'
      index++
      continue
    }
    index += tag[0].length
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    if (skipping !== null) {
      if (closing && name === skipping) skipping = null
      continue
    }
    if (!closing && OPAQUE_ELEMENTS.has(name)) {
      if (!tag[3]!.trimEnd().endsWith('/')) skipping = name
      continue
    }
    if (name !== 'a') continue
    flush()
    href = closing ? undefined : readSafeHref(tag[3]!)
  }
  flush()

  const nonEmpty = segments.filter(segment => segment.text !== '')
  const first = nonEmpty[0]
  if (first !== undefined) first.text = first.text.trimStart()
  const last = nonEmpty[nonEmpty.length - 1]
  if (last !== undefined) last.text = last.text.trimEnd()
  return nonEmpty.filter(segment => segment.text !== '')
}

/** Plain text of an attribution, as a screen reader or a log would read it. */
export function attributionText(html: string): string {
  return parseAttribution(html)
    .map(segment => segment.text)
    .join('')
}

/**
 * Whether the control is compact: `compact` when set, otherwise when the container is narrower than
 * `automaticCompactBelowPixels` (640).
 */
export function resolveCompact(compact: boolean | undefined, containerWidthPixels: number, automaticCompactBelowPixels = 640): boolean {
  return compact ?? containerWidthPixels < automaticCompactBelowPixels
}
