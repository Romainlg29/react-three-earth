// Which browser checks to run. By default, only those a change can reach: a check is skipped when no line it ran
// (in the browser, in its workers, in run.mjs and in its assertions) has changed since it last passed.
//
//   node apps/playground/tests/run.mjs                    the checks a change can reach
//   node apps/playground/tests/run.mjs --list             … printed with the reason, nothing run
//   node apps/playground/tests/run.mjs labels             an area (a group name expands to its members)
//   node apps/playground/tests/run.mjs labels/webgl2      one check; `run.mjs --list --all` prints every id
//   node apps/playground/tests/run.mjs --all              every check
//
// Records: tests/check-coverage.json.gz (committed, refreshed with `assert-results.mjs --save-baseline`) and
// test-results/check-coverage.json (this clone's passing runs, newer). run.mjs writes test-results/pending-coverage.json;
// assert-results.mjs moves the checks that passed into the local record and drops those that failed, so a failed
// check runs again.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { AREAS, GROUPS } from './areas.mjs'
import { ROOT, contentHash, fingerprint, formatRanges, LINE_FINGERPRINT_LENGTH, parseRanges } from './coverage.mjs'

export const BASELINE = path.join(ROOT, 'apps/playground/tests/check-coverage.json.gz')
export const LOCAL = path.join(ROOT, 'apps/playground/test-results/check-coverage.json')
export const PENDING = path.join(ROOT, 'apps/playground/test-results/pending-coverage.json')

/** The area of a check id: `labels/webgl2` → `labels`. */
export const areaOf = id => id.split('/')[0]

// ── Files coverage cannot see ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Files that shape what the browser runs without being run there: the fixture tile server and the test helpers it
 * imports, the Vite config, the TypeScript settings its transform reads, the pages, static files, the lockfile.
 * Each check records their hashes; a change runs the areas named here, every area when the list is null.
 */
const ENVIRONMENT = [
  [/^apps\/playground\/public\/georef\//, ['georef']],
  [/^apps\/playground\/(fixtures|public)\//, null],
  [/^apps\/playground\/(index\.html|examples\.html|vite\.config\.ts|package\.json)$/, null],
  [/^packages\/[^/]+\/test\/helpers\//, null],
  [/^((apps|packages)\/[^/]+\/)?tsconfig[^/]*\.json$/, null],
  [/^pnpm-lock\.yaml$/, null],
]
const ENVIRONMENT_PATHS = ['apps/playground', 'packages', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.base.json']

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })

/** Environment files tracked or new (not ignored), with their content hashes. */
export function environmentHashes() {
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '--', ...ENVIRONMENT_PATHS).split('\n')
  const hashes = {}
  for (const file of files) {
    if (file === '' || !ENVIRONMENT.some(([pattern]) => pattern.test(file))) continue
    const absolute = path.join(ROOT, file)
    if (existsSync(absolute)) hashes[file] = contentHash(readFileSync(absolute))
  }
  return hashes
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function emptyRecord() {
  return { version: 1, checks: {}, fingerprints: {} }
}

export function readRecord(file) {
  if (!existsSync(file)) return emptyRecord()
  const bytes = readFileSync(file)
  const record = JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))
  return record.version === 1 ? record : emptyRecord()
}

/** One check and one fingerprint per line, unused fingerprints dropped; gzipped when the name ends in `.gz`. */
export function writeRecord(file, record) {
  const used = new Set(Object.values(record.checks).flatMap(check => Object.values(check.files ?? {}).map(text => text.slice(0, text.indexOf(':')))))
  const checks = Object.keys(record.checks).sort().map(id => `${JSON.stringify(id)}:${JSON.stringify(record.checks[id])}`)
  const fingerprints = Object.keys(record.fingerprints).filter(hash => used.has(hash)).sort().map(hash => `${JSON.stringify(hash)}:${JSON.stringify(record.fingerprints[hash])}`)
  mkdirSync(path.dirname(file), { recursive: true })
  const text = `{"version":1,\n"checks":{\n${checks.join(',\n')}\n},\n"fingerprints":{\n${fingerprints.join(',\n')}\n}}\n`
  writeFileSync(file, file.endsWith('.gz') ? gzipSync(text, { level: 9 }) : text)
}

/**
 * The committed baseline with this clone's newer records over it. A check that failed here has a `failed` record,
 * so the baseline cannot skip it; `{ passingOnly: true }` leaves those out (for a new baseline).
 */
export function readRecords({ passingOnly = false } = {}) {
  const baseline = readRecord(BASELINE)
  const local = readRecord(LOCAL)
  const checks = { ...baseline.checks, ...local.checks }
  if (passingOnly) for (const id of Object.keys(checks)) if (checks[id].failed || checks[id].alwaysRun) delete checks[id]
  return { version: 1, checks, fingerprints: { ...baseline.fingerprints, ...local.fingerprints } }
}

/**
 * A check's record from the lines it ran: `files` maps a repository path to `<content hash>:<line ranges>`, and the
 * fingerprint of each version goes to `fingerprints`.
 */
export function checkRecord(results, linesByFile, environment, fingerprints) {
  const files = {}
  for (const [file, lines] of [...linesByFile].sort(([a], [b]) => a.localeCompare(b))) {
    const content = readFileSync(path.join(ROOT, file), 'utf8')
    const hash = contentHash(content)
    fingerprints[hash] ??= fingerprint(content)
    files[file] = `${hash}:${formatRanges(lines)}`
  }
  const record = { results, files, environment }
  if (linesByFile.incomplete !== undefined) record.alwaysRun = linesByFile.incomplete
  return record
}

// ── What changed ───────────────────────────────────────────────────────────────────────────────────────────────────

const splitFingerprint = text => text.match(new RegExp(`.{${LINE_FINGERPRINT_LENGTH}}`, 'g')) ?? []
const QUIET = /^-+$/

/**
 * Old-side lines a check must have run for a change to reach it, from a line diff of the recorded fingerprint
 * against the file now (git's diff, on one hash per line). Each hunk adds its removed lines and the nearest code
 * line above and below it, so an insertion counts when the code around it ran. Hunks of comments and blank lines
 * alone add nothing.
 */
function linesReached(recordedFingerprint, currentFingerprint, scratch) {
  const before = path.join(scratch, 'before')
  const after = path.join(scratch, 'after')
  const oldLines = splitFingerprint(recordedFingerprint)
  writeFileSync(before, oldLines.join('\n') + '\n')
  writeFileSync(after, splitFingerprint(currentFingerprint).join('\n') + '\n')
  let diff = ''
  try {
    diff = git('diff', '--no-index', '--no-color', '-U0', before, after)
  } catch (error) {
    diff = error.stdout ?? '' // exit status 1: the files differ
  }
  const reached = new Set()
  const hunks = diff.split('\n@@').slice(1)
  for (const hunk of hunks) {
    const [header, ...body] = hunk.split('\n')
    const [, start, count = '1'] = /^ -(\d+)(?:,(\d+))?/.exec(header)
    if (body.every(line => line === '' || QUIET.test(line.slice(1)))) continue
    const first = Number(start) + (Number(count) === 0 ? 1 : 0) // a pure insertion sits after line `start`
    const last = first + Number(count) - 1
    for (let line = first; line <= last; line++) reached.add(line)
    let above = first - 1
    while (above >= 1 && QUIET.test(oldLines[above - 1])) above--
    let below = last + 1
    while (below <= oldLines.length && QUIET.test(oldLines[below - 1])) below++
    reached.add(above).add(below)
  }
  return reached
}

/**
 * Why each check must run, or nothing when it can be skipped: never recorded, an environment file changed, a file
 * it ran is gone, or a changed line is one it ran.
 */
export function reasonsToRun(ids, records = readRecords()) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'browser-checks-'))
  const currentHashes = new Map()
  const currentFingerprints = new Map()
  const reachedCache = new Map()
  const environmentNow = environmentHashes()
  const current = file => {
    if (!currentHashes.has(file)) {
      const absolute = path.join(ROOT, file)
      const content = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
      currentHashes.set(file, content === null ? null : contentHash(content))
      if (content !== null) currentFingerprints.set(file, fingerprint(content))
    }
    return currentHashes.get(file)
  }
  const reasons = new Map()
  try {
    for (const id of ids) {
      const record = records.checks[id]
      if (record === undefined) {
        reasons.set(id, 'never passed here (no coverage record)')
        continue
      }
      if (record.failed) {
        reasons.set(id, 'failed last time')
        continue
      }
      if (record.alwaysRun !== undefined) {
        reasons.set(id, `its coverage is incomplete: ${record.alwaysRun}`)
        continue
      }
      const environmentChange = Object.keys({ ...record.environment, ...environmentNow }).find(file => {
        if (record.environment[file] === environmentNow[file]) return false
        const areas = ENVIRONMENT.find(([pattern]) => pattern.test(file))?.[1]
        return areas === null || areas === undefined || areas.includes(areaOf(id))
      })
      if (environmentChange !== undefined) {
        reasons.set(id, `${environmentChange} changed`)
        continue
      }
      for (const [file, text] of Object.entries(record.files)) {
        const separator = text.indexOf(':')
        const hash = text.slice(0, separator)
        const now = current(file)
        if (now === hash) continue
        if (now === null) {
          reasons.set(id, `${file} is gone`)
          break
        }
        const ran = parseRanges(text.slice(separator + 1))
        if (ran === '*') {
          reasons.set(id, `${file} changed`)
          break
        }
        const recorded = records.fingerprints[hash]
        if (recorded === undefined) {
          reasons.set(id, `${file} changed (no fingerprint recorded)`)
          break
        }
        const key = `${hash} ${file}`
        if (!reachedCache.has(key)) reachedCache.set(key, linesReached(recorded, currentFingerprints.get(file), scratch))
        const line = [...reachedCache.get(key)].sort((a, b) => a - b).find(line => ran.has(line))
        if (line !== undefined) {
          reasons.set(id, `${file} changed around line ${line}, which it ran`)
          break
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return reasons
}

// ── Command line ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Checks to run from command-line arguments: named areas, groups or check ids run whatever changed; `--all` runs
 * every check; otherwise only the checks a change reaches. Returns the ids with a reason each.
 */
export function selectChecks(argv, ids) {
  const names = argv.filter(argument => !argument.startsWith('-'))
  if (argv.includes('--all')) {
    if (names.length > 0) throw new Error('Pass either --all or check names, not both')
    return new Map(ids.map(id => [id, 'every check (--all)']))
  }
  if (names.length > 0) {
    const unknown = names.filter(name => !AREAS.includes(name) && !ids.includes(name))
    if (unknown.length > 0) throw new Error(`Unknown browser check ${unknown.join(', ')}: use an area (${AREAS.join(', ')}) or a check id (\`run.mjs --list --all\` prints them)`)
    const areas = new Set(names.flatMap(name => GROUPS[name] ?? [name]))
    return new Map(ids.filter(id => names.includes(id) || areas.has(areaOf(id))).map(id => [id, 'named']))
  }
  return reasonsToRun(ids)
}
