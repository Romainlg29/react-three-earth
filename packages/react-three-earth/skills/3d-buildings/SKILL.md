---
name: 3d-buildings
description: >
  Use when showing 3D buildings on a react-three-earth globe or flat map from a MapLibre style's fill-extrusion
  layers (MapStyleSource extrusions="3d" or "draped"): heights, bases, colours, opacity and the vertical gradient,
  buildings standing on terrain, lighting by the atmosphere's sun, the flat map, checking them in tests
  (earth.inspect().terrain.extrusions), and what fill-extrusion does not do yet.
metadata:
  purpose: 'Covers fill-extrusion as 3D buildings: the extrusions option, which paint properties are read, how buildings stand on terrain, inspect().terrain.extrusions and current limits.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/extrusions/Extrusions.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/extrusions/extrusionMaterial.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/extrusions.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
requires:
  - map-styles
---

# 3D buildings

Read `map-styles` first: buildings come from the `fill-extrusion` layers of a `MapStyleSource`.

`fill-extrusion` layers stand in 3D, as MapLibre's 3D buildings: walls and flat roofs on the terrain as it is
drawn, lit by the scene's lights (the `<Atmosphere>` sun) and hazed by aerial perspective like the ground. They
morph to the flat map with the terrain; there they are shaded as MapLibre shades them, unlit.

## Setup

Nothing to set up: a style with `fill-extrusion` layers shows buildings once the camera is close enough (the
layer's `minzoom`, usually 14 or 15).

```tsx
import { Earth, Imagery, MapStyleSource, QuantizedMeshSource, Terrain } from 'react-three-earth/react'

const style = {
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.example.com/planet.json' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#efe9dc' } },
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#d6cfc4',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'render_height']],
        'fill-extrusion-base': ['get', 'render_min_height'],
        'fill-extrusion-opacity': 0.9,
      },
    },
  ],
}

export function City() {
  return (
    <Earth>
      <Terrain>
        <QuantizedMeshSource url="https://terrain.example.com/" />
      </Terrain>
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </Earth>
  )
}
```

Vanilla: `new MapStyleSource({ style })` in an `Imagery`, as in `map-styles`; `extrusions` is an option of both.

## Core Patterns

### Paint properties

- `fill-extrusion-height` and `fill-extrusion-base` (metres, data-driven): heights follow the camera's zoom
  between the tile's zoom and the next, so a style that grows buildings from 0 at zoom 14 to their height at 15
  grows them as you zoom in. A base above the roof is clamped to it (MapLibre).
- `fill-extrusion-color` (data-driven), `fill-extrusion-opacity` (per layer, by zoom), and
  `fill-extrusion-vertical-gradient` (default true: tall walls darken towards their foot).
- Feature-state in these properties works; a state change processes the building's tile again.

### Draped instead

`extrusions="draped"` draws the footprints flat into the terrain's textures, as before 3D buildings: cheaper, no
3D. Use it for a style whose extrusions are meant as a coloured footprint, or on low-end devices.

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'

export function FlatBuildings({ url }: { url: string }) {
  return (
    <Imagery>
      <MapStyleSource url={url} extrusions="draped" />
    </Imagery>
  )
}
```

### How buildings meet the terrain

Building tiles come from the camera, as labels facing the viewer do: deeper near the camera, past the source's
`maxzoom` by overzooming, never two tiles over the same ground. Each building stands on the lowest ground under
its footprint as the terrain is drawn (read on a grid over its tile), so on a slope its uphill side sinks in
rather than its downhill side floating. A building shows once the terrain under it has been read, and follows
finer terrain as it loads, every few seconds. Without terrain tiles there (out of the screen), it takes the
nearest ground read.

### Check them in a test

```ts
import type { Earth } from 'react-three-earth'

export function buildingsReady(earth: Earth): boolean {
  const extrusions = earth.inspect().terrain?.extrusions
  return extrusions != null && extrusions.tilesDrawn > 0 && extrusions.elevationsPending === 0
}
```

`buildings` counts the buildings in drawn tiles (one cut by a tile edge counts in each tile);
`updateMilliseconds` is the main-thread time of the last frame's update.

## Common Mistakes

### HIGH: Expecting buildings far from the camera

Like MapLibre, buildings exist only in tiles at or above the layer's `minzoom`: tiles towards the horizon are
shallower, so far buildings are left out on a pitched view. Lower the layer's `minzoom` to keep them, at a cost
in triangles.

### MEDIUM: Clicking a building's roof

Feature queries hit `fill-extrusion` layers by their footprint on the ground, not by the 3D shape: on a pitched
view a click on a tall roof lands behind the building. Query at its foot, or use `extrusions="draped"` where
clicks must match what is drawn.

### MEDIUM: Expecting the style's `light`

The style root `light` is not read: on the globe the scene's lights (the atmosphere's sun, or yours) light the
buildings, so at night they are dark like the ground; on the flat map MapLibre's default light shades them.

### MEDIUM: Unsupported properties

`fill-extrusion-pattern` draws with the colour instead, `fill-extrusion-translate` is ignored, and a colour that
changes with zoom is read at the tile's zoom.

## Completion

- `earth.inspect().terrain.extrusions` is not null, `tilesDrawn` is above 0 near the buildings and
  `elevationsPending` returns to 0.
- The buildings stand on the ground at the terrain's height, in 3D and on the flat map.
- The console shows no `MapStyleSource:` error about building tiles.
