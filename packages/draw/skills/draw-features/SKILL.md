---
name: draw-features
description: >
  Use when an app lets users draw on a react-three-earth map, like maplibre-gl-draw or terra-draw: place points, draw
  lines and polygons by tapping, get the result as GeoJSON, load saved features back, style them, or build a drawing
  toolbar (headless: the app renders the buttons from useDrawState). Also when drawing must work with touch on
  iPhone Safari, on the globe and on the flat 2D map, or when writing a custom drawing mode. Also for circles,
  rectangles, ellipses, regular polygons and spheres in metres (createCircle, createRectangle…, like turf.circle), and
  for 3D: solids stored as meshes of faces (MultiPolygon with altitudes, like Blender): boxes, cylinders, prisms,
  walls, spheres, imported solids, and shapes at an altitude (the GeoJSON third coordinate). Also for editing:
  selecting features, a Blender-style gizmo (arrows, planes, arcs, scale cubes, tools, local axes) to move, raise,
  tilt and scale them, G / R / S keys, dragging, adding and deleting vertices, undo (edit mode: edit-shapes).
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
  - 'Romainlg29/react-three-earth:packages/draw/src/transform.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/shapes.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/mesh.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/localFrame.ts'
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
| `draw.changeMode('draw_polygon')` | `draw.setMode('polygon')` (`'static'`, `'select'`, `'point'`, `'linestring'`, `'polygon'`, `'circle'`, `'rectangle'`, `'sphere'`) |
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
  buttons. Keys are opt-in: with `new Draw({ keyboard: true })`, Enter, Backspace and Escape do it while the map has
  focus (and the select mode's G, R, S keys work, see below).
- Between taps, one finger still pans and two fingers still pinch and rotate. While a drawing mode is active,
  double-tap zoom is held off (`earth.interactions.holdDoubleClickZoom`), so two quick taps place two vertices.
- With a mouse, the next segment follows the pointer. Touch screens have no hover: segments appear on each tap.
- Taps hit a vertex within 10 pixels with a mouse, 22 with a finger.
- `'static'` (the default mode) leaves the map alone.

### Saving and loading GeoJSON

```ts
import type { FeatureCollection } from 'geojson'
import { Draw } from 'react-three-earth-draw'

declare const saved: FeatureCollection<GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon | GeoJSON.MultiPolygon>
declare function save(collection: unknown): void

const draw = new Draw({ features: saved })
draw.addEventListener('change', ({ features }) => save(features))
// Features without an id get one; a taken id replaces that feature (`update` fires).
draw.addFeatures([{ type: 'Feature', properties: { name: 'Camp' }, geometry: { type: 'Point', coordinates: [6.86, 45.83] } }])
```

Every feature has a string `id` (a random UUID unless `createId` says otherwise; numeric ids become strings, missing
ones are made, in `features` and `addFeatures` alike). Draw holds `Point`, `LineString`, `Polygon` and `MultiPolygon`
(a `MultiPolygon` with an altitude on every position and a steep face or a closed surface is a solid mesh, see below;
any other is flat polygons, draped or at their altitudes); coordinates not shaped as GeoJSON says (rings of 4 or more
positions, finite numbers, latitudes within ±90°) throw with the fix; split `MultiPoint`, `MultiLineString` and `GeometryCollection` into several features. Longitudes are kept as tapped, in -180 to 180: a line drawn across the antimeridian
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
See-through solids are drawn after the atmosphere (`TRANSLUCENT_LAYER`, hazed at their own distance) when the pipeline runs that pass (`<Atmosphere>` does).

### Shapes and 3D solids

The `circle`, `rectangle` and `sphere` modes take two taps: a center (or a corner), then the edge (or the opposite
corner). The shape previews under the mouse between taps. A second tap on the first point, a double tap, is ignored.
To make shapes in code, use the builders. Lengths are metres on the ground, and angles are degrees clockwise from north.
They return plain GeoJSON: nothing in `properties` describes the shape.

Solids are **meshes of faces**, as in Blender. A mesh is a `MultiPolygon` whose every position has a third coordinate,
its altitude in metres above the WGS84 ellipsoid (like every height in react-three-earth), with a face steeper than 60°
or closed (`isMeshGeometry`; flat polygons lifted over relief stay flat polygons). Each polygon is one planar
face (a box has six: top, bottom, four walls), its exterior ring **counter-clockwise seen from outside** the solid, so
its normal points outwards (the top of a prism is counter-clockwise from above, as GeoJSON wants; its bottom
clockwise). Faces share vertices by equal coordinates. No property holds a height or a shape: moving, turning,
scaling or raising a solid writes new vertex positions.

```ts
import { createCircle, createEllipse, createRectangle, createRegularPolygon, createSphere, Draw } from 'react-three-earth-draw'

const draw = new Draw()
draw.addFeatures([
  // A box mesh: bottom at 420 m, its level top 900 m above it, turned 30°.
  createRectangle([6.65, 46.45], 2000, 3500, { rotationDegrees: 30, baseHeightMeters: 420, heightMeters: 900 }),
  createCircle([6.6, 46.45], 1500, { baseHeightMeters: 400, heightMeters: 800 }), // a cylinder
  createRegularPolygon([6.55, 46.5], 1200, 6, { baseHeightMeters: 2500, heightMeters: 200 }), // a slab at 2.5 km
  createRegularPolygon([6.5, 46.4], 300, 4, { baseHeightMeters: 2500 }), // a flat polygon at 2.5 km
  createEllipse([6.7, 46.4], 3000, 1000, { rotationDegrees: 45 }), // flat: draped on the terrain
  createSphere([6.6, 46.5], 900, { id: 'ball', baseHeightMeters: 450 }), // a sphere resting at 450 m
])
```

`baseHeightMeters` is one altitude or a function of longitude and latitude, such as one reading the terrain, so the
bottom follows the ground under each vertex. With `heightMeters`, the top is level, that high above the highest base
vertex. The geometry helpers build meshes from your own outlines, and read them back:

```ts
import { indexMesh, isClosedMesh, isMeshFeature, meshTop, prismMesh, sphereMesh, wallMesh, type DrawFeature } from 'react-three-earth-draw'

const box = prismMesh([[[6.6, 46.45], [6.61, 46.45], [6.61, 46.46], [6.6, 46.46]]], 420, 30) // MultiPolygon, 6 faces
const fence = wallMesh([[6.6, 46.45], [6.62, 46.45]], 400, 2) // open: a quad per segment, 2 m tall
const ball = sphereMesh([6.6, 46.45], 50, 500, { segments: 24, rings: 12 }) // centred 500 m up

declare const feature: DrawFeature
if (isMeshFeature(feature)) {
  const mesh = indexMesh(feature.geometry) // { vertices, faces }: each vertex once, faces as vertex indices
  console.log(mesh.vertices.length, isClosedMesh(mesh), meshTop(feature.geometry)) // 8, true, { topMeters, belowMeters }
}
```

A feature is drawn as a lit 3D solid, instead of being draped, when it is a mesh, or a polygon or line string with
altitudes (a polygon at an altitude is one flat face; a line string at an altitude a line in the air). A closed mesh
wound outwards is drawn from outside only; open or inside-out meshes from both sides. Faces are shaded smoothly where
they meet at less than 30° (a cylinder's wall, a sphere) and outlined in `lineColor` where sharper. Edges longer than
2 km are split so faces follow the curve of the Earth. To draw solids, pass `heightMeters` to the modes; it can change
at any time. Their base is the terrain under each vertex as it was when drawn:

```ts
import { CircleMode, Draw, LineStringMode, PolygonMode, RectangleMode, SphereMode, StaticMode } from 'react-three-earth-draw'

const circle = new CircleMode({ heightMeters: 600 }) // cylinders
const polygon = new PolygonMode({ heightMeters: 600 }) // prisms; LineStringMode makes walls
const draw = new Draw({ modes: [new StaticMode(), circle, new RectangleMode(), polygon, new LineStringMode({ heightMeters: 50 }), new SphereMode()] })
circle.heightMeters = 2000 // the next circles are 2 km tall; undefined draws flat ones
```

### Selecting and editing features

The `select` mode selects and edits finished features. A tap selects the feature under it: points and lines win over
the polygon under them, and a tap on the empty map clears the selection. A selected line, polygon or mesh shows a
gizmo at its center (the middle of its altitudes, or on the terrain), about 80 px on the screen at any zoom
(`gizmoSizePixels`). Its axes are x east (red), y north (green) and z up (blue); an axis pointing away from the camera
is drawn the other way, so arrows never lie on each other:

- Drag an **arrow** to move along that axis only; up gives positions altitudes, as `liftFeature` does (seen from
  above, up is a knob up the screen). A **square** moves in its plane, the white **center ring** on the ground.
- Drag an **arc** to turn around that axis through the center: around up is the heading; around east or north tilts
  the feature, straight into its vertex positions (a flat polygon or line gets altitudes). An arc seen edge on hides
  (turn the camera a little). With `snapping: true`, Shift snaps turns to `snapDegrees` (15).
- Drag a **cube** on an axis to scale along it (along up from the base, so it stays standing); drag the outer ring
  (or, with the scale tool, the center ring) to scale uniformly, a mesh in 3D from its base.
- A press within reach of a handle (10 px with a mouse, 22 px with a finger) takes the nearest one, over the feature
  too; anywhere else on the feature it moves it on the ground. Small on the screen: zoom in or lower `gizmoSizePixels`.

`draw.setGizmoTool('all' | 'move' | 'rotate' | 'scale')` shows every handle (default) or one tool's;
`draw.setGizmoSpace('world' | 'local')` turns the axes to the feature's own (`featureAxes`: z a box's or prism's
first face normal, so it follows any tilt, straight up for a sphere; x and y its tightest rectangle's edges); both are in the state. With `keyboard: true`, G, R or S moves, turns or
scales under the mouse with no press (on the ground, around up, uniformly), X, Y or Z locks a gizmo axis, a click or
Enter confirms, Escape or a right click cancels (`select.startTransform('move')` from a button).

Tap the selected feature again, or double tap a line, polygon or solid, for **edit mode** (`state.editingVertices`):
its vertices, edges or faces instead of the gizmo, to pick and drag; a picked face pushes, pulls and extrudes. A tap
on the empty map (or Escape) goes back to the gizmo. `react-three-earth-draw#edit-shapes` covers it. Picking vertices
of a line or polygon, drag a vertex handle (one at an altitude moves level, keeping it), tap or drag a faded midpoint
to insert one, tap a vertex then Delete or `draw.deleteSelected()` to remove it (a line keeps 2, a ring 3).

Points have no gizmo and no vertices: they move whole. For all features:
- Presses off the selection still pan, with one finger too, and two fingers cancel a drag and pinch.
- Each edit fires `update` once, on release (`delete` for a deletion). A drag that changes nothing records nothing. `undo()` takes edits back.
- Solids are picked where they are drawn (inside a face at its altitudes, or near an edge) and stay 3D while they change.
- A tap inside a selected polygon still selects a point or line under it. Among polygons, the one containing the tap wins over a neighbour whose edge is near.
- Changes made elsewhere (`addFeatures`, `clear`, another tool) clear the undo history, drop a picked vertex, and cancel a drag on that feature.

```tsx
import { Draw } from 'react-three-earth-draw'
import { useDrawEvent, useDrawState } from 'react-three-earth-draw/react'

function EditBar({ draw }: { draw: Draw }) {
  const { mode, selectedIds, canUndo, editingVertices } = useDrawState(draw)
  useDrawEvent(draw, 'update', ({ features }) => console.log('edited', features.map(feature => feature.id)))
  return (
    <div>
      <button aria-pressed={mode === 'select'} onClick={() => draw.setMode('select')}>Select</button>
      <button disabled={selectedIds.length === 0} onClick={() => draw.deleteSelected()}>Delete</button>
      <button disabled={!canUndo} onClick={() => draw.undo()}>Undo</button>
      <span>{editingVertices ? 'Tap the empty map for the gizmo.' : 'Tap it again to edit it.'}</span>
    </div>
  )
}

declare const draw: Draw
draw.select(['parcel-12']) // switches to the select mode when needed; [] clears
```

Selected features use the style with `selected: true`. By default lines, fills, points and handle rings turn
amber (`DEFAULT_SELECTED_STYLE`); a style function can pick its own colours from `state.selected`.

Options turn parts off: `editVertices: false` keeps the gizmo (`select.setEditingVertices(true)` switches from a
button), `moveFeatures: false` leaves the body to the camera, `move`, `rotate` and `scale` remove handle groups:

```tsx
import { Draw, featureCenter, offsetFeature, rotateFeature, rotateFeatureAroundAxis, scaleFeatureAlongAxis, SelectMode, StaticMode } from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'

const select = new SelectMode({ snapping: true, rotate: true, scale: false })
const draw = new Draw({ modes: [new StaticMode(), select], keyboard: true })

function GizmoBar() {
  const { gizmoTool, gizmoSpace } = useDrawState(draw)
  return (
    <div>
      {(['all', 'move', 'rotate', 'scale'] as const).map(tool => (
        <button key={tool} aria-pressed={gizmoTool === tool} onClick={() => draw.setGizmoTool(tool)}>{tool}</button>
      ))}
      <button onClick={() => draw.setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world')}>{gizmoSpace} axes</button>
    </div>
  )
}

// The same changes from code. Axes are [east, north, up]; turns are right-handed (counter-clockwise from the tip).
const feature = draw.getFeature('parcel-12')!
const [longitude, latitude] = featureCenter(feature)
const raised = offsetFeature(feature, [200, 0, 50], 400) // 200 m east, 50 m up from the terrain (400 m) under it
const tilted = rotateFeatureAroundAxis(raised, [longitude, latitude, 450], [1, 0, 0], 20, 400) // 20° around east
const wider = scaleFeatureAlongAxis(tilted, [longitude, latitude, 450], [1, 0, 0], 2) // twice as wide east-west
draw.addFeatures([rotateFeature(wider, [longitude, latitude], 30)]) // heading: 30° clockwise from north
```

`liftFeature(feature, deltaMeters, groundHeightMeters)` raises positions with an altitude by `deltaMeters`, the others
from the terrain's height (`groundHeightMeters`, here and in the 3D helpers: one height or a function of longitude and
latitude, such as one calling `earth.queryTerrainElevation`); `placeOnTerrain` drops altitudes again. Tilts (`rotateFeatureAroundAxis` around a horizontal axis) and `scaleFeatureAlongAxis` along
a slanted one work in the pivot's east-north-up frame (`LocalFrame`), so distances and flat faces are kept exactly;
around up and along horizontal axes they are `rotateFeature` and `stretchFeature`, which keep altitudes. Also exported:
`scaleFeature`, `stretchFeature`, `extrudeFeature`, `moveMeshTop`, and the editing helpers (`moveVertex`,
`insertVertex`, `removeVertex`, `translateFeature`, `featureVertices`, `hitFeature`) for custom modes.

Every transform maps vertex positions (lifting a slab at 2500–2700 m by 100 m makes them 2600–2800).
`altitudeRangeOf(feature)` gives its lowest and highest altitudes (null on the terrain), `meshTopOf` a level top face's
altitude, and `select.gizmoHandles()` where each gizmo handle is on the screen (for tests and tutorials).

### React hooks

- `useDrawState(draw)`: the state (`mode`, `modes`, `features`, `selectedIds`, `drawing`, `vertexCount`, `canFinish`,
  `canUndo`, `editingVertices`, `elementMode`, `canExtrude`, `gizmoTool`, `gizmoSpace`), re-rendering on change;
  `useDrawState(draw, state => state.mode)` only when that part changes.
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

A polygon or line string with any third coordinate, and a multipolygon with one on every position, is drawn as a solid
at that altitude, above the WGS84 ellipsoid.
Files from KML often carry `0`, and GPS tracks carry heights above sea level, so these features end up buried
under the terrain or floating tens of metres off. To drape them, strip the third coordinate before `addFeatures`.
Points always drape.

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

### HIGH: Storing a solid as an outline and a height

There is no `extrusionHeightMeters` or `shape` property: a polygon with one stays a flat polygon. Build a mesh
(`prismMesh`, `createRectangle(…, { heightMeters })`, `extrudeFeature`), and wind each face counter-clockwise seen from
outside; faces wound the other way, or a mesh with gaps, are drawn from both sides.

### MEDIUM: Multi geometries

`addFeatures` throws for `MultiPoint`, `MultiLineString` and `GeometryCollection`; split them into one feature per part
first. A `MultiPolygon` is held: as a mesh when `isMeshGeometry` says so, else as flat polygons (draped, or at their
altitudes), which `placeOnTerrain` drapes again and `extrudeFeature` turns into one prism per polygon.

### MEDIUM: Expecting scaling to keep a mesh's height

`scaleFeature` (and the gizmo's outer ring) scales anything with altitudes in 3D, around its base: a box twice as wide
is twice as tall, a tilted polygon keeps its slope; draped positions stay draped. To change only the footprint use a cube (`scaleFeatureAlongAxis` along east or north), or set the top
back with `moveMeshTop`.

### MEDIUM: Expecting the keys without opting in

`keyboard` defaults to false: Escape, Enter, Delete and G / R / S do nothing until `new Draw({ keyboard: true })`, and
then only while the map has focus. Shift snaps turns only with `new SelectMode({ snapping: true })`.

## Completion

- The toolbar switches modes, and `canFinish`/`canUndo` enable its buttons.
- Taps place vertices on the globe and on the flat map, with a finger on a phone too; one finger still pans.
- `getFeatures()` (or the `change` event) gives the GeoJSON to save, and `features`/`addFeatures` load it back.
- In the select mode, a tap selects and shows the gizmo: arrows and squares move, the ring moves on the ground, arcs
  turn and tilt, cubes and the outer ring scale; tool and axes buttons call `setGizmoTool` and `setGizmoSpace`. A drag
  on the feature off the handles moves it, while a drag elsewhere still pans.
- A second tap enters edit mode (see edit-shapes): vertex handles drag, midpoints add, Delete removes the picked one.
- Shapes made in two taps or with the builders are plain GeoJSON; those with a height are meshes (faces with
  altitudes) and stand as solids on the globe and the flat map, as do features at an altitude.
