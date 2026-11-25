/** Lower case, accents and other combining marks removed, spaces collapsed: `'Genève '` → `'geneve'`. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s\-‐-―_'’.,]+/g, ' ').trim()
}

/** Whole text, start of the text, start of a word, inside the text, every query word starting a word. */
const SCORE_EXACT = 0
const SCORE_PREFIX = 1
const SCORE_WORD_PREFIX = 2
const SCORE_CONTAINS = 3
const SCORE_ALL_WORDS = 4

/**
 * How well a normalised `text` matches a normalised `query`, lower is better, or infinity for no match. Both go
 * through `normalizeText` first.
 */
export function matchScore(text: string, query: string): number {
  if (text === query) return SCORE_EXACT
  if (text.startsWith(query)) return SCORE_PREFIX
  if (text.includes(` ${query}`)) return SCORE_WORD_PREFIX
  if (text.includes(query)) return SCORE_CONTAINS
  const words = text.split(' ')
  const queryWords = query.split(' ')
  if (queryWords.length > 1 && queryWords.every(queryWord => words.some(word => word.startsWith(queryWord)))) return SCORE_ALL_WORDS
  return Number.POSITIVE_INFINITY
}
