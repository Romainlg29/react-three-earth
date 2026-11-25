---
name: water
description: >
  Use when an earthkit globe needs a sea, ocean, lakes or water that looks real or like a map: water coloured from its
  optics (chlorophyll, salinity), glossy from the wind with the sun's glint and sky reflection, whitecaps in a gale,
  the seafloor through shallow water, a flat light-blue map sea, presets (map, calm, breeze, open-ocean, storm,
  coastal), changing the wind at runtime, the sea on the flat 2D map.
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

Without a water mask nothing changes. It draws no waves yet: the wind sets the gloss and the whitecaps, not geometry.

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
- `salinityPartsPerThousand`: 35 sea, 0 fresh water (a little less scattering).
- `depthFromElevation`: the seafloor (`seafloorColor`, default sand) shows through shallow water, fading with depth by
  the water's own attenuation (blue reaches farthest). Needs a source holding the seafloor: Terrarium through
  `RasterDemSource` with `flattenBelowSeaLevel`. Leave it off for quantized mesh, whose sea heights are not depths.
  Depth is measured from `seaLevelMeters` (default 0): set it to the source's `seaLevelMeters` when you change that.

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
