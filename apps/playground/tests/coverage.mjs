// Records which source lines each browser check runs: V8 block coverage of the page, its workers and the Node script
// that drives it, mapped back to the original TypeScript lines through Vite's inline source maps. selection.mjs reads
// these records to skip a check when no line it ran has changed since it last passed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The repository root, with a trailing separator. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PLAYGROUND = path.join(ROOT, 'apps/playground')

/** Repository-relative path, with forward slashes, of a file inside the repository and outside node_modules; else null. */
export function repositoryPath(absolutePath) {
  const relative = path.relative(ROOT, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) return null
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null
  return relative.split(path.sep).join('/')
}

/** Repository path of a script URL that Vite serves (`/src/…`, `/@fs/…`) or a file URL; null for dependencies and Vite's own modules. */
export function scriptPath(url, origin) {
  if (url.startsWith('file://')) return repositoryPath(fileURLToPath(url))
  if (!url.startsWith(origin)) return null
  const pathname = decodeURIComponent(new URL(url).pathname)
  if (pathname.startsWith('/@fs/')) return repositoryPath(pathname.slice('/@fs'.length))
  if (pathname.startsWith('/@') || pathname.startsWith('/node_modules/')) return null
  return repositoryPath(path.join(PLAYGROUND, pathname))
}

// ── Lines from block coverage ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A sweep over a script's coverage ranges: `at(offset)`, called with offsets that never decrease, tells whether the
 * code there ran (the innermost range decides) and whether it is top-level code, outside every function. With
 * `topLevelRan`, top-level code counts as run (the Node scripts take coverage per check, after their top level ran).
 */
function coverageSweep(functions, topLevelRan) {
  const ranges = []
  for (const coverage of functions) {
    const topLevel = coverage.functionName === '' && coverage.ranges[0]?.startOffset === 0
    coverage.ranges.forEach((range, index) => ranges.push({ start: range.startOffset, end: range.endOffset, count: range.count, topLevel, functionRange: index === 0 }))
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const stack = []
  let next = 0
  return offset => {
    while (next < ranges.length && ranges[next].start <= offset) {
      while (stack.length > 0 && stack.at(-1).end <= ranges[next].start) stack.pop()
      stack.push(ranges[next++])
    }
    while (stack.length > 0 && stack.at(-1).end <= offset) stack.pop()
    const innermost = stack.at(-1)
    const functionIndex = stack.findLastIndex(range => range.functionRange)
    const topLevel = stack[functionIndex]?.topLevel === true
    const inFunctionNeverCalled = functionIndex !== -1 && !topLevel && stack[functionIndex].count === 0
    if (innermost === undefined) return { ran: false, topLevel }
    if (!topLevelRan && inFunctionNeverCalled) return { ran: false, topLevel, inFunctionNeverCalled }
    if (innermost.count > 0) return { ran: true, topLevel }
    if (!topLevelRan) return { ran: false, topLevel }
    // A block of the top level that did not run this time still counts
    if (topLevel) return { ran: true, topLevel }
    // A function Node never called inside one it did: a callback that runs in the browser (`page.evaluate(() => …)`)
    if (stack[functionIndex].count === 0) {
      const enclosing = stack.slice(0, functionIndex).some(range => range.functionRange && !range.topLevel && range.count > 0)
      return { ran: enclosing, topLevel }
    }
    return { ran: false, topLevel }
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = new Map([...BASE64].map((character, index) => [character, index]))

/** Source map `mappings` as [generatedLine, generatedColumn, sourceIndex, originalLine] segments, all zero-based, in order. */
function* decodeMappings(mappings) {
  let sourceIndex = 0, originalLine = 0, originalColumn = 0
  let line = 0
  for (const lineMappings of mappings.split(';')) {
    let column = 0
    for (const segment of lineMappings.split(',')) {
      if (segment === '') continue
      const fields = []
      let value = 0, shift = 0
      for (const character of segment) {
        const digit = BASE64_VALUES.get(character)
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      column += fields[0]
      if (fields.length >= 4) {
        sourceIndex += fields[1]
        originalLine += fields[2]
        originalColumn += fields[3]
        yield [line, column, sourceIndex, originalLine]
      }
    }
    line++
  }
}

function lineStarts(source) {
  const starts = [0]
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1)
  return starts
}

const INLINE_SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/

/**
 * Original lines (one-based) a script ran, by repository path. A script without a source map (CSS, plain JS)
 * counts as run whole when it is not the Node script itself: `'*'`.
 */
export function linesRan(scriptCoverage, source, file, { topLevelRan = false, wholeWithoutMap = true, ranBeforeChecks = new Set() } = {}) {
  const at = coverageSweep(scriptCoverage.functions, topLevelRan)
  const starts = lineStarts(source)
  const sourceMap = INLINE_SOURCE_MAP.exec(source)
  const byFile = new Map()
  if (sourceMap === null) {
    if (wholeWithoutMap) return new Map([[file, '*']])
    // A top-level line where a function starts (a `['labels/webgl2', () => …]` entry, an expectation's `r => [`)
    // belongs to that function: it ran when the function ran in this check, or before the first check.
    const nestedFunctions = scriptCoverage.functions
      .filter(coverage => !(coverage.functionName === '' && coverage.ranges[0]?.startOffset === 0))
      .map(coverage => ({ start: coverage.ranges[0].startOffset, ran: coverage.ranges[0].count > 0 || ranBeforeChecks.has(coverage.ranges[0].startOffset) }))
      .sort((a, b) => a.start - b.start)
    let nextFunction = 0
    const lines = new Set()
    starts.forEach((start, index) => {
      const end = starts[index + 1] ?? source.length
      const startingHere = []
      while (nextFunction < nestedFunctions.length && nestedFunctions[nextFunction].start < end) startingHere.push(nestedFunctions[nextFunction++])
      const firstCharacter = source.slice(start, end).search(/\S/)
      if (firstCharacter === -1) return
      const { ran, topLevel } = at(start + firstCharacter)
      if (startingHere.length > 0 ? startingHere.some(nested => nested.ran) || (ran && !topLevel) : ran) lines.add(index + 1)
    })
    return new Map([[file, lines]])
  }
  const map = JSON.parse(Buffer.from(sourceMap[1], 'base64').toString('utf8'))
  const lineStates = new Map()
  const directory = path.dirname(path.join(ROOT, file))
  const sources = map.sources.map(source => {
    if (source.startsWith('file://')) return repositoryPath(fileURLToPath(source))
    return repositoryPath(path.isAbsolute(source) && existsSync(source) ? source : path.resolve(directory, map.sourceRoot ?? '', source))
  })
  for (const [line, column, sourceIndex, originalLine] of decodeMappings(map.mappings)) {
    const original = sources[sourceIndex]
    if (original === null || original === undefined) continue
    if (!lineStates.has(original)) lineStates.set(original, new Map())
    const states = lineStates.get(original)
    const { ran, topLevel, inFunctionNeverCalled } = at(starts[line] + column)
    // Bit 1: code inside a function ran. Bit 2: top-level code ran. Bit 4: a function that never ran.
    states.set(originalLine + 1, (states.get(originalLine + 1) ?? 0) | (ran ? (topLevel ? 2 : 1) : 0) | (inFunctionNeverCalled ? 4 : 0))
  }
  // `export function shapeText(`: the `export` is top-level code that ran, the function never did. A line where a
  // function that never ran starts counts as run only when code inside a function on it ran.
  for (const [original, states] of lineStates) {
    byFile.set(original, new Set([...states].filter(([, state]) => state & 1 || (state & 2 && !(state & 4))).map(([line]) => line)))
  }
  return byFile
}

/** Merges per-file line sets into `into`; `'*'` (the whole file) wins. */
export function mergeLines(into, byFile) {
  for (const [file, lines] of byFile) {
    const existing = into.get(file)
    if (existing === '*' || lines === '*') into.set(file, '*')
    else if (existing === undefined) into.set(file, new Set(lines))
    else for (const line of lines) existing.add(line)
  }
  return into
}

/** `1-4,7,9-12` from a set of line numbers. */
export function formatRanges(lines) {
  if (lines === '*') return '*'
  const sorted = [...lines].sort((a, b) => a - b)
  const parts = []
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index]
    while (sorted[index + 1] === sorted[index] + 1) index++
    parts.push(start === sorted[index] ? `${start}` : `${start}-${sorted[index]}`)
  }
  return parts.join(',')
}

export function parseRanges(text) {
  if (text === '*') return '*'
  const lines = new Set()
  for (const part of text.split(',')) {
    if (part === '') continue
    const [start, end = start] = part.split('-').map(Number)
    for (let line = start; line <= end; line++) lines.add(line)
  }
  return lines
}

// ── Fingerprints ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Width of one line's fingerprint. A blank or comment line is all dashes, so a change to comments alone runs nothing. */
export const LINE_FINGERPRINT_LENGTH = 8
const QUIET_LINE = '-'.repeat(LINE_FINGERPRINT_LENGTH)

export function contentHash(content) {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}

/** One fixed-width hash per line, whitespace-insensitive, concatenated. */
export function fingerprint(content) {
  let inBlockComment = false
  let result = ''
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    // Only whole-line comments are quiet: `/* note */ code()` is code. Inside a block comment every line starts
    // with `*` (the style here), so a `/*` in a template literal cannot hide the code lines after it.
    let quiet = line === '' || line.startsWith('//')
    if (inBlockComment && (line.startsWith('*') || line.endsWith('*/'))) {
      quiet = true
      inBlockComment = !line.includes('*/')
    } else {
      inBlockComment = false
      if (line.startsWith('/*') && (!line.includes('*/') || line.endsWith('*/'))) {
        quiet = true
        inBlockComment = !line.includes('*/')
      }
    }
    result += quiet ? QUIET_LINE : createHash('sha1').update(line).digest('base64url').slice(0, LINE_FINGERPRINT_LENGTH)
  }
  return result
}

// ── Recording ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Block coverage per check, for every page the check opens (and the workers those pages start) and for Node scripts
 * (run.mjs, assert-results.mjs). `instrument(browser)` hooks page creation, `beginCheck()` and `endCheck()` bracket
 * a check, and `endCheck()` returns its lines by repository path.
 */
export class CoverageRecorder {
  /** @param {{ origin?: string, scripts: string[] }} options origin of the dev server; absolute paths of the Node scripts to track */
  constructor({ origin = null, scripts }) {
    this.origin = origin
    this.scripts = new Map(scripts.map(script => [pathToFileURL(script).href, repositoryPath(script)]))
    this.session = new Session()
    this.pages = new Set()
    this.collected = []
    this.sources = new Map()
    this.messageId = 0
    this.lostWorkers = new Set()
  }

  async start() {
    this.session.connect()
    await this.session.post('Profiler.enable')
    await this.session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    return this
  }

  /**
   * Starts coverage on every page the browser opens, before the page loads anything. `browser.newPage()` goes
   * through `newContext()`, so hooking contexts covers both.
   */
  instrument(browser) {
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (...options) => {
      const context = await newContext(...options)
      const contextNewPage = context.newPage.bind(context)
      context.newPage = async (...pageOptions) => this.attach(await contextNewPage(...pageOptions))
      const close = context.close.bind(context)
      context.close = async (...closeOptions) => {
        for (const entry of [...this.pages]) if (entry.page.context() === context) await this.collect(entry)
        return close(...closeOptions)
      }
      return context
    }
    return browser
  }

  async attach(page) {
    const session = await page.context().newCDPSession(page)
    const entry = { page, session, workers: new Map() }
    const pendingReplies = new Map()
    session.on('Target.receivedMessageFromTarget', ({ message }) => {
      const reply = JSON.parse(message)
      if (reply.id === undefined || !pendingReplies.has(reply.id)) return
      pendingReplies.get(reply.id).resolve(reply)
      pendingReplies.delete(reply.id)
    })
    session.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
      // A worker waits for the debugger, so its coverage starts before its first line
      const send = (method, params = {}) => new Promise(resolve => {
        const id = ++this.messageId
        pendingReplies.set(id, { sessionId, resolve })
        session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => resolve({}))
      })
      try {
        if (targetInfo.type === 'worker') {
          await send('Profiler.enable')
          await send('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
          entry.workers.set(sessionId, { url: targetInfo.url, send })
        }
      } finally {
        await send('Runtime.runIfWaitingForDebugger')
      }
    })
    session.on('Target.detachedFromTarget', ({ sessionId }) => {
      // A worker the page terminated (a StrictMode remount, a replaced style) took its coverage with it
      const worker = entry.workers.get(sessionId)
      if (worker !== undefined) this.lostWorkers.add(worker.url)
      entry.workers.delete(sessionId)
      for (const [id, pending] of pendingReplies) {
        if (pending.sessionId !== sessionId) continue
        pending.resolve({})
        pendingReplies.delete(id)
      }
    })
    await session.send('Profiler.enable')
    await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
    this.pages.add(entry)

    // Take the coverage before it goes: closing, navigating and reloading discard the page's scripts.
    const close = page.close.bind(page)
    page.close = async (...options) => {
      await this.collect(entry)
      return close(...options)
    }
    for (const method of ['goto', 'reload', 'goBack', 'goForward']) {
      const original = page[method].bind(page)
      page[method] = async (...options) => {
        await this.take(entry)
        entry.workers.clear() // they end with the document, after their coverage was taken
        return original(...options)
      }
    }
    return page
  }

  async take(entry) {
    try {
      const { result } = await entry.session.send('Profiler.takePreciseCoverage')
      this.collected.push(...result)
    } catch {}
    for (const { url, send } of entry.workers.values()) {
      const reply = await send('Profiler.takePreciseCoverage')
      if (reply.result !== undefined) this.collected.push(...reply.result.result.map(script => ({ ...script, worker: url })))
    }
  }

  async collect(entry) {
    if (!this.pages.delete(entry)) return
    await this.take(entry)
    entry.workers.clear() // they end with the page, after their coverage was taken
  }

  /** Resets the counts, so the next `endCheck()` holds only what the check ran. */
  async beginCheck() {
    this.collected = []
    this.lostWorkers = new Set()
    this.checkStartedMilliseconds = Date.now()
    const { result } = await this.session.post('Profiler.takePreciseCoverage')
    if (this.ranBeforeChecks !== undefined) return
    // What the Node scripts ran before the first check (their setup) counts for every check
    this.ranBeforeChecks = new Map()
    for (const script of result) {
      if (!this.scripts.has(script.url)) continue
      this.ranBeforeChecks.set(script.url, new Set(script.functions.filter(coverage => coverage.ranges[0].count > 0).map(coverage => coverage.ranges[0].startOffset)))
    }
  }

  /**
   * Lines the check ran, by repository path: a Set of line numbers, or `'*'` for a file without a source map. The
   * map's `incomplete` property names what makes the record unreliable (the check then always runs): a terminated
   * worker no other worker of the same script stood in for, or a file edited while the check ran.
   */
  async endCheck() {
    const { result: node } = await this.session.post('Profiler.takePreciseCoverage')
    for (const entry of [...this.pages]) await this.take(entry)
    const byFile = new Map()
    for (const script of node) {
      const file = this.scripts.get(script.url)
      if (file === undefined) continue
      const ranBeforeChecks = this.ranBeforeChecks?.get(script.url)
      mergeLines(byFile, linesRan(script, readFileSync(path.join(ROOT, file), 'utf8'), file, { topLevelRan: true, wholeWithoutMap: false, ranBeforeChecks }))
    }
    const workersSeen = new Set(this.collected.map(script => script.worker).filter(Boolean))
    const browserFiles = new Set()
    for (const script of this.collected) {
      const file = this.origin === null ? null : scriptPath(script.url, this.origin)
      if (file === null) continue
      browserFiles.add(file)
      const source = await this.source(script.url)
      if (source === null) continue
      // A sibling of a terminated worker ran its scripts too, but maybe not the same lines: count them whole
      const lines = linesRan(script, source, file)
      mergeLines(byFile, this.lostWorkers.has(script.worker) ? new Map([...lines.keys()].map(key => [key, '*'])) : lines)
    }
    const lost = [...this.lostWorkers].find(url => !workersSeen.has(url))
    if (lost !== undefined) byFile.incomplete = `a terminated worker (${lost}) left no coverage`
    const edited = [...byFile.keys()].find(file => {
      const since = browserFiles.has(file) ? this.checkStartedMilliseconds : performance.timeOrigin
      return statSync(path.join(ROOT, file)).mtimeMs > since
    })
    if (edited !== undefined) byFile.incomplete ??= `${edited} was edited during the run`
    this.collected = []
    return byFile
  }

  /** The code Vite served for a URL: the same transform the browser ran. */
  async source(url) {
    if (!this.sources.has(url)) {
      this.sources.set(url, fetch(url).then(response => (response.ok ? response.text() : null)).catch(() => null))
    }
    return this.sources.get(url)
  }
}
