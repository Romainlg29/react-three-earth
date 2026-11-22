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
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/atmosphere/AtmosphereParameters.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/atmosphere/ephemeris.ts'
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

### Combine with your own post-processing (vanilla)

The atmosphere output is an ordinary TSL node, so wrap it:

```ts
import type { Atmosphere } from 'react-three-earth'
import type { Camera, Scene } from 'three'
import { pass } from 'three/tsl'
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu'

export function createPipeline(renderer: WebGPURenderer, scene: Scene, camera: Camera, atmosphere: Atmosphere) {
  const scenePass = pass(scene, camera)
  const pipeline = new RenderPipeline(renderer)
  const sky = atmosphere.createAerialPerspective(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), camera)
  pipeline.outputNode = sky // feed `sky` into bloom, vignette... here
  return pipeline
}
```

## Common Mistakes

### HIGH: Two components setting the render pipeline

`<Atmosphere>` owns R3F's render pipeline output through `useRenderPipeline`. Another component that
also sets `renderPipeline.outputNode` replaces the sky. Build one pipeline that chains effects after
`createAerialPerspective`.

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

The first frames have no sky. On a CPU rasteriser (SwiftShader in CI) paced generation takes minutes, so
tests pass `generationBudgetMillisecondsPerFrame={Infinity}`; on a real GPU it is much shorter. Wait for `ready`.

## Completion

- Sky pixels are blue in daylight, terrain far away is hazed, and the console has no warnings.
- `earth.inspect().atmosphere.ready` is true.
- Not available yet: stars, moon, clouds, shadow length.
