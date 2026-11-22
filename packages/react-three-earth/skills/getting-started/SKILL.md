---
name: getting-started
description: >
  Use when building a 3D globe, map or Earth viewer from scratch with react-three-earth, in React Three Fiber
  or vanilla three.js: installing the package, creating the WebGPU canvas or renderer, adding terrain,
  raster imagery, the atmosphere and camera controls, and placing the first camera view.
metadata:
  purpose: 'Takes an agent from an empty project to a rendering globe with terrain, imagery, atmosphere and controls.'
  type: lifecycle
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/*.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/*.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/MapDemo.tsx'
---

# Getting started with react-three-earth

react-three-earth is a WebGPU map engine for three.js r187 and React Three Fiber v10. The scene is in
Earth-centred, Earth-fixed (ECEF, WGS84) metres. Every React component has a vanilla class of the same
name, so both paths below build the same thing.

## Setup

Install the exact versions the library is built against. three is pinned to r187, R3F to v10 alpha.

```sh
pnpm add react-three-earth three@0.187.0 @react-three/fiber@10.0.0-alpha.6 @react-three/tsl@10.0.0-alpha.6 react@19.3.1 react-dom@19.3.1
pnpm add -D @types/three@0.187.0
```

Vanilla three.js only needs `react-three-earth` and `three@0.187.0`.

## Core Patterns

### Render a globe in React Three Fiber

```tsx
import { Canvas, useThree } from '@react-three/fiber'
import { prefersWebGLBackend, setCameraView } from 'react-three-earth'
import { Atmosphere, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain } from 'react-three-earth/react'
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
          <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" />
        </Terrain>
        <Imagery>
          <RasterTileSource url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        </Imagery>
        <Atmosphere />
        <EarthControls />
      </Earth>
    </Canvas>
  )
}
```

The canvas needs a sized parent: give `html, body, #root` `height: 100%` and `margin: 0`. The library
draws no attribution: render the credit your tile providers require next to the canvas, outside
`<Canvas>`, for example
`<div style={{ position: 'fixed', right: 4, bottom: 4 }}>© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</div>`.

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
- `<EarthControls>`: orbit, pan and zoom with mouse or touch.

### Render the same globe in vanilla three.js

```ts
import { AgXToneMapping, PerspectiveCamera, Scene, Timer } from 'three'
import { pass } from 'three/tsl'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import { Atmosphere, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain, prefersWebGLBackend, setCameraView } from 'react-three-earth'

const renderer = new WebGPURenderer({ antialias: true, reversedDepthBuffer: true, forceWebGL: prefersWebGLBackend() })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.append(renderer.domElement)
await renderer.init()

const scene = new Scene()
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e8)
setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: 60_000, pitchDegrees: -25 })

const earth = new Earth()
earth.connect(renderer)
scene.add(earth)

const terrain = new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://terrain.reearth.land/cesium-mesh/ellipsoid/' })] })
earth.setTerrain(terrain)
earth.addImagery(new Imagery({ sources: [new RasterTileSource({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' })] }))

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
and `controls.dispose()` on teardown.

### Expose the Earth to agents and tests

`earth.inspect()` returns plain JSON: tiles loaded and visible, memory, imagery work, atmosphere state.
Put it on `window` in development so an agent or a Playwright test can read it.

```tsx
import type { Earth } from 'react-three-earth'
import { useEarth } from 'react-three-earth/react'
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

React components live in `react-three-earth/react`. The root entry `react-three-earth` exports the
vanilla classes of the same names: `<Earth>` from the root is a three.js `Group` class, not a component.
Helpers such as `setCameraView` and `toCartesian` are only in the root entry.

### HIGH: Installing another three or R3F version

The library pins `three >=0.187.0 <0.188.0` and R3F v10. Two copies of three in the bundle break
`instanceof` checks and node materials silently. Check with `pnpm why three`.

### MEDIUM: Leaving out `reversedDepthBuffer: true`

The atmosphere logs `create the renderer with reversedDepthBuffer: true` and distant terrain shows haze
bands from orbit. A logarithmic depth buffer also works.

### MEDIUM: A camera far plane under planet scale

With `far` below about 2e7 m the globe is clipped before the controls refit it on the first frame. Start
with `near: 1, far: 1e8`.

## Completion

- The page shows terrain with imagery and a blue sky, and the console has no errors.
- `earth.inspect().terrain.tilesVisible` is above 0 and `earth.inspect().atmosphere.ready` turns true
  after a few seconds (the lookup textures are generated on the GPU at startup).
- If the globe is blank or black, load the `inspect-and-debug` skill.

Next steps: other terrain and imagery providers are in `terrain-and-imagery-sources`, placing your own
objects in `coordinates-and-units`, reading state for UI in `react-hooks-and-frame-loop`.
