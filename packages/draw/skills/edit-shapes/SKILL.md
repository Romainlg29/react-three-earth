---
name: edit-shapes
description: >
  Use when users of an @earthkit/draw app must reshape what they drew, like Blender's edit mode: pick and drag
  the vertices, edges or faces of a solid (a mesh), a polygon or a line; push or pull a face along its normal to resize
  a box by one side; extrude a face, or a flat polygon into a prism; double tap to edit a face; Vertex / Edge / Face /
  Extrude buttons in a headless toolbar (setElementMode, extrude, elementMode, canExtrude); Tab, 1, 2, 3 and E keys;
  touch on iPhone Safari. Also for editing meshes in code: moveMeshVertices, pushMeshFace, extrudeMeshFace.
metadata:
  purpose: 'Documents the edit mode of the @earthkit/draw select mode: element modes, picking, dragging, push and pull, extrude, and the mesh editing helpers.'
  type: framework
  framework: 'react'
  library: '@earthkit/draw'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/SelectMode.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/meshEditing.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/mesh.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/editing.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/Draw.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/DrawGizmoToolbar.tsx'
requires:
  - draw-features
---

# Edit shapes

Read `draw-features` first: it sets up the `Draw`, the select mode and its gizmo. Edit mode is the select mode's
other face, as Tab is in Blender: instead of the gizmo, the selected feature shows its **elements**, vertices, edges
or faces, to pick and drag. It works on meshes (solids stored as faces, see `draw-features`), polygons and lines.
Nothing is rendered outside the map: the app builds the buttons from the state.

| Blender | @earthkit/draw |
| --- | --- |
| Tab | a second tap on the selected feature, a double tap on any, `select.setEditingVertices(true)`, or Tab with `keyboard` |
| 1 / 2 / 3 (vertex, edge, face select) | `draw.setElementMode('vertex' \| 'edge' \| 'face')`, or 1 / 2 / 3 with `keyboard` |
| click an element, G to move it | tap it to pick it, drag it to move it |
| E (extrude region) | `draw.extrude()`, or E with `keyboard` |
| move a face along its normal | drag the picked face's arrow (push and pull) |
| Tab back to object mode | a tap on the empty map, Escape, or Tab |

## Setup

```tsx
import { Draw } from '@earthkit/draw'
import { useDrawState } from '@earthkit/draw/react'

function EditToolbar({ draw }: { draw: Draw }) {
  const { editingVertices, elementMode, canExtrude, canUndo } = useDrawState(draw)
  if (!editingVertices) return <span>Tap a shape twice, or double tap a solid's face, to edit it.</span>
  return (
    <div role="group" aria-label="Edit mode">
      {(['vertex', 'edge', 'face'] as const).map(mode => (
        <button key={mode} aria-pressed={elementMode === mode} onClick={() => draw.setElementMode(mode)}>
          {mode}
        </button>
      ))}
      <button disabled={!canExtrude} onClick={() => draw.extrude()}>Extrude</button>
      <button disabled={!canUndo} onClick={() => draw.undo()}>Undo</button>
    </div>
  )
}

// Keys are opt-in: Tab, 1, 2, 3 and E only with `keyboard: true`, while the map has focus.
export const draw = new Draw({ mode: 'select', keyboard: true })
```

State: `editingVertices` (in edit mode), `elementMode` (`'vertex'` by default), `canExtrude` (a face is picked).
Start in faces with `new SelectMode({ elementMode: 'face' })`; `editVertices: false` turns edit mode off.

## Core Patterns

### Entering and leaving

- A tap selects a feature and shows its gizmo. A second tap on it enters edit mode in the current element mode,
  picking the element under the tap.
- A **double tap** (or double click) on a feature selects it and enters edit mode at once; on a mesh it switches to
  faces and picks the face under the pointer. Double tap a box's wall and its arrow is ready to drag.
- A tap on the empty map leaves edit mode and keeps the selection; another clears it. Escape (and Tab) leave too.
- While something is selected, the camera's double-tap zoom is held off, so a double tap edits instead of zooming.
  Selecting another feature starts with its gizmo.
- Points have no edit mode. Flat multipolygons (several draped polygons) neither: they keep the gizmo.

### Picking and dragging elements

- Taps pick within reach: 10 px of a vertex or edge with a mouse, 22 px with a finger; a face under the pointer. On a
  closed mesh only what faces the camera can be picked, so the far side of a box never steals a tap.
- With a mouse, the element under the pointer is highlighted; touch needs no hover: tap, then drag.
- Drag a vertex, an edge or a face to move it **level** under the pointer, at its altitude (on the terrain for a
  draped polygon). A mesh's vertex is shared by the faces around it, so it moves in each and they stay joined.
- Lines and polygons in vertex mode keep their vertex handles: drag one, tap or drag a midpoint to add one, tap one
  then Delete to remove it. In edge mode an edge drags both its ends; in face mode a polygon's face drags it whole.
- Each drag fires `update` once, on release, and is one `undo()` step. The element stays picked after its edit.
- Presses on elements never pan the map; on the feature away from them they move it whole, as with the gizmo; off
  the feature they still pan, with one finger too.

### Push and pull a face

A picked face shows an arrow along its outward normal from its middle, `gizmoSizePixels` (80) long at any zoom. Drag
it to move the face along its normal: the faces around it stretch, so dragging a box's top makes it taller and dragging
a wall makes it wider that way only. Pushed in, the face stops just short of the vertices behind it (a box's bottom),
so the solid never turns inside out. A face seen squarely (a top from above, a wall from in front) shows a knob up the screen instead, to drag up.

On a picked polygon face the arrow pulls the polygon up into a prism that tall (`prismMesh`), its top then picked.

```ts
import { SelectMode } from '@earthkit/draw'

declare const select: SelectMode // the Draw's select mode, from `modes`
// Where a press grabs the arrow, in screen pixels (for tests and tutorials): null without a picked face.
console.log(select.pushPullHandle())
```

### Extrude

`draw.extrude(distanceMeters?)` extrudes the picked face along its normal, as Blender's E: the face moves out on new
vertices and a wall joins each of its edges to where it was. The new face keeps the index and stays picked, so its
arrow pushes it further. A negative distance extrudes into the solid (a dent); on a polygon it returns false. Without a distance it goes half the
arrow's length, about 40 px on the screen. A picked polygon face becomes a prism. One `update`, one undo step; false
when nothing is picked (`state.canExtrude`).

```ts
import { Draw, SelectMode, StaticMode } from '@earthkit/draw'

const select = new SelectMode()
const draw = new Draw({ modes: [new StaticMode(), select], mode: 'select' })
draw.addEventListener('update', ({ features }) => console.log('edited', features[0]!.id))
// After the user picked a face (a double tap on it):
if (draw.getState().canExtrude) draw.extrude(25) // 25 m out
```

### Editing meshes in code

The same edits work on an `IndexedMesh` (`indexMesh`), returning a new one whose vertex and face indices are those of
the input (new vertices and faces come after), so an element found before an edit is the same one after it. Offsets
are metres east, north and up in the east-north-up frame at the moved vertices' middle (`meshElementFrame`).

```ts
import { createRectangle, Draw, indexMesh, meshFaceNormal, meshFromIndexed, extrudeMeshFace, moveMeshVertices, pushMeshFace } from '@earthkit/draw'
import type { MultiPolygon } from 'geojson'

declare const draw: Draw
const box = createRectangle([6.6, 46.45], 100, 50, { id: 'box', baseHeightMeters: 400, heightMeters: 30 })
const mesh = indexMesh(box.geometry as MultiPolygon)
// Face 0 is the top of a shape made with a height (`prismMesh`): its normal points up.
console.log(meshFaceNormal(mesh, 0)) // ≈ [0, 0, 1]
const taller = pushMeshFace(mesh, 0, 20) // the top 20 m higher: 50 m tall
const tower = extrudeMeshFace(taller, 0, 10) // a new top 10 m above, four new walls: 10 faces
const leaning = moveMeshVertices(tower, tower.faces[0]![0]!, [5, 0, 0]) // the top 5 m east, the walls lean
draw.addFeatures([{ ...box, geometry: meshFromIndexed(leaning) }])
```

`moveVertices(feature, paths, from, to)` moves several vertices of a line or polygon by one step, keeping altitudes.
`meshFaceVertices`, `meshFaceArea` and `meshFaceTriangles` read a face.

### Faces stay planar

Each face of a mesh is planar. Moving a whole face, an edge along its walls, or a vertex within the planes of its
faces keeps them so. A face that an edit bends (a box's top with one corner raised) is split into triangles, each
planar: the first keeps the face's index, the others come after the last face. The output is always a valid mesh, at
the cost of more faces.

## Common Mistakes

### HIGH: Expecting the keys without opting in

Tab, 1, 2, 3 and E do nothing until `new Draw({ keyboard: true })`, and then only while the map has focus. Touch users
have no keys: give them buttons on `setElementMode` and `extrude`.

### HIGH: Waiting for a third tap to leave edit mode

Taps on the selected feature pick elements; they never leave edit mode. A tap on the empty map does (or Escape, Tab,
`select.setEditingVertices(false)`). Say so in the app's status line.

### MEDIUM: Expecting Delete to remove a mesh's vertex, edge or face

In edit mode only the picked vertex of a line or polygon is deleted. Otherwise `deleteSelected()` returns false and
deletes nothing, not the feature either: leave edit mode to delete the feature.

### MEDIUM: Dragging a vertex up or down

Element drags move level, at the element's altitude. To change a height, pick a face and drag its arrow, or use the
gizmo's up arrow in object mode, or `moveMeshVertices(mesh, indices, [0, 0, meters])` in code.

### MEDIUM: Calling `extrude(0)`

A distance of 0 would stack new vertices on the old ones (vertices are shared by equal coordinates), so it throws with
the fix. Leave the distance out for the default, or pass a negative one to extrude inwards.

## Completion

- A second tap or a double tap enters edit mode; a double tap on a solid's face picks it and shows its arrow.
- The toolbar shows Vertex, Edge, Face and Extrude while `state.editingVertices`, built from `elementMode`,
  `canExtrude`, `setElementMode` and `extrude`.
- Dragging a picked face's arrow resizes the solid along the face's normal; extrude adds walls and a new face.
- Every edit fires one `update` and `undo()` takes it back; a tap on the empty map returns to the gizmo.
- It works with a finger on a phone: taps pick within 22 px, no hover needed.
