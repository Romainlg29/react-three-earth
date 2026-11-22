---
name: inspect-and-debug
description: >
  Use when a react-three-earth globe is blank, black, missing tiles or sky, looks wrong, or is slow or
  uses too much memory: reading earth.inspect(), diagnosing common setup errors, tuning tile detail,
  memory and imagery budgets for phones, and checking a map in an automated browser test.
metadata:
  purpose: 'Gives a symptom-to-cause table, the inspect() JSON fields, the performance knobs, and a headed-Chromium WebGPU test recipe.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
  - 'Romainlg29/react-three-earth:apps/playground/tests/run.mjs'
  - 'Romainlg29/react-three-earth:docs/spike/SPIKE.md'
requires:
  - getting-started
---

# Inspect and debug

Read `getting-started` first. Start every investigation with `earth.inspect()`: it returns plain JSON,
cheap enough to poll, so read it instead of guessing from screenshots.

## Core Patterns

### Read the state

```ts
import type { Earth } from 'react-three-earth'

export function report(earth: Earth) {
  const { terrain, atmosphere, imageryLayers } = earth.inspect()
  return {
    tiles: terrain && `${terrain.tilesVisible} visible / ${terrain.tilesLoaded} loaded, ${terrain.tilesDownloading} downloading`,
    memory: terrain && `${(terrain.memoryUsedBytes / 2 ** 20).toFixed(0)} of ${(terrain.memoryBudgetBytes / 2 ** 20).toFixed(0)} MB`,
    imagery: terrain && `${imageryLayers} layers, ${terrain.imageryCompositionsPending} compositions pending, ${terrain.imageryMainThreadMilliseconds.toFixed(1)} ms last frame`,
    atmosphere: atmosphere && (atmosphere.ready ? `ready in ${atmosphere.generationTimeMilliseconds} ms` : 'generating'),
  }
}
```

| Field | Meaning |
| --- | --- |
| `terrain` | null when no `<Terrain>` has a source |
| `terrain.url` | terrain root URL in use |
| `tilesLoaded`, `tilesVisible` | tiles in memory, tiles drawn this frame |
| `tilesDownloading`, `tilesParsing` | work in flight; both 0 means the view is settled |
| `memoryUsedBytes`, `memoryBudgetBytes` | tile cache use against `memoryBudgetBytes` |
| `imageryTilesComposited`, `imageryMainThreadMilliseconds` | imagery GPU composition over the last frame |
| `imageryCompositionsPending` | compositions waiting for a later frame's budget |
| `imageryLayers` | `<Imagery>` layers with at least one source |
| `atmosphere` | null without `<Atmosphere>`; `ready` turns true once lookup textures exist |

In React, get the Earth with `useEarth()`; for a HUD use `useEarthState` (see
`react-hooks-and-frame-loop`).

### Diagnose by symptom

| Symptom | Check | Likely cause and fix |
| --- | --- | --- |
| Error `useEarth: call it inside <Earth>` | component tree | move the component inside `<Earth>` |
| Error `must sit inside <Imagery>` / `<Terrain>` | tree | put the source component in its layer |
| Nothing at all, `terrain` is null | `inspect().terrain` | `<Terrain>` has no source child |
| `tilesLoaded` stays 0, network errors | DevTools network | wrong terrain URL (it must hold `layer.json`), CORS, or offline |
| Terrain is black | lights | no `<Atmosphere>` and no lights: add one or the other |
| Terrain grey, no imagery | `imageryLayers`, network | `<Imagery>` missing a source, wrong template, `levels` past the server's max zoom (404s) |
| No sky for the first seconds | `atmosphere.ready` | lookup textures still generating; wait |
| Haze bands from orbit, console warning | renderer options | `reversedDepthBuffer: true` on the renderer |
| Globe clipped or flickering at start | camera | `far` below planet scale; use `near: 1, far: 1e8` |
| Objects jitter close up | `renderer.highPrecision` | must be true (`<Earth>` sets it); keep vertices local, position objects |
| Errors about `instanceof` or node materials | `pnpm why three` | two copies of three; pin `three@0.187.0` |
| Blank in headless Chromium | browser flags | WebGPU needs a headed browser, see the test recipe |

### Tune performance

| Knob | Where | Effect |
| --- | --- | --- |
| `errorTargetPixels` (default 2, from 3d-tiles-renderer's recommended quantized-mesh settings) | `<Terrain>` | higher loads fewer, coarser tiles; try 4 to 8 on phones |
| `memoryBudgetBytes` (default 300 MB) | `<Terrain>` | tile cache ceiling; lower on low-memory phones |
| `imageryCompositionBudgetMilliseconds` (default 2) | `<Terrain>` | main-thread time per frame for imagery composition; lower smooths panning, higher fills imagery faster |
| `dpr={[1, 2]}` | `<Canvas>` | caps pixel ratio; 3x phones otherwise render 2.25 times the pixels |
| `antialias` | `<Canvas renderer>` | MSAA costs fill rate on phones |
| `frameloop="demand"` | `<Canvas>` | no rendering when idle (see `react-hooks-and-frame-loop` for the controls caveat) |
| atmosphere `textureSizesTexels` | `AtmosphereParameters` | smaller lookup textures generate faster |

Measure frame time on the target device, not on a desktop or a CPU rasteriser. `imageryMainThreadMilliseconds`
shows the library's own main-thread imagery cost per frame.

### Check a map in an automated browser (Playwright)

Headless Chromium drops the GPU instance when it presents a WebGPU canvas. Use a headed Chromium (under
`xvfb-run -a` on Linux CI) with SwiftShader's Vulkan backend:

```js no-check
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
})
const page = await browser.newPage()
await page.goto('http://localhost:5173')
// window.earth is set by the app in development (see getting-started)
await page.waitForFunction(() => {
  const state = window.earth?.inspect()
  return state?.terrain?.tilesLoaded > 0 && state.terrain.tilesDownloading === 0 && state.terrain.tilesParsing === 0 && state.atmosphere?.ready !== false
}, null, { timeout: 240_000, polling: 500 })
await page.screenshot({ path: 'map.png' })
```

SwiftShader is a CPU rasteriser: use it for correctness, never for frame times. Paced atmosphere generation
takes minutes on it: generate in one go with `generationBudgetMillisecondsPerFrame={Infinity}`.

## Common Mistakes

### HIGH: Judging performance on SwiftShader or a desktop GPU

Numbers from CI or a laptop say nothing about a Pixel or an iPhone. Profile on the device.

### HIGH: Polling `inspect()` into React state every frame

See `react-hooks-and-frame-loop`: use `useEarthState` with a primitive and a low `hz`.

### MEDIUM: Screenshotting before tiles settle

Wait for `tilesDownloading === 0 && tilesParsing === 0`, then a few more frames for tile fades and
imagery composition, as the library's own browser checks do.

## Completion

- The symptom is gone and `inspect()` shows settled tiles (`tilesDownloading` and `tilesParsing` at 0)
  and, with an atmosphere, `ready: true`.
- For performance work, note the device, the knob values and the frame time before and after.
