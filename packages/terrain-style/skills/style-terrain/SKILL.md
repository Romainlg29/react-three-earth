---
name: style-terrain
description: >
  Use when an earthkit globe should look stylised without imagery or map layers, or the ground should be coloured by
  height, steepness or the direction it faces: hypsometric tints, snow above an altitude, rock on steep slopes,
  avalanche slope classes (30°, 35°, 40°), sunny south faces, a grey base map for data. MapLibre-style expressions
  (step, interpolate, case) over ['elevation'], ['slope'], ['slope-percent'] and ['aspect'], or a preset (alpine,
  atlas, desert, monochrome, slope-classes); legends from the same expression.
metadata:
  purpose: 'Documents @earthkit/terrain-style: TerrainStyle and its presets, the expression language, useTerrainStyle, compileTerrainColor and evaluateTerrainExpression.'
  type: framework
  framework: 'react'
  library: '@earthkit/terrain-style'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/terrain-style/src/expression.ts'
  - 'Romainlg29/react-three-earth:packages/terrain-style/src/compile.ts'
  - 'Romainlg29/react-three-earth:packages/terrain-style/src/presets.ts'
  - 'Romainlg29/react-three-earth:packages/terrain-style/src/TerrainStyle.ts'
  - 'Romainlg29/react-three-earth:packages/terrain-style/src/react/index.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/TerrainExample.tsx'
requires:
  - '@earthkit/globe#getting-started'
  - '@earthkit/globe#customize-terrain-shading'
---

# Style terrain

Read `@earthkit/globe#getting-started` first. `@earthkit/terrain-style` colours the terrain itself, per pixel, from
its elevation, slope and aspect: the globe looks finished with no imagery, and imagery layers, when you add some,
blend over it. It works with any terrain source (quantized mesh or raster DEM) and costs one compiled shader.

## Setup

```tsx
import { Earth, RasterDemSource, Terrain } from '@earthkit/globe/react'
import { useTerrainStyle } from '@earthkit/terrain-style/react'

export function StylisedGlobe() {
  const createMaterial = useTerrainStyle({ color: 'alpine' })
  return (
    <Earth>
      <Terrain createMaterial={createMaterial}>
        <RasterDemSource url="https://example.com/terrarium/{z}/{x}/{y}.png" encoding="terrarium" />
      </Terrain>
    </Earth>
  )
}
```

Vanilla: `new Terrain({ sources, createMaterial: new TerrainStyle({ color: 'alpine' }).createMaterial })`.

Presets: `alpine` (green valleys, rock over about 30°, snow above 3000 m), `atlas` (classic hypsometric tints),
`desert`, `monochrome` (grey by steepness, a base for data) and `slope-classes` (avalanche classes). They are plain
expressions in `TERRAIN_STYLE_PRESETS`: read one to start your own.

## Core Patterns

### Your own expression

The colour is a MapLibre-style expression. Inputs, per pixel:

| Input | Value |
| --- | --- |
| `['elevation']` | metres above the WGS84 ellipsoid, as loaded (exaggeration does not scale it) |
| `['slope']` | degrees, 0 flat to 90 vertical |
| `['slope-percent']` | grade: 100 at 45° |
| `['aspect']` | downhill compass direction, degrees clockwise from north (0 to 360); 0 on flat ground |

Operators: `step`, `interpolate` (`['linear']` or `['exponential', base]`), `case`, `all`, `any`, `!`, `<`, `<=`,
`>`, `>=`, `==`, `!=`, `+`, `-`, `*`, `/`, `%`, `^`, `min`, `max`, `abs`, `sqrt`, `sin`, `cos`, `rgb`. Colours are CSS
strings (`'#cccccc'`, `'rgb(…)'`, `'white'`), blended in sRGB as MapLibre does. Outputs can be expressions themselves,
which is how two inputs combine:

```tsx
import { useTerrainStyle } from '@earthkit/terrain-style/react'
import type { TerrainExpression } from '@earthkit/terrain-style'

// Steeper than 20% grey; else white from 2000 m; else green to tan by height
const color: TerrainExpression = [
  'case',
  ['>', ['slope-percent'], 20], '#cccccc',
  ['>=', ['elevation'], 2000], '#ffffff',
  ['interpolate', ['linear'], ['elevation'], 0, '#4f7f45', 2000, '#c4ad7e'],
]

export function useMyTerrainStyle() {
  return useTerrainStyle({ color })
}
```

`step` gives hard bands, `interpolate` gradients: `['interpolate', ['linear'], ['slope'], 25, grass, 35, '#8a8580']`
fades grass into rock between 25° and 35°.

### A legend from the same expression

`evaluateTerrainExpression` computes on the CPU exactly what the shader draws, as sRGB channels from 0 to 1:

```ts
import { evaluateTerrainExpression, TERRAIN_STYLE_PRESETS, type TerrainColor } from '@earthkit/terrain-style'

const toCss = ([red, green, blue]: TerrainColor) => `rgb(${red * 255}, ${green * 255}, ${blue * 255})`

export const legend = [0, 1000, 2000, 3000, 4000].map(elevation => ({
  label: `${elevation} m`,
  color: toCss(evaluateTerrainExpression(TERRAIN_STYLE_PRESETS.atlas, { elevation, slope: 0 }) as TerrainColor),
}))
```

### The colour in a material of your own

`TerrainStyle.colorNode` (or `compileTerrainColor(expression)`) is a TSL node: put it on any node material's
`colorNode` in your own `createMaterial`, with your own roughness, emissive or opacity. Build it once at module level.

## Common Mistakes

### HIGH: Changing the style every render

`useTerrainStyle` compares the options by value, so an inline object is fine, but each new style is a new material
factory and reloads every terrain tile. Switch styles on a user action, not per frame. For a smoothly changing
look, write your own material with a TSL `uniform` (`customize-terrain-shading`).

### HIGH: A MapLibre `color-relief` expression with `['get', …]` or `zoom`

Only the four inputs above exist here. `['get', 'height']`, `['zoom']` and data-driven operators throw an error that
lists what is supported. For a draped `color-relief` layer from a `raster-dem` source in a map style, use
`@earthkit/globe#satellite-and-relief-styles` instead.

### MEDIUM: Expecting exaggerated values

`<Terrain exaggeration={2}>` draws mountains twice as high, but a 30° slope still reads 30 and 2000 m still reads
2000: bands stay true to the real terrain.

### MEDIUM: Thresholds that coarse tiles cannot show

Values come from the tile mesh, interpolated across triangles. Far away, coarse tiles smooth out narrow ridges, so
a 40° band appears as you zoom in. Skirts under tile edges read their lowered height: a thin seam of the band below
can show where tiles of different detail meet.

## Completion

- The globe shows the style's colours with no imagery; `earth.inspect().terrain.tilesLoaded` grows as usual.
- Imagery added later blends over the style.
- A legend built with `evaluateTerrainExpression` matches the colours on screen.
