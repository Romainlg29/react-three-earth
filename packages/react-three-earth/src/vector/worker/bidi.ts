/**
 * The Unicode bidirectional algorithm (UAX #9) for map labels: resolves embedding levels for a paragraph, then
 * reorders each line into visual order (left to right on the screen) and mirrors brackets inside right-to-left
 * runs. It covers rules P2–P3, W1–W7, N1–N2, I1–I2 and L1–L4. Explicit embeddings, overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069) are ignored, as are bracket pairs (N0): labels are names, not paragraphs.
 */

export type BidiClass = 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON'

/** Code point ranges and their class, sorted; anything else is L (Latin, Cyrillic, CJK, Indic, Thai…). */
const RANGES: ReadonlyArray<readonly [number, number, BidiClass]> = [
  [0x0000, 0x0008, 'BN'],
  [0x0009, 0x0009, 'S'],
  [0x000a, 0x000a, 'B'],
  [0x000b, 0x000b, 'S'],
  [0x000c, 0x000c, 'WS'],
  [0x000d, 0x000d, 'B'],
  [0x000e, 0x001b, 'BN'],
  [0x001c, 0x001e, 'B'],
  [0x001f, 0x001f, 'S'],
  [0x0020, 0x0020, 'WS'],
  [0x0021, 0x0022, 'ON'],
  [0x0023, 0x0025, 'ET'],
  [0x0026, 0x002a, 'ON'],
  [0x002b, 0x002b, 'ES'],
  [0x002c, 0x002c, 'CS'],
  [0x002d, 0x002d, 'ES'],
  [0x002e, 0x002f, 'CS'],
  [0x0030, 0x0039, 'EN'],
  [0x003a, 0x003a, 'CS'],
  [0x003b, 0x0040, 'ON'],
  [0x005b, 0x0060, 'ON'],
  [0x007b, 0x007e, 'ON'],
  [0x007f, 0x0084, 'BN'],
  [0x0085, 0x0085, 'B'],
  [0x0086, 0x009f, 'BN'],
  [0x00a0, 0x00a0, 'CS'],
  [0x00a1, 0x00a1, 'ON'],
  [0x00a2, 0x00a5, 'ET'],
  [0x00a6, 0x00a9, 'ON'],
  [0x00ab, 0x00ac, 'ON'],
  [0x00ad, 0x00ad, 'BN'],
  [0x00ae, 0x00af, 'ON'],
  [0x00b0, 0x00b1, 'ET'],
  [0x00b2, 0x00b3, 'EN'],
  [0x00b4, 0x00b4, 'ON'],
  [0x00b6, 0x00b8, 'ON'],
  [0x00b9, 0x00b9, 'EN'],
  [0x00bb, 0x00bf, 'ON'],
  [0x00d7, 0x00d7, 'ON'],
  [0x00f7, 0x00f7, 'ON'],
  [0x0300, 0x036f, 'NSM'],
  [0x0483, 0x0489, 'NSM'],
  [0x0590, 0x0590, 'R'],
  [0x0591, 0x05bd, 'NSM'],
  [0x05be, 0x05be, 'R'],
  [0x05bf, 0x05bf, 'NSM'],
  [0x05c0, 0x05c0, 'R'],
  [0x05c1, 0x05c2, 'NSM'],
  [0x05c3, 0x05c3, 'R'],
  [0x05c4, 0x05c5, 'NSM'],
  [0x05c6, 0x05c6, 'R'],
  [0x05c7, 0x05c7, 'NSM'],
  [0x05c8, 0x05ff, 'R'],
  [0x0600, 0x0605, 'AN'],
  [0x0606, 0x0607, 'ON'],
  [0x0608, 0x0608, 'AL'],
  [0x0609, 0x060a, 'ET'],
  [0x060b, 0x060b, 'AL'],
  [0x060c, 0x060c, 'CS'],
  [0x060d, 0x060d, 'AL'],
  [0x060e, 0x060f, 'ON'],
  [0x0610, 0x061a, 'NSM'],
  [0x061b, 0x064a, 'AL'],
  [0x064b, 0x065f, 'NSM'],
  [0x0660, 0x0669, 'AN'],
  [0x066a, 0x066a, 'ET'],
  [0x066b, 0x066c, 'AN'],
  [0x066d, 0x066f, 'AL'],
  [0x0670, 0x0670, 'NSM'],
  [0x0671, 0x06d5, 'AL'],
  [0x06d6, 0x06dc, 'NSM'],
  [0x06dd, 0x06dd, 'AN'],
  [0x06de, 0x06de, 'ON'],
  [0x06df, 0x06e4, 'NSM'],
  [0x06e5, 0x06e6, 'AL'],
  [0x06e7, 0x06e8, 'NSM'],
  [0x06e9, 0x06e9, 'ON'],
  [0x06ea, 0x06ed, 'NSM'],
  [0x06ee, 0x06ef, 'AL'],
  [0x06f0, 0x06f9, 'EN'],
  [0x06fa, 0x0710, 'AL'],
  [0x0711, 0x0711, 'NSM'],
  [0x0712, 0x072f, 'AL'],
  [0x0730, 0x074a, 'NSM'],
  [0x074b, 0x07a5, 'AL'],
  [0x07a6, 0x07b0, 'NSM'],
  [0x07b1, 0x07bf, 'AL'],
  [0x07c0, 0x07ea, 'R'],
  [0x07eb, 0x07f3, 'NSM'],
  [0x07f4, 0x07ff, 'R'],
  [0x0800, 0x085f, 'R'],
  [0x0860, 0x08d2, 'AL'],
  [0x08d3, 0x08e1, 'NSM'],
  [0x08e2, 0x08e2, 'AN'],
  [0x08e3, 0x08ff, 'NSM'],
  [0x0e31, 0x0e31, 'NSM'],
  [0x0e34, 0x0e3a, 'NSM'],
  [0x0e3f, 0x0e3f, 'ET'],
  [0x0e47, 0x0e4e, 'NSM'],
  [0x2000, 0x200a, 'WS'],
  [0x200b, 0x200d, 'BN'],
  [0x200e, 0x200e, 'L'],
  [0x200f, 0x200f, 'R'],
  [0x2010, 0x2027, 'ON'],
  [0x2028, 0x2028, 'WS'],
  [0x2029, 0x2029, 'B'],
  [0x202a, 0x202e, 'BN'],
  [0x202f, 0x202f, 'CS'],
  [0x2030, 0x2034, 'ET'],
  [0x2035, 0x2043, 'ON'],
  [0x2044, 0x2044, 'CS'],
  [0x2045, 0x205e, 'ON'],
  [0x205f, 0x205f, 'WS'],
  [0x2060, 0x206f, 'BN'],
  [0x2070, 0x2070, 'EN'],
  [0x2074, 0x2079, 'EN'],
  [0x207a, 0x207b, 'ES'],
  [0x207c, 0x207e, 'ON'],
  [0x2080, 0x2089, 'EN'],
  [0x208a, 0x208b, 'ES'],
  [0x208c, 0x208e, 'ON'],
  [0x20a0, 0x20cf, 'ET'],
  [0x20d0, 0x20f0, 'NSM'],
  [0x2100, 0x2101, 'ON'],
  [0x2103, 0x2106, 'ON'],
  [0x2108, 0x2109, 'ON'],
  [0x2116, 0x2118, 'ON'],
  [0x211e, 0x2123, 'ON'],
  [0x2125, 0x2125, 'ON'],
  [0x2127, 0x2127, 'ON'],
  [0x2129, 0x2129, 'ON'],
  [0x212e, 0x212e, 'ET'],
  [0x2140, 0x2144, 'ON'],
  [0x214a, 0x214d, 'ON'],
  [0x2150, 0x215f, 'ON'],
  [0x2189, 0x2211, 'ON'],
  [0x2212, 0x2212, 'ES'],
  [0x2213, 0x2213, 'ET'],
  [0x2214, 0x2335, 'ON'],
  [0x237b, 0x2394, 'ON'],
  [0x2396, 0x2487, 'ON'],
  [0x2488, 0x249b, 'EN'],
  [0x24ea, 0x26ab, 'ON'],
  [0x26ad, 0x27ff, 'ON'],
  [0x2900, 0x2bff, 'ON'],
  [0x2e00, 0x2e7f, 'ON'],
  [0x2ff0, 0x2fff, 'ON'],
  [0x3000, 0x3000, 'WS'],
  [0x3001, 0x3004, 'ON'],
  [0x3008, 0x3020, 'ON'],
  [0x302a, 0x302d, 'NSM'],
  [0x3030, 0x3030, 'ON'],
  [0x3036, 0x3037, 'ON'],
  [0x303d, 0x303f, 'ON'],
  [0x3099, 0x309a, 'NSM'],
  [0x309b, 0x309c, 'ON'],
  [0x30a0, 0x30a0, 'ON'],
  [0x30fb, 0x30fb, 'ON'],
  [0xfb1d, 0xfb1d, 'R'],
  [0xfb1e, 0xfb1e, 'NSM'],
  [0xfb1f, 0xfb28, 'R'],
  [0xfb29, 0xfb29, 'ES'],
  [0xfb2a, 0xfb4f, 'R'],
  [0xfb50, 0xfd3d, 'AL'],
  [0xfd3e, 0xfd3f, 'ON'],
  [0xfd40, 0xfdff, 'AL'],
  [0xfe00, 0xfe0f, 'NSM'],
  [0xfe10, 0xfe19, 'ON'],
  [0xfe20, 0xfe2f, 'NSM'],
  [0xfe30, 0xfe4f, 'ON'],
  [0xfe50, 0xfe50, 'CS'],
  [0xfe51, 0xfe51, 'ON'],
  [0xfe52, 0xfe52, 'CS'],
  [0xfe54, 0xfe54, 'ON'],
  [0xfe55, 0xfe55, 'CS'],
  [0xfe56, 0xfe5e, 'ON'],
  [0xfe5f, 0xfe5f, 'ET'],
  [0xfe60, 0xfe61, 'ON'],
  [0xfe62, 0xfe63, 'ES'],
  [0xfe64, 0xfe66, 'ON'],
  [0xfe68, 0xfe68, 'ON'],
  [0xfe69, 0xfe6a, 'ET'],
  [0xfe6b, 0xfe6b, 'ON'],
  [0xfe70, 0xfefe, 'AL'],
  [0xfeff, 0xfeff, 'BN'],
  [0xff01, 0xff02, 'ON'],
  [0xff03, 0xff05, 'ET'],
  [0xff06, 0xff0a, 'ON'],
  [0xff0b, 0xff0b, 'ES'],
  [0xff0c, 0xff0c, 'CS'],
  [0xff0d, 0xff0d, 'ES'],
  [0xff0e, 0xff0f, 'CS'],
  [0xff10, 0xff19, 'EN'],
  [0xff1a, 0xff1a, 'CS'],
  [0xff1b, 0xff20, 'ON'],
  [0xff3b, 0xff40, 'ON'],
  [0xff5b, 0xff65, 'ON'],
  [0xffe0, 0xffe1, 'ET'],
  [0xffe2, 0xffe4, 'ON'],
  [0xffe5, 0xffe6, 'ET'],
  [0xffe8, 0xffee, 'ON'],
  [0xfff9, 0xfffd, 'ON'],
  [0x10800, 0x10fff, 'R'],
  [0x1e800, 0x1edff, 'R'],
  [0x1ee00, 0x1eeff, 'AL'],
  [0x1ef00, 0x1efff, 'R'],
  [0x1f000, 0x1f0ff, 'ON'],
  [0x1f300, 0x1faff, 'ON'],
  [0xe0001, 0xe007f, 'BN'],
]

/** The bidi class of a code point (Unicode DerivedBidiClass.txt, the ranges labels meet). */
export function bidiClassOf(codePoint: number): BidiClass {
  let low = 0
  let high = RANGES.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end, bidiClass] = RANGES[middle]!
    if (codePoint < start) high = middle - 1
    else if (codePoint > end) low = middle + 1
    else return bidiClass
  }
  return 'L'
}

/** Whether any code point of the text is right-to-left: other labels skip the algorithm. */
export function hasRightToLeft(codePoints: readonly number[]): boolean {
  for (const codePoint of codePoints) {
    if (codePoint < 0x0590) continue
    const bidiClass = bidiClassOf(codePoint)
    if (bidiClass === 'R' || bidiClass === 'AL' || bidiClass === 'AN') return true
  }
  return false
}

/** The paragraph's direction from its first strong character (P2, P3): 0 left to right, 1 right to left. */
export function paragraphLevel(classes: readonly BidiClass[]): 0 | 1 {
  for (const bidiClass of classes) {
    if (bidiClass === 'L') return 0
    if (bidiClass === 'R' || bidiClass === 'AL') return 1
  }
  return 0
}

const isNeutral = (bidiClass: BidiClass) => bidiClass === 'B' || bidiClass === 'S' || bidiClass === 'WS' || bidiClass === 'ON' || bidiClass === 'BN'

/**
 * The resolved embedding level of each code point of one paragraph (no line breaks inside), at `level` (from
 * `paragraphLevel` when omitted). Even levels run left to right, odd ones right to left.
 */
export function resolveLevels(codePoints: readonly number[], level?: 0 | 1): Uint8Array {
  const classes = codePoints.map(bidiClassOf)
  const base = level ?? paragraphLevel(classes)
  const types = [...classes]
  const count = types.length
  const embedding: BidiClass = base === 1 ? 'R' : 'L'

  // W1: a mark takes the class of the character before it (or the paragraph's direction at the start).
  for (let index = 0; index < count; index++) {
    if (types[index] === 'NSM') types[index] = index === 0 ? embedding : types[index - 1] === 'BN' ? 'ON' : types[index - 1]!
  }
  // W2: European digits after Arabic letters are Arabic digits. W3: Arabic letters are R.
  let lastStrong: BidiClass = embedding
  for (let index = 0; index < count; index++) {
    const type = types[index]!
    if (type === 'L' || type === 'R' || type === 'AL') lastStrong = type
    else if (type === 'EN' && lastStrong === 'AL') types[index] = 'AN'
  }
  for (let index = 0; index < count; index++) if (types[index] === 'AL') types[index] = 'R'
  // W4: one separator between two numbers of the same kind joins them.
  for (let index = 1; index < count - 1; index++) {
    const type = types[index]
    const before = types[index - 1]
    const after = types[index + 1]
    if (type === 'ES' && before === 'EN' && after === 'EN') types[index] = 'EN'
    else if (type === 'CS' && before === after && (before === 'EN' || before === 'AN')) types[index] = before!
  }
  // W5: terminators (currency, percent) next to European digits are digits.
  for (let index = 0; index < count; index++) {
    if (types[index] !== 'ET') continue
    let end = index
    while (end < count && types[end] === 'ET') end++
    if ((index > 0 && types[index - 1] === 'EN') || (end < count && types[end] === 'EN')) for (let fill = index; fill < end; fill++) types[fill] = 'EN'
    index = end - 1
  }
  // W6: other separators and terminators are neutral. W7: European digits after L are L.
  lastStrong = embedding
  for (let index = 0; index < count; index++) {
    const type = types[index]!
    if (type === 'ES' || type === 'ET' || type === 'CS') types[index] = 'ON'
    else if (type === 'L' || type === 'R') lastStrong = type
    else if (type === 'EN' && lastStrong === 'L') types[index] = 'L'
  }
  // N1, N2: neutrals between characters of one direction take it (digits count as R); others, the paragraph's.
  const direction = (type: BidiClass): 'L' | 'R' | null => (type === 'L' ? 'L' : type === 'R' || type === 'EN' || type === 'AN' ? 'R' : null)
  for (let index = 0; index < count; index++) {
    if (!isNeutral(types[index]!)) continue
    let end = index
    while (end < count && isNeutral(types[end]!)) end++
    const before = index > 0 ? direction(types[index - 1]!) : embedding
    const after = end < count ? direction(types[end]!) : embedding
    const resolved: BidiClass = before === after && before !== null ? before : embedding
    for (let fill = index; fill < end; fill++) types[fill] = resolved
    index = end - 1
  }
  // I1, I2: levels from the resolved types.
  const levels = new Uint8Array(count)
  for (let index = 0; index < count; index++) {
    const type = types[index]
    if (base === 0) levels[index] = type === 'R' ? 1 : type === 'AN' || type === 'EN' ? 2 : 0
    else levels[index] = type === 'L' || type === 'EN' || type === 'AN' ? 2 : 1
  }
  // L1: separators, and whitespace at the end of the paragraph, go back to the paragraph level.
  for (let index = count - 1; index >= 0 && (classes[index] === 'WS' || classes[index] === 'BN'); index--) levels[index] = base
  for (let index = 0; index < count; index++) {
    if (classes[index] !== 'S' && classes[index] !== 'B') continue
    levels[index] = base
    for (let before = index - 1; before >= 0 && (classes[before] === 'WS' || classes[before] === 'BN'); before--) levels[before] = base
  }
  return levels
}

/**
 * The visual order of a line (L2): indices into `levels`, left to right on the screen. From the highest level
 * down to the lowest odd one, every run at that level or higher is reversed.
 */
export function visualOrder(levels: ArrayLike<number>): number[] {
  const order = Array.from({ length: levels.length }, (_, index) => index)
  let highest = 0
  let lowestOdd = Infinity
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index]!
    highest = Math.max(highest, level)
    if (level % 2 === 1) lowestOdd = Math.min(lowestOdd, level)
  }
  for (let level = highest; level >= lowestOdd; level--) {
    for (let index = 0; index < order.length; index++) {
      if (levels[order[index]!]! < level) continue
      let end = index
      while (end < order.length && levels[order[end]!]! >= level) end++
      order.splice(index, end - index, ...order.slice(index, end).reverse())
      index = end
    }
  }
  return order
}

const MIRRORED = new Map<number, number>()
for (const [opening, closing] of [
  [0x28, 0x29],
  [0x3c, 0x3e],
  [0x5b, 0x5d],
  [0x7b, 0x7d],
  [0xab, 0xbb],
  [0x2039, 0x203a],
  [0x2045, 0x2046],
  [0x207d, 0x207e],
  [0x208d, 0x208e],
  [0x2264, 0x2265],
  [0x3008, 0x3009],
  [0x300a, 0x300b],
  [0x300c, 0x300d],
  [0x300e, 0x300f],
  [0x3010, 0x3011],
  [0xff08, 0xff09],
  [0xff3b, 0xff3d],
  [0xff5b, 0xff5d],
] as const) {
  MIRRORED.set(opening, closing)
  MIRRORED.set(closing, opening)
}

/** L4: the mirrored glyph of a bracket or similar on a right-to-left level, or the code point itself. */
export function mirrorCodePoint(codePoint: number): number {
  return MIRRORED.get(codePoint) ?? codePoint
}
