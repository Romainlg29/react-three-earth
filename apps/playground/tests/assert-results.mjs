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
  'attribution control': r => [
    ['wide window shows the terrain and OpenStreetMap credits', r.wide.text === 'Synthetic test terrain | © OpenStreetMap contributors'],
    ['the OpenStreetMap credit is a safe link', r.wide.links.length === 1 && r.wide.links[0].href === 'https://www.openstreetmap.org/copyright' && r.wide.links[0].target === '_blank' && r.wide.links[0].rel === 'noopener noreferrer'],
    ['it sits in the bottom-right corner', r.wide.bottomRight?.right === 0 && r.wide.bottomRight?.bottom === 0],
    ['earth.getAttributions() lists terrain first, then imagery', JSON.stringify(r.wide.earthAttributions) === JSON.stringify(['Synthetic test terrain', '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'])],
    ['wide window has no toggle button', r.wide.textVisible && !r.wide.buttonVisible],
    ['narrow window is compact: only the button', r.compact.buttonVisible && !r.compact.textVisible],
    ['the button expands the credits', r.expanded.buttonVisible && r.expanded.textVisible && r.expanded.text.includes('OpenStreetMap')],
    ['a style\'s source attribution shows once it loads', r.vector.text === 'Synthetic test terrain | © Fixture map data' && r.vector.links[0]?.href === 'https://example.com/fixture-map'],
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
  'camera animations and pointer events with fixtures': r => {
    const angle = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
    const endsAt = (flight, pitchDegrees) =>
      flight.completed &&
      Math.abs(flight.view.longitudeDegrees - r.target.longitudeDegrees) < 1e-6 &&
      Math.abs(flight.view.latitudeDegrees - r.target.latitudeDegrees) < 1e-6 &&
      Math.abs(flight.view.zoom - r.target.zoom) < 1e-3 &&
      angle(flight.view.headingDegrees, r.target.headingDegrees) < 0.01 &&
      Math.abs(flight.view.pitchDegrees - pitchDegrees) < 0.01
    const click = r.clicks[0]
    return [
      ['flyTo Tokyo → Paris ends at the requested view on the globe', endsAt(r.globe, -50)],
      ['flyTo Tokyo → Paris ends at the requested view on the flat map', endsAt(r.flat, -90)],
      ['the flights zoom out on the way', r.globe.lowestZoom < 6 && r.flat.lowestZoom < 6],
      ['the flights take about their 4 s', Math.abs(r.globe.seconds - 4) < 1 && Math.abs(r.flat.seconds - 4) < 1],
      ['zoom and rotate events fire inside movestart and moveend', ['globe', 'flat'].every(name => r[name].events.join() === 'movestart,zoomstart,rotatestart,zoomend,rotateend,moveend')],
      ['the mouse wheel stops a running flight', r.flightCompleted === false],
      ['fitBounds puts the box inside 40 px of padding', r.fit.completed && r.fit.corners.every(corner => corner.xPixels > 39 && corner.xPixels < 761 && corner.yPixels > 39 && corner.yPixels < 561)],
      ['one click (a drag is not a click)', r.clicks.length === 1],
      ['the click reports its screen position', click?.screen.xPixels === 400 && click?.screen.yPixels === 300],
      ['the click reports the position under it, on the terrain', click?.geographic != null && Math.abs(click.geographic.longitudeDegrees + 89.6) < 1e-4 && Math.abs(click.geographic.latitudeDegrees - 0.3) < 1e-4 && Math.abs(click.geographic.heightMeters - r.elevationAtCenter) < 1 && r.elevationAtCenter > 1000],
      ['pointermove fires with the pointer', r.pointerMoves > 0],
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
