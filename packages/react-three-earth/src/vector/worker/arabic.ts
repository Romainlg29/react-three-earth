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

// Persian, Urdu, Pashto, Kurdish and other extended letters with forms in Arabic Presentation Forms-A.
const right = (codePoint: number, form: number) => define(codePoint, 'right', [form, form + 1, 0, 0])
const dual = (codePoint: number, form: number) => define(codePoint, 'dual', [form, form + 1, form + 2, form + 3])
right(0x0671, 0xfb50) // alef wasla
dual(0x067b, 0xfb52) // beeh
dual(0x067e, 0xfb56) // peh
dual(0x0680, 0xfb5a) // beheh
dual(0x067a, 0xfb5e) // tteheh
dual(0x067f, 0xfb62) // teheh
dual(0x0679, 0xfb66) // tteh
dual(0x06a4, 0xfb6a) // veh
dual(0x06a6, 0xfb6e) // peheh
dual(0x0684, 0xfb72) // dyeh
dual(0x0683, 0xfb76) // nyeh
dual(0x0686, 0xfb7a) // tcheh
dual(0x0687, 0xfb7e) // tcheheh
right(0x068d, 0xfb82) // ddahal
right(0x068c, 0xfb84) // dahal
right(0x068e, 0xfb86) // dul
right(0x0688, 0xfb88) // ddal
right(0x0698, 0xfb8a) // jeh
right(0x0691, 0xfb8c) // rreh
dual(0x06a9, 0xfb8e) // keheh
dual(0x06af, 0xfb92) // gaf
dual(0x06b3, 0xfb96) // gueh
dual(0x06b1, 0xfb9a) // ngoeh
dual(0x06bb, 0xfba0) // rnoon
right(0x06c0, 0xfba4) // heh with yeh above
dual(0x06c1, 0xfba6) // heh goal
dual(0x06be, 0xfbaa) // heh doachashmee
right(0x06d2, 0xfbae) // yeh barree
right(0x06d3, 0xfbb0) // yeh barree with hamza above
dual(0x06ad, 0xfbd3) // ng
right(0x06c7, 0xfbd7) // u
right(0x06c6, 0xfbd9) // oe
right(0x06c8, 0xfbdb) // yu
right(0x06cb, 0xfbde) // ve
right(0x06c5, 0xfbe0) // kirghiz oe
right(0x06c9, 0xfbe2) // kirghiz yu
dual(0x06d0, 0xfbe4) // e
dual(0x06cc, 0xfbfc) // farsi yeh
// Noon ghunna joins on both sides in Unicode, but has no initial or medial form: drawn as joining right only.
right(0x06ba, 0xfb9e)

/**
 * Joining types of the other letters of the Arabic blocks (Unicode ArabicShaping.txt). They have no presentation
 * form and draw in their own glyph, but their neighbours still join to them, as ICU shapes them.
 */
const JOINING_RANGES: ReadonlyArray<readonly [number, number, 'dual' | 'right']> = [
  [0x0620, 0x0620, 'dual'],
  [0x063b, 0x063f, 'dual'],
  [0x066e, 0x066f, 'dual'],
  [0x0672, 0x0673, 'right'],
  [0x0675, 0x0677, 'right'],
  [0x0678, 0x0687, 'dual'],
  [0x0688, 0x0699, 'right'],
  [0x069a, 0x06bf, 'dual'],
  [0x06c0, 0x06c0, 'right'],
  [0x06c1, 0x06c2, 'dual'],
  [0x06c3, 0x06cb, 'right'],
  [0x06cc, 0x06cc, 'dual'],
  [0x06cd, 0x06cd, 'right'],
  [0x06ce, 0x06ce, 'dual'],
  [0x06cf, 0x06cf, 'right'],
  [0x06d0, 0x06d1, 'dual'],
  [0x06d2, 0x06d3, 'right'],
  [0x06d5, 0x06d5, 'right'],
  [0x06ee, 0x06ef, 'right'],
  [0x06fa, 0x06fc, 'dual'],
  [0x06ff, 0x06ff, 'dual'],
  [0x0750, 0x0758, 'dual'],
  [0x0759, 0x075b, 'right'],
  [0x075c, 0x076a, 'dual'],
  [0x076b, 0x076c, 'right'],
  [0x076d, 0x0770, 'dual'],
  [0x0771, 0x0771, 'right'],
  [0x0772, 0x0772, 'dual'],
  [0x0773, 0x0774, 'right'],
  [0x0775, 0x0777, 'dual'],
  [0x0778, 0x0779, 'right'],
  [0x077a, 0x077f, 'dual'],
]
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
  for (const [start, end, type] of JOINING_RANGES) if (codePoint >= start && codePoint <= end) return type
  return null
}

/** Whether a code point is Arabic script, base or presentation form: such labels take no letter spacing. */
export function isArabicScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x0600 && codePoint <= 0x06ff) ||
    (codePoint >= 0x0750 && codePoint <= 0x077f) ||
    (codePoint >= 0x08a0 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  )
}

/** Whether a string has a letter this module shapes, to skip the work for every other label. */
export function needsArabicShaping(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code >= 0x0620 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f)) return true
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
