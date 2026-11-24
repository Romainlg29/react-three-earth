/**
 * Arabic contextual shaping for map labels: each letter becomes its isolated, final, initial or medial
 * presentation form (U+FB50–U+FDFF, U+FE70–U+FEFF), and lam followed by alef becomes one ligature. This is what
 * MapLibre's `@mapbox/mapbox-gl-rtl-text` plugin does with ICU before looking glyphs up, so glyph servers
 * (which carry the presentation-form ranges) and local fonts draw connected script without a shaping engine.
 */

/** How a letter joins its neighbours (Unicode ArabicShaping.txt): dual, right only, join causing, transparent. */
type JoiningType = 'dual' | 'right' | 'causing' | 'transparent'

/** Presentation forms: isolated, final, initial, medial (0 where the form does not exist). */
type Forms = readonly [number, number, number, number]

const FORMS = new Map<number, Forms>()
const JOINING = new Map<number, JoiningType>()

function define(codePoint: number, joining: 'dual' | 'right', forms: Forms): void {
  FORMS.set(codePoint, forms)
  JOINING.set(codePoint, joining)
}

// U+0621–U+064A, forms in Arabic Presentation Forms-B (U+FE80–U+FEF4), in code point order.
{
  // For each letter: 'u' no joining (hamza), 'r' right-joining (2 forms), 'd' dual-joining (4 forms).
  const letters = 'urrrrdrdrdddddrrrrdddddddd'
  let form = 0xfe80
  for (let index = 0; index < letters.length; index++) {
    const codePoint = 0x0621 + index
    const kind = letters[index]
    if (kind === 'u') {
      FORMS.set(codePoint, [form, 0, 0, 0])
      form += 1
    } else if (kind === 'r') {
      define(codePoint, 'right', [form, form + 1, 0, 0])
      form += 2
    } else {
      define(codePoint, 'dual', [form, form + 1, form + 2, form + 3])
      form += 4
    }
  }
  // U+0641–U+064A after tatweel (U+0640) and the gap of U+063B–U+063F.
  const after = 'dddddddrrd' // feh qaf kaf lam meem noon heh waw alef-maksura yeh
  form = 0xfed1
  for (let index = 0; index < after.length; index++) {
    const codePoint = 0x0641 + index
    if (after[index] === 'r') {
      define(codePoint, 'right', [form, form + 1, 0, 0])
      form += 2
    } else {
      define(codePoint, 'dual', [form, form + 1, form + 2, form + 3])
      form += 4
    }
  }
  // Alef maksura joins on both sides; its initial and medial forms live in Presentation Forms-A.
  define(0x0649, 'dual', [0xfeef, 0xfef0, 0xfbe8, 0xfbe9])
}

// Persian, Urdu and other extended letters, in Arabic Presentation Forms-A.
define(0x0671, 'right', [0xfb50, 0xfb51, 0, 0]) // alef wasla
define(0x0679, 'dual', [0xfb66, 0xfb67, 0xfb68, 0xfb69]) // tteh
define(0x067e, 'dual', [0xfb56, 0xfb57, 0xfb58, 0xfb59]) // peh
define(0x0686, 'dual', [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d]) // tcheh
define(0x0688, 'right', [0xfb88, 0xfb89, 0, 0]) // ddal
define(0x0691, 'right', [0xfb8c, 0xfb8d, 0, 0]) // rreh
define(0x0698, 'right', [0xfb8a, 0xfb8b, 0, 0]) // jeh
define(0x06a4, 'dual', [0xfb6a, 0xfb6b, 0xfb6c, 0xfb6d]) // veh
define(0x06a9, 'dual', [0xfb8e, 0xfb8f, 0xfb90, 0xfb91]) // keheh
define(0x06af, 'dual', [0xfb92, 0xfb93, 0xfb94, 0xfb95]) // gaf
define(0x06ba, 'dual', [0xfb9e, 0xfb9f, 0, 0]) // noon ghunna
define(0x06be, 'dual', [0xfbaa, 0xfbab, 0xfbac, 0xfbad]) // heh doachashmee
define(0x06c0, 'right', [0xfba4, 0xfba5, 0, 0]) // heh with yeh above
define(0x06c1, 'dual', [0xfba6, 0xfba7, 0xfba8, 0xfba9]) // heh goal
define(0x06cc, 'dual', [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff]) // farsi yeh
define(0x06d2, 'right', [0xfbae, 0xfbaf, 0, 0]) // yeh barree
JOINING.set(0x0640, 'causing') // tatweel
JOINING.set(0x200d, 'causing') // zero width joiner

/** Combining marks the joining skips over (harakat, Quranic marks, superscript alef). */
const TRANSPARENT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x08d3, 0x08e1],
  [0x08e3, 0x08ff],
]

/** Lam-alef ligatures by alef: isolated and final forms. */
const LAM_ALEF = new Map<number, readonly [number, number]>([
  [0x0622, [0xfef5, 0xfef6]],
  [0x0623, [0xfef7, 0xfef8]],
  [0x0625, [0xfef9, 0xfefa]],
  [0x0627, [0xfefb, 0xfefc]],
])
const LAM = 0x0644

function joiningOf(codePoint: number): JoiningType | null {
  const joining = JOINING.get(codePoint)
  if (joining !== undefined) return joining
  for (const [start, end] of TRANSPARENT_RANGES) if (codePoint >= start && codePoint <= end) return 'transparent'
  return null
}

/** Whether a string has a letter this module shapes, to skip the work for every other label. */
export function needsArabicShaping(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0x0620 && code <= 0x06ff) return true
  }
  return false
}

/**
 * Shapes a sequence of code points. Each output code point keeps the index of the input code point it came
 * from (a lam-alef ligature keeps the lam's), so callers can carry per-character data (a text section) along.
 */
export function shapeArabicCodePoints(codePoints: readonly number[]): { codePoints: number[]; sources: number[] } {
  const joinings = codePoints.map(joiningOf)
  // The nearest non-transparent neighbour on each side, -1 for none.
  const previous = new Int32Array(codePoints.length).fill(-1)
  const next = new Int32Array(codePoints.length).fill(-1)
  let last = -1
  for (let index = 0; index < codePoints.length; index++) {
    previous[index] = last
    if (joinings[index] !== 'transparent') last = index
  }
  last = -1
  for (let index = codePoints.length - 1; index >= 0; index--) {
    next[index] = last
    if (joinings[index] !== 'transparent') last = index
  }
  const joinsForward = (index: number) => index >= 0 && (joinings[index] === 'dual' || joinings[index] === 'causing')
  const joinsBackward = (index: number) => index >= 0 && (joinings[index] === 'dual' || joinings[index] === 'right' || joinings[index] === 'causing')

  const output: number[] = []
  const sources: number[] = []
  const dropped = new Set<number>()
  for (let index = 0; index < codePoints.length; index++) {
    if (dropped.has(index)) continue
    const codePoint = codePoints[index]!
    const joining = joinings[index]
    const forms = FORMS.get(codePoint)
    if (forms === undefined || joining === 'transparent' || joining === null) {
      // Hamza (U+0621) has an isolated form only; everything else is kept as it is.
      output.push(forms?.[0] || codePoint)
      sources.push(index)
      continue
    }
    const joinsPrevious = joinsBackward(index) && joinsForward(previous[index]!)
    if (codePoint === LAM && next[index]! >= 0) {
      const ligature = LAM_ALEF.get(codePoints[next[index]!]!)
      if (ligature !== undefined) {
        output.push(joinsPrevious ? ligature[1] : ligature[0])
        sources.push(index)
        dropped.add(next[index]!)
        continue
      }
    }
    const joinsNext = joinsForward(index) && joinsBackward(next[index]!)
    const form = joinsPrevious && joinsNext ? forms[3] : joinsPrevious ? forms[1] : joinsNext ? forms[2] : forms[0]
    // A missing form (a right-joining letter has no initial or medial) falls back to the nearest that exists.
    output.push(form || (joinsPrevious ? forms[1] : 0) || forms[0] || codePoint)
    sources.push(index)
  }
  return { codePoints: output, sources }
}

/** Shapes the Arabic letters of a string; other text is returned unchanged. */
export function shapeArabic(text: string): string {
  if (!needsArabicShaping(text)) return text
  const codePoints = Array.from(text, character => character.codePointAt(0)!)
  return String.fromCodePoint(...shapeArabicCodePoints(codePoints).codePoints)
}
