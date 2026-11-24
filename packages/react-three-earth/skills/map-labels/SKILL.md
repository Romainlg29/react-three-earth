---
name: map-labels
description: >
  Use when working on the text labels of a MapLibre style on a react-three-earth globe or flat map: labels that
  face the viewer at a constant size (the default, place and road names alike) or lie on the ground (MapStyleSource symbols="draped"), their
  collision across the screen, priorities (symbol-sort-key, text-allow-overlap, text-ignore-placement), variable
  anchors (text-variable-anchor), icons from the sprite (icon-image), labels hidden behind mountains, fades
  (symbolFadeDurationSeconds), right-to-left Arabic and Hebrew names, Hindi and Thai, vertical CJK
  (text-writing-mode), reading the labels on the screen in tests (earth.terrain.getScreenLabels), custom label
  looks from a plugin (registerSymbolEffect: neon, glow, outline, gradient text), and what labels do not do yet.
metadata:
  purpose: 'Covers screen-space labels: the symbols option, placement and fades, getScreenLabels and inspect().terrain.symbols, symbol effects from plugins, and current limits.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/ScreenSymbols.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/SymbolPlacement.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/symbolEffects.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/symbolMaterial.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/symbolEffects/neonLabels.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/labels.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/bidi.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/arabic.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/clusters.ts'
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
  anchor moves only the text. An icon alone uses `icon-padding` (its widest side), `icon-allow-overlap` and
  `icon-ignore-placement`; with text, both boxes take `text-padding` and the label overlaps (or ignores placement)
  only when both the text and icon flags allow it, where MapLibre decides icon and text apart.
- `earth.queryRenderedFeatures`, layer events and hover hit them by their box on the screen
  (`query-features-and-layer-events`).

### Arabic, Hebrew and other right-to-left names

Nothing to turn on, and no plugin to load (MapLibre needs `@mapbox/mapbox-gl-rtl-text`): the worker shapes and
orders the text itself.

- Arabic and Persian letters take their joined forms (initial, medial, final, isolated) and lam-alef becomes one
  ligature, as Unicode presentation forms (U+FB50–U+FEFF): the glyph server must carry those ranges (OpenMapTiles
  and MapLibre demo fonts do), else the local font (`localFontFamily`) draws them.
- Each line is reordered by the Unicode bidirectional algorithm: right-to-left words read right to left, numbers
  and Latin runs inside them left to right, brackets mirror. Wrapping (`text-max-width`) breaks in reading order
  first, so the first word read stays on the first line. Road names work the same way.
- `text-letter-spacing` is ignored on labels with Arabic, whose letters must touch (as in MapLibre).
- Letters of the Arabic blocks with no presentation form (some Kurdish and Pashto letters) draw in their own
  glyph; their neighbours still join to them.
- Not covered: explicit direction controls (U+202A–U+202E, U+2066–U+2069 are ignored), and bracket pairing
  (UAX #9 rule N0), which rarely matters in a name.

### Hindi, Thai and other complex scripts

Devanagari and the other Indic scripts, Thai, Lao, Tibetan, Myanmar and Khmer need a shaping engine, which glyph
servers do not have. Each grapheme cluster (a conjunct with its vowel signs, a Thai consonant with its marks) is
drawn whole by the local font, as MapLibre does for local CJK ideographs:

- `localFontFamily` (default `sans-serif`) must cover these scripts; system fonts usually do. The style's glyph
  server is not asked for them.
- Thai, Lao, Khmer and Myanmar have no spaces between words: lines (`text-max-width`) may break between words found
  by `Intl.Segmenter`. Without `Intl.Segmenter` the text draws code point by code point, unshaped.
- `text-letter-spacing` is ignored on these labels, which would break the clusters' joins.
- Shaping across clusters (a few Indic ligatures span two) is not done: each cluster is shaped on its own.

### Vertical Japanese, Chinese and Korean

`"text-writing-mode": ["vertical"]` on a point-placed symbol layer stands CJK names in columns, read top to bottom,
the next line in a column to the left. CJK characters stand upright, one em each, punctuation takes its vertical
form (、 → ︑, 「 → ﹁) when the font has it, and other characters (Latin, digits) turn 90° clockwise inside the
column. Names with no CJK character, or with right-to-left text, stay horizontal.

```json
{
  "id": "station-label",
  "type": "symbol",
  "source": "openmaptiles",
  "source-layer": "poi",
  "layout": { "text-field": ["get", "name:ja"], "text-font": ["Noto Sans Regular"], "text-writing-mode": ["vertical", "horizontal"] }
}
```

Only the first mode is used: MapLibre tries the next one when the first collides, here a vertical label that
collides hides. Line-placed labels stay horizontal.

### Give labels a custom look (symbol effects)

A plugin registers a symbol effect: a TSL function from the glyph's signed distance to a colour. A `symbol`
layer opts in through its `metadata`, so the style stays valid for MapLibre, which ignores it:

```json
{ "id": "town-label", "type": "symbol", "metadata": { "react-three-earth:symbol-effect": "neon" }, "layout": {}, "paint": {} }
```

```ts
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { Color } from 'three'
import { max, min, mix, smoothstep, uniform, vec4 } from 'three/tsl'

export function neonLabels(): EarthPlugin {
  const core = uniform(new Color('#39ff14')) // a uniform: recolouring needs no new pipeline
  const outline = uniform(new Color('#ff2bd6'))
  return {
    name: 'neon-labels',
    apiVersion: PLUGIN_API_VERSION,
    install(context) {
      context.registerSymbolEffect({
        name: 'neon',
        // Linear RGB, straight alpha. The library applies fades, layer opacity and the flat map's luminance.
        shade: ({ distance, edge, haloEdge, distancePerPixel, fillColor }) => {
          const smoothing = distancePerPixel.mul(0.7)
          const inside = smoothstep(edge.sub(smoothing), edge.add(smoothing), distance)
          const outlineEdge = max(min(haloEdge, edge.sub(distancePerPixel)), 0.05) // the halo's band, or 1 px
          const outlined = smoothstep(outlineEdge.sub(smoothing), outlineEdge.add(smoothing), distance)
          return vec4(mix(outline, core, inside), max(inside, outlined).mul(fillColor.a))
        },
      })
    },
  }
}
```

The inputs are `distance` (0 far outside, `edge` = 0.75 on the outline, 1 inside), `haloEdge` (where
`text-halo-width` ends), `distancePerPixel` (distance units per screen pixel), `fillColor` and `haloColor`
(the style's data-driven colours, linear), `isIcon` (1 for SDF icons), `scale` (`text-size` / 24, or the
icon's scale) and `standardColor` (the default fill over halo, to wrap rather than replace). Placement,
collision and colour icons are unchanged. One material per effect per map style source; a tile mixing
layers with and without effects draws in a few calls, in style order. Installing or removing the plugin,
or a `setStyle` that changes a layer's metadata, restyles the labels on the screen without processing
tiles again. A `shade` that throws draws the standard look and logs an error naming the effect. The
playground example is `?fixtures&map=labels&neon`.

### Read the labels on the screen (tests, devtools)

```ts
import type { Earth } from 'react-three-earth'

export function labelsOnScreen(earth: Earth): string[] {
  return earth.terrain?.getScreenLabels().map(label => `${label.text} @ ${label.xPixels},${label.yPixels}`) ?? []
}
```

Each entry has `text` (as the style gives it, in reading order), `xPixels` / `yPixels` (anchor point), `box` (at the variable anchor placement chose) (left, top, right, bottom, padding included),
`opacity`, `layerIndex`, `allowOverlap` and `ignorePlacement`. Labels that collide as several boxes have
`collisionBoxes` (a road name's glyphs, or a place's icon then text); it is null for a single box.
`glyphAnglesRadians` (0 reads left to right) is set for road names only. Labels fading in
count; collided ones do not.

## Common Mistakes

### HIGH: A glow wider than the glyph's padding

An effect draws inside each glyph's quad, which reaches 3 pixels of a 24 px font past the glyph (the
distance field's padding, 1.5 px at 12 px). A wider glow or outline is cut at the quad's edge, in a square.
For a wide glow around roads or areas, register a style layer type with reach (write-a-plugin).

### MEDIUM: Expecting a symbol effect on draped labels

Effects apply to labels facing the viewer (the default). With `symbols="draped"`, labels keep the standard
look; the layer's effect name is ignored.

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
