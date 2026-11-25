---
name: getting-started
description: >
  Use when building a 3D globe, map or Earth viewer from scratch with @earthkit/globe, in React Three Fiber
  or vanilla three.js: installing the package, creating the WebGPU canvas or renderer, adding terrain,
  raster imagery, the atmosphere and camera controls, and placing the first camera view.
metadata:
  purpose: 'Takes an agent from an empty project to a rendering globe with terrain, imagery, atmosphere and controls.'
  type: lifecycle
  library: '@earthkit/globe'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/*.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/*.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/AttributionControl.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/MapDemo.tsx'
---

# Getting started with @earthkit/globe

`@earthkit/globe` is a WebGPU map engine for three.js r187 and React Three Fiber v10. The scene is in
Earth-centred, Earth-fixed (ECEF, WGS84) metres. Every React component has a vanilla class of the same
name, so both paths below build the same thing.

## Setup

Install the exact versions the library is built against. three is pinned to r187, R3F to v10 alpha.

```sh
pnpm add @earthkit/globe three@0.187.0 @react-three/fiber@10.0.0-alpha.6 @react-three/tsl@10.0.0-alpha.6 react@19.3.1 react-dom@19.3.1
pnpm add -D @types/three@0.187.0
```

Vanilla three.js only needs `@earthkit/globe` and `three@0.187.0`.

## Core Patterns

### Render a globe in React Three Fiber

```tsx
import { Canvas, useThree } from '@react-three/fiber'
import { prefersWebGLBackend, setCameraView } from '@earthkit/globe'
import { Atmosphere, AttributionControl, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain } from '@earthkit/globe/react'
import { useLayoutEffect } from 'react'

function InitialView() {
  const camera = useThree(state => state.camera)
  useLayoutEffect(() => {
    // Mount Fuji from 60 km, looking north-west and down 25 degrees
    setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: 60_000, headingDegrees: -40, pitchDegrees: -25 })
  }, [camera])
  return null
}

export function App() {
  return (
    <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL: prefersWebGLBackend() }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
      <Earth>
        <InitialView />
        <Terrain>
          <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" attribution="Terrain: Re:Earth Terrain, Mapterhorn" />
        </Terrain>
        <Imagery>
          <RasterTileSource
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
        </Imagery>
        <Atmosphere />
        <EarthControls />
        {/* Unstyled: place it yourself (a style or a class of yours) */}
        <AttributionControl style={{ position: 'absolute', right: 0, bottom: 0, background: '#fffc' }} />
      </Earth>
    </Canvas>
  )
}
```

The canvas needs a sized parent: give `html, body, #root` `height: 100%` and `margin: 0`.

Attribution is part of the setup: most tile providers require visible credit. Give every source an
`attribution` (plain text, or HTML where only `<a href="https://…">` links survive) and add
`<AttributionControl />`, which renders the credits of all sources, de-duplicated, as unstyled HTML over the
canvas: the library ships no CSS, so give it a `className` that places it (see "Show attribution" below).

What each piece does:

- `<Canvas>` is WebGPU by default in R3F v10, with a WebGL2 fallback. `forceWebGL: prefersWebGLBackend()`
  picks WebGL 2 in Safari and on iOS, where WebGPU costs far more CPU per frame (27 ms against 2.5 ms in
  Chrome on the same Mac). `reversedDepthBuffer: true` keeps the haze clean from orbit. `near`/`far` are starting values: `<EarthControls>` refits them every frame.
- `<Earth>` turns on `renderer.highPrecision` (64-bit model-view matrices, centimetre-stable anywhere on
  the planet) and updates tiles and the sun every frame. Everything else goes inside it.
- `<Terrain>` takes exactly one terrain source. `<Imagery>` stacks raster sources bottom to top.
- `<Atmosphere>` takes over the render pipeline: sky, sunlight and aerial perspective, with AgX tone
  mapping at `exposure={10}` by default (see `atmosphere-and-sun`). Without it, add
  your own lights (`<ambientLight>`, `<directionalLight>`), or the terrain renders black.
- `<EarthControls>`: orbit, pan and zoom with mouse or touch. On touch screens it works like Apple Maps: one finger pans, and two fingers pinch, twist and pan together, with the ground staying under them. A two-finger drag up or down tilts the globe. With the keyboard, once the map has focus: arrows pan, `+` / `-` zoom, `Shift` + arrows turn and tilt. `Shift` + drag zooms to a box; the right button rotates (see `map-controls`, also for cooperative gestures in a scrolling page).
- `<AttributionControl>`: the credit line as unstyled HTML, compact (a "ⓘ" button) on containers narrower than 640 px.

### Render the same globe in vanilla three.js

```ts
import { AgXToneMapping, PerspectiveCamera, Scene, Timer } from 'three'
import { pass } from 'three/tsl'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import { Atmosphere, AttributionControl, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain, appendAttribution, prefersWebGLBackend, setCameraView } from '@earthkit/globe'

const renderer = new WebGPURenderer({ antialias: true, reversedDepthBuffer: true, forceWebGL: prefersWebGLBackend() })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
const container = document.createElement('div')
container.style.cssText = 'position: relative; width: 100vw; height: 100vh'
document.body.append(container)
container.append(renderer.domElement)
await renderer.init()

const scene = new Scene()
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e8)
setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: 60_000, pitchDegrees: -25 })

const earth = new Earth()
earth.connect(renderer)
scene.add(earth)

const terrain = new Terrain({
  sources: [new QuantizedMeshSource({ url: 'https://terrain.reearth.land/cesium-mesh/ellipsoid/', attribution: 'Terrain: Re:Earth Terrain, Mapterhorn' })],
})
earth.setTerrain(terrain)
earth.addImagery(
  new Imagery({
    sources: [
      new RasterTileSource({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    ],
  }),
)
// The credits, drawn by you: text and safe links, kept up to date
const credits = document.createElement('div')
credits.style.cssText = 'position: absolute; right: 0; bottom: 0; font: 11px system-ui; background: #fffc'
container.append(credits)
const attributionControl = new AttributionControl({ earth, container, compact: false })
const stopAttribution = attributionControl.subscribe(state => appendAttribution(credits, state.entries))
appendAttribution(credits, attributionControl.getState().entries)

const atmosphere = new Atmosphere()
atmosphere.install(renderer)
earth.setAtmosphere(atmosphere)
renderer.toneMapping = AgXToneMapping
renderer.toneMappingExposure = 10

const scenePass = pass(scene, camera)
const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = atmosphere.createAerialPerspective(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), camera)

const controls = new EarthControls(earth, camera, renderer.domElement)
controls.enableDamping = true
controls.setEllipsoid(terrain.tiles.ellipsoid, terrain.tiles.group)

const timer = new Timer()
renderer.setAnimationLoop(() => {
  timer.update()
  controls.update(timer.getDelta()) // before earth.update, so tiles follow this frame's camera
  earth.update(camera, renderer)
  pipeline.render()
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
```

The order inside the loop matters: controls, then `earth.update`, then render. Without an atmosphere,
call `renderer.render(scene, camera)` instead of the pipeline and add lights. Call `earth.dispose()`
`stopAttribution()`, `credits.remove()` and `controls.dispose()` on teardown.

### Show attribution

`attribution` goes on every source (`QuantizedMeshSource`, `RasterTileSource`, `MapStyleSource`). A
`MapStyleSource` also reads the `attribution` of its style's vector sources and their TileJSON or PMTiles
metadata once the style has loaded, so a style from a provider usually needs no option. Credits are
de-duplicated and ordered terrain first, then imagery layers in order.

```tsx
import { AttributionControl, AttributionText, useAttributionControl } from '@earthkit/globe/react'

// Inside <Earth>. compact: undefined (automatic) | true (always a "ⓘ" button) | false (always the text)
export const Credits = () => (
  <AttributionControl className="credits" compact customAttribution="Flights: <a href='https://example.com/data'>Example data</a>" />
)

// Or markup of your own (inside <Controls>, which renders HTML from inside <Earth>)
export function MyCredits() {
  const attribution = useAttributionControl()
  return (
    <div {...attribution.groupProps}>
      {attribution.textVisible ? <AttributionText entries={attribution.entries} /> : null}
      <button {...attribution.toggleButtonProps}>ⓘ</button>
    </div>
  )
}
```

`<AttributionControl>` ships no CSS: its element has the classes `react-three-earth-controls react-three-earth-attribution`
plus yours, and holds a `role="group"` element with `.react-three-earth-attribution-text` and, in compact mode, the
`.react-three-earth-attribution-toggle` button (`hidden` otherwise; make `[hidden]` `display: none` if your CSS sets
`display`). `useAttributionControl` gives `entries` (each a list of `{ text, href? }` segments), `visible`, `compact`,
`textVisible`, `toggle`, and props for the group and the toggle. Vanilla: `new AttributionControl({ earth, container,
compact, customAttribution })` with `getState()` and `subscribe()`, and `appendAttribution(element, entries)` builds
the text and links; `earth.getAttributions()` returns the raw strings. Only text and `<a href>` links with `http` or
`https` URLs are kept; any other markup is dropped, so provider strings are safe to pass. Render segments as text and
`<a>` elements, never through `innerHTML`.

### Expose the Earth to agents and tests

`earth.inspect()` returns plain JSON: tiles loaded and visible, memory, imagery work, atmosphere state.
Put it on `window` in development so an agent or a Playwright test can read it.

```tsx
import type { Earth } from '@earthkit/globe'
import { useEarth } from '@earthkit/globe/react'
import { useLayoutEffect } from 'react'

declare global {
  interface Window {
    earth?: Earth
  }
}

export function ExposeEarth() {
  const earth = useEarth()
  useLayoutEffect(() => {
    window.earth = earth
  }, [earth])
  return null
}
```

Render `<ExposeEarth />` inside `<Earth>`, then wait for
`earth.inspect().terrain.tilesLoaded > 0 && earth.inspect().terrain.tilesDownloading === 0`.

## Common Mistakes

### HIGH: Putting layers outside `<Earth>`

`<Terrain>`, `<Imagery>`, `<Atmosphere>`, `<EarthControls>` and the hooks read the Earth from context and
throw `useEarth: call it inside <Earth>` otherwise. Source components throw
`<RasterTileSource> must sit inside <Imagery>` when placed directly under `<Earth>`.

### HIGH: Importing React components from the root entry

React components live in `@earthkit/globe/react`. The root entry `@earthkit/globe` exports the
vanilla classes of the same names: `<Earth>` from the root is a three.js `Group` class, not a component.
Helpers such as `setCameraView` and `toCartesian` are only in the root entry.

### HIGH: Installing another three or R3F version

The library pins `three >=0.187.0 <0.188.0` and R3F v10. Two copies of three in the bundle break
`instanceof` checks and node materials silently. Check with `pnpm why three`.

### MEDIUM: Shipping without attribution

Tile providers (OpenStreetMap among them) require visible credit. The library fetches nothing itself,
so it only shows what you give it: set `attribution` on each source and render `<AttributionControl />`.

### MEDIUM: Leaving out `reversedDepthBuffer: true`

The atmosphere logs `create the renderer with reversedDepthBuffer: true` and distant terrain shows haze
bands from orbit. A logarithmic depth buffer also works.

### MEDIUM: A camera far plane under planet scale

With `far` below about 2e7 m the globe is clipped before the controls refit it on the first frame. Start
with `near: 1, far: 1e8`.

## Completion

- The page shows terrain with imagery and a blue sky, and the console has no errors.
- The credit line shows each source's attribution: `earth.getAttributions()` is not empty.
- `earth.inspect().terrain.tilesVisible` is above 0 and `earth.inspect().atmosphere.ready` turns true
  after a few seconds (the lookup textures are generated on the GPU at startup).
- If the globe is blank or black, load the `inspect-and-debug` skill.

Next steps: other terrain and imagery providers are in `terrain-and-imagery-sources`, placing your own
objects in `coordinates-and-units`, reading state for UI in `react-hooks-and-frame-loop`.
