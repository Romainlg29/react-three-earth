---
name: draw-features
description: >
  Use when an app lets users draw on a react-three-earth map, like maplibre-gl-draw or terra-draw: place points, draw
  lines and polygons by tapping, get the result as GeoJSON, load saved features back, style them, or build a drawing
  toolbar (headless: the app renders the buttons from useDrawState). Also when drawing must work with touch on
  iPhone Safari, on the globe and on the flat 2D map, or when writing a custom drawing mode. Also for circles,
  rectangles, ellipses, regular polygons and spheres in metres (createCircle, createRectangle…, like turf.circle), and
  for 3D: extruded cylinders, boxes, prisms and walls, and shapes at an altitude (the GeoJSON third coordinate). Also
  for editing: selecting features, dragging vertices, adding and deleting vertices, moving features, undo; and for a
  transform gizmo: move, rotate and scale features, and extrude flat shapes into volumes by dragging a height knob.
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
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/ShapeModes.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/SelectMode.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/editing.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/TransformMode.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/transform.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/shapes.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/render/SolidFeatures.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/types.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/react/index.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/PointerInteractions.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/DrawExample.tsx'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/ShapesExample.tsx'
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
| `draw.changeMode('draw_polygon')` | `draw.setMode('polygon')` (`'static'`, `'select'`, `'transform'`, `'point'`, `'linestring'`, `'polygon'`, `'circle'`, `'rectangle'`, `'sphere'`) |
| `draw.changeMode('simple_select', { featureIds })`, `draw.getSelectedIds()`, `draw.trash()` | `draw.select(ids)`, `draw.getSelectedIds()` (or `state.selectedIds`), `draw.deleteSelected()` |
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
`pointOutlineColor`, `pointOutlineWidthPixels`, `solidOpacity` (3D solids, default 0.85; their edges use `lineColor`),
and `vertex*` for the handles. Colours are CSS colours without alpha; opacities are separate.

### Shapes and 3D solids

The `circle`, `rectangle` and `sphere` modes take two taps: a center (or a corner), then the edge (or the opposite
corner). The shape previews under the mouse between taps. A second tap on the first point, a double tap, is ignored.
Shapes are plain GeoJSON polygons (a sphere is a `Point`) whose measurements are kept in `properties.shape`, so they can
be rebuilt from metres rather than from their outline. To make shapes in code, use the builders. Lengths are metres on
the ground, and angles are degrees clockwise from north.

```ts
import { createCircle, createEllipse, createRectangle, createRegularPolygon, createSphere, Draw, shapeOf } from 'react-three-earth-draw'

const draw = new Draw()
draw.addFeatures([
  createCircle([6.6, 46.45], 1500, { extrusionHeightMeters: 800 }), // a cylinder 800 m tall, on the terrain
  createRectangle([6.65, 46.45], 2000, 3500, { rotationDegrees: 30, extrusionHeightMeters: 900 }), // a box
  createRegularPolygon([6.55, 46.5], 1200, 6, { baseHeightMeters: 2500, extrusionHeightMeters: 200 }), // a slab at 2.5 km
  createEllipse([6.7, 46.4], 3000, 1000, { rotationDegrees: 45 }), // flat: draped on the terrain
  createSphere([6.6, 46.5], 900, { id: 'ball' }), // a ball resting on the terrain
])
const shape = shapeOf(draw.getFeature('ball')!) // { type: 'sphere', center: [6.6, 46.5], radiusMeters: 900 }
```

A feature becomes a 3D solid, drawn as a lit mesh instead of being draped, in three cases:

- `properties.extrusionHeightMeters > 0`. A polygon becomes a prism (a circle a cylinder, a rectangle a box), and a line string becomes a wall.
- Its positions have a third coordinate, the GeoJSON altitude, in metres above the WGS84 ellipsoid like every height
  in react-three-earth. A polygon at an altitude floats, and a line string at an altitude is drawn as a line in the air.
- It is a sphere (`properties.shape.type === 'sphere'`). It rests on the terrain, or its center sits at the point's altitude.

Solids without altitudes stand on the terrain under their center. Long edges are split every 2 km so walls follow the curve of the
Earth. To draw solids, pass `extrusionHeightMeters` to the modes; it can change at any time:

```ts
import { CircleMode, Draw, PolygonMode, RectangleMode, SphereMode, StaticMode } from 'react-three-earth-draw'

const circle = new CircleMode({ extrusionHeightMeters: 600 })
const polygon = new PolygonMode({ extrusionHeightMeters: 600 })
const draw = new Draw({ modes: [new StaticMode(), circle, new RectangleMode(), polygon, new SphereMode()] })
circle.extrusionHeightMeters = 2000 // the next circles are 2 km tall; undefined draws flat ones
```

### Editing features

The `select` mode selects and edits finished features:

- A tap selects the feature under it. Points and lines win over the polygon under them, and a tap on the empty map clears the selection.
- On a selected line or polygon, drag a vertex handle to move it.
- Tap or drag a faded midpoint handle to insert a vertex there.
- Tap a vertex to pick it, then press Delete or Backspace, or call `draw.deleteSelected()`. A line keeps 2 vertices and a ring keeps 3.
- Drag inside a selected feature to move it whole. Each position keeps its distance and bearing in metres, so shapes keep their size.
- Shapes (`properties.shape`) and spheres only move whole: they show no vertex handles, so they stay circles and boxes. An edited outline would drop `properties.shape`.
- Presses off the selection still pan, with one finger too, and two fingers cancel a drag and pinch.
- Each edit fires `update` once, on release (`delete` for a deletion). `undo()` takes edits back.
- Solids are picked where they are drawn: their faces and walls at their altitude, a sphere by its outline on the screen.
- A solid stays in 3D while selected; a polygon or wall solid has its footprint outlined, and shows its footprint while dragged.
- A tap inside a selected polygon still selects a point or line under it. Among polygons, the one containing the tap wins over a neighbour whose edge is near.
- Changes made elsewhere (`addFeatures`, `clear`, another tool) clear the undo history, drop a picked vertex, and cancel a drag on that feature.

```tsx
import { Draw } from 'react-three-earth-draw'
import { useDrawEvent, useDrawState } from 'react-three-earth-draw/react'

function EditBar({ draw }: { draw: Draw }) {
  const { mode, selectedIds, canUndo } = useDrawState(draw)
  useDrawEvent(draw, 'update', ({ features }) => console.log('edited', features.map(feature => feature.id)))
  return (
    <div>
      <button aria-pressed={mode === 'select'} onClick={() => draw.setMode('select')}>Select</button>
      <button disabled={selectedIds.length === 0} onClick={() => draw.deleteSelected()}>Delete</button>
      <button disabled={!canUndo} onClick={() => draw.undo()}>Undo</button>
    </div>
  )
}

// From code: selects (switching to the select mode when needed) and clears.
declare const draw: Draw
draw.select(['parcel-12'])
draw.select([])
```

Selected features use the style with `selected: true`. By default lines, fills, points and handle rings turn
amber (`DEFAULT_SELECTED_STYLE`); a style function can pick its own colours from `state.selected`. The editing
helpers (`moveVertex`, `insertVertex`, `removeVertex`, `translateFeature`, `featureVertices`, `hitFeature`) are
exported for custom modes. `new SelectMode({ moveFeatures: false })` only edits vertices, and
`new SelectMode({ editVertices: false })` only selects and moves.

### Transform gizmo: move, rotate, scale, extrude

The `transform` mode selects like `select`, but shows a gizmo on the selected feature instead of vertex handles:

- Drag the feature to move it.
- Drag a corner of the box around it to scale it around its center.
- Drag the knob beyond the box's top edge to turn it; hold Shift to snap to 15°. Circles and spheres have no turning knob.
- Drag the knob in the middle of a line or polygon up to extrude it into a volume: a rectangle becomes a box, a circle a cylinder, a line a wall.
  - On a solid, the knob sits on top; drag it up or down to change the height, or down to the ground to flatten it again.
  - Seen from straight above, as on the flat map, dragging up the screen raises it.
- Shapes keep their measurements: a scaled circle has a new `radiusMeters`, a turned rectangle a new `rotationDegrees`.
- While a solid changes it is previewed in 3D. Each change fires one `update` on release, and `undo()` takes it back.

```ts
import { CircleMode, Draw, featureCenter, rotateFeature, scaleFeature, setExtrusionHeight, StaticMode, TransformMode } from 'react-three-earth-draw'

const draw = new Draw({ modes: [new StaticMode(), new CircleMode(), new TransformMode({ snapDegrees: 45 })] })
draw.setMode('transform')

// The same changes from code, on any feature:
const feature = draw.getFeature('parcel-12')!
const center = featureCenter(feature)
draw.addFeatures([setExtrusionHeight(scaleFeature(rotateFeature(feature, center, 30), center, 2), 120)])
```

The extrusion height and the altitude are two different things. A position's third coordinate is where the feature
sits (its base, above the ellipsoid). `properties.extrusionHeightMeters` is how tall it stands from there. GeoJSON
has only one height per position, so a polygon cannot hold both its base and its top in its coordinates; a
height property is how MapLibre (`fill-extrusion-height` over `fill-extrusion-base`) and Cesium (`extrudedHeight`)
do it too. A slab floating at 2.5 km and 200 m thick has positions at `2500` and `extrusionHeightMeters: 200`.

### React hooks

- `useDrawState(draw)`: the state (`mode`, `modes`, `features`, `selectedIds`, `drawing`, `vertexCount`, `canFinish`,
  `canUndo`),
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

### HIGH: Loading GeoJSON whose third coordinate is not an ellipsoidal altitude

A polygon or line string with any third coordinate is drawn as a solid at that altitude, above the WGS84 ellipsoid.
Files from KML often carry `0`, and GPS tracks carry heights above sea level, so these features end up buried
under the terrain or floating tens of metres off. To drape them, strip the third coordinate before `addFeatures`.
Points always drape; only spheres stand in 3D.

```ts
import type { FeatureCollection, LineString, Polygon } from 'geojson'

function dropAltitudes(collection: FeatureCollection<Polygon | LineString>): FeatureCollection<Polygon | LineString> {
  const flat = (positions: number[][]) => positions.map(([longitude, latitude]) => [longitude!, latitude!])
  return {
    ...collection,
    features: collection.features.map(feature => ({
      ...feature,
      geometry:
        feature.geometry.type === 'Polygon'
          ? { type: 'Polygon', coordinates: feature.geometry.coordinates.map(flat) }
          : { type: 'LineString', coordinates: flat(feature.geometry.coordinates) },
    })),
  }
}
```

### MEDIUM: Solids hundreds of kilometres wide on the flat map

Solids are built on the curve of the globe, with their faces split into triangles about 2 km wide. On the flat map
they keep that curve, so a solid 300 km wide droops about 1.8 km at its edges there. For airspaces at that
scale, split them into smaller features.

### MEDIUM: Multi geometries

`addFeatures` throws for `MultiPolygon` and other `Multi*` geometries; split them into one feature per part first.

## Completion

- The toolbar switches modes, and `canFinish`/`canUndo` enable its buttons.
- Taps place vertices on the globe and on the flat map, with a finger on a phone too; one finger still pans.
- `getFeatures()` (or the `change` event) gives the GeoJSON to save, and `features`/`addFeatures` load it back.
- In the select mode, a tap selects, handles drag vertices, midpoints add them, Delete removes the picked one, and a
  drag inside moves the feature, while a drag elsewhere still pans.
- In the transform mode, corners scale, the outer knob turns, and the middle knob extrudes flat shapes into volumes and
  changes their height.
- Shapes made in two taps or with the builders keep `properties.shape`; extruded ones and ones at an altitude stand as
  solids on the globe and the flat map.
