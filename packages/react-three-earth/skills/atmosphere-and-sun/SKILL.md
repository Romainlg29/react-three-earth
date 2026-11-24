---
name: atmosphere-and-sun
description: >
  Use when adding or tuning the sky, sunlight, haze, time of day or exposure of a react-three-earth globe:
  the Atmosphere component or class, the date that drives the sun, brightness and tone mapping, hazier or
  clearer air, another planet's atmosphere, combining the atmosphere with your own post-processing, or
  waiting for the atmosphere to be ready.
metadata:
  purpose: 'Explains the physically based atmosphere (Bruneton 2017 precomputed scattering), its lifecycle, the sun ephemeris, exposure, parameters and render-pipeline ownership.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Atmosphere.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Atmosphere.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthRenderPipeline.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/RenderPipeline.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/atmosphere/AtmosphereParameters.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/atmosphere/ephemeris.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/atmosphere/AerialPerspectiveNode.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/TranslucentPass.ts'
  - 'Romainlg29/react-three-earth:docs/spike/SPIKE.md'
requires:
  - getting-started
---

# Atmosphere and sun

Read `getting-started` first. The atmosphere is the library's own port of Bruneton's precomputed
atmospheric scattering (2017). It provides three things:

- a sun light (a `DirectionalLight`) that lights stock `MeshStandardNodeMaterial`s with attenuated
  sunlight plus sky irradiance as ambient,
- a post-processing node that draws the sky and sun and hazes distant geometry (aerial perspective),
- a solar ephemeris: the sun's direction is computed from `<Earth date>`.

Lookup textures are generated on the GPU at startup, within a GPU-time budget per frame
(`generationBudgetMillisecondsPerFrame`, default 4 ms), and cached in IndexedDB so later page loads with
the same parameters skip generation (`cache={false}` turns it off). Until they are ready, the scene renders
with neutral sunlight and no sky. No network request is made.

## Core Patterns

### Set the time of day

```tsx
import { Atmosphere, Earth } from 'react-three-earth/react'

export function Sunset() {
  // 16:00 in Tokyo on 22 November: low sun in the south-west
  return (
    <Earth date={new Date('2026-11-22T07:00:00Z')}>
      <Atmosphere />
    </Earth>
  )
}
```

`date` defaults to the time of mount and does not advance on its own. To animate time, change the prop,
or in a frame callback assign `earth.date = new Date(...)`; the sun is re-aimed every frame and costs
almost nothing.

```tsx
import { useEarthFrame } from 'react-three-earth/react'

/** Ten simulated minutes per real second. Render inside <Earth>. */
export function FastClock() {
  useEarthFrame((earth, deltaSeconds) => {
    earth.date = new Date(earth.date.getTime() + deltaSeconds * 600_000)
  })
  return null
}
```

### Adjust brightness

`<Atmosphere exposure={10} />` (10 is the default) sets AgX tone mapping and `renderer.toneMappingExposure` (restored on
unmount). Luminance is scaled so sunlight at the top of the atmosphere is about 1.5: about 10 suits
daylight, raise it towards 20 to 40 at dusk. Vanilla: set `renderer.toneMapping = AgXToneMapping` and
`renderer.toneMappingExposure` yourself.

### Change the air (haze, other planets)

```tsx
import { AtmosphereParameters } from 'react-three-earth'
import { Atmosphere } from 'react-three-earth/react'
import { Vector3 } from 'three'
import { useMemo } from 'react'

export function HazyAtmosphere() {
  const parameters = useMemo(
    () =>
      AtmosphereParameters.create({
        mieScatteringPerMeter: new Vector3(12e-6, 12e-6, 12e-6),
        mieExtinctionPerMeter: new Vector3(13.3e-6, 13.3e-6, 13.3e-6),
        mieScaleHeightMeters: 1600,
      }),
    [],
  )
  return <Atmosphere parameters={parameters} />
}
```

Fields are SI and documented in `AtmosphereParameters` (`rayleighScatteringPerMeter`,
`ozoneAbsorptionPerMeter`, `groundAlbedo`, `bottomRadiusMeters`, `scatteringOrders`,
`textureSizesTexels`...). The constructor takes no arguments: use `AtmosphereParameters.create({...})`.
`parameters` is read once at mount, because the lookup textures are generated from it. To change it,
remount with a React `key`.

### Wait for the atmosphere

```ts
import { Atmosphere } from 'react-three-earth'
import type { WebGPURenderer } from 'three/webgpu'

export async function startAtmosphere(renderer: WebGPURenderer) {
  const atmosphere = new Atmosphere()
  atmosphere.install(renderer)
  const ready = await atmosphere.ready // true when generated, false if disposed or failed
  console.log(ready, atmosphere.generationTimeMilliseconds)
  return atmosphere
}
```

From anywhere, `earth.inspect().atmosphere` is `{ ready, generationTimeMilliseconds }`, or null without
an atmosphere. Tests should wait for `ready === true` before taking screenshots.

### Combine with your own post-processing

`<Atmosphere>` runs an `EarthRenderPipeline` inside R3F's `useRenderPipeline`. It builds the output in three
stages: `scene` (the scene colour) → `radiance` (after aerial perspective and the sky, linear HDR) →
`display` (tone-mapped; the built-in FXAA runs last here). The easiest way to add an effect is a render
pass in a plugin (`context.registerRenderPass`, see the write-a-plugin skill): it joins the atmosphere's
pipeline, and the output is rebuilt once, not per frame.

Vanilla, attach an `EarthRenderPipeline` to your own three `RenderPipeline`:

```ts
import { EarthRenderPipeline, type Atmosphere, type Earth } from 'react-three-earth'
import type { Camera, Scene } from 'three'
import { pass } from 'three/tsl'
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu'

export function createPipeline(renderer: WebGPURenderer, scene: Scene, camera: Camera, earth: Earth, atmosphere: Atmosphere) {
  const renderPipeline = new RenderPipeline(renderer)
  const earthPipeline = new EarthRenderPipeline(earth, { atmosphere, antialiasing: 'fxaa' })
  earthPipeline.attach(renderPipeline, pass(scene, camera), camera) // render with renderPipeline.render()
  return { renderPipeline, earthPipeline } // earthPipeline.dispose() when done
}
```

To compose the atmosphere into a pipeline of your own (for example @aeronautic/core's `volume_pass`), pass
`renderPipeline={false}` and build from `useAtmosphere()` with `createAerialPerspective` or
`createBackdropNode`; `new EarthRenderPipeline(earth, { atmosphere }).buildOutput({ color, depth, camera })`
gives the staged output with plugin passes included.

## Common Mistakes

### HIGH: Two components setting the render pipeline

`<Atmosphere>` owns R3F's render pipeline output through `useRenderPipeline`. Another component that
also calls `useRenderPipeline` replaces the sky (R3F warns that more than one component configures it).
Register effects as render passes instead, or pass `renderPipeline={false}` and build the one pipeline
yourself. Without `<Atmosphere>`, `<Earth>` sets the pipeline while plugin render passes are registered: give
it `renderPipeline={false}` too (or call `useClaimRenderPipeline()` in your pipeline component).

### HIGH: Passing the post-processing camera to `createAerialPerspective`

Pass the scene camera. Inside a post-processing pass the renderer's camera is the full-screen quad's, so
every sky ray points the wrong way and the sky shows the ground colour.

### HIGH: Removing the lights' replacement

With `<Atmosphere>` removed, nothing lights the terrain and it renders black. Add `<ambientLight>` and
`<directionalLight>` in that case.

### MEDIUM: No `reversedDepthBuffer`

Haze bands on distant terrain seen from orbit, and a one-time warning. Create the renderer with
`reversedDepthBuffer: true` (or a logarithmic depth buffer).

### MEDIUM: Screenshots taken before `ready`

The first frames have no sky. On a CPU rasteriser (SwiftShader in automated browser tests) paced generation takes minutes, so
tests pass `generationBudgetMillisecondsPerFrame={Infinity}`; on a real GPU it is much shorter. Wait for `ready`.

### MEDIUM: Expecting haze on objects that write no depth

The aerial perspective hazes a pixel by its depth. Transparent meshes and screen labels write none: over the ground
they take the ground's haze, and against the sky they are drawn over it, unhazed but for their edges, so a
see-through face crossing the horizon changes shade along it. Put see-through solids on `TRANSLUCENT_LAYER` instead:
they are drawn after the atmosphere, hazed at their own distance and hidden behind nearer ground.

```ts
import { TRANSLUCENT_LAYER, type Earth } from 'react-three-earth'
import { Mesh, type BufferGeometry } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'

function addGlassBox(earth: Earth, geometry: BufferGeometry): () => void {
  const release = earth.renderPasses.retainTranslucentPass() // the pass runs while held
  // depthWrite stays true: the pass's depth buffer is its own, and gives the haze its distance.
  const mesh = new Mesh(geometry, new MeshStandardNodeMaterial({ transparent: true, opacity: 0.6 }))
  mesh.layers.set(TRANSLUCENT_LAYER) // out of the scene pass, which sees layer 0
  earth.add(mesh)
  return () => {
    mesh.removeFromParent()
    release()
  }
}
```

The pass needs an `EarthRenderPipeline` attached with the scene pass (`<Earth>` and `<Atmosphere>` host one; vanilla
apps call `attach(renderPipeline, scenePass, camera)`): without it, objects on the layer are not drawn. Lights the
camera sees light them. Other effects can haze themselves with `createAerialPerspectiveAlongRay`. A
`scene.background` colour covers the sky: leave it unset with an atmosphere.

## Completion

- Sky pixels are blue in daylight, terrain far away is hazed, and the console has no warnings.
- `earth.inspect().atmosphere.ready` is true.
- Not available yet: stars, moon, clouds, shadow length.
