---
name: map-styles
description: >
  Use when draping a MapLibre style (vector tiles: roads, water, labels) on a react-three-earth globe or flat
  map with MapStyleSource: style URLs or objects, XYZ, TileJSON and PMTiles sources, satellite and relief
  styles (raster and raster-dem sources, raster, hillshade and color-relief layers), the worker, headers,
  fonts, labels facing the viewer or draped (symbols, symbolFadeDurationSeconds), sprite patterns (fill-pattern, line-pattern, background-pattern), runtime images with addImage /
  updateImage / removeImage and onStyleImageMissing, changing the style at runtime (setPaintProperty,
  setFilter, addLayer, setStyle diff, StyleLayer), app data with GeoJsonSource (geojson sources, setData,
  updateData, clustering with point_count and cluster queries, line-gradient with lineMetrics), feature-state for
  hover and selection, global-state, transformRequest and addProtocol, and redrawing after tile data changed on
  the server with invalidate(bounds).
metadata:
  purpose: 'Covers MapStyleSource, what it draws, its options, the runtime style API, GeoJSON sources and clusters, feature-state, invalidate and what is not supported yet.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyleOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyle.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/symbols/ScreenSymbols.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/StyleLayer.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/GeoJsonSource.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/GeoJsonSource.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/geoJsonSource.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/geoJsonData.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/styleLayers.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/rectangles.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/sprites.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/tileSources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/styleImageInput.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/camera.ts'
requires:
  - terrain-and-imagery-sources
---

# Map styles (MapLibre vector tiles)

Read `terrain-and-imagery-sources` first: a map style is an imagery source, so it sits in an `<Imagery>`
layer and drapes on terrain.

`MapStyleSource` takes a MapLibre style (version 8). A worker fetches and tessellates the vector tiles, tiles
GeoJSON (fills, lines, circles, text labels) and decodes raster and elevation tiles; the main thread draws them
straight into each terrain tile's texture on the GPU. Labels, place and road names alike, face the viewer
(`map-labels`), and `fill-extrusion` layers stand as 3D buildings.

## Setup

```tsx
import { Earth, Imagery, MapStyleSource, QuantizedMeshSource, Terrain } from 'react-three-earth/react'

export function VectorMap() {
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

Vanilla: `earth.addImagery(new Imagery({ sources: [new MapStyleSource({ url })] }))`, then
`imagery.dispose()` after `earth.removeImagery(imagery)` (it stops the worker).

## Core Patterns

### Pass a style object, headers or a font

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import { useMemo } from 'react'

export function OwnStyle({ token }: { token: string }) {
  const style = useMemo(
    () => ({
      version: 8,
      sources: { base: { type: 'vector', url: 'pmtiles://https://example.com/planet.pmtiles' } },
      layers: [
        { id: 'land', type: 'background', paint: { 'background-color': '#f2efe9' } },
        { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#a0c8f0' } },
      ],
    }),
    [],
  )
  const requestHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])
  return (
    <Imagery>
      <MapStyleSource style={style} requestHeaders={requestHeaders} localFontFamily="Inter, sans-serif" />
    </Imagery>
  )
}
```

- Exactly one of `url` and `style`; both or neither throws.
- Vector sources can be XYZ `tiles`, a TileJSON `url` or `pmtiles://https://…`.
- `requestHeaders` go with the style, TileJSON, tile and glyph requests.
- `localFontFamily` draws labels when the style has no `glyphs` URL or the server lacks a glyph.
- `maximumZoom` (default 20): deepest zoom terrain is textured at; past the data's maximum, tiles overzoom.

### Change the style at runtime

The vanilla `MapStyleSource` (the `ref` in React) has MapLibre's style methods. Each change processes only
the tiles of the sources it touches, from the worker's cached tiles (nothing is fetched again), and redraws
the textures that show them in place, with no flicker.

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import type { MapStyleSource as MapStyleSourceInstance } from 'react-three-earth'
import { useEffect, useRef } from 'react'

export function NightMode({ night }: { night: boolean }) {
  const source = useRef<MapStyleSourceInstance>(null)
  useEffect(() => {
    const style = source.current
    if (style === null) return
    style.setPaintProperty('water', 'fill-color', night ? '#0b2a4a' : '#a0c8f0')
    style.setLayerVisibility('poi-labels', !night)
    style.setFilter('roads', night ? ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]] : null)
  }, [night])
  return (
    <Imagery>
      <MapStyleSource ref={source} url="https://example.com/style.json" />
    </Imagery>
  )
}
```

- Layers: `setPaintProperty`, `setLayoutProperty`, `setFilter` (`null` removes it), `setLayerZoomRange(id,
  minimumZoom, maximumZoom)`, `setLayerVisibility(id, visible)`, `addLayer(layer, beforeId?)`,
  `removeLayer`, `moveLayer(id, beforeId?)`. Sources: `addSource(id, source)`, `removeSource` (remove its
  layers first). Reading: `getStyle()`, `getLayer`, `getLayerIds`, `getSource`, `getPaintProperty`,
  `getLayoutProperty`, `getFilter`.
- A wrong id throws an error that says what to do. An expression that does not compile skips the layer and
  fires `error`.
- Calls made before the style loaded are kept and applied once it has. Calls in the same task are sent to the
  worker as one batch.
- Events: `source.addEventListener('styledata' | 'sourcedata' | 'error', listener)`.

### Replace the style: `setStyle` (diffed)

`source.setStyle(urlOrDocument)` diffs the new style against the current one (the style specification's
`diff`, as MapLibre) and applies only the differences. A change no command can express (other `glyphs`, a
`sprite`, another base URL) reloads the style, still without flicker. In React, a new `url` or `style`
prop does the same: no reload. When the first style failed to load (a wrong URL), a new prop starts over.

It is asynchronous, even for an object (the diff code loads on first use): changes made before it resolves
(`setPaintProperty`, `addLayer`…) apply after it, to the new style, and getters show them once it has. When
calls overlap, the last one wins. `await source.setStyle(next)` before reading the new style back.

### Layers the app owns: `<StyleLayer>`

```tsx
import { Imagery, MapStyleSource, StyleLayer } from 'react-three-earth/react'

export function Highlights({ selectedClass }: { selectedClass: string }) {
  return (
    <Imagery>
      <MapStyleSource url="https://example.com/style.json">
        <StyleLayer
          id="selected-roads"
          type="line"
          source="openmaptiles"
          sourceLayer="transportation"
          filter={['==', ['get', 'class'], selectedClass]}
          paint={{ 'line-color': '#ff6a00', 'line-width': 4 }}
          beforeId="road-label"
        />
      </MapStyleSource>
    </Imagery>
  )
}
```

- Prop changes send only what changed (`setPaintProperty`, `setFilter`, `moveLayer`…). A new `type`,
  `source` or `sourceLayer` replaces the layer where it is. Zoom props are `minimumZoom` / `maximumZoom`.
- `<StyleLayer>` layers survive `setStyle` and a new `style` prop.
- Vanilla: `new StyleLayer(options).addTo(source)`, then `layer.update(options)` and `layer.remove()`.

### App data: `<GeoJsonSource>` (routes, points, clusters)

GeoJSON from the app is tiled in the worker (geojson-vt, and supercluster for clusters, as MapLibre does). Put
`<GeoJsonSource>` inside `<MapStyleSource>`; the `<StyleLayer>`s inside it read it (their `source` defaults to it).

```tsx
import type { FeatureCollection } from 'geojson'
import { Imagery, MapStyleSource, GeoJsonSource, StyleLayer } from 'react-three-earth/react'

export function Stations({ stations, route }: { stations: FeatureCollection; route: FeatureCollection }) {
  return (
    <Imagery>
      <MapStyleSource url="https://example.com/style.json">
        <GeoJsonSource id="route" data={route} lineMetrics>
          <StyleLayer id="route-line" type="line" paint={{ 'line-width': 6, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#00e0ff'] }} />
        </GeoJsonSource>
        <GeoJsonSource id="stations" data={stations} cluster clusterRadiusPixels={40} clusterProperties={{ seats: ['+', ['get', 'seats']] }}>
          <StyleLayer id="clusters" type="circle" filter={['has', 'point_count']} paint={{ 'circle-color': '#20c040', 'circle-radius': 16 }} />
          <StyleLayer id="cluster-counts" type="symbol" filter={['has', 'point_count']} layout={{ 'text-field': '{point_count_abbreviated}' }} />
          <StyleLayer id="stations" type="circle" filter={['!', ['has', 'point_count']]} paint={{ 'circle-radius': 5 }} />
        </GeoJsonSource>
      </MapStyleSource>
    </Imagery>
  )
}
```

- `data` is GeoJSON or a URL (the app's; fetched through `transformRequest` and protocols). A **new object** is sent
  with `setData`; keep it memoised and never mutate it after passing it. Only the regions where the old or the new
  data lie are redrawn. Other prop changes (`cluster`, `filter`…) cut the tiles again.
- Options are MapLibre's with units: `maximumZoom` (18), `bufferPixels` (128), `tolerancePixels` (0.375),
  `cluster`, `clusterRadiusPixels` (50), `clusterMaximumZoom`, `clusterMinimumPoints` (2), `clusterProperties`,
  `lineMetrics`, `generateId`, `promoteId`, `filter`, `attribution`.
- Clusters carry `cluster: true`, `cluster_id`, `point_count` and `point_count_abbreviated`. Only points cluster;
  lines and polygons of a clustered source are dropped, as in MapLibre: use a second source for them.
- A `geojson` source written in the style itself works the same; a `<GeoJsonSource>` of the same id replaces it
  (its layers keep reading it) and survives `setStyle`.

Change a few features by id without sending everything (moving vehicles), and ask about clusters, on the ref or
the vanilla class:

```ts
import { GeoJsonSource, MapStyleSource } from 'react-three-earth'

const style = new MapStyleSource({ url: 'https://example.com/style.json' })
const buses = new GeoJsonSource({ id: 'buses', data: { type: 'FeatureCollection', features: [] }, cluster: true })
style.addGeoJsonSource(buses)
buses.updateData({ add: [{ type: 'Feature', id: 12, geometry: { type: 'Point', coordinates: [2.35, 48.85] }, properties: {} }] })
buses.updateData({ update: [{ id: 12, newGeometry: { type: 'Point', coordinates: [2.36, 48.86] } }], remove: [7] })
const zoom: number = await buses.getClusterExpansionZoom(42) // a cluster_id read from a drawn cluster
const leaves = await buses.getClusterLeaves(42, Infinity)
style.setGeoJsonSourceData('buses', { type: 'FeatureCollection', features: [] }) // by source id, style sources too
```

- `updateData` needs every feature to have an id (`id`, or the `promoteId` property) and the data as an object.
  It redraws around the changed features only, or around the whole data when points are clustered.
- Feature-state on GeoJSON: `setFeatureState({ source: 'buses', id: 12 }, { hover: true })`, no `sourceLayer`.

### Hover and selection: feature-state

```tsx
import { Imagery, MapStyleSource, StyleLayer } from 'react-three-earth/react'
import type { MapStyleSource as MapStyleSourceInstance } from 'react-three-earth'
import { useEffect, useRef } from 'react'

export function HoveredBuilding({ hoveredId }: { hoveredId: number | null }) {
  const source = useRef<MapStyleSourceInstance>(null)
  useEffect(() => {
    const style = source.current
    if (style === null || hoveredId === null) return
    const building = { source: 'openmaptiles', sourceLayer: 'building', id: hoveredId }
    style.setFeatureState(building, { hover: true })
    return () => style.removeFeatureState(building, 'hover')
  }, [hoveredId])
  return (
    <Imagery>
      <MapStyleSource ref={source} url="https://example.com/style.json">
        <StyleLayer
          id="building-hover"
          type="fill"
          source="openmaptiles"
          sourceLayer="building"
          paint={{ 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff6a00', 'rgba(0, 0, 0, 0)'] }}
        />
      </MapStyleSource>
    </Imagery>
  )
}
```

- `setFeatureState` merges into the feature's state; `removeFeatureState(feature, key?)` removes a key, the
  feature's state, or every state of a source layer (no `id`); `getFeatureState(feature)` reads it.
- Ids: the tile's feature id, compared as strings. Tiles without ids need `promoteId` on the source:
  `{ type: 'vector', url, promoteId: 'osm_id' }` or per source layer `{ building: 'osm_id' }`.
- Fast path: colour and opacity of fills, lines and circles (`fill-color`, `line-opacity`,
  `circle-stroke-color`…) read the state from a colour table on the GPU, so a change only redraws the
  textures holding the feature. Other state-dependent paint (`line-width`, `circle-radius`, text colours)
  processes the feature's tiles again: correct, but slower. Prefer colour for hover.
- A transparent colour that turns visible with state is still drawn (as with MapLibre).
- Feature-state works in paint properties only, as in MapLibre.
- To find the feature under the pointer, or to set hover state from pointer moves, see
  `query-features-and-layer-events` (`earth.queryRenderedFeatures`, `useHoverFeatureState`).

### App state in filters and layout: `global-state`

```ts
import type { MapStyleSource } from 'react-three-earth'

export function showCategory(source: MapStyleSource, category: string) {
  // The style reads it with ['global-state', 'category'], defaulting to its root `state`
  source.setGlobalStateProperty('category', category)
}
```

Unlike feature-state, `global-state` works in filters and layout too. Only sources whose layers read the
changed name are processed again. `undefined` returns it to the style root `state` default.

### Rewrite requests: `transformRequest` and `addProtocol`

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import { useCallback } from 'react'

export function SignedTiles({ token }: { token: string }) {
  const transformRequest = useCallback((url: string, kind: string) => (kind === 'Tile' ? { headers: { Authorization: `Bearer ${token}` } } : undefined), [token])
  return (
    <Imagery>
      <MapStyleSource url="https://example.com/style.json" transformRequest={transformRequest} />
    </Imagery>
  )
}
```

- `kind` is `'Style'`, `'Source'` (TileJSON), `'Tile'`, `'Glyphs'`, `'SpriteJSON'` or `'SpriteImage'`. Return
  `{ url?, headers? }` or nothing. A new function does not reload the source.
- With `transformRequest`, the worker asks the main thread about each request (a short round trip per tile);
  for fixed headers, `requestHeaders` costs nothing.
- `protocols={{ offline: loader }}` or `source.addProtocol('offline', loader)` serves `offline://…` URLs:
  `loader({ url, kind, headers, signal })` returns the bytes (`ArrayBuffer` or `Uint8Array`), or `null` for
  a missing tile. `pmtiles://` is built in.

### Redraw after tile data changed: `invalidate(bounds)`

Textures are drawn once per terrain tile. When the server's tiles change (live data, an edit you saved),
tell the source where:

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import type { MapStyleSource as MapStyleSourceInstance } from 'react-three-earth'
import { useEffect, useRef } from 'react'

export function LiveMap({ changes }: { changes: EventTarget }) {
  const source = useRef<MapStyleSourceInstance>(null)
  useEffect(() => {
    const onChange = () => source.current?.invalidate({ westDegrees: 138.5, southDegrees: 35.2, eastDegrees: 139, northDegrees: 35.6 })
    changes.addEventListener('change', onChange)
    return () => changes.removeEventListener('change', onChange)
  }, [changes])
  return (
    <Imagery>
      <MapStyleSource ref={source} url="https://example.com/style.json" />
    </Imagery>
  )
}
```

- No argument redraws everything. Bounds are `GeographicBounds` (`westDegrees`, `southDegrees`,
  `eastDegrees`, `northDegrees`); `westDegrees > eastDegrees` crosses the antimeridian.
- Cached tiles in the bounds are fetched and processed again; textures that draw them redraw, including
  neighbours whose labels reach in. Other tiles and textures are untouched. For tiles fetched recently
  (the last 4096), the next request uses `cache: 'no-cache'`, once, so the browser's HTTP cache revalidates them (a 304 when unchanged) instead
  of returning the old copy.
- PMTiles: any `invalidate` also reads the archive's header and directories again, so a replaced
  `.pmtiles` file is read at its new offsets; its range requests revalidate with the server from then on.
  Call `invalidate()` with no bounds after replacing the whole archive.
- No flicker: each texture keeps its old content until the new one is drawn over it in one pass. Textures
  still loading when you call it finish, then redraw.
- Calls within a frame are coalesced. Redraws share the imagery composition budget, after the first
  textures of visible tiles and before preloads.
- `earth.inspect().terrain.imageryRecompositionsPending` counts textures still to redraw;
  `source.recompositionsPending` counts them for one source.

Vanilla: keep the `MapStyleSource` you passed to `new Imagery` and call `source.invalidate(bounds)`.

### Patterns from the sprite, and runtime images

`fill-pattern`, `line-pattern` and `background-pattern` draw images from the style's `sprite` (a URL, or
MapLibre 3's array of `{ id, url }`: images of a sprite other than `default` are named `id:name`). The `@2x`
sheet loads on high-density screens; set `spritePixelRatio` (1 or 2) to choose. Images the sprite lacks can
be added at runtime, as with MapLibre's `addImage`:

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import type { MapStyleSource as MapStyleSourceInstance } from 'react-three-earth'
import { useRef } from 'react'

/** A 4 × 4 checker as raw RGBA pixels (straight alpha, sRGB, rows from the top). */
function checker(): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(4 * 4 * 4)
  for (let index = 0; index < 16; index++) data.set((index + (index >> 2)) % 2 === 0 ? [230, 40, 220, 255] : [20, 20, 20, 255], index * 4)
  return { width: 4, height: 4, data }
}

export function PatternedMap() {
  const source = useRef<MapStyleSourceInstance>(null)
  return (
    <Imagery>
      <MapStyleSource
        ref={source}
        url="https://example.com/style.json"
        // A tile asked for an image nobody has: provide it, and the tiles that asked redraw with it.
        onStyleImageMissing={imageId => {
          if (imageId === 'hatch') source.current?.addImage('hatch', checker(), { pixelRatio: 1 })
        }}
      />
    </Imagery>
  )
}
```

- `addImage(id, image, { pixelRatio, sdf, stretchX, stretchY, content })` takes raw pixels
  (`{ width, height, data }`), `ImageData`, an `ImageBitmap`, a canvas or a loaded `<img>` (`await
  image.decode()` first). An existing id throws: use `updateImage`. A runtime image hides a sprite image of
  the same id; `removeImage` uncovers it again. `hasImage(id)` covers both.
- `updateImage(id, image)` at the same size only rewrites the atlas pixels and redraws the textures that
  use it (no re-tessellation), so it is cheap enough to animate a few times a second. Another size
  re-tessellates those tiles.
- Only textures whose tiles use the image redraw; a background pattern redraws everything. A
  `background-pattern` draws over the `background-color` layer below it.
- Patterns follow MapLibre: `pixelRatio` image pixels per map pixel, aligned across tiles; a line pattern
  is scaled so its height spans the line's width and repeats along the line; a patterned fill has no
  outline; dashes do not combine with `line-pattern`; a missing image draws nothing (and calls
  `onStyleImageMissing` once per id until it is added).
- Vanilla: `new MapStyleSource({ url, onStyleImageMissing })`, then `source.addImage(…)`.

### 3D buildings

`fill-extrusion` layers stand as 3D buildings on the terrain by default: see `3d-buildings`.

### Satellite and relief layers

A style's `raster` and `raster-dem` sources draw `raster`, `hillshade` and `color-relief` layers in style order
with the vector layers. Read `satellite-and-relief-styles` for sources, encodings and paint.

## Common Mistakes

### HIGH: Expecting `invalidate` to change the style

`invalidate` refetches tiles. To change the style, use the style methods (`setPaintProperty`…) or
`setStyle`; they reuse the tiles the worker already has.

### MEDIUM: Waiting for a failed source to come back on its own

A source whose TileJSON or PMTiles header failed to load is skipped (a warning and an `error` event) and is
not retried on later style changes. Retry it by replacing it: `removeSource` (after its layers) then
`addSource`, or `setStyle` with the corrected source.

### HIGH: A new `requestHeaders`, `protocols` or `createWorker` every render

Each new object reloads the source, worker included. Memoise them. A new `style` object is fine but costs a
diff each render: memoise it too.

### HIGH: Feature-state on tiles without ids

`setFeatureState` silently matches nothing when the tiles carry no feature ids (most MVT tiles). Set
`promoteId` on the source to a property that identifies features.

### MEDIUM: Feature-state driving widths for hover

`line-width` or `circle-radius` from feature-state processes tiles again on every change. For hover, change a
colour or opacity instead: it only redraws.

### HIGH: A CDN caches the changed tiles

`invalidate` drops the library's caches and makes the browser revalidate, but a CDN in front of the tile
server can still answer with the old tile. Purge it, or serve changing tiles with `Cache-Control: no-cache`
(or versioned URLs).

### MEDIUM: Bounds in the wrong order

`southDegrees` greater than `northDegrees` throws and says to swap them. Longitudes need no order: 170 to
-170 is the 20° across the antimeridian.

### HIGH: Adding an image from an `<img>` that has not loaded

`addImage` reads the pixels immediately and throws on an image element that has not loaded. `await
image.decode()` first, or pass `{ width, height, data }`.

### HIGH: Mutating GeoJSON data after passing it

`data` is kept by reference and only a new object is sent: `features.push(…)` then the same object changes nothing
on the map (and confuses later snapshots). Pass a new object, or use `updateData` for a few features.

### MEDIUM: `line-gradient` without `lineMetrics`

A gradient needs the line's progress, which only a `geojson` source with `lineMetrics` (or `lineMetrics` on
`<GeoJsonSource>`) carries. Without it the line draws with `line-color` and one warning names the layer.

### MEDIUM: Unsupported layers

Heatmap layers are skipped with one console warning listing them, as are layers reading a source of the
wrong kind (a hillshade on a vector source, a fill on a raster source). `fill-extrusion`
stands in 3D (`3d-buildings`). Labels (`symbols`, icons not drawn yet, other limits) are in `map-labels`. A layer of a type MapLibre does not define is drawn by the
plugin that registers it (`write-a-plugin`); without one, it is skipped with a warning naming the type.

## Completion

- `earth.inspect().imageryLayers` counts the `<Imagery>` holding the style; `imageryCompositionsPending`
  returns to 0 once the view is drawn.
- After `invalidate` or a style change, `imageryRecompositionsPending` is above 0, then returns to 0 with the
  new content shown.
- `source.getStyle()` shows the change; `source.getFeatureState(feature)` returns what was set.
- The console shows no `MapStyleSource:` error; a warning lists skipped layers, if any. A sprite that cannot
  load warns once, naming its URL.
- `source.hasImage('name')` is true for sprite images once the style has loaded.
