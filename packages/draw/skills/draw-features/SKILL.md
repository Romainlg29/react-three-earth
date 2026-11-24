---
name: draw-features
description: >
  Use when an app lets users draw on a react-three-earth map, like maplibre-gl-draw or terra-draw: place points, draw
  lines and polygons by tapping, get the result as GeoJSON, load saved features back, style them, or build a drawing
  toolbar (headless: the app renders the buttons from useDrawState). Also when drawing must work with touch on
  iPhone Safari, on the globe and on the flat 2D map, or when writing a custom drawing mode.
metadata:
  purpose: 'Documents react-three-earth-draw: the Draw plugin (modes, actions, features, events, style), useDrawState and useDrawEvent, custom DrawMode subclasses, and the PointerInteractions core it uses to take presses from the camera controls.'
  type: framework
  framework: 'react'
  library: 'react-three-earth-draw'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/draw/src/Draw.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/DrawMode.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/PathModes.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/types.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/react/index.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/PointerInteractions.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/DrawExample.tsx'
requires:
  - react-three-earth#getting-started
---

# Draw features

Read `react-three-earth#getting-started` first. `react-three-earth-draw` is a react-three-earth plugin for drawing points, line strings and polygons on the map, kept as
GeoJSON. It is headless, like the map controls: it draws the features and the handles of the feature in progress on the
map, and nothing else. No buttons, no CSS. The app builds its toolbar from the state.

| maplibre-gl-draw / terra-draw | react-three-earth-draw |
| --- | --- |
| `new MapboxDraw()`, `map.addControl(draw)` | `new Draw()`, `earth.addPlugin(draw)` or `<Earth plugins={[draw]}>` |
| `draw.changeMode('draw_polygon')` | `draw.setMode('polygon')` (`'static'`, `'point'`, `'linestring'`, `'polygon'`) |
| `draw.getAll()` | `draw.getFeatures()` (a `FeatureCollection`) |
| `draw.add(geojson)`, `draw.delete(ids)`, `draw.deleteAll()` | `draw.addFeatures(geojson)`, `draw.removeFeatures(ids)`, `draw.clear()` |
| `draw.create`, `draw.update`, `draw.delete` events | `create`, `update`, `delete`, `change`, `modechange` events |
| style layers with `user_` properties | `style`: an object, or a function of the feature and `{ selected, drawing }` |

Finished features are draped on the terrain like an imagery layer: they follow the ground, on the globe and on the flat
map, and redraw once when they change. The feature being drawn moves in a screen-space overlay every frame, so drawing
never redraws terrain textures per pointer move.

## Setup

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, EarthControls, QuantizedMeshSource, Terrain } from 'react-three-earth/react'
import { Draw } from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'
import { useMemo } from 'react'

function Toolbar({ draw }: { draw: Draw }) {
  const { mode, canFinish, canUndo, features } = useDrawState(draw)
  return (
    <div className="toolbar">
      {(['static', 'point', 'linestring', 'polygon'] as const).map(name => (
        <button key={name} aria-pressed={mode === name} onClick={() => draw.setMode(name)}>
          {name}
        </button>
      ))}
      <button disabled={!canFinish} onClick={() => draw.finish()}>Finish</button>
      <button disabled={!canUndo} onClick={() => draw.undo()}>Undo</button>
      <span>{features.features.length} features</span>
    </div>
  )
}

export function App() {
  // Once: a new Draw every render would reinstall the plugin and lose the features.
  const draw = useMemo(() => new Draw(), [])
  const plugins = useMemo(() => [draw], [draw])
  return (
    <>
      <Canvas>
        <Earth plugins={plugins}>
          <Terrain>
            <QuantizedMeshSource url="https://example.com/terrain/layer.json" />
          </Terrain>
          <EarthControls />
        </Earth>
      </Canvas>
      <Toolbar draw={draw} />
    </>
  )
}
```

The toolbar can live outside the canvas: `useDrawState` only needs the `Draw`. Vanilla:

```ts
import { Earth } from 'react-three-earth'
import { Draw } from 'react-three-earth-draw'

declare const earth: Earth
declare const polygonButton: HTMLButtonElement
declare const finishButton: HTMLButtonElement

const draw = new Draw()
earth.addPlugin(draw)
polygonButton.onclick = () => draw.setMode('polygon')
finishButton.onclick = () => draw.finish()
draw.subscribe(state => (finishButton.disabled = !state.canFinish))
```

## Core Patterns

### How drawing works with fingers and a mouse

- `point`: each tap places a point.
- `linestring` and `polygon`: each tap places a vertex. A tap on the last vertex finishes (a double click or double tap
  does the same); a polygon also closes on a tap on its first vertex. `finish()`, `undo()` and `cancel()` do it from
  buttons, and Enter, Backspace and Escape while the map has focus (`keyboard: false` turns the keys off).
- Between taps, one finger still pans and two fingers still pinch and rotate. While a drawing mode is active,
  double-tap zoom is held off (`earth.interactions.holdDoubleClickZoom`), so two quick taps place two vertices.
- With a mouse, the next segment follows the pointer. Touch screens have no hover: segments appear on each tap.
- Taps hit a vertex within 10 pixels with a mouse, 22 with a finger.
- `'static'` (the default mode) leaves the map alone.

### Saving and loading GeoJSON

```ts
import type { FeatureCollection } from 'geojson'
import { Draw } from 'react-three-earth-draw'

declare const saved: FeatureCollection<GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon>
declare function save(collection: unknown): void

const draw = new Draw({ features: saved })
draw.addEventListener('change', ({ features }) => save(features))
// Features without an id get one; a taken id replaces that feature (`update` fires).
draw.addFeatures([{ type: 'Feature', properties: { name: 'Camp' }, geometry: { type: 'Point', coordinates: [6.86, 45.83] } }])
```

Every feature has a string `id` (a random UUID unless `createId` says otherwise; numeric ids become strings, missing
ones are made, in `features` and `addFeatures` alike). Draw holds `Point`, `LineString` and `Polygon`; split `Multi*`
geometries into several features. Longitudes are kept as tapped, in -180 to 180: a line drawn across the antimeridian
(179.5° to -179.5°) is drawn the short way on the map, but other GeoJSON tools read it as going around the world, so
split it at 180° before handing it to them. Ring winding is kept as drawn. `getFeatures()` returns the same object until something
changes, so it can be compared by identity.

### Styling

```ts
import { Draw } from 'react-three-earth-draw'

const draw = new Draw({
  style: (feature, { drawing }) => ({
    fillColor: drawing ? '#f59e0b' : '#22c55e',
    fillOpacity: 0.3,
    lineColor: feature.properties?.kind === 'route' ? '#e11d48' : '#16a34a',
    lineWidthPixels: 3,
    pointRadiusPixels: 7,
  }),
})
draw.setStyle({ lineColor: '#000000' }) // redraws every feature
```

Options: `fillColor`, `fillOpacity`, `lineColor`, `lineOpacity`, `lineWidthPixels`, `pointColor`, `pointRadiusPixels`,
`pointOutlineColor`, `pointOutlineWidthPixels`, and `vertex*` for the handles. Colours are CSS colours without alpha;
opacities are separate.

### React hooks

- `useDrawState(draw)`: the state (`mode`, `modes`, `features`, `drawing`, `vertexCount`, `canFinish`, `canUndo`),
  re-rendering on change. `useDrawState(draw, state => state.mode)` re-renders only when the selected part changes.
- `useDrawEvent(draw, 'create', ({ features }) => …)`: an event listener for the component's lifetime.
- Install with `<Earth plugins={[draw]}>` (a stable array) or `usePlugin(draw)` from `react-three-earth/react` inside
  `<Earth>`.

### A custom mode

Subclass `DrawMode` (or extend `PathMode`, `PolygonMode`…; everything is `protected`), and pass it in `modes` with the
built-in ones you keep:

```ts
import { Draw, DrawMode, PointMode, StaticMode, type DrawPointerEvent } from 'react-three-earth-draw'

/** Places a point and goes back to static after each tap. */
class OnePointMode extends DrawMode {
  readonly name = 'one-point'

  override click(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null || event.geographic === null) return
    const { longitudeDegrees, latitudeDegrees } = event.geographic
    context.create([{ type: 'Feature', id: context.createId(), properties: {}, geometry: { type: 'Point', coordinates: [longitudeDegrees, latitudeDegrees] } }])
  }
}

const draw = new Draw({ modes: [new StaticMode(), new PointMode(), new OnePointMode()] })
draw.addEventListener('create', () => draw.setMode('static'))
```

A mode gets taps (`click`), mouse moves (`hover`), keys (`keyDown`), and presses it may take from the camera controls:
return true from `pointerDown` and the press, its moves and its release go to the mode (`pointerMove`, `pointerUp`)
and never pan the map. It draws what is in progress in `overlay(content)` (features, guide lines, handles), and reports
progress in `status()`.

### Taking presses from the camera controls (core)

The draw plugin uses `earth.interactions` (`PointerInteractions`), which any plugin can use through
`context.addPointerInteraction`:

```ts
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'

export const dragLogger: EarthPlugin = {
  name: 'drag-logger',
  apiVersion: PLUGIN_API_VERSION,
  install(context) {
    context.addPointerInteraction({
      // Take presses that start in the middle of the screen; leave the rest to the map.
      pointerDown: event => event.screen.xPixels > 300 && event.screen.xPixels < 500,
      pointerMove: event => console.log(event.geographic),
      pointerUp: () => console.log('released'),
    })
  },
}
```

Presses are offered to the interaction added last first. A taken press never reaches the controls, `BoxZoom` or the
earth's `click` and `doubleclick`; a second finger landing cancels it (`pointerCancel`), so pinching still zooms.

## Common Mistakes

### HIGH: A new `Draw` or plugins array every render

`<Earth plugins={[new Draw()]}>` reinstalls the plugin on each render and loses every feature. Create the `Draw` once
(`useMemo`, a ref, or module scope) and keep the array stable.

### HIGH: Expecting buttons or CSS

Nothing is rendered outside the map. Build the toolbar from `useDrawState` (or `getState`/`subscribe`), and call
`setMode`, `finish`, `undo`, `cancel`, `clear`.

### MEDIUM: Reading features from the store between frames to animate them

Finished features are draped and redraw once per change. Changing a feature every frame through `addFeatures`
redraws terrain textures every frame: fine for an edit, too heavy for an animation. Animate with scene objects.

### MEDIUM: Multi geometries

`addFeatures` throws for `MultiPolygon` and other `Multi*` geometries; split them into one feature per part first.

## Completion

- The toolbar switches modes, and `canFinish`/`canUndo` enable its buttons.
- Taps place vertices on the globe and on the flat map, with a finger on a phone too; one finger still pans.
- `getFeatures()` (or the `change` event) gives the GeoJSON to save, and `features`/`addFeatures` load it back.
