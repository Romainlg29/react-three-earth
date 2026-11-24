// Browser checks on real WebGPU (Chromium, SwiftShader adapter). Needs `pnpm dev` running.
// Frame times here measure a CPU rasteriser, not a GPU: correctness only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { AREAS, selectAreas } from './areas.mjs'

// The pre-installed Playwright resolves through require (NODE_PATH), not ESM import.
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.PLAYGROUND_URL ?? 'http://localhost:5173'
const OUT = new URL('../test-results/', import.meta.url)
mkdirSync(OUT, { recursive: true })
// A run that crashes leaves no results, so assert-results.mjs fails instead of reading an earlier run's.
rmSync(new URL('results.json', OUT), { force: true })
rmSync(new URL('selection.json', OUT), { force: true })

// Areas: all by default, named ones (`labels buildings`), or those the branch's changes reach (`--changed`). See areas.mjs.
const selected = new Set(selectAreas(process.argv.slice(2)))
const want = area => selected.has(area)
console.error(selected.size === AREAS.length ? 'Browser checks: every area' : `Browser checks: ${[...selected].join(', ') || 'none, no change reaches the playground'}`)
/** Writes the results and the areas they cover: assert-results.mjs tells the checks a partial run skipped from missing ones. */
function writeResults(results) {
  writeFileSync(new URL('selection.json', OUT), JSON.stringify({ areas: [...selected], every: selected.size === AREAS.length }, null, 2))
  writeFileSync(new URL('results.json', OUT), JSON.stringify(results, null, 2))
}
if (selected.size === 0) {
  writeResults([])
  process.exit(0)
}

// WebGPU needs a headed Chromium on SwiftShader's Vulkan here: in headless mode, presenting a WebGPU
// canvas drops the GPU instance. Run under xvfb-run on machines without a display.
// `BROWSER_CHECKS_GPU=1` runs on the machine's own GPU instead (much faster; proves the same correctness).
const useGpu = process.env.BROWSER_CHECKS_GPU === '1'
const browser = await chromium.launch({
  headless: false,
  args: useGpu
    ? ['--enable-unsafe-webgpu', '--force_high_performance_gpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
    : ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
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

/** The map controls: zoom, compass, view, scale, geolocate and fullscreen, on a desktop and on a phone-sized touch screen. */
async function controls() {
  const openIn = async (contextOptions, size) => {
    const context = await browser.newContext({ viewport: size, ...contextOptions })
    const page = await context.newPage()
    const errors = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push(String(e)))
    await page.goto(BASE + '/?fixtures&stats=0&atmosphere=0')
    await page.waitForFunction(() => window.earth?.camera.ready === true && document.querySelector('.map-control-button'), null, { timeout: 120_000 })
    return { page, context, errors }
  }
  const buttonSelector = label => `button[aria-label="${label}"]`
  const view = page => page.evaluate(() => ({ ...window.earth.camera.getView(), mode: window.earth.view.mode }))
  // Idle includes loading: terrain tiles arriving under the centre change the zoom, which is measured from the ground
  const settle = page => page.waitForFunction(() => !window.earth.camera.animating && !window.earth.view.transitioning && window.earth.idle, null, { timeout: 120_000 })

  // Desktop, with a position to find
  const desktop = await openIn({ permissions: ['geolocation'], geolocation: { longitude: -90, latitude: 0.02, accuracy: 60 } }, { width: 1000, height: 640 })
  const { page } = desktop
  const result = {}
  result.labels = await page.evaluate(() => [...document.querySelectorAll('.map-corner button')].map(b => b.getAttribute('aria-label')))
  result.corner = await page.evaluate(() => {
    const box = document.querySelector('.map-corner-top-right').getBoundingClientRect()
    return { right: Math.round(innerWidth - box.right), top: Math.round(box.top) }
  })

  await settle(page)
  const startZoom = (await view(page)).zoom
  await page.click(buttonSelector('Zoom in'))
  await settle(page)
  result.zoomInDelta = (await view(page)).zoom - startZoom
  await page.click(buttonSelector('Zoom out'))
  await page.click(buttonSelector('Zoom out'))
  await settle(page)
  result.zoomOutDelta = (await view(page)).zoom - startZoom

  await page.evaluate(() => window.earth.camera.jumpTo({ headingDegrees: 45, pitchDegrees: -50 }))
  await page.waitForFunction(() => document.querySelector('.map-compass-needle')?.style.transform.includes('rotateZ(-45'), null, { timeout: 10_000 })
  result.compassTurned = await page.evaluate(() => document.querySelector('.map-compass-needle').style.transform)
  await page.click(buttonSelector('Reset bearing to north and look straight down'))
  await settle(page)
  const reset = await view(page)
  result.resetHeading = reset.headingDegrees
  result.resetPitch = reset.pitchDegrees

  result.scaleText = await page.evaluate(() => document.querySelector('.map-scale')?.textContent ?? null)
  result.scaleWidth = await page.evaluate(() => document.querySelector('.map-scale')?.getBoundingClientRect().width ?? 0)
  const scaleBefore = result.scaleText
  await page.click(buttonSelector('Zoom in'))
  await page.click(buttonSelector('Zoom in'))
  await settle(page)
  await page.waitForFunction(before => document.querySelector('.map-scale')?.textContent !== before, scaleBefore, { timeout: 10_000 })
  result.scaleAfterZoom = await page.evaluate(() => document.querySelector('.map-scale').textContent)

  await page.click(buttonSelector('Switch to the flat map'))
  await settle(page)
  result.flat = { mode: (await view(page)).mode, text: await page.textContent(buttonSelector('Switch to the globe')) }
  await page.click(buttonSelector('Switch to the globe'))
  await settle(page)
  result.globe = { mode: (await view(page)).mode, text: await page.textContent(buttonSelector('Switch to the flat map')) }

  // A press on a control is not a click on the map
  await page.evaluate(() => { window.mapClicks = 0; window.earth.addEventListener('click', () => window.mapClicks++) })
  await page.click(buttonSelector('Zoom out'))
  result.mapClicksFromControls = await page.evaluate(() => window.mapClicks)

  // Geolocate: follows the user, dot on the map, a second press stops
  await page.click(buttonSelector('Show my location'))
  await page.waitForFunction(() => document.querySelector('.map-user-dot') !== null, null, { timeout: 20_000 })
  await settle(page)
  const found = await view(page)
  result.geolocate = {
    longitude: found.longitudeDegrees,
    latitude: found.latitudeDegrees,
    pressed: await page.getAttribute('.map-control-button[aria-label="Stop following my location"]', 'aria-pressed'),
    circle: await page.evaluate(() => document.querySelector('.map-accuracy-circle') !== null),
  }
  await page.click(buttonSelector('Stop following my location'))
  result.geolocate.dotAfterStop = await page.evaluate(() => document.querySelector('.map-user-dot') !== null)
  writeFileSync(new URL('controls-desktop.png', OUT), await page.screenshot())

  // Fullscreen (a user gesture is needed, a click is one)
  await page.click(buttonSelector('Enter fullscreen'))
  await page.waitForFunction(() => document.fullscreenElement !== null || (() => { const target = document.querySelector('canvas')?.parentElement; return target?.style.position === 'fixed' })(), null, { timeout: 10_000 })
  result.fullscreen = await page.evaluate(() => ({ native: document.fullscreenElement !== null, pseudo: (() => { const target = document.querySelector('canvas')?.parentElement; return target?.style.position === 'fixed' })(), pressed: document.querySelector('button[aria-label="Exit fullscreen"]')?.getAttribute('aria-pressed') }))
  await page.click(buttonSelector('Exit fullscreen'))
  await page.waitForFunction(() => document.fullscreenElement === null && !(() => { const target = document.querySelector('canvas')?.parentElement; return target?.style.position === 'fixed' })(), null, { timeout: 10_000 })
  result.fullscreenExited = true
  await desktop.context.close()

  // A phone: touch, 390 × 700. Buttons are 44 pixels and a tap works
  const phone = await openIn({ isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, { width: 390, height: 700 })
  result.phone = await phone.page.evaluate(() => {
    const sizes = [...document.querySelectorAll('.map-corner button')].map(b => Math.round(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)))
    const inside = [...document.querySelectorAll('.map-corner')].every(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })
    return { sizes, inside }
  })
  await settle(phone.page)
  const phoneStart = (await view(phone.page)).zoom
  await phone.page.tap(buttonSelector('Zoom in'))
  await settle(phone.page)
  result.phone.zoomInDelta = (await view(phone.page)).zoom - phoneStart
  writeFileSync(new URL('controls-phone.png', OUT), await phone.page.screenshot())
  await phone.context.close()

  results.push({ check: 'map controls', ...result, errors: [...desktop.errors, ...phone.errors] })
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

/**
 * The runtime style API on fixture tiles: a paint change recolours the lakes, hiding the layer removes them, and
 * feature-state highlights one lake through an added layer, by redrawing regions without processing tiles again.
 */
async function vectorStyleRuntime() {
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&map=vector')
  const settled = () => page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && t.imageryRecompositionsPending === 0
  }, null, { timeout: 240_000, polling: 100 })
  const shot = async name => {
    await settled()
    await page.waitForTimeout(1500) // tile fades
    const png = await page.screenshot()
    writeFileSync(new URL(`map-vector-style-${name}.png`, OUT), png)
    return analyse(page, png, LAKE_COLOURS)
  }
  // Waits for the change to reach the regions: pending recompositions appear, then settle
  const change = async script => {
    const composedBefore = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
    const startMilliseconds = await page.evaluate(script)
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending > 0, null, { timeout: 30_000, polling: 'raf' }).catch(() => {})
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending === 0, null, { timeout: 120_000, polling: 'raf' })
    const settledMilliseconds = await page.evaluate(start => performance.now() - start, startMilliseconds)
    const composedAfter = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
    return { settledMilliseconds, regionsRedrawn: composedAfter - composedBefore }
  }
  await settled()
  const before = await shot('before')
  const recolour = await change(() => {
    window.mapStyleSource.setPaintProperty('water', 'fill-color', '#e0457b')
    return performance.now()
  })
  const recoloured = await shot('recoloured')
  await change(() => {
    window.mapStyleSource.setLayerVisibility('water', false)
    return performance.now()
  })
  const hidden = await shot('hidden')
  await change(() => {
    const source = window.mapStyleSource
    source.setLayerVisibility('water', true)
    source.setPaintProperty('water', 'fill-color', '#5fa8e8')
    source.addLayer({ id: 'water-hover', type: 'fill', source: 'fixture', 'source-layer': 'water', paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#e0457b', 'rgba(0, 0, 0, 0)'] } }, 'road-casing')
    return performance.now()
  })
  const restored = await shot('restored')
  // Hover: Lake Kawaguchi (id 1) only
  // Counts tiles sent for processing from here (the backend is protected, wrapped for the check only)
  await page.evaluate(() => {
    window.tilesProcessed = 0
    for (const overlay of window.mapStyleSource.overlays) {
      const backend = overlay.backend
      const processTile = backend.processTile.bind(backend)
      backend.processTile = (...args) => {
        window.tilesProcessed++
        return processTile(...args)
      }
    }
  })
  const hover = await change(() => {
    window.mapStyleSource.setFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }, { hover: true })
    return performance.now()
  })
  const hovered = await shot('hover')
  const featureState = await page.evaluate(() => window.mapStyleSource.getFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }))
  const tilesProcessedDuringHover = await page.evaluate(() => window.tilesProcessed)
  await page.close()
  results.push({
    check: 'vector map style with fixtures, runtime style',
    before,
    recoloured,
    hidden,
    restored,
    hovered,
    recolour,
    hover,
    featureState,
    tilesProcessedDuringHover,
    errors,
  })
}

/**
 * Feature querying and layer events on fixture tiles (`?hover`): `queryRenderedFeatures` at the screen position of
 * a lake and of a road returns them, a real mouse click reaches a layer `click` listener with the lake, hovering
 * the lake sets its feature-state (it turns pink) and the pointer cursor, leaving clears both, and a whole-screen
 * query and `querySourceFeatures` list the lakes.
 */
async function featureQueries() {
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&map=vector&hover')
  const settled = () => page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && t.imageryRecompositionsPending === 0
  }, null, { timeout: 240_000, polling: 200 })
  await settled()
  await page.waitForTimeout(3000) // tile fades
  const lakeShare = async name => {
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending === 0, null, { timeout: 120_000, polling: 'raf' })
    await page.waitForTimeout(500)
    const png = await page.screenshot()
    writeFileSync(new URL(`map-vector-query-${name}.png`, OUT), png)
    return analyse(page, png, LAKE_COLOURS)
  }
  const before = await lakeShare('before')
  // Screen positions of a point of Lake Kawaguchi (id 1) and of East Road 6, on the terrain
  const screenOf = (longitudeDegrees, latitudeDegrees) => page.evaluate(([longitudeDegrees, latitudeDegrees]) => {
    const heightMeters = window.earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees }) ?? 0
    return window.earth.project({ longitudeDegrees, latitudeDegrees, heightMeters })
  }, [longitudeDegrees, latitudeDegrees])
  const lake = await screenOf(138.76, 35.515)
  const road = await screenOf(138.6, 35.3575)
  const lakeQuery = await page.evaluate(async screen => (await window.earth.queryRenderedFeatures(screen)).map(feature => ({ layer: feature.layer.id, id: feature.id ?? null, name: feature.properties.name ?? null, geometry: feature.geometry.type })), lake)
  const roadQuery = await page.evaluate(async screen => (await window.earth.queryRenderedFeatures(screen, { tolerancePixels: 3 })).map(feature => ({ layer: feature.layer.id, name: feature.properties.name ?? null })), road)

  await page.mouse.click(lake.xPixels, lake.yPixels)
  await page.waitForFunction(() => (window.layerClicks?.length ?? 0) > 0, null, { timeout: 30_000 }).catch(() => {})
  const clicked = await page.evaluate(() => (window.layerClicks ?? []).map(features => features.map(feature => ({ layer: feature.layer.id, id: feature.id ?? null }))))

  // The click left the pointer on the lake: it is hovered
  await page.waitForFunction(() => window.mapStyleSource.getFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }).hover === true, null, { timeout: 30_000 }).catch(() => {})
  await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending > 0, null, { timeout: 10_000, polling: 'raf' }).catch(() => {})
  const hovered = await lakeShare('hover')
  const hover = await page.evaluate(() => ({
    state: window.mapStyleSource.getFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }),
    cursor: window.earth.pointerEventsElement?.style.cursor ?? null,
    entered: (window.hoveredFeatures ?? []).map(feature => feature.id),
  }))
  // Leave the lake for a spot with no lake and no road
  await page.mouse.move(5, 5)
  await page.waitForFunction(() => window.mapStyleSource.getFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }).hover === false, null, { timeout: 30_000 }).catch(() => {})
  await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending > 0, null, { timeout: 10_000, polling: 'raf' }).catch(() => {})
  const left = await lakeShare('left')
  const leave = await page.evaluate(() => ({
    state: window.mapStyleSource.getFeatureState({ source: 'fixture', sourceLayer: 'water', id: 1 }),
    cursor: window.earth.pointerEventsElement?.style.cursor ?? null,
    entered: (window.hoveredFeatures ?? []).map(feature => feature.id),
  }))
  const screenLakes = await page.evaluate(async () => [...new Set((await window.earth.queryRenderedFeatures(undefined, { layers: ['water'] })).map(feature => feature.id))].sort())
  const sourceLakes = await page.evaluate(async () => [...new Set((await window.mapStyleSource.querySourceFeatures('fixture', { sourceLayer: 'water' })).map(feature => feature.id))].sort())
  // Timing of a point query on the CPU rasteriser's machine (worker round trip and hit test), for the record
  const queryMilliseconds = await page.evaluate(async screen => {
    const start = performance.now()
    for (let index = 0; index < 20; index++) await window.earth.queryRenderedFeatures(screen)
    return +((performance.now() - start) / 20).toFixed(2)
  }, lake)
  await page.close()
  results.push({
    check: 'vector map style with fixtures, feature queries and layer events',
    lake: { screen: lake, features: lakeQuery },
    road: { screen: road, features: roadQuery },
    clicked,
    before,
    hovered,
    left,
    hover,
    leave,
    screenLakes,
    sourceLakes,
    queryMilliseconds,
    errors,
  })
}

const PATTERN_COLOURS = `
  // By hue, since the terrain is lit: the sprite's green checks (background), dark and light blue stripes
  // (lakes), red dashes (primary roads), and the runtime image's magenta, then yellow, hatch (Lake Motosu).
  let green = 0, darkBlue = 0, lightBlue = 0, red = 0, magenta = 0, yellow = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (g > r * 1.2 && g > b * 1.3 && g > 40) green++
    else if (b > r * 2.5 && b > g * 1.6 && b > 60) darkBlue++
    else if (b > r * 1.25 && g > r * 1.1 && b >= g && b > 90) lightBlue++
    else if (r > g * 2.5 && r > b * 2.5 && r > 60) red++
    else if (r > g * 1.8 && b > g * 1.8 && r > 50 && b > 50) magenta++
    else if (r > b * 2 && g > b * 2 && r > 70 && g > 70) yellow++
  }
  const n = px.length / 4
  const share = count => +(count / n).toFixed(4)
  return { meadowShare: share(green), darkBlueShare: share(darkBlue), lightBlueShare: share(lightBlue), redShare: share(red), magentaShare: share(magenta), yellowShare: share(yellow) }
`

/**
 * Sprite patterns: `background-pattern`, `fill-pattern` and `line-pattern` from the fixture sprite, then an
 * image the sprite lacks (reported through `onStyleImageMissing`) added with `addImage` and replaced with
 * `updateImage`, each redrawing the lake that uses it.
 */
async function vectorPatterns(name, query) {
  // Above Lake Motosu and Lake Kawaguchi, looking down.
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=patterns&camera=138.68,35.47,0,40000,0,-80${query}`)
  const settled = () => page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && t.imageryRecompositionsPending === 0
  }, null, { timeout: 240_000, polling: 300 })
  await settled()
  await page.waitForTimeout(4000) // remaining compositions and fades
  const beforePng = await page.screenshot()
  writeFileSync(new URL(`map-vector-patterns-${name}.png`, OUT), beforePng)
  const sprite = await analyse(page, beforePng, PATTERN_COLOURS)
  const missing = await page.evaluate(() => window.styleImagesMissing ?? [])
  const hatch = rgb => `{ width: 8, height: 8, data: new Uint8Array(Array.from({ length: 64 }, (_, i) => ((i % 8) + Math.floor(i / 8)) % 4 < 2 ? [${rgb}, 255] : [20, 20, 20, 255]).flat()) }`
  await page.evaluate(`window.mapStyleSource.addImage('hatch', ${hatch('230, 40, 220')})`)
  await page.waitForTimeout(500)
  await settled()
  await page.waitForTimeout(1500)
  const addedPng = await page.screenshot()
  writeFileSync(new URL(`map-vector-patterns-${name}-added.png`, OUT), addedPng)
  const added = await analyse(page, addedPng, PATTERN_COLOURS)
  const composedBefore = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
  await page.evaluate(`window.mapStyleSource.updateImage('hatch', ${hatch('240, 220, 30')})`)
  await page.waitForTimeout(500)
  await settled()
  await page.waitForTimeout(1500)
  const updatedPng = await page.screenshot()
  writeFileSync(new URL(`map-vector-patterns-${name}-updated.png`, OUT), updatedPng)
  const updated = await analyse(page, updatedPng, PATTERN_COLOURS)
  const composedAfter = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
  const inspection = await page.evaluate(() => window.earth.inspect())
  await page.close()
  results.push({ check: `vector map style with fixtures, patterns, ${name}`, sprite, missing, added, updated, regionsRedrawnByUpdate: composedAfter - composedBefore, tilesLoaded: inspection.terrain.tilesLoaded, errors })
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
      peakRole: peak.element.getAttribute('role'),
      peakTabIndex: peak.element.tabIndex,
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
    const xs = []
    const ys = []
    const check = () => {
      if (peak.visibility === 'hidden') return
      const projected = earth.project(peak.getPosition())
      const [x, y] = peak.element.style.transform.match(/-?[\d.]+/g).map(Number)
      errorsPixels.push(Math.hypot(x - projected.xPixels, y - projected.yPixels))
      xs.push(x)
      ys.push(y)
      const box = peak.element.getBoundingClientRect()
      const canvas = document.querySelector('canvas').getBoundingClientRect()
      domErrorsPixels.push(Math.hypot(box.left + box.width / 2 - canvas.left - projected.xPixels, box.bottom - canvas.top - projected.yPixels))
    }
    earth.addEventListener('update', check)
    const start = earth.camera.getView()
    // Around a point beside the peak, so the pin travels across the screen.
    for (let frame = 0; frame < 40; frame++) {
      earth.camera.jumpTo({ longitudeDegrees: -89.98 + frame * 0.0012, latitudeDegrees: 0.02, headingDegrees: start.headingDegrees + frame * 2, pitchDegrees: -30 - frame * 0.5 })
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    await new Promise(resolve => requestAnimationFrame(resolve))
    earth.removeEventListener('update', check)
    return { frames: errorsPixels.length, travelPixels: Math.hypot(xs.at(-1) - xs[0], ys.at(-1) - ys[0]), maximumTransformErrorPixels: Math.max(...errorsPixels), maximumElementErrorPixels: Math.max(...domErrorsPixels) }
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

  // Controlled popups, one selected at a time: clicking the other marker moves the selection, not clears it.
  const openPopups = () => page.evaluate(() => [...document.querySelectorAll('.react-three-earth-popup')].map(element => element.textContent.replace('×', '').trim()))
  await page.click('.react-three-earth-marker[aria-label="Place east"]')
  await page.waitForFunction(() => window.selectedPlace === 'east' && document.querySelectorAll('.react-three-earth-popup').length === 1, null, { timeout: 10_000 })
  const afterFirst = { selected: await page.evaluate(() => window.selectedPlace), open: await openPopups() }
  await page.click('.react-three-earth-marker[aria-label="Place west"]')
  await page.waitForTimeout(300)
  const afterSecond = { selected: await page.evaluate(() => window.selectedPlace), open: await openPopups() }
  await page.click('.react-three-earth-marker[aria-label="Place west"]')
  await page.waitForTimeout(300)
  const afterThird = { selected: await page.evaluate(() => window.selectedPlace), open: await openPopups() }
  const selection = { afterFirst, afterSecond, afterThird }

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

  // Under StrictMode (every effect twice): one root per marker, content and pins in place, no React errors.
  const strict = await open('/?fixtures&stats=0&atmosphere=0&markers&strict&camera=-90,0,3900,40000,-40,-30')
  await strict.page.waitForFunction(() => window.earth?.inspect().loaded === true && window.markers?.peak?.visibility === 'visible', null, { timeout: 240_000, polling: 500 })
  await strict.page.waitForTimeout(500)
  await strict.page.click('.react-three-earth-marker[aria-label="Fixture peak"]')
  await strict.page.waitForFunction(() => document.querySelector('.react-three-earth-popup')?.dataset.visibility === 'visible', null, { timeout: 10_000 })
  const strictMode = await strict.page.evaluate(() => ({
    markerElements: document.querySelectorAll('.react-three-earth-marker').length,
    pinsShown: [...document.querySelectorAll('.react-three-earth-marker-fallback-pin')].filter(pin => getComputedStyle(pin).display !== 'none').length,
    buriedText: window.markers.buried.element.textContent,
    popupText: document.querySelector('.react-three-earth-popup')?.textContent ?? '',
  }))
  await strict.page.close()
  results.push({
    check: 'markers and popups with fixtures',
    ...initial,
    ...moving,
    behindHorizon,
    popup,
    afterEscape,
    drag: { ...drag, movedPixels: end.x - start.x },
    strictMode: { ...strictMode, errors: strict.errors },
    selection,
    errors,
  })
}

/**
 * Camera animations and pointer events on fixture terrain: flyTo Tokyo → Paris in 3D and in 2D ends at the
 * requested view, user input stops a flight, fitBounds fits, and a click reports the position under it.
 */
async function cameraAnimations() {
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0')
  await page.waitForFunction(() => window.earth?.inspect().loaded === true, null, { timeout: 240_000, polling: 500 })
  const PARIS = { longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 11, headingDegrees: 20 }
  const fly = pitchDegrees => page.evaluate(async ({ target }) => {
    const earth = window.earth
    earth.camera.jumpTo({ longitudeDegrees: 139.69, latitudeDegrees: 35.69, zoom: 10, headingDegrees: 0, pitchDegrees: -90 })
    const events = []
    const listeners = ['movestart', 'zoomstart', 'zoomend', 'rotatestart', 'rotateend', 'moveend'].map(type => {
      const listener = () => events.push(type)
      earth.addEventListener(type, listener)
      return [type, listener]
    })
    let lowestZoom = Infinity
    const sample = () => (lowestZoom = Math.min(lowestZoom, earth.camera.getView().zoom))
    earth.addEventListener('move', sample)
    const startMilliseconds = performance.now()
    const completed = await earth.camera.flyTo(target, { durationSeconds: 4, essential: true })
    const seconds = (performance.now() - startMilliseconds) / 1000
    const endView = earth.camera.getView()
    // The frame after the last one, so moveend has fired. Frames can be 400 ms apart on SwiftShader: wait for it
    // (up to 3 s) rather than a fixed delay.
    if (!events.includes('moveend')) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); earth.removeEventListener('moveend', done); resolve() }
        const timer = setTimeout(done, 3000)
        earth.addEventListener('moveend', done)
      })
    }
    earth.removeEventListener('move', sample)
    for (const [type, listener] of listeners) earth.removeEventListener(type, listener)
    return { completed, seconds, lowestZoom, view: endView, settledView: earth.camera.getView(), events }
  }, { target: { ...PARIS, pitchDegrees } })
  const globe = await fly(-50)
  writeFileSync(new URL('fly-to-paris-3d.png', OUT), await page.screenshot())

  // User input stops a flight where it is.
  const interrupted = await page.evaluate(() => {
    window.flight = window.earth.camera.flyTo({ longitudeDegrees: -89.6, latitudeDegrees: 0.3, zoom: 9 }, { durationSeconds: 20, essential: true })
    return true
  })
  await page.waitForTimeout(1500)
  await page.mouse.move(400, 300)
  await page.mouse.wheel(0, -200)
  const flightCompleted = await page.evaluate(() => Promise.race([window.flight, new Promise(resolve => setTimeout(() => resolve('still running'), 3000))]))

  // fitBounds: the box's corners land inside the padding.
  const fit = await page.evaluate(async () => {
    const earth = window.earth
    const bounds = { westDegrees: -91, southDegrees: -0.5, eastDegrees: -88.5, northDegrees: 1.2 }
    const completed = await earth.camera.fitBounds(bounds, { paddingPixels: 40, pitchDegrees: -90, durationSeconds: 1, essential: true })
    const corners = [[-91, -0.5], [-88.5, -0.5], [-88.5, 1.2], [-91, 1.2]].map(([longitudeDegrees, latitudeDegrees]) => earth.project({ longitudeDegrees, latitudeDegrees }))
    return { completed, corners }
  })

  // A click at the centre after jumping over the fixture's hill reports the hill under it.
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: -89.6, latitudeDegrees: 0.3, zoom: 12, headingDegrees: 0, pitchDegrees: -60 }))
  const stateLog = []
  const logState = setInterval(async () => {
    stateLog.push(await page.evaluate(() => {
      const i = window.earth.inspect()
      return JSON.stringify({ idle: i.idle, animating: window.earth.camera.animating, terrain: i.terrain, zoom: i.camera?.zoom, x: window.camera.position.x })
    }).catch(e => String(e)))
  }, 15_000)
  try {
    await page.waitForFunction(() => window.earth.inspect().idle === true, null, { timeout: 240_000, polling: 500 })
  } catch (error) {
    console.error(stateLog.join('\n'))
    throw error
  } finally {
    clearInterval(logState)
  }
  // Again, now that the terrain under the centre is loaded at full detail.
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: -89.6, latitudeDegrees: 0.3 }))
  await page.waitForFunction(() => window.earth.inspect().idle === true, null, { timeout: 240_000, polling: 500 })
  await page.evaluate(() => {
    window.pointerEvents = []
    for (const type of ['click', 'pointermove']) {
      window.earth.addEventListener(type, event => window.pointerEvents.push({ type, screen: event.screen, geographic: event.geographic }))
    }
  })
  await page.mouse.move(400, 300)
  await page.mouse.click(400, 300)
  // A drag is not a click.
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(260, 230, { steps: 5 })
  await page.mouse.up()
  const pointer = await page.evaluate(() => ({
    events: window.pointerEvents,
    elevation: window.earth.queryTerrainElevation({ longitudeDegrees: -89.6, latitudeDegrees: 0.3 }),
  }))
  writeFileSync(new URL('click-on-terrain.png', OUT), await page.screenshot())

  // The same flight on the flat map.
  await page.evaluate(() => window.setView('2d'))
  // Settled, so the flight's first frame is a fresh movestart.
  await page.waitForFunction(() => window.earth.inspect().view.morph === 1 && window.earth.inspect().idle === true, null, { timeout: 240_000, polling: 500 })
  const flat = await fly(-90)
  writeFileSync(new URL('fly-to-paris-2d.png', OUT), await page.screenshot())
  await page.close()

  const clicks = pointer.events.filter(event => event.type === 'click')
  results.push({
    check: 'camera animations and pointer events with fixtures',
    globe,
    flat,
    target: PARIS,
    interrupted,
    flightCompleted,
    fit,
    clicks,
    pointerMoves: pointer.events.filter(event => event.type === 'pointermove').length,
    elevationAtCenter: pointer.elevation,
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


/** Orange pixels of the `?sdf` shape, and the colour at given screen points. */
const SDF_PIXELS = `
  let orange = 0, below = 0, black = 0
  const { belowY, points } = window.__sdfProbe
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.floor(i / 4 / width)
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 150 && g > 40 && g < 150 && b < 110 && r > g + 60) { orange++; if (y > belowY) below++ }
    if (r + g + b < 15) black++
  }
  const sample = ([x, y]) => { const i = (Math.round(y) * width + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]] }
  const n = px.length / 4
  return { orangeShare: +(orange / n).toFixed(4), orangeBelowGround: below, blackShare: +(black / n).toFixed(3), samples: points.map(sample) }
`

/**
 * The example plugin (`src/sdf/`, `?sdf`): a raymarched shape on the fixture peak, its lower half buried. Checks
 * it renders, the terrain hides the buried part (depth is written), the atmosphere hazes it with distance, it
 * stays on its spot and is not black on the flat map, and WebGL2 matches.
 */
async function sdfShapes(name, query, { distanceMeters = 6000, pitchDegrees = -15, view = '3d' } = {}) {
  const { page, errors } = await open(`/?fixtures&stats=0&sdf&atmosphereBudget=Infinity&date=2026-11-22T21:00:00Z&camera=-90,0,3900,${distanceMeters},-40,${pitchDegrees}${query}`)
  await page.waitForFunction(() => window.earth?.inspect().loaded === true && (window.earth.inspect().atmosphere?.ready ?? true), null, { timeout: 240_000, polling: 500 })
  if (view === '2d') {
    await page.evaluate(() => window.setView('2d'))
    await page.waitForFunction(() => window.earth.inspect().view.morph === 1 && window.earth.inspect().idle, null, { timeout: 120_000, polling: 500 })
  }
  await page.waitForTimeout(2500)
  const probe = await page.evaluate(() => {
    const earth = window.earth
    const at = heightMeters => earth.project({ longitudeDegrees: -90, latitudeDegrees: 0, heightMeters })
    const centre = at(4050) // on the sphere, above the ground
    const base = at(3000) // the capsule's buried end
    window.__sdfProbe = { belowY: (at(3900).yPixels + base.yPixels) / 2 + 3, points: [[centre.xPixels, centre.yPixels], [400, 20]] }
    return { centre, base, plugins: earth.inspect().plugins }
  })
  const png = await page.screenshot()
  writeFileSync(new URL(`sdf-shapes-${name}.png`, OUT), png)
  const stats = await analyse(page, png, SDF_PIXELS)
  await page.close()
  results.push({ check: `sdf shapes plugin, ${name}`, ...stats, centreVisible: probe.centre.visible, plugin: probe.plugins['sdf-shapes'], errors })
}

/** Magenta glow pixels, and the two stripe blues of the `?glow` example layers, with samples at given points. */
const STYLE_LAYER_PIXELS = `
  let magenta = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 110 && b > 80 && r > g + 60 && b > g + 40) magenta++
  }
  const sample = ([x, y]) => { const i = (Math.round(y) * width + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]] }
  // Striped lakes: both stripe blues are present (a plain lake is neither), and they alternate along rows.
  const { points } = window.__styleLayerProbe
  let dark = 0, light = 0, changes = 0
  for (let y = 0; y < height; y += 4) {
    let previous = null
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      // The map is dimmed by its terrain lighting: light stripes about (65, 97, 127), dark ones (0, 40, 98).
      const kind = b > 110 && g > 80 && r > 40 && b > r + 40 ? 'light' : b > 80 && r < 30 && g < 60 ? 'dark' : null
      if (kind === 'light') light++
      if (kind === 'dark') dark++
      if (kind !== null && previous !== null && kind !== previous) changes++
      previous = kind
    }
  }
  const n = px.length / 4
  return { magentaShare: +(magenta / n).toFixed(4), samples: points.map(sample), stripeDarkShare: +((dark * 4) / n).toFixed(4), stripeLightShare: +((light * 4) / n).toFixed(4), stripeChanges: changes }
`

/**
 * The style layer type examples (`src/styleLayers/`, `?glow`): a glow around primary roads only (worker module,
 * offscreen maximum blending) and striped lakes (built-in fill, own shader). `late` installs the plugins after
 * the style loaded, then removes them: the layers appear and disappear without fetching tiles again.
 */
async function styleLayerTypes(name, query, { late = false } = {}) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=vector&glow${late ? '=late' : ''}&camera=138.75,35.45,0,15000,0,-90${query}`)
  const tileRequests = []
  page.context().on('request', request => { if (request.url().includes('/fixtures/vector/')) tileRequests.push(request.url()) })
  const settle = async () => {
    await page.waitForFunction(() => window.earth?.inspect().loaded === true && window.earth.inspect().terrain.imageryRecompositionsPending === 0, null, { timeout: 240_000, polling: 500 })
    await page.waitForTimeout(2500)
  }
  // After a plugin change: the worker answers, then every region redraws in place.
  const settleRedraw = async () => {
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending > 0, null, { timeout: 60_000, polling: 50 })
    await settle()
  }
  await settle()
  const probe = await page.evaluate(() => {
    const project = (longitudeDegrees, latitudeDegrees) => window.earth.project({ longitudeDegrees, latitudeDegrees })
    // North Road 7 (primary) and North Road 8 (minor) at 35.45°: 12 px east of each.
    const primary = project(138.77 - 0.02 * (0.1 / 0.35), 35.45)
    const minor = project(138.82 - 0.02 * (0.1 / 0.35), 35.45)
    window.__styleLayerProbe = { points: [[primary.xPixels + 12, primary.yPixels], [minor.xPixels + 12, minor.yPixels]] }
    return { primary, minor }
  })
  const measure = async label => {
    const png = await page.screenshot()
    writeFileSync(new URL(`style-layer-types-${name}${label}.png`, OUT), png)
    return analyse(page, png, STYLE_LAYER_PIXELS)
  }
  const result = { check: `style layer types, ${name}`, probe, errors }
  if (late) {
    result.before = await measure('-before')
    const requestsBefore = tileRequests.length
    await page.evaluate(() => { for (const plugin of window.styleLayerTypePlugins) window.earth.addPlugin(plugin) })
    await settleRedraw()
    result.added = await measure('-added')
    await page.evaluate(() => { for (const plugin of window.styleLayerTypePlugins) window.earth.removePlugin(plugin) })
    await settleRedraw()
    result.removed = await measure('-removed')
    result.tileRequestsAfterLoad = tileRequests.length - requestsBefore
  } else {
    Object.assign(result, await measure(''))
    result.layerTypes = await page.evaluate(() => [...window.earth.styleLayerTypes.values()].map(definition => definition.type))
  }
  await page.close()
  results.push(result)
}

/** Brightness of the corners against a point above the centre that the vignette leaves alone, and magenta glow pixels. */
const EFFECT_PIXELS = `
  const brightness = (x0, y0, size) => {
    let sum = 0
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) { const i = (y * width + x) * 4; sum += px[i] + px[i + 1] + px[i + 2] }
    return sum / (size * size * 3)
  }
  const corners = (brightness(0, 0, 40) + brightness(width - 40, 0, 40) + brightness(0, height - 80, 40) + brightness(width - 40, height - 80, 40)) / 4
  const reference = brightness(width / 2 + 40, 130, 40)
  let magenta = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 110 && b > 80 && r > g + 60 && b > g + 40) magenta++
  }
  const sample = ([x, y]) => { const i = (Math.round(y) * width + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]] }
  return { corners: +corners.toFixed(2), reference: +reference.toFixed(2), cornerRatio: +(corners / Math.max(reference, 1)).toFixed(3), magentaShare: +(magenta / (px.length / 4)).toFixed(4), samples: window.__effectProbe.points.map(sample) }
`

/**
 * The render pass and draped layer examples (`src/effects/`, `?effects=late`): a vignette in the display stage
 * and a highlight lift in the radiance stage, and a selection glow draped above the imagery. The plugins are
 * installed at runtime, the selection moves, then they are removed: the output rebuilds and the glow redraws
 * only around the old and new place.
 */
async function renderPassesAndDrapedLayers(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&effects=late&atmosphereBudget=Infinity&date=2026-11-22T18:00:00Z&camera=-90,0,0,20000,0,-90${query}`)
  const settle = async () => {
    await page.waitForFunction(() => window.earth?.inspect().loaded === true && (window.earth.inspect().atmosphere?.ready ?? true) && window.earth.inspect().terrain.imageryRecompositionsPending === 0 && window.earth.inspect().terrain.imageryCompositionsPending === 0, null, { timeout: 240_000, polling: 250 })
    await page.waitForTimeout(2500)
  }
  const first = { longitudeDegrees: -90, latitudeDegrees: 0 }
  const second = { longitudeDegrees: -89.95, latitudeDegrees: 0.01 }
  const measure = async label => {
    await page.evaluate(([first, second]) => {
      const at = position => { const projected = window.earth.project({ ...position, heightMeters: window.earth.queryTerrainElevation(position) ?? 0 }); return [projected.xPixels, projected.yPixels] }
      window.__effectProbe = { points: [at(first), at(second)] }
    }, [first, second])
    const png = await page.screenshot()
    writeFileSync(new URL(`effects-${name.replaceAll(' ', '-')}-${label}.png`, OUT), png)
    const stats = await analyse(page, png, EFFECT_PIXELS)
    const inspection = await page.evaluate(() => { const i = window.earth.inspect(); return { renderPasses: i.renderPasses, drapedLayers: i.drapedLayers } })
    return { ...stats, ...inspection }
  }
  await settle()
  const result = { check: `render passes and draped layers, ${name}`, errors }
  result.plain = await measure('plain')
  await page.evaluate(() => { window.earth.addPlugin(window.effectPlugins.vignette); window.earth.addPlugin(window.effectPlugins.selectionGlow) })
  await settle()
  result.installed = await measure('installed')
  // Selecting redraws only the regions around the place: count them as they are marked.
  result.pendingAfterSelect = await page.evaluate(first => {
    window.effectPlugins.selectionGlow.select(first)
    return new Promise(resolve => requestAnimationFrame(() => resolve(window.earth.inspect().terrain.imageryRecompositionsPending)))
  }, first)
  await settle()
  result.selected = await measure('selected')
  await page.evaluate(second => window.effectPlugins.selectionGlow.select(second), second)
  await settle()
  result.moved = await measure('moved')
  await page.evaluate(() => { window.earth.removePlugin(window.effectPlugins.selectionGlow); window.earth.removePlugin(window.effectPlugins.vignette) })
  await settle()
  result.removed = await measure('removed')
  await page.close()
  results.push(result)
}

/**
 * Screen-space labels (`?map=labels`: a dense grid of towns): no two placed labels overlap, no text repeats at one
 * place, labels near the centre keep their size whatever the pitch, and the draped mode draws none on the screen.
 * `map` 'vector' is the plain fixture style, where road names show.
 */
async function screenSymbols(name, query, map = 'labels') {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphereBudget=Infinity&map=${map}${query}`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    const atmosphereReady = inspection?.atmosphere === null || inspection?.atmosphere?.ready === true
    const settledView = inspection?.view.morph === (inspection?.view.mode === '2d' ? 1 : 0)
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && atmosphereReady && settledView
  }, null, { timeout: 240_000, polling: 500 })
  // Labels settle: tiles loaded, heights read, no fade running.
  let previous = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(1000)
    const state = await page.evaluate(() => {
      const s = window.earth.inspect().terrain.symbols ?? { labelsShown: 0, elevationsPending: 0, tilesRequested: 0, tilesDrawn: 0 }
      return JSON.stringify([s.labelsShown, s.elevationsPending, s.tilesRequested, s.tilesDrawn, window.earth.terrain.getScreenLabels().filter(l => l.opacity < 1).length])
    })
    if (state === previous && JSON.parse(state)[1] === 0 && JSON.parse(state)[4] === 0) break
    previous = state
  }
  const png = await page.screenshot()
  writeFileSync(new URL(`map-labels-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, OUT), png)
  const result = await page.evaluate(() => {
    const symbols = window.earth.inspect().terrain.symbols
    const labels = window.earth.terrain.getScreenLabels()
    const width = window.innerWidth
    const height = window.innerHeight
    const colliding = labels.filter(l => !l.ignorePlacement && !l.allowOverlap)
    // Road names collide glyph by glyph; a pixel of slack: boxes that touch are not an overlap.
    const meets = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1
    let overlaps = 0
    for (let i = 0; i < colliding.length; i++) {
      for (let j = i + 1; j < colliding.length; j++) {
        const [a, b] = [colliding[i].collisionBoxes ?? [colliding[i].box], colliding[j].collisionBoxes ?? [colliding[j].box]]
        if (a.some(boxA => b.some(boxB => meets(boxA, boxB)))) overlaps++
      }
    }
    // Road names read left to right: no glyph turned past a quarter turn from the horizontal, beyond the slack
    // that keeps a name on a vertical road from turning back and forth (a tenth of its length, about 6°).
    const roads = labels.filter(l => l.glyphAnglesRadians !== null)
    const upsideDown = roads.filter(l => l.glyphAnglesRadians.some(angle => Math.cos(angle) < -0.2)).length
    let duplicates = 0
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        if (labels[i].text === labels[j].text && Math.hypot(labels[i].xPixels - labels[j].xPixels, labels[i].yPixels - labels[j].yPixels) < 24) duplicates++
      }
    }
    // Box height (text size plus padding) of the towns nearest the centre of the screen.
    const central = labels
      .filter(l => l.text.startsWith('Town') && Math.hypot(l.xPixels - width / 2, l.yPixels - height / 2) < 150)
      .map(l => l.box[3] - l.box[1])
      .sort((a, b) => a - b)
    return {
      labelsShown: labels.length,
      towns: labels.filter(l => l.text.startsWith('Town')).length,
      // Variable anchors: a town whose box is no longer centred on its point.
      townsBesideTheirPoint: labels.filter(l => l.text.startsWith('Town') && Math.abs((l.box[0] + l.box[2]) / 2 - l.xPixels) + Math.abs((l.box[1] + l.box[3]) / 2 - l.yPixels) > 4).length,
      roadNames: roads.length,
      // Places: an icon's box and its text's (collisionBoxes of 2), the icon at the point.
      iconLabels: labels.filter(l => l.glyphAnglesRadians === null && l.collisionBoxes?.length === 2).length,
      roadNamesUpsideDown: upsideDown,
      overlaps,
      duplicates,
      centralBoxHeightPixels: central.length > 0 ? +central[Math.floor(central.length / 2)].toFixed(1) : null,
      onScreen: labels.every(l => l.box[2] > 0 && l.box[0] < width && l.box[3] > 0 && l.box[1] < height),
      inspection: symbols,
    }
  })
  // A feature query at a label shown on the screen answers its town (labels facing the viewer hit by their box).
  result.queryAtLabel = await page.evaluate(async () => {
    const label = window.earth.terrain.getScreenLabels().find(l => l.text.startsWith('Town'))
    if (label === undefined) return null
    const features = await window.earth.queryRenderedFeatures({ xPixels: label.xPixels, yPixels: label.yPixels }, { layers: ['town-label'] })
    return { text: label.text, names: features.map(feature => feature.properties.name) }
  })
  // Dark text with a white halo: pixels of the text colour (#4a3b22) on the lit ground.
  const stats = await analyse(page, png, `
    let text = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (r < 110 && r > g && g > b && r - b > 15 && r - b < 60) text++
    }
    // The pin's red and the summit's blue SDF disc.
    let red = 0, blue = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (r > 150 && g < 80 && b < 80) red++
      if (b > 150 && r < 80 && g < 120) blue++
    }
    return { textShare: +(text / (px.length / 4)).toFixed(4), redPixels: red, bluePixels: blue }
  `)
  await page.close()
  results.push({ check: `screen-space labels, ${name}`, ...result, ...stats, errors })
}

/** Neon green text and magenta outline pixels of the symbol effect example, and the standard town text colour. */
const NEON_PIXELS = `
  let green = 0, magenta = 0, standard = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    // Thin strokes blend with the ground: green dominates rather than being pure.
    if (g > 200 && g > r + 50 && g > b + 90) green++
    if (r > 180 && b > 140 && g < 110) magenta++
    if (r < 110 && r > g && g > b && r - b > 15 && r - b < 60) standard++
  }
  const share = count => +(count / (px.length / 4)).toFixed(4)
  return { greenShare: share(green), magentaShare: share(magenta), standardShare: share(standard) }
`

/**
 * The symbol effect example (`src/symbolEffects/`, `?map=labels&neon=late`): the town labels name the `neon` effect in
 * their metadata. Before its plugin is installed they draw the standard look (one warning names the missing effect);
 * installed at runtime, they turn neon with no tile processed again; removed, they are standard again.
 */
async function symbolEffects(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=labels&neon=late&camera=138.74,35.36,0,40000,0,-30${query}`)
  const warnings = []
  page.on('console', message => { if (message.type() === 'warning' && message.text().includes('symbol effect')) warnings.push(message.text()) })
  const settle = async () => {
    await page.waitForFunction(() => {
      const t = window.earth?.inspect().terrain
      return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && (t.symbols?.labelsShown ?? 0) > 0 && t.symbols.elevationsPending === 0
    }, null, { timeout: 240_000, polling: 500 })
    await page.waitForTimeout(1500)
  }
  const measure = async label => {
    const png = await page.screenshot()
    writeFileSync(new URL(`symbol-effects-${name.replaceAll(' ', '-')}-${label}.png`, OUT), png)
    const stats = await analyse(page, png, NEON_PIXELS)
    const labels = await page.evaluate(() => window.earth.terrain.getScreenLabels().filter(l => l.text.startsWith('Town')).length)
    return { ...stats, towns: labels }
  }
  await settle()
  const result = { check: `symbol effects, ${name}`, errors }
  result.before = await measure('before')
  // Tiles processed from here: installing the effect must not process any again.
  await page.evaluate(() => {
    window.__processed = 0
    for (const overlay of window.mapStyleSource.overlays) {
      const backend = overlay.backend // protected, wrapped for the check only
      const processTile = backend.processTile.bind(backend)
      backend.processTile = (...args) => { window.__processed++; return processTile(...args) }
    }
    window.earth.addPlugin(window.neonLabelsPlugin)
  })
  await settle()
  result.installed = await measure('installed')
  result.tilesProcessedOnInstall = await page.evaluate(() => window.__processed)
  await page.evaluate(() => window.earth.removePlugin(window.neonLabelsPlugin))
  await settle()
  result.removed = await measure('removed')
  result.warnings = warnings
  await page.close()
  results.push(result)
}

/**
 * Place names in other scripts (`?map=scripts`): every name shows, reported in reading order, with text pixels
 * inside its box. Shaping and order are unit-tested (test/scripts.test.ts); the screenshot shows them drawn.
 */
async function scriptLabels(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphereBudget=Infinity&map=scripts${query}`)
  await page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0
  }, null, { timeout: 240_000, polling: 500 })
  let previous = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(1000)
    const state = await page.evaluate(() => {
      const s = window.earth.inspect().terrain.symbols ?? { labelsShown: 0, elevationsPending: 0 }
      return JSON.stringify([s.labelsShown, s.elevationsPending, window.earth.terrain.getScreenLabels().filter(l => l.opacity < 1).length])
    })
    if (state === previous && JSON.parse(state)[1] === 0 && JSON.parse(state)[2] === 0) break
    previous = state
  }
  const png = await page.screenshot()
  writeFileSync(new URL(`map-scripts-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, OUT), png)
  const labels = await page.evaluate(() =>
    window.earth.terrain.getScreenLabels()
      .filter(l => /[^\x00-\x7f]/.test(l.text))
      .map(l => ({ text: l.text, box: l.box.map(Math.round), heightOverWidth: +((l.box[3] - l.box[1]) / (l.box[2] - l.box[0])).toFixed(2) })),
  )
  // Text-colour pixels inside each label's box.
  const inBoxes = await analyse(page, png, `
    const boxes = ${JSON.stringify(labels.map(l => l.box))}
    return boxes.map(([left, top, right, bottom]) => {
      let count = 0
      for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
        for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
          const i = (y * width + x) * 4
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
          if (r < 110 && r > g && g > b && r - b > 15 && r - b < 60) count++
        }
      }
      return count
    })
  `)
  await page.close()
  results.push({
    check: `script labels, ${name}`,
    labels: labels.map((l, index) => ({ ...l, textPixels: inBoxes[index] })),
    errors,
  })
}

const BUILDING_PIXELS = `
  // Red buildings (roofs bright, walls darker), the blue glass tower blended over the ground, and the courtyard's
  // middle (the screen centre in the top-down view).
  let red = 0, blue = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 40 && r - g > 40 && r - b > 40) red++
    if (b - r > 20 && b - g > 10) blue++
  }
  const at = (x, y) => { const i = (Math.round(y) * width + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]] }
  return { redShare: +(red / (px.length / 4)).toFixed(4), blueShare: +(blue / (px.length / 4)).toFixed(4), center: at(width / 2, height / 2) }
`

/**
 * 3D buildings (`?map=buildings`): the fixture block on the 3900 m peak plateau, across the corner of four tiles.
 * Checks that they stand on the terrain (each building's elevation read from it), and counts red and blue pixels.
 */
async function buildings(name, query, { settle = true } = {}) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphereBudget=Infinity&map=buildings${query}`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    const atmosphereReady = inspection?.atmosphere === null || inspection?.atmosphere?.ready === true
    const settledView = inspection?.view.morph === (inspection?.view.mode === '2d' ? 1 : 0)
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && atmosphereReady && settledView && inspection.idle
  }, null, { timeout: 240_000, polling: 500 })
  if (settle) await page.waitForTimeout(1500)
  const png = await page.screenshot()
  writeFileSync(new URL(`map-buildings-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, OUT), png)
  const result = await page.evaluate(() => {
    const inspection = window.earth.inspect().terrain.extrusions
    // Protected state, read for the check only: the elevation each drawn building stands at.
    const overlay = [...window.mapStyleSource.overlays][0]
    const tiles = overlay.extrusions === null ? [] : [...overlay.extrusions.tiles.values()].filter(tile => tile.drawn && tile.attributes !== null)
    const elevations = tiles.flatMap(tile => {
      const array = tile.attributes.elevation.array
      return Array.from(tile.extrusions.buildingVertexStarts.slice(0, -1), start => array[start])
    })
    const ground = window.earth.terrain.sampleElevation(-Math.PI / 2, 0)
    return {
      inspection,
      tileZooms: [...new Set(tiles.map(tile => tile.request.zoom))].sort(),
      lowestElevation: elevations.length === 0 ? null : Math.min(...elevations),
      highestElevation: elevations.length === 0 ? null : Math.max(...elevations),
      groundAtCenter: ground,
    }
  })
  const stats = await analyse(page, png, BUILDING_PIXELS)
  await page.close()
  results.push({ check: `3d buildings, ${name}`, ...result, ...stats, errors })
}

const GEOJSON_PIXELS = `
  // The ?geojson example, by hue (the terrain is lit dimly): a magenta area, a red-to-cyan route, green clusters.
  let magenta = 0, magentaX = 0, green = 0, red = 0, cyan = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (r > 50 && b > 50 && g < r * 0.45 && g < b * 0.45) { magenta++; magentaX += (i / 4) % width }
    else if (g > 50 && g > r * 2 && g > b * 2) green++
    else if (r > 50 && g < r * 0.3 && b < r * 0.3) red++
    else if (g > 50 && b > 60 && r < g * 0.3) cyan++
  }
  const n = px.length / 4
  return { magentaShare: +(magenta / n).toFixed(4), magentaCentreX: magenta === 0 ? null : +(magentaX / magenta / width).toFixed(3), greenShare: +(green / n).toFixed(4), redShare: +(red / n).toFixed(4), cyanShare: +(cyan / n).toFixed(4) }
`

/**
 * GeoJSON sources (`?geojson`): an area, a route with a line gradient and clustered points draw over the fixture
 * style; a new `data` prop moves the area; seen from close to the clusters, moving the area again redraws only the
 * regions near its old and new place; `updateData` moves one station; a cluster query reaches the worker.
 */
async function geoJsonSources(name, query) {
  let { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=vector&geojson&camera=138.75,35.4,0,60000,0,-80${query}`)
  // `idle`, not zero download, parse and composition counts: between two refinement steps, tiles still sit in the download
  // queue or wait for their children to be prepared with nothing downloading or parsing, and the slower WebGL2
  // path often stopped there, on coarse tiles and their coarse imagery.
  const settled = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 10 && inspection.idle
  }, null, { timeout: 240_000, polling: 200 })
  const shot = async label => {
    await settled()
    await page.waitForTimeout(2000) // tile fades
    const png = await page.screenshot()
    writeFileSync(new URL(`geojson-${name}-${label}.png`, OUT), png)
    return analyse(page, png, GEOJSON_PIXELS)
  }
  const change = async script => {
    const composedBefore = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
    await page.evaluate(script)
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending > 0, null, { timeout: 30_000, polling: 'raf' }).catch(() => {})
    await page.waitForFunction(() => window.earth.inspect().terrain.imageryRecompositionsPending === 0, null, { timeout: 120_000, polling: 'raf' })
    const composedAfter = await page.evaluate(() => window.earth.inspect().terrain.imageryTilesCompositedTotal)
    return composedAfter - composedBefore
  }
  const regionsHeld = () => page.evaluate(() => [...window.mapStyleSource.overlays].reduce((sum, overlay) => sum + overlay.regions.size, 0))
  await settled()
  const before = await shot('before')
  await change(() => window.moveGeoJsonArea(0.12))
  const moved = await shot('moved')
  const regionsRedrawnAfterUpdateData = await change(() => window.geoJsonSources.stations.updateData({ update: [{ id: 13, newGeometry: { type: 'Point', coordinates: [138.55, 35.52] } }] }))
  // A cluster id that does not exist: the worker answers with the error that states the fix
  const clusterQuery = await page.evaluate(() => window.geoJsonSources.stations.getClusterChildren(987654).then(() => 'resolved', error => error.message))
  await page.close()
  // A fresh page close to the clusters, over 20 km from the area: moving it further west redraws the coarse regions
  // that span both, but not the detailed ones in view
  const closePage = await open(`/?fixtures&stats=0&atmosphere=0&map=vector&geojson&camera=138.93,35.245,0,6000,0,-89${query}`)
  page = closePage.page
  await settled()
  const close = await shot('close')
  // Records the regions redrawn from here (recomposeRegion is protected, wrapped for the check only)
  await page.evaluate(() => {
    window.regionsRedrawn = []
    for (const overlay of window.mapStyleSource.overlays) {
      const recomposeRegion = overlay.recomposeRegion.bind(overlay)
      overlay.recomposeRegion = (key, ...rest) => {
        window.regionsRedrawn.push(key)
        return recomposeRegion(key, ...rest)
      }
    }
  })
  const regionsHeldClose = await regionsHeld()
  const regionsRedrawnFarFromView = await change(() => window.moveGeoJsonArea(-0.1))
  // Region keys end with their level: the deepest level holds the detailed regions in view
  const detail = await page.evaluate(() => {
    const level = key => Number(key.split('_').pop())
    const held = [...window.mapStyleSource.overlays].flatMap(overlay => [...overlay.regions.keys()])
    const deepest = Math.max(...held.map(level))
    return { detailedRegionsHeld: held.filter(key => level(key) === deepest).length, detailedRegionsRedrawn: window.regionsRedrawn.filter(key => level(key) === deepest).length }
  })
  await page.close()
  results.push({ check: `geojson sources, ${name}`, before, moved, close, regionsHeldClose, regionsRedrawnFarFromView, ...detail, regionsRedrawnAfterUpdateData, clusterQuery, errors: [...errors, ...closePage.errors] })
}

/**
 * The `?heatmap` layers, by colour: MapLibre's default ramp (its red core), the magenta ramp of the second layer.
 * The quake heat straddles a tile edge (`edgeX` on screen). `edgeStep` is the mean colour step across the edge
 * (3 px either side, clear of the terrain's 1 px region line), `nearbyStep` the same step 6 px to the west: a seam
 * (a tile missing its neighbour's points) cuts the heat off at the edge, so its step stands out.
 */
const heatmapPixels = (edgeX, centerY) => `
  const edgeX = ${Math.round(edgeX)}, centerY = ${Math.round(centerY)}
  const at = (x, y) => { const i = (y * width + x) * 4; return [px[i], px[i + 1], px[i + 2]] }
  const step = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3
  // By hue, so the dimly lit 3D view counts too.
  const isRed = ([r, g, b]) => r > 80 && r > g * 3 && r > b * 3
  const isHeat = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 100 && !(r > 80 && b > 80 && g < Math.min(r, b) * 0.6)
  let red = 0, heat = 0, magenta = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (isRed([r, g, b])) red++
    if (isHeat([r, g, b])) heat++
    if (r > 80 && b > 80 && g < Math.min(r, b) * 0.6 && Math.abs(r - b) < Math.max(r, b) * 0.3) magenta++
  }
  let edgeStep = 0, nearbyStep = 0, rows = 0
  for (let y = Math.max(centerY - 200, 0); y < Math.min(centerY + 200, height - 40); y++) {
    if (!isHeat(at(edgeX - 3, y)) && !isHeat(at(edgeX + 3, y))) continue
    edgeStep += step(at(edgeX - 3, y), at(edgeX + 3, y))
    nearbyStep += step(at(edgeX - 9, y), at(edgeX - 3, y))
    rows++
  }
  const n = px.length / 4
  return { redShare: +(red / n).toFixed(4), heatShare: +(heat / n).toFixed(4), magentaShare: +(magenta / n).toFixed(4), edgeRows: rows, edgeStep: rows === 0 ? null : +(edgeStep / rows).toFixed(1), nearbyStep: rows === 0 ? null : +(nearbyStep / rows).toFixed(1) }
`

/** Heatmap layers (`?heatmap`): two layers over GeoJSON points, one mirrored about a tile edge. */
async function heatmaps(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&map=vector&heatmap${query}`)
  const warnings = []
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()) })
  // `idle`, not zero download, parse and composition counts: those also hold between two refinement steps, and the
  // slower WebGL2 path sometimes stopped there and screenshotted the heat of coarse tiles, with a seam at their edge.
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 10 && inspection.idle
  }, null, { timeout: 240_000, polling: 300 })
  await page.waitForTimeout(3000) // tile fades
  // The tile edge the quake heat straddles (z8 column 227) at the cloud's latitude.
  const edge = await page.evaluate(() => window.earth.project({ longitudeDegrees: (227 / 256) * 360 - 180, latitudeDegrees: 35.3 }))
  const png = await page.screenshot()
  writeFileSync(new URL(`heatmap-${name.replace(/[^a-z0-9]+/g, '-')}.png`, OUT), png)
  const stats = await analyse(page, png, heatmapPixels(edge.xPixels, edge.yPixels))
  await page.close()
  results.push({ check: `heatmap layers, ${name}`, edge: { x: Math.round(edge.xPixels), y: Math.round(edge.yPixels) }, ...stats, errors, warnings: warnings.filter(text => /heatmap|skipp/i.test(text)) })
}

/**
 * The gallery examples (`?example=<name>`, src/examples/) on the fixtures: each loads without an error and draws what
 * it is about. `interact` runs in the page once it is idle and returns extra facts.
 */
async function galleryExample(name, query = '', interact = null) {
  const { page, errors } = await open(`/?fixtures&atmosphere=0&example=${name}${query}`)
  const idle = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 5 && inspection.idle && !window.earth.camera.animating
  }, null, { timeout: 240_000, polling: 300 })
  await idle()
  await page.waitForTimeout(2000) // tile and label fades
  const facts = interact === null ? {} : await interact(page, idle)
  const png = await page.screenshot()
  writeFileSync(new URL(`example-${name}.png`, OUT), png)
  const inspection = await page.evaluate(() => {
    const { terrain } = window.earth.inspect()
    return { buildings: terrain?.extrusions?.buildings ?? 0, labels: window.earth.terrain.getScreenLabels().filter(label => label.opacity > 0.5).map(label => label.text) }
  })
  // Heat: purple to orange pixels, far from the grey fixture ground (green well under red or blue).
  const colours = await analyse(page, png, `
    let heat = 0
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 2]) - px[i + 1] > 60) heat++
    return { heatShare: heat / (width * height) }
  `)
  await page.close()
  results.push({ check: `gallery example, ${name}`, ...inspection, ...colours, ...facts, errors })
}

/**
 * The drawing plugin (`?example=draw`, react-three-earth-draw): a polygon, a line and a point drawn by tapping, with a
 * mouse or a finger, on the globe or the flat map. Finished features drape on the terrain (green fill, red line and
 * point); the feature in progress shows in the overlay; one-finger drags between taps still pan.
 */
async function drawing(name, { touch = false, flat = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: touch })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?fixtures&atmosphere=0&example=draw&camera=-90,0,0,60000,0,-60`)
  const idle = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 5 && inspection.idle && !window.earth.camera.animating
  }, null, { timeout: 240_000, polling: 300 })
  await idle()
  if (flat) {
    await page.evaluate(() => window.earth.setView('2d', { durationSeconds: 0 }))
    await page.waitForTimeout(500)
    await idle()
  }
  // The map before drawing, to compare with: the globe is lit, so the draped colours are measured as changes.
  await analyse(page, await page.screenshot(), 'window.drawingBase = px; return {}')
  // Collapse the card so taps reach the map, then drive the tools through the plugin (the toolbar is the example's).
  const tap = (x, y) => (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
  const result = { check: `drawing, ${name}`, errors }
  await page.evaluate(() => window.draw.setMode('polygon'))
  for (const [x, y] of [[420, 250], [620, 260], [640, 420], [440, 430]]) {
    await tap(x, y)
    await page.waitForTimeout(150)
  }
  result.inProgress = await page.evaluate(() => { const { drawing, vertexCount, canFinish } = window.draw.getState(); return { drawing, vertexCount, canFinish } })
  writeFileSync(new URL(`drawing-${name.replaceAll(' ', '-')}-progress.png`, OUT), await page.screenshot())
  await tap(420, 250) // the first vertex closes the polygon
  await page.evaluate(() => window.draw.setMode('linestring'))
  for (const [x, y] of [[400, 150], [700, 180], [750, 300]]) {
    await tap(x, y)
    await page.waitForTimeout(150)
  }
  await tap(750, 300) // the last vertex finishes the line
  await page.evaluate(() => window.draw.setMode('point'))
  await tap(540, 340)
  // A one-finger (or mouse) drag still pans the map in a drawing mode, and places nothing.
  const before = await page.evaluate(() => window.earth.camera.getView())
  if (touch) {
    const client = await page.context().newCDPSession(page)
    const point = (x, y) => ({ x, y, id: 1 })
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(600, 520)] })
    for (let step = 1; step <= 6; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(600 - step * 20, 520)] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(600, 520)
    await page.mouse.down()
    await page.mouse.move(480, 520, { steps: 6 })
    await page.mouse.up()
  }
  await page.waitForTimeout(800)
  const after = await page.evaluate(() => window.earth.camera.getView())
  result.panned = Math.abs(after.longitudeDegrees - before.longitudeDegrees) > 1e-4
  // Back where the features were drawn, to look at them.
  await page.evaluate(view => window.earth.camera.jumpTo(view), before)
  await page.waitForTimeout(500)
  await idle()
  await page.waitForTimeout(1000)
  const png = await page.screenshot()
  writeFileSync(new URL(`drawing-${name.replaceAll(' ', '-')}.png`, OUT), png)
  result.features = await page.evaluate(() => window.draw.getFeatures().features.map(feature => feature.geometry.type))
  result.vertices = await page.evaluate(() => window.draw.getFeatures().features.map(feature => feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0].length : feature.geometry.type === 'LineString' ? feature.geometry.coordinates.length : 1))
  result.drapedLayers = await page.evaluate(() => window.earth.inspect().drapedLayers)
  Object.assign(result, await analyse(page, png, `
    // Right of the card, against the map before drawing: the red line and point, and the green fill over the checker.
    const base = window.drawingBase
    let red = 0, green = 0
    for (let y = 0; y < height; y++) for (let x = 360; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      const [dr, dg, db] = [r - base[i], g - base[i + 1], b - base[i + 2]]
      if (dr > 40 && r > g + 40) red++
      else if (dg > 10 && dr <= 5 && db > 0 && g > r) green++
    }
    return { redPixels: red, greenPixels: green }
  `))
  await page.close()
  results.push(result)
}

/**
 * Editing (`?example=draw`, the select mode): a tap selects a polygon (with its gizmo), a second tap shows its vertex
 * handles, a drag on a vertex handle moves it, a tap on a
 * midpoint inserts a vertex, a drag inside moves the polygon whole without panning, a drag off it still pans, and a
 * picked vertex can be deleted. Each edit fires one update; undo takes the last back. Mouse or finger, globe or flat map.
 */
async function editing(name, { touch = false, flat = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: touch })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?fixtures&atmosphere=0&example=draw&camera=-90,0,0,60000,0,-60`)
  const idle = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 5 && inspection.idle && !window.earth.camera.animating
  }, null, { timeout: 240_000, polling: 300 })
  await idle()
  if (flat) {
    await page.evaluate(() => window.earth.setView('2d', { durationSeconds: 0 }))
    await page.waitForTimeout(500)
    await idle()
  }
  const tap = async (x, y) => {
    await (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
    await page.waitForTimeout(200)
  }
  const client = touch ? await page.context().newCDPSession(page) : null
  const drag = async ([x0, y0], [x1, y1]) => {
    const steps = 8
    if (touch) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] })
      for (let step = 1; step <= steps; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * step) / steps, y: y0 + ((y1 - y0) * step) / steps, id: 1 }] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      await page.mouse.move(x1, y1, { steps })
      await page.mouse.up()
    }
    await page.waitForTimeout(400)
  }
  const result = { check: `editing, ${name}`, errors }
  // A polygon to edit, drawn with the polygon tool.
  await page.evaluate(() => window.draw.setMode('polygon'))
  for (const [x, y] of [[420, 250], [620, 260], [640, 420], [440, 430]]) await tap(x, y)
  await tap(420, 250)
  await page.evaluate(() => {
    window.drawUpdates = 0
    window.draw.addEventListener('update', () => window.drawUpdates++)
    window.draw.setMode('select')
  })
  const ring = () => page.evaluate(() => window.draw.getFeatures().features[0].geometry.coordinates[0])
  const view = () => page.evaluate(() => window.earth.camera.getView())
  await tap(530, 340)
  result.selected = await page.evaluate(() => window.draw.getState().selectedIds.length)
  result.gizmoFirst = await page.evaluate(() => !window.draw.getState().editingVertices)
  await tap(530, 340) // a second tap on the selected polygon: its vertex handles instead of the gizmo
  result.editingVertices = await page.evaluate(() => window.draw.getState().editingVertices)
  const before = await ring()
  await drag([640, 420], [700, 490])
  const afterVertex = await ring()
  result.vertexMoved = afterVertex.length === before.length && afterVertex.filter((position, index) => position[0] !== before[index][0] || position[1] !== before[index][1]).length === 1
  await tap(520, 255) // the midpoint of the first edge
  result.verticesAfterInsert = (await ring()).length - 1
  const viewBeforeMove = await view()
  const beforeMove = await ring()
  await drag([520, 340], [470, 300])
  const afterMove = await ring()
  const viewAfterMove = await view()
  result.movedWhole = afterMove.every((position, index) => position[0] !== beforeMove[index][0])
  result.cameraHeldDuringMove = Math.abs(viewAfterMove.longitudeDegrees - viewBeforeMove.longitudeDegrees) < 1e-9
  result.updates = await page.evaluate(() => window.drawUpdates)
  writeFileSync(new URL(`editing-${name.replaceAll(' ', '-')}.png`, OUT), await page.screenshot())
  // Pick the first vertex (it followed the move) and delete it.
  const first = await page.evaluate(() => {
    const [longitude, latitude] = window.draw.getFeatures().features[0].geometry.coordinates[0][0]
    return window.earth.project({ longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters: window.earth.queryTerrainElevation({ longitudeDegrees: longitude, latitudeDegrees: latitude }) ?? 0 })
  })
  await tap(first.xPixels, first.yPixels)
  result.deleted = await page.evaluate(() => window.draw.deleteSelected())
  result.verticesAfterDelete = (await ring()).length - 1
  await page.evaluate(() => window.draw.undo())
  result.verticesAfterUndo = (await ring()).length - 1
  // A drag off the selection pans the map.
  const viewBeforePan = await view()
  await drag([740, 560], [640, 560])
  result.pannedOffSelection = Math.abs((await view()).longitudeDegrees - viewBeforePan.longitudeDegrees) > 1e-4
  await idle() // a tap while the map still glides only stops it
  await tap(680, 150) // the empty map clears the selection
  result.selectedAfterEmptyTap = await page.evaluate(() => window.draw.getState().selectedIds.length)
  if (!touch) {
    // The keyboard (opted in by the example): G moves the selection under the pointer, X locks it to east, Enter confirms.
    const middle = await page.evaluate(() => {
      const feature = window.draw.getFeatures().features[0]
      window.draw.select([feature.id])
      const ring = feature.geometry.coordinates[0].slice(0, -1)
      const longitudeDegrees = ring.reduce((sum, position) => sum + position[0], 0) / ring.length
      const latitudeDegrees = ring.reduce((sum, position) => sum + position[1], 0) / ring.length
      const element = window.earth.pointerEventsElement
      if (!element.hasAttribute('tabindex')) element.tabIndex = -1
      element.focus()
      const { xPixels, yPixels } = window.earth.project({ longitudeDegrees, latitudeDegrees, heightMeters: window.earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees }) ?? 0 })
      return { x: xPixels, y: yPixels }
    })
    await page.mouse.move(middle.x - 40, middle.y)
    const beforeKeys = await ring()
    const updatesBeforeKeys = await page.evaluate(() => window.drawUpdates)
    // What the keys reached, for the failure message.
    const keyState = () => page.evaluate(() => {
      const element = window.earth.pointerEventsElement
      const active = document.activeElement
      return { focused: active === element || element.contains(active), documentFocused: document.hasFocus(), transform: window.draw.inspect().modeState.keyboardTransform }
    })
    const keySteps = { beforeG: await keyState() }
    await page.keyboard.press('g')
    keySteps.afterG = await keyState()
    await page.mouse.move(middle.x + 20, middle.y + 30, { steps: 6 })
    keySteps.afterMove = await keyState()
    await page.keyboard.press('x')
    await page.waitForTimeout(200)
    keySteps.afterX = await keyState()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const afterKeys = await ring()
    const shift = afterKeys.map((position, index) => [position[0] - beforeKeys[index][0], position[1] - beforeKeys[index][1]])
    result.keyboardMove = {
      updates: (await page.evaluate(() => window.drawUpdates)) - updatesBeforeKeys,
      eastDegrees: Math.min(...shift.map(([east]) => east)),
      northDegrees: Math.max(...shift.map(([, north]) => Math.abs(north))),
      steps: keySteps,
    }
  }
  await page.close()
  results.push(result)
}

/**
 * Shapes and solids (`?example=shapes`): six starting solids (a cylinder, a box, a hexagonal tower, a slab at 2.5 km,
 * a sphere and a wall) stand on the terrain as meshes, on the globe and the flat map; two taps draw a cylinder and two
 * more a box, each a GeoJSON multipolygon of faces 600 m tall (measured from its altitudes). Clearing them leaves the
 * map as it was.
 */
/**
 * A see-through solid standing against the sky (the hexagonal tower, 2.5 km tall, seen level from 1.5 km): the sky goes
 * behind its transparent faces, not over them, so its top above the horizon stays as orange as its foot.
 */
async function solidsOverSky() {
  const { page, errors } = await open('/?fixtures&example=shapes&date=2026-11-22T12:00:00Z')
  await page.waitForFunction(() => window.earth?.inspect()?.terrain?.tilesLoaded > 5 && window.earth.inspect().idle, null, { timeout: 240_000, polling: 300 })
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: 6.6, latitudeDegrees: 46.414, heightMeters: 1500, distanceMeters: 9000, headingDegrees: 0, pitchDegrees: -4 }))
  // The sky and the ground lookups of the solids.
  await page.waitForFunction(() => window.earth.inspect().loaded === true && window.earth.inspect().idle && (window.earth.inspect().atmosphere?.ready ?? true), null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(4000)
  const png = await page.screenshot()
  writeFileSync(new URL('solids-over-sky.png', OUT), png)
  const orange = (top, bottom) => `
    let count = 0, total = 0
    for (let y = ${top}; y < ${bottom}; y++) for (let x = 370; x < 455; x++) {
      const i = (y * width + x) * 4
      total++
      if (px[i] - px[i + 2] > 40) count++
    }
    return count / total`
  const aboveHorizon = await analyse(page, png, orange(245, 270))
  const belowHorizon = await analyse(page, png, orange(330, 390))
  // From the other side, the tower's shaded face crosses the horizon: hazed at its own distance, it keeps its shade
  // across it (hazed at the ground's distance below and not at all above, it went dark against the sky).
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: 6.6, latitudeDegrees: 46.414, heightMeters: 1500, distanceMeters: 9000, headingDegrees: 150, pitchDegrees: -4 }))
  await page.waitForFunction(() => window.earth.inspect().loaded === true && window.earth.inspect().idle, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(3000)
  const shadedPng = await page.screenshot()
  writeFileSync(new URL('solids-over-sky-shaded.png', OUT), shadedPng)
  const mean = (top, bottom) => `
    const sum = [0, 0, 0]
    let count = 0
    for (let y = ${top}; y < ${bottom}; y++) for (let x = 375; x < 430; x++) {
      const i = (y * width + x) * 4
      sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; count++
    }
    return sum.map(value => value / count)`
  const shadedAbove = await analyse(page, shadedPng, mean(250, 262))
  const shadedBelow = await analyse(page, shadedPng, mean(285, 300))
  const shadeStep = Math.max(...shadedAbove.map((value, channel) => Math.abs(value - shadedBelow[channel])))
  results.push({ check: 'solids over the sky', aboveHorizon, belowHorizon, shadedAbove, shadedBelow, shadeStep, errors })
  await page.close()
}

async function shapes(name, { touch = false, flat = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: touch })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?fixtures&atmosphere=0&example=shapes`)
  const idle = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 5 && inspection.idle && !window.earth.camera.animating
  }, null, { timeout: 240_000, polling: 300 })
  await idle()
  if (flat) {
    await page.evaluate(() => window.earth.setView('2d', { durationSeconds: 0 }))
    await page.waitForTimeout(500)
    await idle()
  }
  await page.waitForTimeout(1500) // terrain heights reach the solids
  const result = { check: `shapes, ${name}`, errors }
  result.startingSolids = await page.evaluate(() => window.draw.inspect().solids)
  const tap = (x, y) => (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
  await page.evaluate(() => window.draw.setMode('circle'))
  await tap(560, 470)
  await page.waitForTimeout(150)
  await tap(620, 470)
  await page.waitForTimeout(150)
  await page.evaluate(() => window.draw.setMode('rectangle'))
  await tap(660, 330)
  await page.waitForTimeout(150)
  await tap(760, 400)
  await page.waitForTimeout(800)
  result.drawn = await page.evaluate(() => window.draw.getFeatures().features.slice(6).map(feature => {
    // The height of a prism: its level top over its highest base vertex.
    const altitudes = feature.geometry.coordinates.flat(2).map(position => position[2])
    const top = Math.max(...altitudes)
    const base = Math.max(...altitudes.filter(altitude => altitude < top - 1e-6))
    return { type: feature.geometry.type, faces: feature.geometry.coordinates.length, heightMeters: Math.round(top - base) }
  }))
  result.solids = await page.evaluate(() => window.draw.inspect().solids)
  await idle()
  const png = await page.screenshot()
  writeFileSync(new URL(`shapes-${name.replaceAll(' ', '-')}.png`, OUT), png)
  await analyse(page, png, 'window.shapesPixels = px; return {}')
  await page.evaluate(() => window.draw.clear())
  await page.waitForTimeout(500)
  await idle()
  result.solidsAfterClear = await page.evaluate(() => window.draw.inspect().solids)
  result.solidObjectsAfterClear = await page.evaluate(() => window.earth.getObjectByName('DrawSolids')?.children.length ?? -1)
  // Right of the card: the orange solids (shaded by the sun on the globe) and the magenta sphere, against the bare map.
  Object.assign(result, await analyse(page, await page.screenshot(), `
    const shapes = window.shapesPixels
    let orange = 0, magenta = 0, leftover = 0
    for (let y = 0; y < height; y++) for (let x = 360; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = [shapes[i], shapes[i + 1], shapes[i + 2]]
      const changed = Math.abs(r - px[i]) + Math.abs(g - px[i + 1]) + Math.abs(b - px[i + 2]) > 30
      if (changed && r > g + 30 && g > b + 20) orange++
      else if (changed && r > g + 40 && b > g + 40) magenta++
      if (px[i] > px[i + 1] + 30 && px[i + 1] > px[i + 2] + 20) leftover++
    }
    return { orangePixels: orange, magentaPixels: magenta, orangeAfterClear: leftover }
  `))
  await page.close()
  results.push(result)
}

/**
 * The gizmo (`?example=shapes`, the select mode): a tap on the box mesh where it stands in 3D selects it. Closer, the
 * gizmo sits at its middle: the east arrow moves it east only, the up arrow raises it, the cube on the east axis
 * widens it east-west only, the arc around up turns its heading and (on the globe, seen obliquely so the arc shows)
 * the arc around east tilts it, its top face no longer level. Seen from above on the flat map the up arrow is a knob up
 * the screen. Each drag fires one update; the box is measured from its vertices. The previews go once released.
 */
async function transforming(name, { touch = false, flat = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: touch })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?fixtures&atmosphere=0&example=shapes`)
  const idle = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    return inspection?.terrain?.tilesLoaded > 5 && inspection.idle && !window.earth.camera.animating
  }, null, { timeout: 240_000, polling: 300 })
  await idle()
  if (flat) {
    await page.evaluate(() => window.earth.setView('2d', { durationSeconds: 0 }))
    await page.waitForTimeout(500)
    await idle()
  }
  await page.waitForTimeout(1500)
  const client = touch ? await page.context().newCDPSession(page) : null
  const tap = async ({ x, y }) => {
    await (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
    await page.waitForTimeout(300)
  }
  /** A press at `from`, moves through `path` (screen points) and a release at the last. */
  const drag = async (from, path) => {
    if (touch) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
      for (const point of path) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, id: 1 }] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      for (const point of path) await page.mouse.move(point.x, point.y)
      await page.mouse.up()
    }
    await page.waitForTimeout(500)
  }
  /** A straight drag in ten steps. */
  const line = (from, to) => Array.from({ length: 10 }, (_, index) => ({ x: from.x + ((to.x - from.x) * (index + 1)) / 10, y: from.y + ((to.y - from.y) * (index + 1)) / 10 }))
  // The box measured from its vertices (metres east and north of where it started), and where its gizmo's handles are.
  const measure = () => page.evaluate(() => {
    const box = window.draw.getFeature('box')
    const positions = box.geometry.coordinates.flat(2)
    const altitudes = positions.map(position => position[2])
    const start = window.boxStart ?? positions.reduce((sum, position) => [sum[0] + position[0] / positions.length, sum[1] + position[1] / positions.length], [0, 0])
    window.boxStart = start
    const radians = Math.PI / 180
    const east = longitude => (longitude - start[0]) * radians * 6_371_008.8 * Math.cos(start[1] * radians)
    const north = latitude => (latitude - start[1]) * radians * 6_371_008.8
    const xs = positions.map(position => east(position[0]))
    const ys = positions.map(position => north(position[1]))
    const top = box.geometry.coordinates[0][0]
    const topAltitudes = top.map(position => position[2])
    const handles = {}
    for (const { handle, x, y } of window.draw.getMode().gizmoHandles()) handles[handle] ??= { x, y }
    return {
      faces: box.geometry.coordinates.length,
      center: { east: xs.reduce((a, b) => a + b) / xs.length, north: ys.reduce((a, b) => a + b) / ys.length },
      extent: { east: Math.max(...xs) - Math.min(...xs), north: Math.max(...ys) - Math.min(...ys) },
      base: Math.min(...altitudes),
      height: Math.max(...altitudes) - Math.min(...altitudes),
      // The heading of the top face's second edge, and how far from level the top face is.
      headingDegrees: (Math.atan2(east(top[2][0]) - east(top[1][0]), north(top[2][1]) - north(top[1][1])) / radians + 360) % 360,
      topTiltMeters: Math.max(...topAltitudes) - Math.min(...topAltitudes),
      handles,
    }
  })
  const result = { check: `transforming, ${name}`, errors }
  await page.evaluate(() => {
    window.drawUpdates = 0
    window.draw.addEventListener('update', () => window.drawUpdates++)
    window.draw.setMode('select')
  })
  // Where the box is drawn: its top, 900 m over its base (on the flat map, seen from above, the same place).
  const top = await page.evaluate(() => {
    const positions = window.draw.getFeature('box').geometry.coordinates.flat(2)
    const longitudeDegrees = positions.reduce((sum, position) => sum + position[0], 0) / positions.length
    const latitudeDegrees = positions.reduce((sum, position) => sum + position[1], 0) / positions.length
    const { xPixels, yPixels } = window.earth.project({ longitudeDegrees, latitudeDegrees, heightMeters: Math.max(...positions.map(position => position[2])) })
    return { x: xPixels, y: yPixels, longitudeDegrees, latitudeDegrees }
  })
  await tap(top)
  result.selected = await page.evaluate(() => window.draw.getState().selectedIds.includes('box'))
  result.gizmoShown = await page.evaluate(() => !window.draw.getState().editingVertices && window.draw.getMode().gizmoHandles().length > 0)
  // The panel folded to its title, so the gizmo's handles are never under it.
  await page.getByRole('button', { name: 'Hide details' }).click()
  // Closer, seen from the south-west so every arc shows on the globe (the flat map is seen from above).
  await page.evaluate(({ longitudeDegrees, latitudeDegrees }) => window.earth.camera.jumpTo({ longitudeDegrees, latitudeDegrees, distanceMeters: 14_000, headingDegrees: 35, pitchDegrees: -40 }), top)
  await page.waitForTimeout(500)
  await idle()
  await page.waitForTimeout(1000)
  writeFileSync(new URL(`transforming-${name.replaceAll(' ', '-')}-gizmo.png`, OUT), await page.screenshot())
  let box = await measure()
  result.before = box
  result.handleNames = Object.keys(box.handles)
  const center = () => box.handles['move-free']
  const along = (handle, pixels) => {
    const grab = box.handles[handle]
    const length = Math.hypot(grab.x - center().x, grab.y - center().y)
    return { x: grab.x + ((grab.x - center().x) / length) * pixels, y: grab.y + ((grab.y - center().y) / length) * pixels }
  }
  const step = async (key, from, path) => {
    const updatesBefore = await page.evaluate(() => window.drawUpdates)
    await drag(from, path)
    const previous = box
    box = await measure()
    result[key] = { before: previous, after: box, updates: (await page.evaluate(() => window.drawUpdates)) - updatesBefore }
  }
  // The east arrow, dragged further along itself.
  await step('east', box.handles['move-x'], line(box.handles['move-x'], along('move-x', 60)))
  // The up arrow (a knob up the screen from above), dragged further up.
  await step('up', box.handles['move-z'], line(box.handles['move-z'], flat ? { x: box.handles['move-z'].x, y: box.handles['move-z'].y - 40 } : along('move-z', 40)))
  // The cube on the east axis, dragged half as far again from the center.
  const cube = box.handles['scale-x']
  await step('scale', cube, line(cube, { x: center().x + (cube.x - center().x) * 1.5, y: center().y + (cube.y - center().y) * 1.5 }))
  // The arc around up, dragged a quarter turn around the center.
  const arc = box.handles['rotate-z']
  const radius = Math.hypot(arc.x - center().x, arc.y - center().y)
  const startAngle = Math.atan2(arc.y - center().y, arc.x - center().x)
  await step('heading', arc, Array.from({ length: 10 }, (_, index) => ({ x: center().x + radius * Math.cos(startAngle + (index + 1) * 0.08), y: center().y + radius * Math.sin(startAngle + (index + 1) * 0.08) })))
  // The arc around east (on the globe), dragged along itself: across the line from the center.
  if (!flat) {
    const tilt = box.handles['rotate-x']
    const length = Math.hypot(tilt.x - center().x, tilt.y - center().y)
    await step('tilt', tilt, line(tilt, { x: tilt.x - ((tilt.y - center().y) / length) * 40, y: tilt.y + ((tilt.x - center().x) / length) * 40 }))
  }
  result.updates = await page.evaluate(() => window.drawUpdates)
  await page.waitForTimeout(500)
  writeFileSync(new URL(`transforming-${name.replaceAll(' ', '-')}.png`, OUT), await page.screenshot())
  result.solids = await page.evaluate(() => ({ stored: window.draw.inspect().solids, inScene: window.earth.getObjectByName('DrawSolids').children.length }))
  await page.close()
  results.push(result)
}

/**
 * Seams: a column (or row) whose step to the next one is larger than its neighbours' steps on over 30 % of the
 * rows. Sensitive enough to find the terrain's faint seam at 90° W (so the views below stay clear of it).
 */
const SEAMS = `
  const lightness = (x, y) => { const i = (y * width + x) * 4; return (px[i] + px[i + 1] + px[i + 2]) / 3 }
  // Leave out the corners' controls and attribution.
  const top = 50, bottom = height - 40
  const step = (ax, ay, bx, by) => Math.abs(lightness(ax, ay) - lightness(bx, by))
  const seams = []
  for (let x = 1; x < width - 2; x++) {
    let jumps = 0
    for (let y = top; y < bottom; y++) if (step(x, y, x + 1, y) - Math.max(step(x - 1, y, x, y), step(x + 1, y, x + 2, y)) > 1.5) jumps++
    if (jumps > (bottom - top) * 0.3) seams.push('x' + x)
  }
  for (let y = top + 1; y < bottom - 2; y++) {
    let jumps = 0
    for (let x = 0; x < width; x++) if (step(x, y, x, y + 1) - Math.max(step(x, y - 1, x, y), step(x, y + 1, x, y + 2)) > 1.5) jumps++
    if (jumps > width * 0.3) seams.push('y' + y)
  }
  // Hillshade only: the grey background, lit slopes and shaded slopes.
  let light = 0, shade = 0
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3
    if (l > 170) light++
    else if (l < 80) shade++
  }
  const n = px.length / 4
  return { seams, litShare: +(light / n).toFixed(3), shadedShare: +(shade / n).toFixed(3) }
`

const RELIEF_PIXELS = `
  // The imagery (desaturated green checker) under the colour relief, white and orange roads on top, hillshade on the hills.
  let green = 0, road = 0, shade = 0, light = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
    if (g > r + 25 && g > b + 25) green++
    if (r > 200 && g > 140 && b < 120 && r > b + 90) road++
    if (r + g + b < 90) shade++
    if (r > 200 && g > 200 && b > 200) light++
  }
  const n = px.length / 4
  return { imageryShare: +(green / n).toFixed(3), primaryRoadShare: +(road / n).toFixed(4), shadedShare: +(shade / n).toFixed(3), lightShare: +(light / n).toFixed(3) }
`

/** A style with raster, colour relief and hillshade layers (fixture imagery and Terrarium DEM) under vector roads. */
async function reliefMap(name, query, script = RELIEF_PIXELS) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0${query}`)
  const warnings = []
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()) })
  await page.waitForFunction(() => {
    const t = window.earth?.inspect()?.terrain
    return t && t.tilesLoaded > 10 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(4000) // remaining compositions and fades
  const png = await page.screenshot()
  writeFileSync(new URL(`map-relief-${name.replace(/[^a-z0-9]+/g, '-')}.png`, OUT), png)
  const stats = await analyse(page, png, script)
  await page.close()
  results.push({ check: `relief style with fixtures, ${name}`, ...stats, errors, warnings })
}

/** The fixture terrain's heights (`fixtures/quantizedMesh.ts`), which the `?plain` Terrarium fixture tiles encode. */
function fixtureHeightMeters(longitudeDegrees, latitudeDegrees) {
  const lon = (longitudeDegrees * Math.PI) / 180
  const lat = (latitudeDegrees * Math.PI) / 180
  const ridges = Math.sin(lon * 7) * Math.cos(lat * 9) + 0.5 * Math.sin(lon * 31 + lat * 17)
  return Math.max(0, ridges) * 2600
}

/**
 * Terrain from raster-dem (`?terrain=dem`, Terrarium tiles of the quantized-mesh fixture's heights): heights under a
 * grid of points match the fixture function, imagery drapes on it, the north pole is closed and the flat map works.
 */
async function rasterDemTerrain(name, query, { heights = false } = {}) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0${query.includes('terrain=') ? '' : '&terrain=dem'}${query}`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    const settledView = inspection?.view.morph === (inspection?.view.mode === '2d' ? 1 : 0)
    return t && t.tilesLoaded > 10 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && settledView
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(2000) // tiles fade in
  const png = await page.screenshot()
  writeFileSync(new URL(`dem-terrain-${name.replace(/[^a-z0-9]+/g, '-')}.png`, OUT), png)
  const stats = await analyse(page, png, `
    let green = 0, black = 0, centreBlack = 0, centre = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      const x = (i / 4) % width, y = Math.floor(i / 4 / width)
      if (g > r + 20 && g > b + 20) green++
      if (r + g + b < 15) black++
      if (Math.abs(x - width / 2) < 30 && Math.abs(y - height / 2) < 30) { centre++; if (r + g + b < 15) centreBlack++ }
    }
    const n = px.length / 4
    return { greenShare: +(green / n).toFixed(3), blackShare: +(black / n).toFixed(3), centreBlackShare: +(centreBlack / centre).toFixed(3) }
  `)
  let heightErrorsMeters = null
  if (heights) {
    const points = []
    for (let i = 0; i < 49; i++) points.push([-91.2 + (i % 7) * 0.4, -1.2 + Math.floor(i / 7) * 0.4])
    const sampled = await page.evaluate(points => points.map(([longitudeDegrees, latitudeDegrees]) => window.earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees })), points)
    heightErrorsMeters = sampled.flatMap((height, index) => (height === null ? [] : [Math.abs(height - fixtureHeightMeters(...points[index]))]))
    heightErrorsMeters = { count: heightErrorsMeters.length, maximum: Number(Math.max(...heightErrorsMeters).toFixed(2)), heightRangeMeters: Number((Math.max(...points.map(p => fixtureHeightMeters(...p))) - Math.min(...points.map(p => fixtureHeightMeters(...p)))).toFixed(0)) }
  }
  const { inspection, attributions } = await page.evaluate(() => ({ inspection: window.earth.inspect(), attributions: window.earth.getAttributions() }))
  await page.close()
  results.push({ check: `raster-dem terrain, ${name}`, ...stats, heightErrorsMeters, view: inspection.view, tilesLoaded: inspection.terrain.tilesLoaded, attributions, errors })
}

/**
 * A style's root properties (`?terrain=style`): with an empty `<Terrain>`, the earth builds terrain from the style's
 * `terrain` (DEM fixture, exaggeration 1.5) and the camera starts at its `center`, `zoom`, `bearing` and `pitch`.
 */
async function styleRoot() {
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&terrain=style')
  await page.waitForFunction(() => {
    const t = window.earth?.inspect().terrain
    return t && t.tilesLoaded > 10 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(2000) // tiles fade in
  const png = await page.screenshot()
  writeFileSync(new URL('style-root.png', OUT), png)
  const stats = await analyse(page, png, `
    let green = 0
    for (let i = 0; i < px.length; i += 4) if (px[i + 1] > px[i] + 20 && px[i + 1] > px[i + 2] + 20) green++
    return { greenShare: +(green / (px.length / 4)).toFixed(3) }
  `)
  const heights = await fixtureHeightErrors(page, 1.5)
  const { inspection, attributions } = await page.evaluate(() => ({ inspection: window.earth.inspect(), attributions: window.earth.getAttributions() }))
  await page.close()
  results.push({ check: 'style root properties', ...stats, heights, fromStyle: inspection.terrain?.fromStyle, camera: inspection.camera, attributions, errors })
}

/** Heights under a 7 × 7 grid over 2.4° around (-90°, 0°), against the fixture function times `exaggeration`. */
async function fixtureHeightErrors(page, exaggeration = 1) {
  const points = []
  for (let i = 0; i < 49; i++) points.push([-91.2 + (i % 7) * 0.4, -1.2 + Math.floor(i / 7) * 0.4])
  const sampled = await page.evaluate(points => points.map(([longitudeDegrees, latitudeDegrees]) => window.earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees })), points)
  const errors = sampled.flatMap((height, index) => (height === null ? [] : [Math.abs(height - exaggeration * fixtureHeightMeters(...points[index]))]))
  return { count: errors.length, maximum: Number(Math.max(...errors).toFixed(2)) }
}

/**
 * `<Terrain exaggeration>`: heights read under a grid are the fixture's times the exaggeration, a new value applies
 * without reloading the terrain, and the flat map draws it.
 */
async function terrainExaggeration(name, query) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&camera=-90,0,0,400000,0,-90${query}`)
  const settled = () => page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    return t && t.tilesLoaded > 10 && t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && inspection.view.morph === (inspection.view.mode === '2d' ? 1 : 0)
  }, null, { timeout: 240_000, polling: 500 })
  await settled()
  await page.waitForTimeout(1000)
  const exaggerated = await fixtureHeightErrors(page, 2)
  await page.evaluate(() => { window.terrainBeforeChange = window.earth.terrain })
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: -90, latitudeDegrees: 0, distanceMeters: 80000, headingDegrees: 30, pitchDegrees: -25 }))
  await settled()
  await page.waitForTimeout(1500)
  const pngExaggerated = await page.screenshot()
  writeFileSync(new URL(`exaggeration-${name.replace(/[^a-z0-9]+/g, '-')}.png`, OUT), pngExaggerated)
  await page.evaluate(() => window.setExaggeration(1))
  await page.waitForTimeout(1500)
  const pngPlain = await page.screenshot()
  const changedShare = await page.evaluate(async ([a, b]) => {
    const load = async data => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data }
    const [pa, pb] = [await load(a), await load(b)]
    let changed = 0
    for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 30) changed++
    return Number((changed / (pa.length / 4)).toFixed(3))
  }, [pngExaggerated.toString('base64'), pngPlain.toString('base64')])
  await page.evaluate(() => window.earth.camera.jumpTo({ longitudeDegrees: -90, latitudeDegrees: 0, distanceMeters: 400000, headingDegrees: 0, pitchDegrees: -90 }))
  await settled()
  await page.waitForTimeout(1000)
  const plain = await fixtureHeightErrors(page, 1)
  const sameTerrain = await page.evaluate(() => window.terrainBeforeChange === window.earth.terrain)
  await page.close()
  results.push({ check: `terrain exaggeration, ${name}`, exaggerated, plain, changedShare, sameTerrain, errors })
}

/**
 * Georeferenced image and video sources (`?georef=image|video`: a four-colour picture over a skewed quad). The image
 * lines up with its corners (colours inside each corner, its white margin just inside every edge); the video changes
 * colour over time. Points are placed with the same projective map the source uses, in Web Mercator.
 */
async function georeferenced(kind, query, label = kind) {
  const { page, errors } = await open(`/?fixtures&stats=0&atmosphere=0&georef=${kind}&camera=-90,0,0,8000,0,-90${query}`)
  // Tile counts can read settled for a moment between two levels of the terrain: wait for `idle`, which also covers
  // queued tiles and redraws. A playing video redraws without end and never goes idle: it waits for the tiles only.
  await page.waitForFunction(kind => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    if (!t || t.tilesLoaded <= 4) return false
    return kind === 'video' ? t.tilesDownloading === 0 && t.tilesParsing === 0 && t.imageryCompositionsPending === 0 && window.earth.terrain.tiles.stats.queued === 0 && !window.earth.terrain.tiles.isLoading : inspection.idle
  }, kind, { timeout: 240_000, polling: 500 })
  // `idle` does not cover the picture's own download: give it time to arrive and redraw.
  await page.waitForTimeout(3000)
  // Where picture coordinates (u right, v up) land on the screen.
  const locate = () => page.evaluate(() => {
    const mercator = ([longitude, latitude]) => [(longitude + 180) / 360, 0.5 + Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / (2 * Math.PI)]
    const [tl, tr, br, bl] = window.georefCorners.map(mercator)
    // Heckbert's unit square to quad: bottom-left, bottom-right, top-right, top-left.
    const [p0, p1, p2, p3] = [bl, br, tr, tl]
    const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dx3 = p0[0] - p1[0] + p2[0] - p3[0]
    const dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1], dy3 = p0[1] - p1[1] + p2[1] - p3[1]
    const den = dx1 * dy2 - dy1 * dx2
    const g = (dx3 * dy2 - dy3 * dx2) / den, h = (dx1 * dy3 - dy1 * dx3) / den
    const a = p1[0] - p0[0] + g * p1[0], b = p3[0] - p0[0] + h * p3[0], d = p1[1] - p0[1] + g * p1[1], e = p3[1] - p0[1] + h * p3[1]
    const at = (u, v) => {
      const w = g * u + h * v + 1
      const x = (a * u + b * v + p0[0]) / w, y = (d * u + e * v + p0[1]) / w
      const longitude = x * 360 - 180, latitude = (Math.atan(Math.sinh((y - 0.5) * 2 * Math.PI)) * 180) / Math.PI
      const position = { longitudeDegrees: longitude, latitudeDegrees: latitude }
      const projected = window.earth.project({ ...position, heightMeters: window.earth.queryTerrainElevation(position) ?? 0 })
      return [projected.xPixels, projected.yPixels]
    }
    return { at: { red: at(0.25, 0.75), green: at(0.75, 0.75), blue: at(0.75, 0.25), yellow: at(0.25, 0.25), marginInside: at(0.25, 0.94), marginOutside: at(0.25, 0.985), centre: at(0.5, 0.5), outsideAbove: at(0.25, 1.05) } }
  })
  const sample = async (points) => {
    const png = await page.screenshot()
    return analyse(page, png, `
      const points = ${JSON.stringify(points)}
      const out = {}
      for (const [name, [x, y]] of Object.entries(points)) {
        let r = 0, g = 0, b = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const i = ((Math.round(y) + dy) * width + Math.round(x) + dx) * 4
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
        }
        out[name] = [r / n, g / n, b / n]
      }
      return out
    `)
  }
  const { at } = await locate()
  const result = { check: `georeferenced ${label}`, errors }
  const first = await sample(at)
  result.first = first
  if (kind === 'image') {
    const dominant = ([r, g, b]) => r > 1.7 * Math.max(g, b) ? 'red' : g > 1.5 * Math.max(r, b) ? 'green' : b > 1.7 * Math.max(r, g) ? 'blue' : r > 1.7 * b && g > 1.7 * b ? 'yellow' : r > 120 && g > 120 && b > 120 ? 'white' : 'other'
    result.colours = Object.fromEntries(Object.entries(first).map(([name, rgb]) => [name, dominant(rgb)]))
    writeFileSync(new URL('georef-image.png', OUT), await page.screenshot())
  } else {
    // Redraws follow the compositor's speed (slow on SwiftShader): sample until the colour has moved.
    const hues = [first.centre]
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500)
      hues.push((await sample({ centre: at.centre })).centre)
      if (Math.max(...hues.map(rgb => Math.max(...rgb.map((value, channel) => Math.abs(value - hues[0][channel]))))) > 40) break
    }
    result.hues = hues
    result.maximumHueChange = Math.max(...hues.map(rgb => Math.max(...rgb.map((value, channel) => Math.abs(value - hues[0][channel])))))
    writeFileSync(new URL('georef-video.png', OUT), await page.screenshot())
  }
  await page.close()
  results.push(result)
}

/**
 * Keyboard and accessibility: the map is a labelled region in the tab order, keys move the camera, a double
 * click zooms, `prefers-reduced-motion` switches the view at once, and axe-core finds no violation with the
 * controls, markers and an open popup on the page.
 */
async function accessibility() {
  const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
  const runAxe = async page => {
    await page.addScriptTag({ path: axePath })
    return page.evaluate(async () => {
      // WCAG 2.2 A and AA rules. Markers faded behind terrain (`occludedOpacity`) are left out on purpose: the fade
      // shows they are hidden, as MapLibre's `opacityWhenCovered` does, so their text is not meant to be read there.
      const context = { exclude: [['[data-visibility="occluded"]']] }
      const options = { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }
      const { violations } = await window.axe.run(context, options)
      return violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target.join(' ')).slice(0, 5) }))
    })
  }
  const { page, errors } = await open('/?fixtures&stats=0&atmosphere=0&markers&camera=-90,0,3900,40000,0,-60', { width: 1000, height: 640 })
  await page.waitForFunction(() => window.earth?.inspect().loaded === true && window.markers?.peak?.visibility === 'visible', null, { timeout: 240_000, polling: 500 })
  const settle = () => page.waitForFunction(() => !window.earth.camera.animating && !window.earth.view.transitioning, null, { timeout: 60_000 })
  const view = () => page.evaluate(() => window.earth.camera.getView())
  const result = { check: 'keyboard and accessibility' }

  result.region = await page.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Map"]')
    return region === null ? null : { tabIndex: region.tabIndex, holdsCanvas: region.querySelector('canvas') !== null }
  })
  // Tab from the page's start reaches the map (the "Examples" link comes first)
  await page.evaluate(() => document.activeElement?.blur())
  for (let press = 0; press < 3 && !(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'region')); press++) await page.keyboard.press('Tab')
  result.focusedByTab = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'region')
  await page.focus('[role="region"][aria-label="Map"]')

  await settle()
  const start = await view()
  await page.keyboard.press('ArrowRight')
  await settle()
  const panned = await view()
  result.panEastDegrees = panned.longitudeDegrees - start.longitudeDegrees
  result.panLatitudeChange = panned.latitudeDegrees - start.latitudeDegrees
  await page.keyboard.press('=')
  await settle()
  result.zoomInDelta = (await view()).zoom - panned.zoom
  const beforeTurn = await view()
  await page.keyboard.press('Shift+ArrowRight')
  await settle()
  const turned = await view()
  result.turnDegrees = turned.headingDegrees - beforeTurn.headingDegrees
  await page.keyboard.press('Shift+ArrowUp')
  await settle()
  result.tiltDegrees = (await view()).pitchDegrees - turned.pitchDegrees
  const beforeZoomOut = await view()
  await page.keyboard.press('-')
  await page.keyboard.press('-')
  await settle()
  result.twoZoomOutsDelta = (await view()).zoom - beforeZoomOut.zoom
  result.pageScrolled = await page.evaluate(() => scrollX !== 0 || scrollY !== 0)

  // Double click zooms in on the point (away from the markers in the middle)
  const beforeDoubleClick = await view()
  await page.mouse.dblclick(250, 480)
  await page.waitForTimeout(800)
  await settle()
  result.doubleClickZoomDelta = (await view()).zoom - beforeDoubleClick.zoom

  // axe with the controls and markers, then with a popup open (opened from the keyboard)
  result.violations = await runAxe(page)
  await page.focus('.react-three-earth-marker[aria-label="Fixture peak"]')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.react-three-earth-popup')?.dataset.visibility === 'visible', null, { timeout: 10_000 })
  result.popupViolations = await runAxe(page)
  writeFileSync(new URL('accessibility.png', OUT), await page.screenshot())
  await page.close()

  // Reduced motion: the view button switches at once
  const reduced = await open('/?fixtures&stats=0&atmosphere=0', { width: 1000, height: 640 })
  await reduced.page.emulateMedia({ reducedMotion: 'reduce' })
  await reduced.page.waitForFunction(() => window.earth?.camera.ready === true && document.querySelector('button[aria-label="Switch to the flat map"]'), null, { timeout: 120_000 })
  await reduced.page.evaluate(() => {
    window.morphFrames = []
    window.earth.addEventListener('update', () => window.morphFrames.push(window.earth.view.morph))
  })
  await reduced.page.click('button[aria-label="Switch to the flat map"]')
  await reduced.page.waitForFunction(() => window.earth.view.mode === '2d' && !window.earth.view.transitioning, null, { timeout: 30_000 })
  result.reducedMotionInBetweenFrames = await reduced.page.evaluate(() => window.morphFrames.filter(morph => morph > 0 && morph < 1).length)
  await reduced.page.close()

  results.push({ ...result, errors: [...errors, ...reduced.errors] })
}

/**
 * Box zoom and cooperative gestures. Shift + drag zooms to the box; with `?cooperative` the wheel zooms only with
 * Ctrl and one finger leaves the map alone (with a hint) while two fingers pinch it. Without it, one finger still
 * pans, as before.
 */
async function gestures() {
  const result = { check: 'box zoom and cooperative gestures' }
  const waitLoaded = page => page.waitForFunction(() => window.earth?.inspect().loaded === true, null, { timeout: 240_000, polling: 500 })
  const settle = page => page.waitForFunction(() => !window.earth.camera.animating && !window.earth.view.transitioning, null, { timeout: 60_000 })
  const view = page => page.evaluate(() => window.earth.camera.getView())

  // Box zoom, on a desktop
  const desktop = await open('/?fixtures&stats=0&atmosphere=0&camera=-90,0,0,60000,0,-80', { width: 1000, height: 640 })
  await waitLoaded(desktop.page)
  await settle(desktop.page)
  const before = await view(desktop.page)
  const boxCentre = await desktop.page.evaluate(() => window.earth.camera.unproject({ xPixels: 400, yPixels: 260 }))
  await desktop.page.evaluate(() => { window.boxMapClicks = 0; window.earth.addEventListener('click', () => window.boxMapClicks++) })
  await desktop.page.keyboard.down('Shift')
  await desktop.page.mouse.move(300, 200)
  await desktop.page.mouse.down()
  await desktop.page.mouse.move(400, 260, { steps: 4 })
  await desktop.page.mouse.move(500, 320, { steps: 4 })
  result.boxShown = await desktop.page.evaluate(() => document.querySelector('.react-three-earth-box-zoom') !== null)
  writeFileSync(new URL('box-zoom.png', OUT), await desktop.page.screenshot())
  await desktop.page.mouse.up()
  await desktop.page.keyboard.up('Shift')
  await desktop.page.waitForTimeout(300)
  await settle(desktop.page)
  const after = await view(desktop.page)
  result.boxZoomDelta = after.zoom - before.zoom
  result.boxCentreOffsetDegrees = Math.hypot(after.longitudeDegrees - boxCentre.longitudeDegrees, after.latitudeDegrees - boxCentre.latitudeDegrees)
  result.boxHeadingChange = after.headingDegrees - before.headingDegrees
  result.boxRemoved = await desktop.page.evaluate(() => document.querySelector('.react-three-earth-box-zoom') === null)
  result.boxMapClicks = await desktop.page.evaluate(() => window.boxMapClicks)
  await desktop.page.close()

  // Cooperative gestures, wheel
  const wheel = await open('/?fixtures&stats=0&atmosphere=0&cooperative&camera=-90,0,0,60000,0,-80', { width: 1000, height: 640 })
  await waitLoaded(wheel.page)
  await settle(wheel.page)
  const wheelStart = await view(wheel.page)
  await wheel.page.mouse.move(500, 320)
  await wheel.page.mouse.wheel(0, -400)
  await wheel.page.waitForTimeout(500)
  result.plainWheelZoomDelta = (await view(wheel.page)).zoom - wheelStart.zoom
  result.wheelHint = await wheel.page.evaluate(() => {
    const hint = document.querySelector('.react-three-earth-cooperative-hint')
    return hint === null ? null : { text: hint.textContent, opacity: hint.style.opacity, role: hint.getAttribute('role') }
  })
  writeFileSync(new URL('cooperative-hint.png', OUT), await wheel.page.screenshot())
  await wheel.page.keyboard.down('Control')
  await wheel.page.mouse.wheel(0, -400)
  await wheel.page.keyboard.up('Control')
  await wheel.page.waitForTimeout(1000)
  result.controlWheelZoomDelta = (await view(wheel.page)).zoom - wheelStart.zoom
  await wheel.page.close()

  // Touch, on a phone: CDP touch events, as a finger would send them
  const touchRun = async query => {
    const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    const page = await context.newPage()
    await page.goto(BASE + `/?fixtures&stats=0&atmosphere=0${query}&camera=-90,0,0,60000,0,-80`)
    await waitLoaded(page)
    await settle(page)
    const cdp = await context.newCDPSession(page)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
    const settleFrames = () => page.waitForTimeout(600)
    const start = await view(page)
    // One finger drags 150 pixels up
    await touch('touchStart', [[195, 450]])
    for (let step = 1; step <= 10; step++) await touch('touchMove', [[195, 450 - step * 15]])
    await touch('touchEnd', [])
    await settleFrames()
    await settle(page)
    const afterOne = await view(page)
    const hint = await page.evaluate(() => document.querySelector('.react-three-earth-cooperative-hint')?.textContent ?? null)
    // Two fingers spread apart: zoom in
    await touch('touchStart', [[165, 350], [225, 350]])
    for (let step = 1; step <= 10; step++) await touch('touchMove', [[165 - step * 8, 350], [225 + step * 8, 350]])
    await touch('touchEnd', [])
    await settleFrames()
    await settle(page)
    const afterTwo = await view(page)
    await context.close()
    return {
      oneFingerMovedDegrees: Math.hypot(afterOne.longitudeDegrees - start.longitudeDegrees, afterOne.latitudeDegrees - start.latitudeDegrees),
      hint,
      pinchZoomDelta: afterTwo.zoom - afterOne.zoom,
    }
  }
  result.touchCooperative = await touchRun('&cooperative')
  result.touchDefault = await touchRun('')

  results.push({ ...result, errors: [...desktop.errors, ...wheel.errors] })
}

const only = process.argv[2]
try {
  if (want('precision')) {
    await precision(true)
    await precision(false)
  }
  if (want('map')) {
    await map(false)
    await map(true)
  }
  if (want('2d')) {
    await map(false, '2d')
    await map(true, '2d')
  }
  if (want('vector')) {
    await vectorMap('overview', '')
    await vectorMap('close', '&camera=,,,9000,,-50')
    await vectorMap('webgl2', '&camera=,,,9000,,-50&webgl')
  }
  if (want('patterns')) {
    await vectorPatterns('webgpu', '')
    await vectorPatterns('webgl2', '&webgl')
  }
  if (want('attribution')) await attribution()
  if (want('controls')) await controls()
  if (want('accessibility')) await accessibility()
  if (want('gestures')) await gestures()
  if (want('invalidate')) await vectorInvalidate()
  if (want('style')) await vectorStyleRuntime()
  if (want('geojson')) {
    await geoJsonSources('webgpu', '')
    await geoJsonSources('webgl2', '&webgl')
    await geoJsonSources('strict mode', '&strict')
  }
  if (want('heatmap')) {
    const view = '&view=2d&camera=139.12,35.37,0,40000,0,-90'
    await heatmaps('2d', view)
    await heatmaps('2d webgl2', `${view}&webgl`)
    await heatmaps('3d', '&camera=139.15,35.3,0,30000,20,-35')
  }
  if (want('query')) await featureQueries()
  if (want('afterburner')) await afterburnerChecks()
  if (want('camera')) await cameraAndEvents()
  if (want('markers')) await markers()
  if (want('animations')) await cameraAnimations()
  if (want('sdf')) {
    await sdfShapes('near, atmosphere off', '&atmosphere=0')
    await sdfShapes('near, atmosphere on', '', { distanceMeters: 3000, pitchDegrees: -10 })
    await sdfShapes('far, atmosphere on', '', { distanceMeters: 40000, pitchDegrees: -10 })
    await sdfShapes('2d', '&atmosphere=0', { pitchDegrees: -60, view: '2d' })
    await sdfShapes('webgl2', '&atmosphere=0&webgl')
    await sdfShapes('strict mode', '&atmosphere=0&strict')
  }
  if (want('layers')) {
    await styleLayerTypes('webgpu', '')
    await styleLayerTypes('webgl2', '&webgl')
    await styleLayerTypes('registered late', '', { late: true })
  }
  if (want('relief')) {
    const fuji = '&camera=138.75,35.42,0,15000,0,-89&view=2d'
    await reliefMap('2d', `&map=relief${fuji}`)
    await reliefMap('2d webgl2', `&map=relief${fuji}&webgl`)
    await reliefMap('3d', '&map=relief&camera=138.75,35.42,0,15000,-20,-60')
    await reliefMap('hillshade seams', '&map=hillshade&view=2d&camera=-89.8,0.03,0,30000,0,-89', SEAMS)
    await reliefMap('hillshade seams webgl2', '&map=hillshade&view=2d&camera=-89.8,0.03,0,30000,0,-89&webgl', SEAMS)
    await reliefMap('hillshade globe', '&map=hillshade&camera=-90,0,3000,150000,0,-89', SEAMS)
  }
  if (want('georef')) {
    await georeferenced('image', '')
    await georeferenced('image', '&webgl', 'image webgl2')
    await georeferenced('video', '')
  }
  if (want('effects')) {
    await renderPassesAndDrapedLayers('webgpu', '&atmosphere=0')
    await renderPassesAndDrapedLayers('webgl2', '&atmosphere=0&webgl')
    await renderPassesAndDrapedLayers('atmosphere on', '')
  }
  if (want('labels')) {
    await screenSymbols('top-down', '&atmosphere=0&camera=138.74,35.36,0,40000,0,-90')
    await screenSymbols('pitched', '&atmosphere=0&camera=138.74,35.36,0,40000,0,-30')
    await screenSymbols('atmosphere on', '&camera=138.74,35.36,0,40000,0,-30')
    await screenSymbols('2d', '&atmosphere=0&view=2d&camera=138.74,35.36,0,40000,0,-90')
    await screenSymbols('webgl2', '&atmosphere=0&webgl&camera=138.74,35.36,0,40000,0,-30')
    await screenSymbols('strict mode', '&atmosphere=0&strict&camera=138.74,35.36,0,40000,0,-30')
    await screenSymbols('draped', '&atmosphere=0&symbols=draped&camera=138.74,35.36,0,40000,0,-30')
  }
  if (want('symbol-effects')) {
    await symbolEffects('webgpu', '')
    await symbolEffects('webgl2', '&webgl')
  }
  if (want('scripts')) {
    await scriptLabels('top-down', '&atmosphere=0&camera=138.66,35.37,0,40000,0,-90')
    await scriptLabels('webgl2', '&atmosphere=0&webgl&camera=138.66,35.37,0,40000,0,-90')
  }
  if (want('buildings')) {
    // Pitched from the south-west, close: walls, roofs, the courtyard and the glass tower.
    const pitched = '&camera=-90,0,3900,700,20,-25'
    await buildings('pitched', `&atmosphere=0${pitched}`)
    await buildings('top-down', '&atmosphere=0&camera=-90,0,3900,1200,0,-90')
    // Midday at -90° (19:00 UTC): lit by the sun, hazed.
    await buildings('atmosphere on', `&date=2026-11-22T19:00:00Z${pitched}`)
    await buildings('2d', '&atmosphere=0&view=2d&camera=-90,0,3900,1200,20,-90')
    await buildings('webgl2', `&atmosphere=0&webgl${pitched}`)
    await buildings('strict mode', `&atmosphere=0&strict${pitched}`)
    await buildings('draped', `&atmosphere=0&extrusions=draped${pitched}`)
  }
  if (want('roads')) {
    // Without the town grid and from zoom 11 (the road-label minzoom), road names win room: along their roads, glyph by glyph.
    await screenSymbols('road names, pitched', '&atmosphere=0&camera=138.74,35.36,0,12000,0,-30', 'vector')
    await screenSymbols('road names, top-down', '&atmosphere=0&camera=138.74,35.36,0,12000,0,-90', 'vector')
  }
  if (want('dem')) {
    await rasterDemTerrain('heights', '&camera=-90,0,0,400000,0,-90', { heights: true })
    await rasterDemTerrain('heights, quantized-mesh for comparison', '&terrain=quantized-mesh&camera=-90,0,0,400000,0,-90', { heights: true })
    await rasterDemTerrain('pitched', '&camera=-90,0,0,80000,30,-25')
    await rasterDemTerrain('pitched webgl2', '&camera=-90,0,0,80000,30,-25&webgl')
    await rasterDemTerrain('north pole', '&camera=0,90,0,6000000,0,-90')
    await rasterDemTerrain('2d', '&camera=-90,0,0,80000,30,-40&view=2d')
  }
  if (want('style-root')) await styleRoot()
  if (want('exaggeration')) {
    await terrainExaggeration('raster-dem', '&terrain=dem&exaggeration=2')
    await terrainExaggeration('quantized-mesh', '&exaggeration=2')
    await terrainExaggeration('2d', '&terrain=dem&exaggeration=2&view=2d')
  }
  if (want('draw')) {
    await drawing('globe, mouse')
    await drawing('globe, touch', { touch: true })
    await drawing('flat map, touch', { touch: true, flat: true })
    await editing('globe, mouse')
    await editing('globe, touch', { touch: true })
    await editing('flat map, touch', { touch: true, flat: true })
    await shapes('globe, mouse')
    await transforming('globe, mouse')
    await transforming('flat map, touch', { touch: true, flat: true })
    await shapes('flat map, touch', { touch: true, flat: true })
    await solidsOverSky()
  }
  if (want('examples')) {
    await galleryExample('city')
    await galleryExample('labels', '', async (page, idle) => {
      await page.getByRole('button', { name: 'Vertical Japanese and Chinese' }).click()
      await page.waitForTimeout(500)
      await idle()
      await page.waitForTimeout(1500)
      // A vertical label is taller than wide.
      const tokyo = await page.evaluate(() => window.earth.terrain.getScreenLabels().find(label => label.text === '東京都庁'))
      return { verticalLabel: tokyo === undefined ? null : { width: tokyo.box[2] - tokyo.box[0], height: tokyo.box[3] - tokyo.box[1] } }
    })
    await galleryExample('geojson', '&camera=86,28.3,0,400000,0,-90', async page => {
      // Manaslu stands alone at this zoom: a click on it opens its popup.
      const point = await page.evaluate(() => window.earth.project({ longitudeDegrees: 84.5597, latitudeDegrees: 28.5494 }))
      await page.mouse.click(point.xPixels, point.yPixels)
      await page.waitForTimeout(1000)
      return { popup: await page.evaluate(() => document.querySelector('[role=dialog]')?.textContent ?? null) }
    })
    await galleryExample('heatmap')
    await galleryExample('terrain', '', async (page, idle) => {
      await page.locator('input[type=range]').fill('3')
      await page.getByRole('button', { name: 'Map and hillshade' }).click()
      await page.waitForTimeout(500)
      await idle()
      return { exaggeration: await page.evaluate(() => window.earth.terrain.exaggeration) }
    })
    await galleryExample('overlay', '', async (page, idle) => {
      const radarShare = async () => {
        await idle()
        await page.waitForTimeout(1000)
        return analyse(page, await page.screenshot(), `
          // Radar colours over the green fixture imagery, below the card: more red or blue than green. The centre
          // of the rain moves between frames.
          let radar = 0, sumX = 0
          for (let y = Math.floor(height / 3); y < height - 40; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4
              if (px[i] > px[i + 1] + 15 || px[i + 2] > px[i + 1] + 15) { radar++; sumX += x }
            }
          }
          return { share: radar / (width * height), centreX: radar === 0 ? null : sumX / radar }
        `)
      }
      const shown = await radarShare()
      await page.getByRole('button', { name: 'Play' }).click()
      await page.waitForTimeout(2000)
      await page.getByRole('button', { name: 'Pause' }).click()
      const played = await radarShare()
      await page.locator('input[type=range]').fill('0')
      const hidden = await radarShare()
      return { radar: { shown, played, hidden } }
    })
    await galleryExample('night', '', async (page, idle) => {
      // Glow pixels by hue, before and after the glow colour changes.
      const glow = async () => analyse(page, await page.screenshot(), `
        let amber = 0, cyan = 0, magenta = 0
        for (let i = 0; i < px.length; i += 4) {
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
          if (r > 80 && r > g * 1.5 && r > b * 2) amber++
          if (b > 80 && g > 60 && b > r * 2) cyan++
          // The neon outline (#ff2bd6) around the place names.
          if (r > 170 && b > 150 && g < 110) magenta++
        }
        return { amber: amber / (width * height), cyan: cyan / (width * height), magenta: magenta / (width * height) }
      `)
      const before = await glow()
      await page.getByRole('button', { name: 'Cyan glow' }).click()
      // The new paint reprocesses every tile of the layer: wait for the cyan, up to about 15 s.
      let after = null
      for (let attempt = 0; attempt < 10 && !(after?.cyan > 0.01); attempt++) {
        await page.waitForTimeout(1000)
        await idle()
        after = await glow()
      }
      return { glow: { before, after } }
    })
    await galleryExample('embedded', '', async page => {
      // A plain wheel over the map scrolls the page and leaves the camera where it was.
      const before = await page.evaluate(() => ({ scroll: scrollY, distance: window.earth.camera.getView().distanceMeters }))
      const box = await page.locator('.example-embedded canvas').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(1500)
      const after = await page.evaluate(() => ({ scroll: scrollY, distance: window.earth.camera.getView().distanceMeters }))
      return { wheel: { before, after } }
    })
  }
} finally {
  await browser.close()
}
writeResults(results)
console.log(JSON.stringify(results, null, 2))
