---
name: water
description: >
  Use when an earthkit globe needs a sea, ocean, lakes or water that looks real or like a map: water coloured from its
  optics (chlorophyll, salinity), glossy from the wind with the sun's glint and sky reflection, whitecaps in a gale,
  the seafloor through shallow water, a flat light-blue map sea, presets (map, calm, breeze, open-ocean, storm,
  coastal), FFT waves from wind, fetch and temperature, changing the wind at runtime, the sea on the flat 2D map.
metadata:
  purpose: 'Documents @earthkit/water: the Water plugin and <Water> component, its settings and presets, the optics behind the colour (computeWaterOptics, surfaceRoughness, whitecapCoverage), and how it composes with imagery, terrain styles and the atmosphere.'
  type: framework
  framework: 'react'
  library: '@earthkit/water'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/water/src/Water.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/optics.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/presets.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/spectrum.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/WaveField.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/WaveSurface.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/WaveComputeField.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/foam.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/WaveMesh.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/waves/WaveProbe.ts'
  - 'Romainlg29/react-three-earth:packages/water/src/react/index.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/terrainWaterMask.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/terrainShadings.ts'
requires:
  - '@earthkit/globe#getting-started'
  - '@earthkit/globe#terrain-and-imagery-sources'
  - '@earthkit/globe#atmosphere-and-sun'
---

# Water

Read `@earthkit/globe#getting-started` first. `@earthkit/water` shades the terrain wherever it is water, as a plugin,
over the imagery and any terrain style. It needs a terrain source that says where the water is (`terrainWaterMask`):

- `QuantizedMeshSource` with a server that serves the quantized-mesh water mask (Cesium World Terrain does).
- `RasterDemSource`: heights at or below `seaLevelMeters` (default 0). With Terrarium, add `flattenBelowSeaLevel`.

Without a water mask nothing changes. Near the camera it draws waves (an FFT ocean, as normals: the coastline and the
terrain's geometry stay flat); farther off the wind's roughness stands for them.

## Setup

```tsx
import { Atmosphere, Earth, QuantizedMeshSource, Terrain } from '@earthkit/globe/react'
import { Water } from '@earthkit/water/react'

export function Globe({ url }: { url: string }) {
  return (
    <Earth>
      <Terrain>
        <QuantizedMeshSource url={url} />
      </Terrain>
      <Atmosphere />
      <Water preset="breeze" />
    </Earth>
  )
}
```

`<Water>` installs a `Water` plugin while mounted and applies its props as they change. Vanilla:

```ts
import type { Earth } from '@earthkit/globe'
import { Water } from '@earthkit/water'

export function addSea(earth: Earth): Water {
  const water = new Water({ preset: 'open-ocean' })
  earth.addPlugin(water) // earth.removePlugin(water) takes it off
  return water
}
```

## Core Patterns

### Presets

| Preset | Wind | Look |
| --- | --- | --- |
| `map` | — | flat light blue (`#a0c8f0`), matte, as street maps draw it |
| `calm` | 1.5 m/s | clear deep blue, a sharp sky reflection and sun glint |
| `breeze` (default) | 5 m/s | open ocean blue, a softer glint |
| `open-ocean` | 10 m/s | a broad glint, the first whitecaps (1 %) |
| `storm` | 20 m/s | a tenth of the sea white with foam |
| `coastal` | 4 m/s | phytoplankton-rich green-blue |

Settings override the preset: `<Water preset="calm" windSpeedMetersPerSecond={3} />`.

### Physical settings

- `windSpeedMetersPerSecond`: the gloss from the waves too small to draw (Cox & Munk), so the sun's glint widens as the
  wind rises, and whitecaps from 3 m/s (Monahan). Under `<Atmosphere>` the glossy sea mirrors the sky, Fresnel
  included: deep blue looking down, pale towards the horizon.
- `chlorophyllMilligramsPerCubicMeter`: the colour, from the absorption and scattering of seawater, phytoplankton and
  dissolved matter (ocean colour models). 0.03 deep blue gyres, 0.1 to 0.3 open ocean, 1 to 10 green-blue coasts.
- `salinityPartsPerThousand`: 35 sea, 0 fresh water (a little less scattering, lighter water).

### Waves

The physical presets draw waves near the camera (`waves`, default true but for `map`): a JONSWAP spectrum from the
wind's speed, `windDirectionDegrees` (where it blows from, default 270, a westerly) and `fetchKilometers` (open water it
has blown over: short fetch, short steep waves), dispersed through the water's density and surface tension
(`temperatureCelsius`, salinity: a small effect at the drawn scales). Four tiles of 800 m, 110 m, 15 m and 2.1 m are
simulated by FFT (64 texels a side on the CPU, 256 on the GPU, whose tiles then repeat far less) and tilt the surface's normal; each fades out where a pixel covers several of its texels, and the
roughness takes back the slopes it carried, so the sea is sharp near the camera and the glint stays right at a distance.
Under WebGPU the simulation runs in compute shaders (a few dispatches a frame, no CPU cost) and also draws foam on the
crests that break (where the choppy waves' Jacobian folds), covering the whitecap share (`whitecapCoverage`). On WebGL2
it runs on the CPU (about 1.5 ms a frame on a desktop) without foam patterns: the whitecaps pale the sea evenly.

- `water.state.significantWaveHeightMeters` gives the sea state's wave height (about 1 m at 5 m/s over 100 km).
- Waves animate: the earth renders every frame while they can show, that is below 30 km and off the flat map.
  `waves: false` stops them (and their cost). Nothing is simulated from high above.
- The plane the waves lie on follows the camera, laid again after 20 km: the pattern shifts once then, unseen from
  the heights such a move takes.
- Under WebGPU, below 1.5 km over the sea, a displaced mesh draws the sea near the camera (`waveMesh`, default true):
  see below. Elsewhere the waves are normals only: the horizon stays straight.
- Where the waves fade out with distance, their foam gives way to the whitecap share spread evenly, so a windy sea
  keeps its pallor however far.
- `depthFromElevation`: the seafloor (`seafloorColor`, default sand) shows through shallow water, fading with depth by
  the water's own attenuation (blue reaches farthest). Needs a source holding the seafloor: Terrarium through
  `RasterDemSource` with `flattenBelowSeaLevel`. Leave it off for quantized mesh, whose sea heights are not depths.
  Depth is measured from `seaLevelMeters` (default 0): set it to the source's `seaLevelMeters` when you change that.
  Where the elevation sits exactly at sea level (Terrarium's land data fills the sea near coasts with 0 m, in
  rectangles) there is no depth to show: no seafloor, not a sandbar.

### The sea mesh near the camera

Under WebGPU the waves also move geometry: rings of cells around the camera, each twice the size of the one inside it
(geometry clipmaps, as Crest lays them), so detail per pixel stays even from the camera's feet out to the mesh's edge. The
innermost cell shrinks with the camera's height, down to 6 cm at the water (the mesh then reaches about 360 m; from 25 m
up, with 1 m cells, about 6 km). Vertices take the waves' height and the choppy
waves' pull towards the crests; the fragments shade per pixel, with the foam. The outer ring flattens and the terrain's sea
takes over, seamlessly, Earth's curvature included. It costs one draw of about 120 000 triangles.

- `waveMesh: false` keeps the normals-only sea. The mesh hides above 1.5 km, on the flat map and on WebGL2 (no GPU
  displacement there).
- Under the mesh the terrain's sea is discarded where it is water at or below sea level (+1 m), so the coast stays the
  terrain's. The mesh itself knows nothing of the ground: it lies at `seaLevelMeters` across its whole square, so land
  below sea level (polders, Death Valley) and lakes below it (the Dead Sea, the Caspian) are covered within its reach,
  and on a low coast the crests of a rough sea can show through beaches and quays. Set `waveMesh: false` over such places.
- The mesh lies at `seaLevelMeters` above the WGS84 ellipsoid. A terrain whose sea sits on the geoid instead (tens of
  metres off, as most quantized-mesh services) hides the mesh or lets it float: set `seaLevelMeters` to the source's sea
  height there, or turn the mesh off.
- The mesh shows no seafloor (`depthFromElevation`) and no imagery (`imageryOpacity`): with either, the colour steps at
  the mesh's edge, and in shallow water near the camera the sea is opaque.

### Seed and wave time

`waveSeed` (an integer, default 1) seeds the waves' random phases. The same seed, sea state and wave time draw the same
sea on every WebGPU client, so they agree on where the crests are (and where a probed boat floats): set
`water.waveSurface.timeSeconds` on each from a shared clock before the frame (it then advances by the frame's time; the
waves repeat every hour, `WAVE_REPEAT_PERIOD_SECONDS`). WebGL2 clients simulate a coarser grid, so their sea differs.

### Float a boat: wave probes

A probe samples the sea's height and normal at a few points, on the GPU, exactly as the mesh draws it (the choppy
waves' sideways pull included), and reads them back a frame or two late. Probe a hull at three or four points (bow and
both sides of the stern) and fit a plane for its height, pitch and roll:

```tsx
import type { Water as WaterImpl } from '@earthkit/water'
import { useWaveProbe } from '@earthkit/water/react'
import { useFrame } from '@react-three/fiber'
import type { GeographicAnchor } from '@earthkit/globe'

export function useFloat(water: WaterImpl | null, anchor: GeographicAnchor, longitudeDegrees: number, latitudeDegrees: number) {
  const probe = useWaveProbe(water, [{ longitudeDegrees, latitudeDegrees }])
  useFrame(() => {
    const sample = probe?.samples[0]
    if (sample === undefined || !sample.ready) return
    // heightMeters is above the ellipsoid; normal is east-north-up, as the anchor's frame.
    anchor.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters: sample.heightMeters })
  })
}
```

Vanilla: `const probe = water.createProbe({ capacity: 4 })`, then `probe.setPoints(points)` and read `probe.samples`
every frame; `probe.dispose()` stops it. Without the mesh (WebGL2, high camera, `waveMesh: false`) the sea is drawn flat
and the samples say so: sea level, normal straight up. Up to `capacity` points (default 16) cost one small dispatch.

`water.state` (and `earth.inspect().plugins.water`) gives the resolved values: `albedo` (linear RGB), `roughness`,
`whitecapCoverage`, `diffuseAttenuationPerMeter`.

### Change the weather at runtime

Settings are uniforms: changing them rebuilds no shader and reloads no tile. In React, change the props. Vanilla,
`setSettings` replaces the settings, so spread the current ones:

```ts
import type { Water } from '@earthkit/water'

export function setWind(water: Water, windSpeedMetersPerSecond: number): void {
  water.setSettings({ ...water.settings, windSpeedMetersPerSecond })
}
```

### Imagery and the flat map

- Over imagery, the sea takes the water's colour (`imageryOpacity: 0`, the default), so a satellite sea's
  photographed glare and haze do not fight the sky reflection. Raise `imageryOpacity` to let the imagery show through.
- On the flat map the terrain is drawn unlit, as a map, so the sea fades to `flatMapColor` as it unrolls (default the
  `color` or the preset's colour, else `#a0c8f0`). `flatMapColor: null` keeps the imagery's own sea there.
- A stylised sea: `color` (a CSS colour; an unknown one throws) replaces the optics' colour, `roughness` the wind's. The `map` preset sets both;
  `color: null` and `roughness: null` go back to the physics.

### The optics on their own

`computeWaterOptics({ chlorophyllMilligramsPerCubicMeter, salinityPartsPerThousand })` returns `deepAlbedo` and
`diffuseAttenuationPerMeter` per band, `surfaceRoughness(wind)` and `whitecapCoverage(wind)` the surface's: for a
material of your own or a legend.

## Common Mistakes

### HIGH: No water mask from the terrain source

The plugin shades only where `terrainWaterMask` is above 0. A quantized-mesh server without the `watermask` extension,
or `waterMask={false}`, or `RasterDemSource seaLevelMeters={null}`, leaves the sea as land. Check with
`earth.inspect()` that the terrain loaded, and try `RasterDemSource` with its default sea level.

### HIGH: A new `Water` every render

`new Water()` inside a component body (or `plugins={[new Water()]}`) installs a new plugin each render. Use
`<Water>`, or create the plugin once (module level or `useState`).

### MEDIUM: Expecting a glossy sea without the atmosphere

The sky reflection comes from `<Atmosphere>`'s light. Without it the sea shows only the sun's highlight from the scene's
lights and looks dark.

### MEDIUM: Two water plugins

The name (`'water'`) is unique on an earth: a second `Water` throws. Give each its own `name` only if you really
layer two (they run in registration order; the last wins on water).

## Completion

- The sea shows its own colour over imagery and terrain styles, and the land is unchanged.
- Under `<Atmosphere>`, the sea reflects the sky and the sun's glint, wider in stronger wind.
- On the flat map, the sea shows `flatMapColor`.
