// Fails (exit 1) when the browser checks in test-results/results.json fall outside their expected ranges.
// Run after tests/run.mjs. Thresholds leave margin over the values measured on SwiftShader (docs/spike/SPIKE.md).
import { readFileSync } from 'node:fs'

const results = JSON.parse(readFileSync(new URL('../test-results/results.json', import.meta.url), 'utf8'))

/** check name → assertions on its result, each [description, passes]. */
const expectations = {
  'precision, highPrecision on': r => [
    ['1 cm spans more than 100 px', r.separationPx > 100],
    ['worst centroid error under 2 px', r.maxErrorPx !== null && r.maxErrorPx < 2],
  ],
  // Without 64-bit matrices the cubes collapse or jump; this proves the precision check can fail.
  'precision, highPrecision off': r => [['cubes lost or off by more than 5 px', r.maxErrorPx === null || r.maxErrorPx > 5]],
  'map with fixtures, atmosphere off': r => [
    ['more than 20 tiles loaded', r.tilesLoaded > 20],
    ['imagery drapes on terrain (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'map with fixtures, atmosphere on': r => [
    ['more than 20 tiles loaded', r.tilesLoaded > 20],
    ['sky and haze render (over 50 % blue pixels)', r.blueSkyShare > 0.5],
    ['no black frame (under 5 % black pixels)', r.blackShare < 0.05],
  ],
  // The flat map: the atmosphere fades out, so imagery shows unlit with or without it.
  'map with fixtures, 2d, atmosphere off': r => [
    ['view settled on the map', r.view?.mode === '2d' && r.view?.morph === 1],
    ['imagery drapes on the map (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'map with fixtures, 2d, atmosphere on': r => [
    ['view settled on the map', r.view?.mode === '2d' && r.view?.morph === 1],
    ['imagery drapes on the map (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  // Redrawn in place: the lakes change colour and never disappear while regions redraw.
  'vector map style with fixtures, invalidate': r => [
    ['lakes start blue', r.before.blueShare > 0.002 && r.before.pinkShare < 0.0005],
    ['invalidate reports pending recompositions', r.pendingAfterCall > 0],
    ['lakes end pink', r.after.pinkShare > r.before.blueShare * 0.6 && r.after.blueShare < r.before.blueShare * 0.2],
    ['no frame of missing texture (lakes stay drawn)', r.minimumLakeShareDuringRedraw > r.before.blueShare * 0.6],
    // The bounds cover the lakes, not the whole view: far regions (the horizon, the globe) stay as they are.
    ['only regions reaching into the bounds marked', r.pendingAfterCall < r.regionsHeld],
    ['each marked region redrawn once (a few new tiles may load meanwhile)', r.regionsRedrawn >= r.pendingAfterCall && r.regionsRedrawn <= r.pendingAfterCall + 10],
  ],
}

let failures = 0
for (const [check, assertions] of Object.entries(expectations)) {
  const result = results.find(r => r.check === check)
  if (result === undefined) {
    console.error(`✗ ${check}: missing from results.json`)
    failures++
    continue
  }
  const all = [...assertions(result), ['no console errors', result.errors.length === 0]]
  for (const [description, passes] of all) {
    console.log(`${passes ? '✓' : '✗'} ${check}: ${description}`)
    if (!passes) failures++
  }
  if (result.errors.length > 0) console.error(result.errors.join('\n'))
}

if (failures > 0) {
  console.error(`\n${failures} browser check assertion(s) failed.`)
  process.exit(1)
}
