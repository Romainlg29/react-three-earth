---
name: query-features-and-layer-events
description: >
  Use when an app needs to know which map features (roads, lakes, buildings, labels of a MapLibre style) are
  under the pointer or in an area on a react-three-earth globe or flat map: queryRenderedFeatures,
  querySourceFeatures, clicking a feature, layer-scoped click / pointermove / pointerenter / pointerleave
  events (MapLibre's map.on(type, layerId) with mouseenter / mouseleave), a pointer cursor over layers, or
  highlighting the hovered feature with feature-state.
metadata:
  purpose: 'Documents earth.queryRenderedFeatures, MapStyleSource.querySourceFeatures, earth.layerEvents (addEventListener, addCursor, addHoverState), useEarthEvent with layers, useLayerCursor and useHoverFeatureState, and how hits follow what is drawn.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/LayerEvents.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/featureQuery.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyleOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/featureIndex.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/MapStyleProcessor.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/hooks.ts'
requires:
  - map-styles
  - camera-and-events
---

# Query features and layer events

Read `map-styles` (the style drawing the features) and `camera-and-events` (screen positions, pointer
events) first.

| MapLibre | react-three-earth |
| --- | --- |
| `map.queryRenderedFeatures(point \| box, { layers, filter })` | `await earth.queryRenderedFeatures(screen \| [corner, corner], { layers, filter, tolerancePixels })` |
| `map.querySourceFeatures(sourceId, { sourceLayer, filter })` | `await mapStyleSource.querySourceFeatures(sourceId, { sourceLayer, filter })` |
| `map.on('click', 'roads', listener)` | `useEarthEvent('click', listener, { layers: ['roads'] })`, `earth.layerEvents.addEventListener('click', listener, { layers: ['roads'] })` |
| `mouseenter` / `mouseleave` / `mousemove` on a layer | `pointerenter` / `pointerleave` / `pointermove` with `{ layers }` |
| `map.getCanvas().style.cursor = 'pointer'` on enter, `''` on leave | `useLayerCursor(['roads'])`, `earth.layerEvents.addCursor(['roads'])` |
| hover `setFeatureState` on `mousemove` / `mouseleave` | `useHoverFeatureState(['countries'])`, `earth.layerEvents.addHoverState(['countries'])` |

Both queries are **asynchronous**: the vector worker answers (about 2 ms on a desktop). Features are
MapLibre-shaped: `{ type: 'Feature', id, geometry, properties, source, sourceLayer, state, layer }`, geometry as
GeoJSON in degrees, clipped to the tile it was read from. Rendered features also carry `mapStyleSource`, the
`MapStyleSource` whose style drew them.

## Setup

```tsx
import { Earth, EarthControls, Imagery, MapStyleSource, QuantizedMeshSource, Terrain, useEarthEvent, useLayerCursor } from 'react-three-earth/react'

function RoadPicker({ onPick }: { onPick: (name: string) => void }) {
  useLayerCursor(['road'])
  useEarthEvent('click', event => onPick(String(event.features[0]?.properties.name ?? '')), { layers: ['road'] })
  return null
}

export function PickableMap({ onPick }: { onPick: (name: string) => void }) {
  return (
    <Earth>
      <Terrain>
        <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" />
      </Terrain>
      <Imagery>
        <MapStyleSource url="https://example.com/style.json" />
      </Imagery>
      <EarthControls />
      <RoadPicker onPick={onPick} />
    </Earth>
  )
}
```

The layer hooks go anywhere inside `<Earth>`. The layer ids are the style's (`source.getLayerIds()`).

## Core Patterns

### Query what is under a point or in a box

```ts
import type { Earth } from 'react-three-earth'

export async function namesAt(earth: Earth, xPixels: number, yPixels: number): Promise<string[]> {
  const features = await earth.queryRenderedFeatures({ xPixels, yPixels }, { layers: ['road', 'water'], tolerancePixels: 3 })
  return features.map(feature => String(feature.properties.name ?? feature.layer.id))
}

export async function lakesInBox(earth: Earth) {
  const features = await earth.queryRenderedFeatures([{ xPixels: 100, yPixels: 100 }, { xPixels: 400, yPixels: 300 }], { layers: ['water'], filter: ['>', ['get', 'area'], 1e6] })
  return features
}
```

- Order is what you see, top-most first: the last `<Imagery>` first; within a style, labels first (they draw
  above every shape), then shapes from the top style layer down.
- Hits follow what is drawn: line widths and gaps, `line-offset`, circle radius plus stroke, fills with their
  holes, and the boxes of placed labels, evaluated at the zoom the terrain is textured at under the point.
  Labels facing the viewer (the default `symbols="screen"`) are hit by their box on the screen, as shown.
  Hidden layers and layers outside their zoom range are left out. A transparent fill still answers, as in MapLibre.
- `tolerancePixels` widens every hit (useful on touch); default 0, as MapLibre.
- No geometry queries the whole screen. A box is followed on the ground along its outline (perspective and the
  globe bend it); when part of it is on the sky (the whole globe in view), the ground inside it is sampled.
- Only what visible terrain tiles draw answers, each part at its own zoom: a box over a pitched view reads fine
  tiles near the camera and coarse ones near the horizon, the tiles already loaded.
- A feature with an id is listed once per layer even across tiles. Without an id it may repeat.
- Before the style has loaded, or where no texture is drawn yet, the answer is empty.

### Every feature of a source

```ts
import type { MapStyleSource } from 'react-three-earth'

export async function loadedBuildings(source: MapStyleSource) {
  const features = await source.querySourceFeatures('openmaptiles', { sourceLayer: 'building', filter: ['has', 'height'] })
  return new Set(features.map(feature => feature.id))
}
```

It reads the tiles drawn now, drawn by a layer or not. A feature crossing tiles comes once per tile, clipped to
each (as in MapLibre): dedupe by `id`. A wrong source id throws and lists the style's sources.

### Layer events

```tsx
import { useEarthEvent } from 'react-three-earth/react'
import { useState } from 'react'

export function CountryTooltip() {
  const [country, setCountry] = useState<string | null>(null)
  useEarthEvent('pointerenter', event => setCountry(String(event.features[0]?.properties.name)), { layers: ['countries'] })
  useEarthEvent('pointerleave', () => setCountry(null), { layers: ['countries'] })
  return country === null ? null : <div className="country-tooltip">{country}</div>
}
```

| Type | Fires |
| --- | --- |
| `click`, `doubleclick`, `contextmenu` | the pointer event is over features of the layers |
| `pointermove` | every queried move over features of the layers |
| `pointerenter` | the pointer moves onto the layers from elsewhere (not again between their features) |
| `pointerleave` | the pointer moves off the layers, or leaves the map; `features` is empty |

The event has `features` (in the listener's layers, top-most first), `screen`, `geographic` and
`originalEvent`. Every listener of a type shares one query per pointer event; pointer moves keep one query in
flight and query the latest move next. Vanilla: `earth.layerEvents.addEventListener(type, listener, { layers })`
returns a function that removes it.

### Hover highlight

```tsx
import { MapStyleSource, StyleLayer, useHoverFeatureState } from 'react-three-earth/react'

export function HoverHighlight() {
  useHoverFeatureState(['countries'])
  return null
}

export function CountryStyle() {
  return (
    <MapStyleSource url="https://example.com/style.json">
      <StyleLayer
        id="countries-hover"
        type="fill"
        source="base"
        sourceLayer="countries"
        paint={{ 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffcc00', 'rgba(0, 0, 0, 0)'] }}
      />
    </MapStyleSource>
  )
}
```

`useHoverFeatureState(layers, { stateKey })` sets `{ hover: true }` on the top-most feature with an id under the
pointer and `false` when the pointer leaves it. Hover a colour or opacity: it only redraws the textures holding
the feature (see `map-styles`).

### Select on click

```ts
import type { Earth, RenderedFeature } from 'react-three-earth'

export function selectOnClick(earth: Earth): () => void {
  let selected: RenderedFeature | null = null
  return earth.layerEvents.addEventListener(
    'click',
    event => {
      if (selected !== null) selected.mapStyleSource.setFeatureState({ source: selected.source, sourceLayer: selected.sourceLayer, id: selected.id! }, { selected: false })
      selected = event.features[0] ?? null
      if (selected?.id !== undefined) selected.mapStyleSource.setFeatureState({ source: selected.source, sourceLayer: selected.sourceLayer, id: selected.id }, { selected: true })
    },
    { layers: ['buildings'] },
  )
}
```

## Common Mistakes

### HIGH: Treating the query as synchronous

```ts
import type { Earth } from 'react-three-earth'

export async function firstName(earth: Earth) {
  // Wrong: `earth.queryRenderedFeatures(point)[0]` is a Promise, not an array
  const [feature] = await earth.queryRenderedFeatures({ xPixels: 10, yPixels: 10 })
  return feature?.properties.name
}
```

### HIGH: Calling `preventDefault` in a layer listener

Layer listeners run after the worker answered, too late for `originalEvent.preventDefault()`. Listen with
`earth.addEventListener('contextmenu', …)` (or `useEarthEvent` without `layers`) for that.

### HIGH: Hover state on tiles without ids

`useHoverFeatureState` needs feature ids; most MVT tiles have none. Set `promoteId` on the source. It warns
once per layer when the features have no id.

### MEDIUM: Layer ids that are not in the style

An id no loaded style has warns once (`no style has a layer "…"`) and matches nothing. Check
`source.getLayerIds()`; `<StyleLayer>` ids count once added.

### MEDIUM: Expecting custom layer types, icons or rasters to answer

Only `fill`, `fill-extrusion` (by its footprint on the ground, not its 3D shape), `line`, `circle` and text labels are hit-tested. Plugin layer
types, raster sources and draped layers answer nothing.

### MEDIUM: Expecting hover to follow a camera move

Hover, cursor and `pointerenter` / `pointerleave` update on pointer moves, as in MapLibre: zooming with the wheel
or an animation under a still pointer does not query again until the pointer moves.

### MEDIUM: Translate properties

`fill-translate`, `line-translate` and `circle-translate` move both the drawing and the hit test: a click lands on
the shape where it is drawn, not on its source geometry. A `viewport` anchor is drawn and queried as `map`.

### MEDIUM: Very wide lines near their edge

Line and circle candidates are looked up within 128 map pixels of the query: a data-driven half width or
radius larger than that can be missed near its edge.

## Completion

- `await earth.queryRenderedFeatures(earth.project(position))` returns the feature drawn there, with
  `feature.layer.id` and `feature.properties`.
- A click on a feature reaches `useEarthEvent('click', …, { layers })` with it in `event.features`.
- With `useHoverFeatureState`, `source.getFeatureState({ source, sourceLayer, id })` reads `{ hover: true }`
  while the pointer is over it, and the highlight shows after the textures redraw
  (`earth.inspect().terrain.imageryRecompositionsPending` back to 0).
