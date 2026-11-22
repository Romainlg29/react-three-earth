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

async function map(atmosphere) {
  // SwiftShader rasterises on the CPU, so paced generation would take minutes: generate in one go.
  const { page, errors } = await open(`/?fixtures&atmosphere=${atmosphere ? 1 : 0}&atmosphereBudget=Infinity`)
  await page.waitForFunction(() => {
    const inspection = window.earth?.inspect()
    const t = inspection?.terrain
    const atmosphereReady = inspection?.atmosphere === null || inspection?.atmosphere?.ready === true
    return t && t.tilesLoaded > 20 && t.tilesDownloading === 0 && t.tilesParsing === 0 && atmosphereReady
  }, null, { timeout: 240_000, polling: 500 })
  await page.waitForTimeout(3000) // overlays compose and tiles fade in
  const png = await page.screenshot()
  writeFileSync(new URL(`map-atmosphere-${atmosphere ? 'on' : 'off'}.png`, OUT), png)
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
  results.push({ check: `map with fixtures, atmosphere ${atmosphere ? 'on' : 'off'}`, ...stats, tilesLoaded: inspection.terrain.tilesLoaded, tilesVisible: inspection.terrain.tilesVisible, errors })
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
} finally {
  await browser.close()
}
writeFileSync(new URL('results.json', OUT), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
