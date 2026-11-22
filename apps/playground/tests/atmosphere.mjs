// Generates the atmosphere lookup textures alone and prints timing and fingerprints as JSON.
// Usage: node tests/atmosphere.mjs [query...]   e.g. `webgl`, `cache`. Needs `pnpm dev` running.
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.PLAYGROUND_URL ?? 'http://localhost:5173'
const query = process.argv.slice(2)
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
})
const context = await browser.newContext()
const runs = []
// Two loads in the same browser profile: the second one can hit the persistent cache.
for (let run = 0; run < (query.includes('cache') ? 2 : 1); run++) {
  const page = await context.newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?test=atmosphere&${query.join('&')}`)
  await page.waitForFunction(() => window.atmosphereTest !== undefined, null, { timeout: 600_000, polling: 500 })
  const result = await page.evaluate(() => window.atmosphereTest)
  const intervals = result.frameIntervalsMilliseconds ?? []
  const sorted = [...intervals].sort((a, b) => a - b)
  runs.push({
    ...result,
    frameIntervalsMilliseconds: undefined,
    idleFrameIntervalsMilliseconds: undefined,
    frames: intervals.length,
    idleMedianMilliseconds: [...(result.idleFrameIntervalsMilliseconds ?? [])].sort((a, b) => a - b)[15],
    frameMedianMilliseconds: sorted[sorted.length >> 1],
    frameP95Milliseconds: sorted[Math.floor(sorted.length * 0.95)],
    frameMaxMilliseconds: sorted[sorted.length - 1],
    longestFrames: intervals.map((ms, frame) => [frame, Math.round(ms)]).sort((a, b) => b[1] - a[1]).slice(0, 8),
    errors,
  })
  await page.close()
}
console.log(JSON.stringify(runs, null, 1))
await browser.close()
