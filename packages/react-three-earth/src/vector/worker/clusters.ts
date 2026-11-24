/**
 * Complex scripts (Devanagari and the other Indic scripts, Thai, Lao, Tibetan, Myanmar, Khmer) change a letter's
 * shape and place with its neighbours in ways one glyph per code point cannot show, and glyph servers have no
 * shaping. As MapLibre does for local CJK ideographs, each grapheme cluster is drawn whole by the local font
 * (the browser's canvas shapes it), and stands in the text as one private-use code point (plane 15), so
 * glyph loading, lookup, bidi and line breaking handle it like any other character.
 */

/** Blocks whose clusters are drawn whole. */
const COMPLEX_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0900, 0x0dff], // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
  [0x0e00, 0x0eff], // Thai, Lao
  [0x0f00, 0x0fff], // Tibetan
  [0x1000, 0x109f], // Myanmar
  [0x1780, 0x17ff], // Khmer
  [0x1a20, 0x1aaf], // Tai Tham
  [0xa8e0, 0xa8ff], // Devanagari Extended
  [0xa9e0, 0xa9ff], // Myanmar Extended-B
  [0xaa60, 0xaa7f], // Myanmar Extended-A
]

/** Scripts written without spaces between words: lines may break between words found by `Intl.Segmenter`. */
const UNSPACED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e00, 0x0eff],
  [0x1000, 0x109f],
  [0x1780, 0x17ff],
  [0x1a20, 0x1aaf],
]

const FIRST_CLUSTER_CODE_POINT = 0xf0000
const LAST_CLUSTER_CODE_POINT = 0xffffd
const ZERO_WIDTH_SPACE = '​'

const inRanges = (codePoint: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([start, end]) => codePoint >= start && codePoint <= end)

export function isComplexScriptCodePoint(codePoint: number): boolean {
  return codePoint >= 0x0900 && inRanges(codePoint, COMPLEX_RANGES)
}

/** Whether a code point stands for a cluster drawn whole (see `ClusterRegistry`). */
export function isClusterCodePoint(codePoint: number): boolean {
  return codePoint >= FIRST_CLUSTER_CODE_POINT && codePoint <= LAST_CLUSTER_CODE_POINT
}

/**
 * Gives each grapheme cluster of a complex script a private-use code point, for the life of the worker: the glyph
 * atlas keys glyphs by code point, so a cluster seen again reuses its glyph.
 */
export class ClusterRegistry {
  protected readonly codePoints = new Map<string, number>()
  protected readonly clusters: string[] = []

  /** The code point standing for a cluster, or null once all 65,534 are taken. */
  codePointFor(cluster: string): number | null {
    const known = this.codePoints.get(cluster)
    if (known !== undefined) return known
    const codePoint = FIRST_CLUSTER_CODE_POINT + this.clusters.length
    if (codePoint > LAST_CLUSTER_CODE_POINT) return null
    this.codePoints.set(cluster, codePoint)
    this.clusters.push(cluster)
    return codePoint
  }

  /** The cluster a code point stands for. */
  clusterOf(codePoint: number): string | undefined {
    return this.clusters[codePoint - FIRST_CLUSTER_CODE_POINT]
  }
}

/** The worker's clusters, shared by text preparation and the glyph provider. */
export const clusterRegistry = new ClusterRegistry()

let graphemes: Intl.Segmenter | null | undefined
let words: Intl.Segmenter | null | undefined

function segmenter(granularity: 'grapheme' | 'word'): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null
  if (granularity === 'grapheme') return (graphemes ??= new Intl.Segmenter(undefined, { granularity }))
  return (words ??= new Intl.Segmenter(undefined, { granularity }))
}

/** Whether a string has a character of a complex script, to skip the work for every other label. */
export function needsClusters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0x0900 && isComplexScriptCodePoint(code)) return true
  }
  return false
}

/**
 * Replaces each grapheme cluster of a complex script with the code point standing for it, and puts a zero-width
 * space between the words of scripts written without spaces, where lines may wrap. Other text is unchanged.
 * Without `Intl.Segmenter` the text is returned as it is (drawn code point by code point).
 */
export function substituteClusters(text: string, registry: ClusterRegistry = clusterRegistry): string {
  if (!needsClusters(text)) return text
  const graphemeSegmenter = segmenter('grapheme')
  if (graphemeSegmenter === null) return text
  const unspaced = (segment: string) => inRanges(segment.codePointAt(0)!, UNSPACED_RANGES)
  const wordSegmenter = [...text].some(character => unspaced(character)) ? segmenter('word') : null
  const pieces = wordSegmenter === null ? [text] : Array.from(wordSegmenter.segment(text), segment => segment.segment)
  let result = ''
  let previousUnspaced = false
  for (const piece of pieces) {
    const pieceUnspaced = unspaced(piece)
    if (previousUnspaced && pieceUnspaced) result += ZERO_WIDTH_SPACE
    previousUnspaced = pieceUnspaced
    for (const { segment } of graphemeSegmenter.segment(piece)) {
      const codePoint = isComplexScriptCodePoint(segment.codePointAt(0)!) ? registry.codePointFor(segment) : null
      result += codePoint === null ? segment : String.fromCodePoint(codePoint)
    }
  }
  return result
}
