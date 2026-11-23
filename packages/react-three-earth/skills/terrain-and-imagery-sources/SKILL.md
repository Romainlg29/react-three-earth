---
name: terrain-and-imagery-sources
description: >
  Use when choosing or changing where a react-three-earth globe gets its elevation and its map pictures:
  quantized-mesh terrain (Re:Earth Terrain, Cesium World Terrain, self-hosted), XYZ raster tiles
  (OpenStreetMap, satellite, MapTiler raster, your own server), stacking or fading imagery layers, or
  writing a custom terrain or imagery source class.
metadata:
  purpose: 'Covers the source components and classes, how layers compose, opacity, and the source interfaces for custom providers.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Imagery.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/attribution.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/ImageOverlayPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Imagery.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Terrain.tsx'
requires:
  - getting-started
---

# Terrain and imagery sources

Read `getting-started` first for the canvas and `<Earth>` setup.

A layer (`<Terrain>`, `<Imagery>`) holds sources. Source components render nothing: they register a
source object with the layer around them, so the JSX tree reads like the data flow.

| Layer | Sources | Rule |
| --- | --- | --- |
| `<Terrain>` / `new Terrain({ sources })` | `QuantizedMeshSource` | exactly one (more logs a warning; only the first is used) |
| `<Imagery>` / `new Imagery({ sources })` | `RasterTileSource` | stacked bottom to top |

The library makes no network request of its own: every URL comes from you.

## Core Patterns

### Use quantized-mesh terrain

```tsx
import { QuantizedMeshSource, Terrain } from 'react-three-earth/react'

export function Ground() {
  return (
    <Terrain memoryBudgetBytes={300 * 2 ** 20} errorTargetPixels={4}>
      <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" attribution="Terrain: Re:Earth Terrain, Mapterhorn" />
    </Terrain>
  )
}
```

`url` is the folder holding `layer.json` (a trailing slash is added if missing). Heights must be
ellipsoidal (WGS84): Re:Earth's `ellipsoid` endpoint already includes the geoid. Cesium ion assets need
an access token in the URL or headers that this source does not handle yet; use a self-hosted or open
endpoint.

### Drape raster imagery

```tsx
import { Imagery, RasterTileSource } from 'react-three-earth/react'

export function Basemap() {
  return (
    <Imagery>
      <RasterTileSource
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
    </Imagery>
  )
}
```

- `url` must contain `{z}`, `{x}` and `{y}`; otherwise the constructor throws and says so.
- `levels`: how many zoom levels the server has, z0 to z(levels - 1); default 20, which fits
  OpenStreetMap's z0 to z19. Set it to the provider's maximum zoom + 1: higher requests tiles that 404,
  lower drops the sharpest zoom.
- `tileDimensionPixels`: 256 by default; 512 for "@2x" or MapTiler-style 512 px tiles.
- `projection`: `'EPSG:3857'` (Web Mercator, default, what XYZ servers use) or `'EPSG:4326'`.
- `attribution`: the provider's required credit, text or HTML with `<a href>` links (everything else is
  stripped). Every source takes it, `QuantizedMeshSource` and `MapStyleSource` included; show it with
  `<AttributionControl />` (see `getting-started`). A `MapStyleSource` adds the `attribution` of its style's
  sources and their TileJSON or PMTiles metadata after loading.

Tiles decode off the main thread and are composed onto each terrain tile on the GPU.

### Stack and fade layers

```tsx
import { Imagery, RasterTileSource } from 'react-three-earth/react'
import { useState } from 'react'

export function Layers() {
  const [labelsOpacity, setLabelsOpacity] = useState(0.8)
  return (
    <>
      <Imagery>
        <RasterTileSource url="https://example.com/satellite/{z}/{x}/{y}.jpg" levels={20} />
      </Imagery>
      <Imagery opacity={labelsOpacity}>
        <RasterTileSource url="https://example.com/labels/{z}/{x}/{y}.png" />
      </Imagery>
    </>
  )
}
```

Several `<Imagery>` layers stack in mount order, the last on top. The terrain has 10 layer slots, shared by
every imagery source (counted across all `<Imagery>` layers) and every plugin's draped layer (write-a-plugin
skill): adding past them throws an error naming the fix (remove a source or a draped layer, or merge sources
into one `MapStyleSource`). Changing `opacity` costs nothing (no
reload, no shader rebuild). Changing a source prop (`url`, `levels`…) rebuilds that layer and moves it to the top of the
stack, above layers that mounted after it.

Vanilla: `const labels = new Imagery({ sources: [...], opacity: 0.8 })`, `earth.addImagery(labels)`,
`labels.opacity = 0.5`, `earth.removeImagery(labels)`.

### Write a custom source

A source is any object with the `kind` tag and one factory method, plus an optional `getAttributions()`
(extend `AttributionTracker` to get it, `setAttribution` and change events for free). Implement the exported interfaces:

```ts
import { RasterTileSource, type ImagerySource, type TerrainSource } from 'react-three-earth'
import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'

/** A tenant's tiles: picks the URL template, then reuses RasterTileSource's overlay. */
export class TenantImagerySource implements ImagerySource {
  readonly kind = 'imagery'
  constructor(protected readonly tenant: string) {}
  createOverlay(options: { opacity: number }) {
    return new RasterTileSource({ url: `https://tiles.example.com/${this.tenant}/{z}/{x}/{y}.png` }).createOverlay(options)
  }
  // Optional: credit shown by AttributionControl. Add addAttributionListener(listener) if it can change.
  getAttributions() {
    return ['Tiles: Example Co.']
  }
}

/** Terrain whose plugins you choose yourself. */
export class CustomTerrainSource implements TerrainSource {
  readonly kind = 'terrain'
  constructor(readonly url: string) {}
  createPlugins(): object[] {
    return [new QuantizedMeshPlugin({ useRecommendedSettings: true })]
  }
}
```

`createPlugins` returns 3d-tiles-renderer plugins for the tile renderer; `createOverlay` returns a
3d-tiles-renderer image overlay. In vanilla, pass instances in `sources`. To use them in JSX, write a
small component the same way `src/react/sources.tsx` does: memoise the instance, then register it
through the layer's context. Composing an existing source (as above) is the safest route while the
overlay types are internal.

## Common Mistakes

### HIGH: Two terrain sources in one `<Terrain>`

Only the first is used and the console says `only the first source is used for now`. Stacking terrain
is planned, not available.

### HIGH: A source component outside its layer

`<RasterTileSource>` directly under `<Earth>` throws `<RasterTileSource> must sit inside <Imagery>`.

### HIGH: A WMTS capabilities URL or `{s}` subdomain template

`RasterTileSource` only understands `{z}`, `{x}`, `{y}`. Replace `{s}` with one subdomain, and convert
WMTS to its REST tile template. `{-y}` (TMS) is not supported.

### MEDIUM: Imagery without terrain

Imagery drapes on terrain tiles. With no `<Terrain>`, imagery layers are registered but nothing draws.
For a smooth ellipsoid, use a quantized-mesh `ellipsoid` tileset or a flat-height endpoint.

### MEDIUM: Missing attribution

Most providers require visible credit. Set `attribution` on the source and render `<AttributionControl />`
(vanilla: `new AttributionControl({ earth, container })`); without both nothing is shown.

## Completion

- `earth.inspect().imageryLayers` equals the number of `<Imagery>` layers with at least one source.
- `earth.inspect().terrain.url` is your terrain root, and `tilesLoaded` grows when you move.
- Tiles failing to load show as network 404s; check `levels` and the URL template first.
