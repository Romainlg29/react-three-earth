import { describe, expect, it } from 'vitest'

import { shapeArabic } from '../src/vector/worker/arabic.js'
import { ClusterRegistry, isClusterCodePoint, substituteClusters } from '../src/vector/worker/clusters.js'
import { bidiClassOf, resolveLevels, visualOrder } from '../src/vector/worker/bidi.js'
import { shapeSectionsForScripts, shapeText, type ShapingOptions } from '../src/vector/worker/labels.js'

const codePoints = (text: string) => Array.from(text, character => character.codePointAt(0)!)
const hex = (text: string) => codePoints(text).map(codePoint => codePoint.toString(16))

/** Visual order of a string, as text: what a reader sees left to right. */
function visual(text: string): string {
  const points = codePoints(text)
  return String.fromCodePoint(...visualOrder(resolveLevels(points)).map(index => points[index]!))
}

const options: ShapingOptions = { maximumWidthEms: 0, lineHeightEms: 1.2, letterSpacingEms: 0, anchor: 'center', justify: 'center' }
const lookup = (_fontStack: string, codePoint: number) => ({ width: codePoint === 32 ? 0 : 10, height: 14, left: 1, top: -6, advance: 12, x: 0, y: 0 })
const drawn = (text: string, shaping = options) =>
  String.fromCodePoint(...shapeText([{ text, fontStack: 'f', scale: 1 }], shaping, lookup)!.glyphs.map(glyph => glyph.codePoint))

describe('Arabic shaping', () => {
  it('picks isolated, initial, medial and final forms', () => {
    // بيت (house): beh initial, yeh medial, teh final.
    expect(hex(shapeArabic('بيت'))).toEqual(['fe91', 'fef4', 'fe96'])
    // A single letter stays isolated.
    expect(hex(shapeArabic('ب'))).toEqual(['fe8f'])
  })

  it('stops joining after a right-joining letter', () => {
    // دبي (Dubai): dal isolated (joins nothing before it, never joins after), beh initial, yeh final.
    expect(hex(shapeArabic('دبي'))).toEqual(['fea9', 'fe91', 'fef2'])
  })

  it('makes lam-alef ligatures', () => {
    // سلام (peace): seen initial, lam-alef final ligature, meem isolated.
    expect(hex(shapeArabic('سلام'))).toEqual(['feb3', 'fefc', 'fee1'])
    expect(hex(shapeArabic('لا'))).toEqual(['fefb'])
  })

  it('skips harakat when joining', () => {
    // بَت: the fatha between beh and teh is transparent, so they still join.
    expect(hex(shapeArabic('بَت'))).toEqual(['fe91', '64e', 'fe96'])
  })

  it('shapes Persian letters and leaves other scripts alone', () => {
    // پل (bridge): peh initial, lam final.
    expect(hex(shapeArabic('پل'))).toEqual(['fb58', 'fede'])
    expect(shapeArabic('Tokyo 東京')).toBe('Tokyo 東京')
  })

  it('joins neighbours to letters with no presentation form (Kurdish, Pashto)', () => {
    // هەولێر (Erbil): ە (U+06D5) and ێ (U+06CE) have no forms but heh, lam and reh still join to them.
    expect(hex(shapeArabic('هەولێر'))).toEqual(['feeb', '6d5', 'feed', 'fedf', '6ce', 'feae'])
  })

  it('joins across text sections', () => {
    const sections = shapeSectionsForScripts([
      { text: 'ب', fontStack: 'a', scale: 1 },
      { text: 'ت', fontStack: 'b', scale: 1 },
    ])
    expect(sections.map(section => hex(section.text))).toEqual([['fe91'], ['fe96']])
    expect(sections.map(section => section.fontStack)).toEqual(['a', 'b'])
  })
})

describe('bidirectional text', () => {
  it('classifies characters', () => {
    expect(bidiClassOf(0x41)).toBe('L')
    expect(bidiClassOf(0x05d0)).toBe('R')
    expect(bidiClassOf(0x0628)).toBe('AL')
    expect(bidiClassOf(0xfe91)).toBe('AL')
    expect(bidiClassOf(0x31)).toBe('EN')
    expect(bidiClassOf(0x0661)).toBe('AN')
    expect(bidiClassOf(0x6771)).toBe('L')
  })

  it('reverses Hebrew and keeps digits left to right', () => {
    // "Street 12" in Hebrew: the word reads right to left, the number left to right, to its left.
    expect(visual('רחוב 12')).toBe('12 בוחר')
    expect(visual('שלום')).toBe('םולש')
  })

  it('keeps Latin runs in order inside right-to-left text', () => {
    expect(visual('תל אביב Tel Aviv')).toBe('Tel Aviv ביבא לת')
  })

  it('keeps right-to-left runs in order inside left-to-right text', () => {
    expect(visual('Haifa חיפה')).toBe('Haifa הפיח')
    // A number after a right-to-left word sticks to it (N1), as in browsers.
    expect(visual('Haifa חיפה 2024')).toBe('Haifa 2024 הפיח')
  })

  it('treats European digits after Arabic letters as Arabic numbers, and keeps decimals together', () => {
    expect(visual('شارع 10.5')).toBe('10.5 عراش')
    expect(visual('١٢ مايو')).toBe('ويام ١٢')
  })

  it('leaves left-to-right text alone', () => {
    expect(visual('Mount Fuji (3776 m)')).toBe('Mount Fuji (3776 m)')
  })
})

describe('shaping labels with right-to-left text', () => {
  it('draws glyphs in visual order with mirrored brackets', () => {
    expect(drawn('(שלום)')).toBe('(םולש)')
    // Spaces have no glyph to draw.
    expect(drawn('Jerusalem (ירושלים)')).toBe('Jerusalem(םילשורי)')
  })

  it('breaks lines in reading order, then reorders each line', () => {
    const shaped = shapeText([{ text: 'אבג דהו זחט', fontStack: 'f', scale: 1 }], { ...options, maximumWidthEms: 2, anchor: 'top' }, lookup)!
    const rows = new Map<number, number[]>()
    for (const glyph of shaped.glyphs) rows.set(glyph.y, [...(rows.get(glyph.y) ?? []), glyph.codePoint])
    // The first word read stays on the first line.
    expect([...rows.values()].map(row => String.fromCodePoint(...row))).toEqual(['גבא', 'והד', 'טחז'])
  })

  it('ignores letter spacing on Arabic labels, whose letters must touch', () => {
    const spaced = { ...options, letterSpacingEms: 0.5 }
    const width = (text: string) => {
      const shaped = shapeText([{ text, fontStack: 'f', scale: 1 }], spaced, lookup)!
      return shaped.right - shaped.left
    }
    expect(width(shapeArabic('سلام'))).toBeCloseTo(36)
    expect(width('abc')).toBeCloseTo(3 * 12 + 2 * 12)
  })

  it('keeps advances: a right-to-left label is as wide as it would be left to right', () => {
    const shaped = shapeText([{ text: 'שלום', fontStack: 'f', scale: 1 }], options, lookup)!
    expect(shaped.right - shaped.left).toBeCloseTo(48)
    const xs = shaped.glyphs.map(glyph => glyph.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
  })
})

describe('complex scripts', () => {
  const clusters = (text: string, registry = new ClusterRegistry()) =>
    Array.from(substituteClusters(text, registry), character => {
      const codePoint = character.codePointAt(0)!
      return isClusterCodePoint(codePoint) ? registry.clusterOf(codePoint)! : character === '​' ? '|' : character
    })

  it('draws each Devanagari grapheme cluster whole, conjuncts and vowel signs included', () => {
    // नई दिल्ली (New Delhi): "दि" (vowel sign i drawn before its consonant) and the conjunct "ल्ली" stay whole.
    expect(clusters('नई दिल्ली')).toEqual(['न', 'ई', ' ', 'दि', 'ल्ली'])
  })

  it('gives one cluster one code point, reused', () => {
    const registry = new ClusterRegistry()
    const first = substituteClusters('दिल्ली', registry)
    expect(substituteClusters('दिल्ली', registry)).toBe(first)
    expect([...first].every(character => isClusterCodePoint(character.codePointAt(0)!))).toBe(true)
  })

  it('lets Thai lines break between words', () => {
    // ถนนสุขุมวิท (Sukhumvit Road): marks above and below stay on their consonant; a break between the two words.
    const pieces = clusters('ถนนสุขุมวิท')
    expect(pieces).toEqual(['ถ', 'น', 'น', '|', 'สุ', 'ขุ', 'ม', 'วิ', 'ท'])
  })

  it('leaves other scripts alone', () => {
    expect(substituteClusters('Mount Fuji 富士山')).toBe('Mount Fuji 富士山')
  })

  it('keeps code points where no local font can draw clusters', () => {
    expect(shapeSectionsForScripts([{ text: 'दिल्ली', fontStack: 'f', scale: 1 }], { clusters: false })[0]!.text).toBe('दिल्ली')
  })

  it('shapes a label with clusters as single glyphs', () => {
    const sections = shapeSectionsForScripts([{ text: 'दिल्ली', fontStack: 'f', scale: 1 }])
    const shaped = shapeText(sections, options, lookup)!
    expect(shaped.glyphs).toHaveLength(2)
    expect(shaped.glyphs.every(glyph => isClusterCodePoint(glyph.codePoint))).toBe(true)
  })
})
