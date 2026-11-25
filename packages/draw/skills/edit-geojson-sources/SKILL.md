---
name: edit-geojson-sources
description: >
  Use when users of an earthkit app must edit GeoJSON already on the map (an imported or dropped file, a dataset from
  an API, a GeoJsonSource styled with style layers) with @earthkit/draw, in place: select, move and reshape its
  features, add and delete some, with every change written back to the source and no second copy of the data. Also
  for large files (thousands of features) where performance matters, for hiding features from a GeoJsonSource's tiles
  while an editor draws them (setHiddenFeatureIds), and for draw.setSource versus draw.addFeatures.
metadata:
  purpose: 'Documents Draw.setSource (editing a GeoJsonSource in place), GeoJsonSource.setHiddenFeatureIds, and how edits reach the source.'
  type: framework
  framework: 'react'
  library: '@earthkit/draw'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/draw/src/Draw.ts'
  - 'Romainlg29/react-three-earth:packages/draw/src/modes/SelectMode.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/GeoJsonSource.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/geoJsonSource.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/ShowcaseExample.tsx'
requires:
  - draw-features
---

# Edit GeoJSON sources in place

Read `draw-features` first: it sets up the `Draw` and its select mode. `draw.addFeatures(geojson)` copies features
into Draw's own store, as mapbox-gl-draw does: the app then holds the data twice and must write edits back itself.
`draw.setSource(geoJsonSource)` edits a `GeoJsonSource` **in place** instead:

- Draw's store holds the source's own feature objects (no copy of the coordinates; a shallow copy only for features
  whose id is a number or comes from `promoteId`).
- The source's style layers keep drawing its features, in the app's style. Draw drapes none of them.
- The selected feature is drawn by Draw's overlay and hidden from the source's tiles meanwhile
  (`GeoJsonSource.setHiddenFeatureIds`): the worker filters it out of the tiles it already cut, and only the regions
  around it redraw. Nothing is tiled again on selection.
- Each change (a move, a vertex, a new feature, a delete, an undo, `addFeatures`, `removeFeatures`) is written back with
  one `source.updateData` when it is made: on release, never on each frame of a drag. `source.data` is always current.

## Setup

```ts
import { Draw } from '@earthkit/draw'
import { GeoJsonSource, MapStyleSource } from '@earthkit/globe'
import type { FeatureCollection } from 'geojson'

declare const style: MapStyleSource
declare const parcels: FeatureCollection

const source = new GeoJsonSource({ id: 'parcels', data: parcels })
style.addGeoJsonSource(source)
style.addLayer({ id: 'parcels-fill', type: 'fill', source: 'parcels', paint: { 'fill-color': '#0ca678', 'fill-opacity': 0.3 } })

const draw = new Draw({ source }) // or draw.setSource(source) later
draw.setMode('select')
draw.addEventListener('change', () => console.log(source.data)) // edits are already in the source

// Stop editing: the source keeps its data, and shows every feature again.
draw.setSource(null)
```

In React, take the core source from `<GeoJsonSource>`'s `ref`:

```tsx
import { Draw } from '@earthkit/draw'
import type { GeoJsonSource as GeoJsonSourceImpl } from '@earthkit/globe'
import { GeoJsonSource, StyleLayer } from '@earthkit/globe/react'
import type { FeatureCollection } from 'geojson'
import { useEffect, useMemo, useState } from 'react'

export function EditableParcels({ data, editing }: { data: FeatureCollection; editing: boolean }) {
  const draw = useMemo(() => new Draw({ name: 'parcels-editor' }), [])
  const [source, setSource] = useState<GeoJsonSourceImpl | null>(null)
  useEffect(() => {
    draw.setSource(editing ? source : null)
    draw.setMode(editing ? 'select' : 'static')
  }, [draw, editing, source])
  // Install `draw` with <Earth plugins={[draw]}> (a stable array) or usePlugin(draw).
  return (
    <GeoJsonSource ref={setSource} id="parcels" data={data}>
      <StyleLayer id="parcels-fill" type="fill" paint={{ 'fill-color': '#0ca678', 'fill-opacity': 0.3 }} />
    </GeoJsonSource>
  )
}
```

## Core Patterns

### What is editable

`Point`, `LineString`, `Polygon` and `MultiPolygon` features. Others (`MultiPoint`, `MultiLineString`,
`GeometryCollection`, invalid coordinates) stay in the source, drawn and untouched, and cannot be selected.

### Ids

Every feature is updated by id: its `id`, or the `promoteId` property. Draw ids are strings: a numeric id `7` is `'7'`
in Draw and stays `7` in the source, after an undo too. Two ids that read the same (`1` and `'1'`) throw. Features with neither get an id from `createId` in one `setData` when editing
starts. A feature drawn new in a `promoteId` source gets that property set to its id.

### Hiding features from a GeoJsonSource's tiles

Any editor can do what Draw does: draw some features itself and hide them from the source meanwhile.

```ts
import type { GeoJsonSource } from '@earthkit/globe'

declare const source: GeoJsonSource
source.setHiddenFeatureIds(['parcel-12']) // still in source.data, gone from the tiles
source.setHiddenFeatureIds([]) // shown again
```

It costs a redraw of the regions around those features, whatever the size of the data: no tiling again. With
`cluster`, hidden points still count in their clusters.

### Performance on large files

- Selecting, deselecting and dragging never tile the data again: the drag is drawn by the overlay, the hide is a
  filter in the tile worker.
- Each committed change is one `updateData`. Without `cluster`, the tile worker cuts only the features changed since
  the last full cut, in a small second index drawn over the first: one edit in 50,000 polygons takes under a
  millisecond where cutting everything took 300 ms, growing with the edits made since. Once the changed and removed
  features pass an eighth of the data (and 256), everything is cut again. Changed features draw above the others until
  then, and keep their `generateId` ids. Clustered sources cluster every point again on each change.
- A tap tests only the draped features whose box is within reach of it, so selecting in a file of thousands of
  features projects a handful of them (in a tilted view, a tap that finds nothing nearby tests them all). Features with
  a third coordinate are always tested.

## Common Mistakes

### HIGH: Passing the features to `addFeatures` as well

`setSource` replaces what Draw held: the features come from the source. Calling `addFeatures(source.data)` too would
write them to the source again. Use one Draw per source edited in place, and another for the user's own drawings.

### HIGH: Changing the source behind Draw's back

Change the data through Draw while it edits (`addFeatures`, `removeFeatures`). After `source.setData` or
`source.updateData` from elsewhere, call `draw.setSource(source)` again, which reloads the features: Draw does not see
the change on its own.

### HIGH: A React `<GeoJsonSource>` whose features have no ids

Draw gives id-less features ids with `setData`, and the next render of `<GeoJsonSource data={…}>` with the old object
replaces that data again. Give every feature an `id` when the data is loaded, before rendering it.

### HIGH: Files whose positions carry a third coordinate

KML exports and GPS tracks often carry `[longitude, latitude, 0]` or heights above sea level. The source's layers drape
them, but Draw treats a third coordinate as an altitude above the ellipsoid: it hit-tests and edits them there, so taps
miss them in tilted mountain views. Strip the third coordinate when the file is loaded, before rendering it.

### MEDIUM: Data loaded from a URL

`setSource` throws for a source whose `data` is a URL: the main thread does not hold the features. Fetch the GeoJSON
in the app and pass the object as `data`.

### MEDIUM: Expecting Draw's style on the source's features

Draw's `style` applies to the selected feature only (drawn by Draw's overlay). The others are drawn by the source's
style layers: style them there, and give the layers fills, lines and circles for the geometry types users may add.

## Completion

- Selecting a feature of the file shows Draw's gizmo on it, with no second copy drawn under it.
- Moving or reshaping it changes `source.data` on release; deselected, the source draws it at its new place.
- New features drawn in the polygon, line or point modes land in the source and are drawn by its layers.
- `draw.setSource(null)` ends editing; the source keeps every change.
