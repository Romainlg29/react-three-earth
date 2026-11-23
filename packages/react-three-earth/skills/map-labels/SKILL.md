---
name: map-labels
description: >
  Use when working on the text labels of a MapLibre style on a react-three-earth globe or flat map: labels that
  face the viewer at a constant size (the default) or lie on the ground (MapStyleSource symbols="draped"), their
  collision across the screen, priorities (symbol-sort-key, text-allow-overlap, text-ignore-placement), fades
  (symbolFadeDurationSeconds), reading the labels on the screen in tests (earth.terrain.getScreenLabels), and what
  labels do not do yet.
metadata:
  purpose: 'Covers screen-space labels: the symbols option, placement and fades, getScreenLabels and inspect().terrain.symbols, and current limits.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/ScreenSymbols.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/SymbolPlacement.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
requires:
  - map-styles
---

# Map labels

Read `map-styles` first: labels come from the symbol layers of a `MapStyleSource`.

Point-placed labels (place names, `symbol-placement: point`) stand upright on the screen at their `text-size`,
readable at any pitch, as in MapLibre. Line-placed labels (road names) still lie on the ground.

## Setup

Nothing to set up: labels face the viewer by default.

```tsx
import { Earth, Imagery, MapStyleSource, QuantizedMeshSource, Terrain } from 'react-three-earth/react'

export function LabelledMap() {
  return (
    <Earth>
      <Terrain>
        <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" />
      </Terrain>
      <Imagery>
        <MapStyleSource url="https://demotiles.maplibre.org/style.json" />
      </Imagery>
    </Earth>
  )
}
```

Vanilla: `new MapStyleSource({ url, symbols: 'screen', symbolFadeDurationSeconds: 0.3 })`.

## Core Patterns

### Labels on the ground instead, or no fade

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'

export function GroundLabels() {
  return (
    <Imagery>
      <MapStyleSource url="https://demotiles.maplibre.org/style.json" symbols="draped" symbolFadeDurationSeconds={0} />
    </Imagery>
  )
}
```

- `symbols="screen"` (default): labels face the viewer, a little smaller towards the horizon (MapLibre's
  perspective ratio). `symbols="draped"`: every label is drawn into the terrain's texture, colliding only within
  its tile.
- `symbolFadeDurationSeconds` (default 0.3, MapLibre's `fadeDuration`): 0 switches at once.

### How labels are placed

- One collision pass for the whole screen: higher style layers first, then `symbol-sort-key` (lower first), then
  labels already showing, so equal labels do not swap places as tiles load.
- The same text of the same layer within 24 px is one label: it never shows twice where tiles of two zooms meet,
  and its fade carries over from one tile to the next.
- `text-allow-overlap` and `text-ignore-placement` apply; `text-padding` widens the box.
- Labels stand on the terrain as drawn and go behind the globe's horizon. They fade with the `<Imagery>`
  layer's `opacity`, and hide while the view morphs between the globe and the flat map.
- `earth.queryRenderedFeatures`, layer events and hover hit them by their box on the screen
  (`query-features-and-layer-events`).

### Read the labels on the screen (tests, devtools)

```ts
import type { Earth } from 'react-three-earth'

export function labelsOnScreen(earth: Earth): string[] {
  return earth.terrain?.getScreenLabels().map(label => `${label.text} @ ${label.xPixels},${label.yPixels}`) ?? []
}
```

Each entry has `text`, `xPixels` / `yPixels` (anchor), `box` (left, top, right, bottom, padding included),
`opacity`, `layerIndex`, `allowOverlap` and `ignorePlacement`. Labels fading in count; collided ones do not.

## Common Mistakes

### MEDIUM: Expecting labels to hide behind mountains

Labels draw over terrain in front of them; only the globe hides them. Pitch over mountains shows labels from
the valley behind.

### MEDIUM: Expecting two styles' labels to avoid each other

Each `<MapStyleSource>` places its own labels. Put the labels in one style, or turn one style's symbol layers off.

### MEDIUM: Expecting road names, icons or variable anchors upright

Line labels stay on the ground and collide only within their terrain tile; `icon-image` is not drawn yet;
`text-variable-anchor` uses its first anchor. On the flat map only the world copy nearest the camera has labels.

### LOW: Testing right after load

Labels wait for their tiles and a terrain height before they show, then fade in. Wait for
`inspect().terrain.symbols.elevationsPending === 0` and the fade duration.

## Completion

- `earth.inspect().terrain.symbols` shows `labelsShown` above 0 and `elevationsPending` back to 0. It is null
  with `symbols="draped"`.
- `earth.terrain.getScreenLabels()` lists no two boxes that overlap, except labels that allow overlap or
  ignore placement.
- The console shows no `MapStyleSource: labels of tile` warning.
