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
  'camera and events with fixtures': r => {
    const angle = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
    return [
      ['unproject then project lands within 1 px', r.worstProjectErrorPixels < 1],
      ['unproject lands on the terrain queryTerrainElevation reports (within 1 m)', r.worstElevationErrorMeters < 1],
      ['a terrain point round-trips through the screen within 1 m', r.worstRoundTripMeters < 1],
      ['the flat map round-trips within 1 px', r.worstFlatProjectErrorPixels < 1],
      ['getView keeps centre, zoom and heading through the morph', Math.abs(r.flatView.longitudeDegrees - r.topDownView.longitudeDegrees) < 1e-4 && Math.abs(r.flatView.latitudeDegrees - r.topDownView.latitudeDegrees) < 1e-4 && Math.abs(r.flatView.zoom - r.topDownView.zoom) < 0.01 && angle(r.flatView.headingDegrees, r.topDownView.headingDegrees) < 0.1],
      ['the morph fires movestart, moveend, then idle', r.morphEvents.join() === 'movestart,moveend,idle'],
    ]
  },
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
