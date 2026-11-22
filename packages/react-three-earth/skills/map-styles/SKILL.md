---
name: map-styles
description: >
  Use when draping a MapLibre style (vector tiles: roads, water, labels) on a react-three-earth globe or flat
  map with MapStyleSource: style URLs or objects, XYZ, TileJSON and PMTiles sources, the worker, headers,
  fonts, and redrawing after tile data changed on the server with invalidate(bounds).
metadata:
  purpose: 'Covers MapStyleSource, what it draws, its options, invalidate and what is not supported yet.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyleOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/rectangles.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/camera.ts'
requires:
  - terrain-and-imagery-sources
---

# Map styles (MapLibre vector tiles)

Read `terrain-and-imagery-sources` first: a map style is an imagery source, so it sits in an `<Imagery>`
layer and drapes on terrain.

`MapStyleSource` takes a MapLibre style (version 8). A worker fetches and tessellates the vector tiles
(fills, lines, circles, text labels); the main thread draws them straight into each terrain tile's texture
on the GPU. Labels lie flat on the ground.

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

## Common Mistakes

### HIGH: Expecting `invalidate` to change the style

`invalidate` refetches tiles; the style itself is fixed when the source is created. To change paint
properties today, give `<MapStyleSource>` a new `style` object: the layer reloads (and flashes).

### HIGH: A new `style` or `requestHeaders` object every render

Each new object reloads the source, worker included. Memoise them, and keep `createWorker` stable.

### HIGH: A CDN caches the changed tiles

`invalidate` drops the library's caches and makes the browser revalidate, but a CDN in front of the tile
server can still answer with the old tile. Purge it, or serve changing tiles with `Cache-Control: no-cache`
(or versioned URLs).

### MEDIUM: Bounds in the wrong order

`southDegrees` greater than `northDegrees` throws and says to swap them. Longitudes need no order: 170 to
-170 is the 20° across the antimeridian.

### MEDIUM: Unsupported layers

Icons and fill patterns (sprites), raster, hillshade and heatmap layers are skipped with one console
warning listing them. `fill-extrusion` draws flat; labels do not collide across tiles.

## Completion

- `earth.inspect().imageryLayers` counts the `<Imagery>` holding the style; `imageryCompositionsPending`
  returns to 0 once the view is drawn.
- After `invalidate`, `imageryRecompositionsPending` is above 0, then returns to 0 with the new content
  shown.
- The console shows no `MapStyleSource:` error; a warning lists skipped layers, if any.
