---
name: map-labels
description: >
  Use when working on the text labels of a MapLibre style on a react-three-earth globe or flat map: labels that
  face the viewer at a constant size (the default, place and road names alike) or lie on the ground (MapStyleSource symbols="draped"), their
  collision across the screen, priorities (symbol-sort-key, text-allow-overlap, text-ignore-placement), variable
  anchors (text-variable-anchor), icons from the sprite (icon-image), labels hidden behind mountains, fades
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
readable at any pitch, as in MapLibre. Line-placed labels (road names, `symbol-placement: line` or
`line-center`) face the viewer too: their glyphs follow the road as projected on the screen, read left to right.

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
- Road names collide glyph by glyph, so a curved name can sit beside a place label inside its bend. Each repeats
  every `symbol-spacing` pixels at its tile's zoom. `text-keep-upright` (default true) turns a name that would read
  upside down (a name on a road running up the screen reads bottom to top); a name fades out where the road on
  the screen turns more than `text-max-angle` (default 45°) along it, or is too short for it.
- `text-variable-anchor`: a label tries its anchors in order and takes the first that fits, beside its point
  (`text-radial-offset`, else `text-offset`, moves it away from the point). One already showing keeps its
  anchor while it fits, so it does not jump. `text-variable-anchor-offset` is not read yet.
- Labels stand on the terrain as drawn, fade out behind mountains in front of them on the globe, and go behind
  the globe's horizon. They fade with the `<Imagery>`
  layer's `opacity`, and hide while the view morphs between the globe and the flat map.
- `icon-image` draws the sprite's icon at the point, facing the viewer: `icon-size`, `icon-anchor`,
  `icon-offset`, `icon-rotate` and `icon-opacity` apply; SDF icons (`"sdf": true` in the sprite JSON) take
  `icon-color`, `icon-halo-color` and `icon-halo-width`. An icon with text collides as two boxes, and a variable
  anchor moves only the text. An icon alone uses `icon-padding`, `icon-allow-overlap` and
  `icon-ignore-placement`; with text, the label overlaps only when both the text and icon flags allow it.
- `earth.queryRenderedFeatures`, layer events and hover hit them by their box on the screen
  (`query-features-and-layer-events`).

### Read the labels on the screen (tests, devtools)

```ts
import type { Earth } from 'react-three-earth'

export function labelsOnScreen(earth: Earth): string[] {
  return earth.terrain?.getScreenLabels().map(label => `${label.text} @ ${label.xPixels},${label.yPixels}`) ?? []
}
```

Each entry has `text`, `xPixels` / `yPixels` (anchor point), `box` (at the variable anchor placement chose) (left, top, right, bottom, padding included),
`opacity`, `layerIndex`, `allowOverlap` and `ignorePlacement`. Labels that collide as several boxes have
`collisionBoxes` (a road name's glyphs, or a place's icon then text); it is null for a single box.
`glyphAnglesRadians` (0 reads left to right) is set for road names only. Labels fading in
count; collided ones do not.

## Common Mistakes

### MEDIUM: Expecting a label to hide the instant a ridge covers it

Labels are tested against the terrain when they are placed (every 100 ms while the camera moves), at their
anchor only, and fade like a collision. A label whose text pokes past a ridge fades as a whole; on the flat map
nothing hides labels.

### MEDIUM: Expecting two styles' labels to avoid each other

Each `<MapStyleSource>` places its own labels. Put the labels in one style, or turn one style's symbol layers off.

### MEDIUM: Expecting icons along roads, icon-text-fit or pitch-aligned road names

Icons draw at points only: `icon-image` on a line-placed layer is skipped, and `icon-text-fit`, `icon-optional`,
`text-optional`, stretchable icons and icon pitch or rotation alignment are not read (icon and text show and hide
together, facing the viewer). With `symbols="draped"` icons are not drawn. Road names face the viewer whatever
`text-pitch-alignment` and `text-rotation-alignment` say: they never lie flat on the ground in the screen mode
(use `symbols="draped"` for that). On the flat map only the world copy nearest the camera has labels.

### LOW: Testing right after load

Labels wait for their tiles and a terrain height before they show, then fade in. Wait for
`inspect().terrain.symbols.elevationsPending === 0` and the fade duration.

## Completion

- `earth.inspect().terrain.symbols` shows `labelsShown` above 0 and `elevationsPending` back to 0;
  `labelsOccluded` counts labels behind terrain. It is null
  with `symbols="draped"`.
- `earth.terrain.getScreenLabels()` lists no two boxes that overlap (compare `collisionBoxes` when set), except
  labels that allow overlap or ignore placement.
- The console shows no `MapStyleSource: labels of tile` warning.
