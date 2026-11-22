// Browser checks on real WebGPU (Chromium, SwiftShader adapter). Needs `pnpm dev` running.
// Frame times here measure a CPU rasteriser, not a GPU: correctness only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// The pre-installed Playwright resolves through require (NODE_PATH), not ESM import.
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.PLAYGROUND_URL ?? 'http://localhost:5173'
const OUT = new URL('../test-results/', import.meta.url)
mkdirSync(OUT, { recursive: true })

// WebGPU needs a headed Chromium on SwiftShader's Vulkan here: in headless mode, presenting a WebGPU
// canvas drops the GPU instance. Run under xvfb-run on machines without a display.
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
})
const results = []

async function open(path, viewport = { width: 800, height: 600 }) {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + path)
  return { page, errors }
}

/** Pixel statistics of a PNG, computed in the browser with a 2D canvas. */
async function analyse(page, png, script) {
  return page.evaluate(async ({ data, script }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const { data: px } = context.getImageData(0, 0, image.width, image.height)
    return new Function('px', 'width', 'height', script)(px, image.width, image.height)
  }, { data: png.toString('base64'), script })
}

const CENTROIDS = `
  const sum = { red: [0, 0, 0], blue: [0, 0, 0] }
  for (let i = 0; i < px.length; i += 4) {
    const x = (i / 4) % width, y = Math.floor(i / 4 / width)
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 150 && g < 80 && b < 80) { sum.red[0] += x; sum.red[1] += y; sum.red[2]++ }
    if (b > 150 && r < 80 && g < 80) { sum.blue[0] += x; sum.blue[1] += y; sum.blue[2]++ }
  }
  const c = s => s[2] === 0 ? null : [s[0] / s[2], s[1] / s[2], s[2]]
  return { red: c(sum.red), blue: c(sum.blue) }
`

async function precision(highPrecision) {
  const { page, errors } = await open(`/?test=precision&highPrecision=${highPrecision ? 1 : 0}`)
  await page.waitForFunction(() => (window.precision?.frames ?? 0) > 5, null, { timeout: 60_000 })
  const errorsPx = []
  const steps = []
  for (let step = 0; step < 6; step++) {
    if (step > 0) {
      await page.evaluate(() => window.precision.nudge(0.0005)) // 0.5 mm per step
      const target = await page.evaluate(() => window.precision.frames + 3)
      await page.waitForFunction(t => window.precision.frames >= t, target)
    }
    const png = await page.screenshot()
    if (step === 0) writeFileSync(new URL(`precision-${highPrecision ? 'on' : 'off'}.png`, OUT), png)
    const seen = await analyse(page, png, CENTROIDS)
    const expected = await page.evaluate(() => window.precision.expected())
    const error = c => (seen[c] === null ? Infinity : Math.hypot(seen[c][0] - expected[c][0], seen[c][1] - expected[c][1]))
    errorsPx.push(error('red'), error('blue'))
    steps.push({ seen, expected })
  }
  await page.close()
  const maxErrorPx = Math.max(...errorsPx)
  const separationPx = steps[0].expected.blue[0] - steps[0].expected.red[0]
  results.push({ check: `precision, highPrecision ${highPrecision ? 'on' : 'off'}`, maxErrorPx: Number(maxErrorPx.toFixed(2)), separationPx: Number(separationPx.toFixed(1)), errors })
}

async function map(atmosphere, view = '3d') {
  // SwiftShader rasterises on the CPU, so paced generation would take minutes: generate in one go.
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=${atmosphere ? 1 : 0}&atmosphereBudget=Infinity&view=${view}`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    const atmosphereReady = inspection?.atmosphere === null || inspection?.atmosphere?.ready === true
    const settledView = inspection?.view.morph === (inspection?.view.mode === '2d' ? 1 : 0)
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && atmosphereReady && settledView
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(3000) // overlays compose and tiles fade in
  const png = await page.screenshot()
  const name = `map${view === '2d' ? '-2d' : ''}-atmosphere-${atmosphere ? 'on' : 'off'}`
  writeFileSync(new URL(`${name}.png`, OUT), png)
  const inspection = await page.evaluate(() => window.earth.inspect())
  const stats = await analyse(page, png, `
    let green = 0, black = 0, sky = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (g > r + 20 && g > b + 20) green++
      if (r + g + b < 15) black++
      if (b > r + 15 && b > g) sky++
    }
    const n = px.length / 4
    return { greenShare: +(green / n).toFixed(3), blackShare: +(black / n).toFixed(3), blueSkyShare: +(sky / n).toFixed(3) }
  `)
  await page.close()
  results.push({ check: `map with fixtures, ${view === '3d' ? '' : `${view}, `}atmosphere ${atmosphere ? 'on' : 'off'}`, ...stats, view: inspection.view, tilesLoaded: inspection.terrain.tilesLoaded, tilesVisible: inspection.terrain.tilesVisible, errors })
}

/** A MapLibre style (synthetic vector tiles: water, roads, places) draped through the GPU compositor. */
async function vectorMap(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=vector${query}`)
  const warnings = []
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()) })
  await page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(4000) // remaining compositions and fades
  const png = await page.screenshot()
  writeFileSync(new URL(`map-vector-${name}.png`, OUT), png)
  const inspection = await page.evaluate(() => window.earth.inspect())
  const stats = await analyse(page, png, `
    // By hue, since the terrain is lit: water is blue, primary roads orange, land a warm grey.
    let water = 0, road = 0, land = 0, dark = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (b > r * 1.5 && b > g * 1.1 && b > 60) water++
      else if (r > b * 1.6 && r > g * 1.15 && r > 60) road++
      else if (r >= g && g >= b && r - b < 30 && r > 50) land++
      if (r + g + b < 60) dark++
    }
    const n = px.length / 4
    return { waterShare: +(water / n).toFixed(3), primaryRoadShare: +(road / n).toFixed(4), landShare: +(land / n).toFixed(3), darkShare: +(dark / n).toFixed(4) }
  `)
  await page.close()
  results.push({ check: `vector map style with fixtures, ${name}`, ...stats, tilesLoaded: inspection.terrain.tilesLoaded, imageryTilesCompositedTotal: inspection.terrain.imageryTilesCompositedTotal, errors, warnings })
}

/** The attribution control: its DOM, its links, its compact mode, and a style's own attribution. */
async function attribution() {
  const read = page =>
    page.evaluate(() => {
      const element = document.querySelector('.react-three-earth-attribution')
      const button = element?.querySelector('button')
      const text = element?.querySelector('.react-three-earth-attribution-text')
      const links = [...(element?.querySelectorAll('a') ?? [])].map(a => ({ text: a.textContent, href: a.href, target: a.target, rel: a.rel }))
      const visible = node => node !== null && node !== undefined && node.getBoundingClientRect().width > 0
      const box = element?.getBoundingClientRect()
      return {
        present: element != null,
        text: text?.textContent ?? '',
        links,
        buttonVisible: visible(button),
        textVisible: visible(text),
        earthAttributions: window.earth?.getAttributions() ?? [],
        bottomRight: box ? { right: Math.round(innerWidth - box.right), bottom: Math.round(innerHeight - box.bottom) } : null,
      }
    })
  const waitForControl = (page, needle) => page.waitForFunction(needle => document.querySelector('.react-three-earth-attribution-text')?.textContent.includes(needle), needle, { timeout: 120_000 })

  // Wide window: full text, no button
  const wide = await open('/?fixtures&stats=0&atmosphere=0', { width: 1000, height: 600 })
  await waitForControl(wide.page, 'OpenStreetMap')
  const wideState = await read(wide.page)
  // Narrow window: compact, the button expands it
  await wide.page.setViewportSize({ width: 400, height: 600 })
  await wide.page.waitForFunction(() => document.querySelector('.react-three-earth-attribution-toggle')?.getBoundingClientRect().width > 0, null, { timeout: 30_000 })
  const compactState = await read(wide.page)
  await wide.page.click('.react-three-earth-attribution-toggle')
  const expandedState = await read(wide.page)
  writeFileSync(new URL('attribution-compact-expanded.png', OUT), await wide.page.screenshot())
  await wide.page.close()

  // A style's source attribution arrives once the style has loaded
  const vector = await open('/?fixtures&stats=0&atmosphere=0&map=vector', { width: 1000, height: 600 })
  await waitForControl(vector.page, 'Fixture map')
  const vectorState = await read(vector.page)
  await vector.page.close()

  results.push({
    check: 'attribution control',
    wide: wideState,
    compact: compactState,
    expanded: expandedState,
    vector: vectorState,
    errors: [...wide.errors, ...vector.errors],
  })
}

const LAKE_COLOURS = `
  // Lakes start blue (the style's colour) and turn pink once their tiles change and are redrawn.
  let blue = 0, pink = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (b > r * 1.5 && b > g * 1.1 && b > 60) blue++
    else if (r > g * 1.8 && b > g * 1.2 && r > 80) pink++
  }
  const n = px.length / 4
  return { blueShare: +(blue / n).toFixed(4), pinkShare: +(pink / n).toFixed(4) }
`

/**
 * `MapStyleSource.invalidate`: the fixture server recolours the lakes, the page invalidates their bounds, and
 * the redrawn regions show the new colour. Screenshots taken while regions redraw must never lose the lakes
 * (no frame of missing texture): every region keeps its old texture until the new one is drawn over it.
 */
async function vectorInvalidate() {
  const setWaterColor = value => fetch(`${BASE}/fixtures/vector-live/water-color?value=${encodeURIComponent(value)}`)
  await setWaterColor('')
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&map=vector&test=invalidate')
  const settled = () => page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && t.imageryRecompositionsPending === 0
  }, null, { timeout: 240_000, polling: 200 })
  await settled()
  await page.waitForTimeout(4000) // remaining compositions and fades
  const beforePng = await page.screenshot()
  writeFileSync(new URL('map-vector-invalidate-before.png', OUT), beforePng)
  const before = await analyse(page, beforePng, LAKE_COLOURS)
  const composedBefore = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)

  await setWaterColor('#e0457b')
  // In the same task as the call, so no frame runs between: regions marked, and regions held in total.
  const { pendingAfterCall, regionsHeld } = await page.evaluate(() => {
    window.mapStyleSource.invalidate({ westDegrees: 138.4, southDegrees: 35.3, eastDegrees: 139.1, northDegrees: 35.65 })
    const overlays = [...window.mapStyleSource.overlays] // protected, read for the check only
    return { pendingAfterCall: window.earth.inspect().terrain.imageryRecompositionsPending, regionsHeld: overlays.reduce((sum, overlay) => sum + overlay.regions.size, 0) }
  })
  const during = []
  const startMilliseconds = Date.now()
  while (Date.now() - startMilliseconds < 120_000) {
    const pending = await page.evaluate(() => window.earth.inspect().terrain.imageryRecompositionsPending)
    const shares = await analyse(page, await page.screenshot(), LAKE_COLOURS)
    during.push({ ...shares, pending })
    if (pending === 0) break
  }
  await settled()
  await page.waitForTimeout(1000)
  const afterPng = await page.screenshot()
  writeFileSync(new URL('map-vector-invalidate-after.png', OUT), afterPng)
  const after = await analyse(page, afterPng, LAKE_COLOURS)
  const composedAfter = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
  await page.close()
  await setWaterColor('')
  const lakeShares = during.map(frame => frame.blueShare + frame.pinkShare)
  results.push({
    check: 'vector map style with fixtures, invalidate',
    before,
    after,
    pendingAfterCall,
    regionsHeld,
    framesDuringRedraw: during.length,
    minimumLakeShareDuringRedraw: Math.min(...lakeShares),
    regionsRedrawn: composedAfter - composedBefore,
    errors,
  })
}

/** earth.camera on fixture terrain: unproject / project / queryTerrainElevation, events, and getView through the morph. */
async function cameraAndEvents() {
  // Over the fixture's highest hill (3.9 km), so terrain and ellipsoid differ.
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&camera=-89.6,0.3,3800,40000,-40,-30')
  // The `load` event: the first view is loaded and composed.
  await page.waitForFunction(() => window.earth?.inspect().loaded === true, null, { timeout: 240_000, polling: 500 })
  const globe = await page.evaluate(() => {
    const earth = window.earth
    const camera = earth.camera
    const samples = []
    for (const [xPixels, yPixels] of [[400, 300], [200, 450], [650, 500], [400, 150]]) {
      const position = earth.unproject({ xPixels, yPixels })
      if (position === null) { samples.push({ xPixels, yPixels, position }); continue }
      const back = earth.project(position)
      const elevation = earth.queryTerrainElevation(position)
      // Reverse trip: a point on the terrain, to the screen and back.
      const onTerrain = { ...position, heightMeters: elevation }
      const screen = earth.project(onTerrain)
      const again = earth.unproject(screen)
      const distance = again === null ? Infinity : camera.toScenePosition(onTerrain).distanceTo(camera.toScenePosition(again))
      samples.push({ xPixels, yPixels, position, projectErrorPixels: Math.hypot(back.xPixels - xPixels, back.yPixels - yPixels), elevationErrorMeters: elevation === null ? Infinity : Math.abs(elevation - position.heightMeters), roundTripMeters: distance })
    }
    return { view: camera.getView(), bounds: camera.getBounds(), samples }
  })
  writeFileSync(new URL('camera-3d.png', OUT), await page.screenshot())
  // Look straight down before the morph: the morph anchors on the ellipsoid, so with relief under a
  // pitched camera the screen centre would move by the relief's parallax.
  await page.evaluate(() => window.earth.camera.jumpTo({ pitchDegrees: -90 }))
  await page.waitForFunction(() => window.earth.inspect().idle === true, null, { timeout: 240_000, polling: 500 })
  const topDownView = await page.evaluate(() => window.earth.camera.getView())
  await page.evaluate(() => {
    window.cameraEvents = []
    for (const type of ['movestart', 'moveend', 'idle']) window.earth.addEventListener(type, () => window.cameraEvents.push(type))
    window.setView('2d')
  })
  await page.waitForFunction(() => window.earth.inspect().view.morph === 1 && window.cameraEvents.includes('idle'), null, { timeout: 240_000, polling: 500 })
  const flat = await page.evaluate(() => {
    const earth = window.earth
    const samples = []
    for (const [xPixels, yPixels] of [[400, 300], [100, 500], [700, 100]]) {
      const position = earth.unproject({ xPixels, yPixels })
      const back = position === null ? null : earth.project(position)
      samples.push({ position, projectErrorPixels: back === null ? Infinity : Math.hypot(back.xPixels - xPixels, back.yPixels - yPixels) })
    }
    return { view: earth.camera.getView(), events: window.cameraEvents, samples }
  })
  writeFileSync(new URL('camera-2d.png', OUT), await page.screenshot())
  await page.close()
  const worst = (samples, key) => Math.max(...samples.map(sample => sample[key] ?? Infinity))
  results.push({
    check: 'camera and events with fixtures',
    globeView: globe.view,
    topDownView,
    globeBounds: globe.bounds,
    worstProjectErrorPixels: worst(globe.samples, 'projectErrorPixels'),
    worstElevationErrorMeters: worst(globe.samples, 'elevationErrorMeters'),
    worstRoundTripMeters: worst(globe.samples, 'roundTripMeters'),
    flatView: flat.view,
    worstFlatProjectErrorPixels: worst(flat.samples, 'projectErrorPixels'),
    morphEvents: flat.events,
    errors,
  })
}

/** Markers and popups on the fixture terrain's highest hill: alignment while moving, horizon, terrain, popup, drag. */
async function markers() {
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&markers&camera=-90,0,3900,40000,-40,-30')
  await page.waitForFunction(() => window.earth?.inspect().loaded === true && window.markers?.peak?.visibility === 'visible', null, { timeout: 240_000, polling: 500 })
  // Terrain heights are read a few times a second: let the finest tiles' height arrive.
  await page.waitForTimeout(1500)
  const initial = await page.evaluate(() => {
    const { peak, buried } = window.markers
    return {
      peakHeightMeters: peak.getPosition().heightMeters,
      peakVisibility: peak.visibility,
      buriedVisibility: buried.visibility,
      buriedOpacity: getComputedStyle(buried.element).opacity,
      buriedText: buried.element.textContent,
      peakTagName: peak.element.tagName,
      peakLabel: peak.element.getAttribute('aria-label'),
    }
  })
  writeFileSync(new URL('markers.png', OUT), await page.screenshot())

  // Turn the camera every frame; at the end of each earth.update (after the markers place themselves, in the
  // frame that draws), compare the pin's tip with where earth.project puts its position.
  const moving = await page.evaluate(async () => {
    const earth = window.earth
    const peak = window.markers.peak
    const errorsPixels = []
    const domErrorsPixels = []
    const check = () => {
      if (peak.visibility === 'hidden') return
      const projected = earth.project(peak.getPosition())
      const [x, y] = peak.element.style.transform.match(/-?[\d.]+/g).map(Number)
      errorsPixels.push(Math.hypot(x - projected.xPixels, y - projected.yPixels))
      const box = peak.element.getBoundingClientRect()
      const canvas = document.querySelector('canvas').getBoundingClientRect()
      domErrorsPixels.push(Math.hypot(box.left + box.width / 2 - canvas.left - projected.xPixels, box.bottom - canvas.top - projected.yPixels))
    }
    earth.addEventListener('update', check)
    const start = earth.camera.getView()
    for (let frame = 0; frame < 40; frame++) {
      earth.camera.jumpTo({ headingDegrees: start.headingDegrees + frame * 2, pitchDegrees: -30 - frame * 0.5 })
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    await new Promise(resolve => requestAnimationFrame(resolve))
    earth.removeEventListener('update', check)
    return { frames: errorsPixels.length, maximumTransformErrorPixels: Math.max(...errorsPixels), maximumElementErrorPixels: Math.max(...domErrorsPixels) }
  })

  // From the far side of the globe the peak is behind the horizon.
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: 90, latitudeDegrees: 0, zoom: 1, pitchDegrees: -90, headingDegrees: 0 }))
  await page.waitForFunction(() => window.markers.peak.visibility === 'hidden', null, { timeout: 30_000 })
  const behindHorizon = await page.evaluate(() => ({ visibility: window.markers.peak.visibility, cssVisibility: getComputedStyle(window.markers.peak.element).visibility }))

  // Back over the hill: click the pin, the popup opens beside it; Escape closes it and focus returns.
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: -90, latitudeDegrees: 0, zoom: 10, pitchDegrees: -60, headingDegrees: -40 }))
  await page.waitForFunction(() => window.markers.peak.visibility === 'visible', null, { timeout: 30_000 })
  await page.waitForTimeout(500)
  await page.click('.react-three-earth-marker[aria-label="Fixture peak"]')
  await page.waitForFunction(() => document.querySelector('.react-three-earth-popup')?.dataset.visibility === 'visible', null, { timeout: 10_000 })
  await page.waitForTimeout(300)
  const popup = await page.evaluate(() => {
    const element = document.querySelector('.react-three-earth-popup')
    const box = element.getBoundingClientRect()
    const pin = window.markers.peak.element.getBoundingClientRect()
    return {
      text: element.textContent,
      anchor: element.dataset.anchor,
      focusInside: element.contains(document.activeElement),
      // Above the pin, centred on it.
      gapAbovePinPixels: pin.top - box.bottom,
      centreOffsetPixels: Math.abs(box.left + box.width / 2 - (pin.left + pin.width / 2)),
    }
  })
  writeFileSync(new URL('markers-popup.png', OUT), await page.screenshot())
  await page.keyboard.press('Escape')
  const afterEscape = await page.evaluate(() => ({
    open: document.querySelector('.react-three-earth-popup') !== null,
    focusOnMarker: document.activeElement === window.markers.peak.element,
  }))

  // Drag the orange pin 80 pixels to the right: it moves, the map does not.
  const viewBefore = await page.evaluate(() => window.earth.camera.getView())
  const handle = await page.$('.react-three-earth-marker[aria-label="Draggable marker"]')
  const start = await handle.boundingBox()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) await page.mouse.move(start.x + start.width / 2 + step * 10, start.y + start.height / 2)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const drag = await page.evaluate(before => {
    const after = window.earth.camera.getView()
    const dragged = window.markers.draggable
    return {
      dragEnds: window.dragEnds?.length ?? 0,
      cameraMovedMeters: Math.hypot(after.longitudeDegrees - before.longitudeDegrees, after.latitudeDegrees - before.latitudeDegrees) * 111_000,
      position: dragged.getPosition(),
      endPosition: window.dragEnds?.at(-1) ?? null,
    }
  }, viewBefore)
  const end = await handle.boundingBox()
  await page.close()
  results.push({
    check: 'markers and popups with fixtures',
    ...initial,
    ...moving,
    behindHorizon,
    popup,
    afterEscape,
    drag: { ...drag, movedPixels: end.x - start.x },
    errors,
  })
}

async function afterburner(plume) {
  const { page, errors } = await open(`/?test=afterburner&fixtures&plume=${plume ? 1 : 0}`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    return t && t.tilesLoaded > 10 && t.tilesDownloading === 0 && t.tilesParsing === 0 && inspection?.atmosphere?.skylightOnCpu === true
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(4000) // overlays compose, tiles fade in, the burner lights
  const png = await page.screenshot()
  writeFileSync(new URL(`afterburner-${plume ? 'on' : 'off'}.png`, OUT), png)
  const illuminance = await page.evaluate(() => window.afterburnerDemo.compareIlluminance())
  const lighting = await page.evaluate(() => window.afterburnerDemo.lighting)
  const stats = await analyse(page, png, `
    let sky = 0, black = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (r + g + b < 15) black++
      if (b > r + 15 && b > g) sky++
    }
    const n = px.length / 4
    return { blueSkyShare: +(sky / n).toFixed(3), blackShare: +(black / n).toFixed(3), png: Array.from(px) }
  `)
  await page.close()
  const relative = illuminance.cpu.map((value, index) => Math.abs(value - illuminance.gpu[index]) / Math.max(Math.abs(illuminance.gpu[index]), 1e-9))
  return { stats, result: { check: `afterburner over terrain, plume ${plume ? 'on' : 'off'}`, blueSkyShare: stats.blueSkyShare, blackShare: stats.blackShare, illuminanceCpuVsGpuMaxRelativeError: +Math.max(...relative).toFixed(4), illuminance, lighting, errors } }
}

async function afterburnerChecks() {
  const off = await afterburner(false)
  const on = await afterburner(true)
  // Pixels the plume changed, and how much it brightened them
  let changed = 0, brighter = 0
  for (let i = 0; i < on.stats.png.length; i += 4) {
    const a = on.stats.png[i] + on.stats.png[i + 1] + on.stats.png[i + 2]
    const b = off.stats.png[i] + off.stats.png[i + 1] + off.stats.png[i + 2]
    if (Math.abs(a - b) > 30) changed++
    if (a - b > 90) brighter++
  }
  const n = on.stats.png.length / 4
  on.result.plumeChangedShare = +(changed / n).toFixed(4)
  on.result.plumeBrightenedShare = +(brighter / n).toFixed(4)
  results.push(off.result, on.result)
}

const only = process.argv[2]
try {
  if (!only || only === 'precision') {
    await precision(true)
    await precision(false)
  }
  if (!only || only === 'map') {
    await map(false)
    await map(true)
  }
  if (!only || only === 'map' || only === '2d') {
    await map(false, '2d')
    await map(true, '2d')
  }
  if (!only || only === 'vector') {
    await vectorMap('overview', '')
    await vectorMap('close', '&camera=,,,9000,,-50')
    await vectorMap('webgl2', '&camera=,,,9000,,-50&webgl')
  }
  if (!only || only === 'attribution') await attribution()
  if (!only || only === 'vector' || only === 'invalidate') await vectorInvalidate()
  if (!only || only === 'afterburner') await afterburnerChecks()
  if (!only || only === 'camera') await cameraAndEvents()
  if (!only || only === 'markers') await markers()
} finally {
  await browser.close()
}
writeFileSync(new URL('results.json', OUT), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
