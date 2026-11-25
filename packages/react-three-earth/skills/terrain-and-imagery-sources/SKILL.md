---
name: terrain-and-imagery-sources
description: >
  Use when choosing or changing where an earthkit globe gets its elevation and its map pictures:
  quantized-mesh terrain (Re:Earth Terrain, Cesium World Terrain, self-hosted), terrain from raster-dem elevation
  tiles (Terrarium, Mapbox Terrain-RGB, MapTiler Terrain, as MapLibre's terrain), XYZ raster tiles
  (OpenStreetMap, satellite, MapTiler raster, your own server, TMS {-y}, TileJSON), stacking or fading imagery layers,
  clipping a layer to one side of the canvas (screenClip, a swipe or split view), or
  exaggerating terrain heights, or writing a custom terrain or imagery source class and its JSX component
  (useRegisterTerrainSource, useRegisterImagerySource).
metadata:
  purpose: 'Covers the source components and classes, how layers compose, opacity, screen clipping, and the source interfaces for custom providers.'
  type: core
  library: '@earthkit/globe'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Imagery.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/screenClip.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/attribution.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/ImageOverlayPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/FlatMapPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/RasterDemTerrainPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/dem/demSurface.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/imagery/XYZImageryOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/imagery/GeoreferencedImageOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/sources.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Imagery.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Terrain.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/context.ts'
requires:
  - getting-started
---

# Terrain and imagery sources

Read `getting-started` first for the canvas and `<Earth>` setup.

A layer (`<Terrain>`, `<Imagery>`) holds sources. Source components render nothing: they register a
source object with the layer around them, so the JSX tree reads like the data flow.

| Layer | Sources | Rule |
| --- | --- | --- |
| `<Terrain>` / `new Terrain({ sources })` | `QuantizedMeshSource`, `RasterDemSource` | exactly one (more logs a warning; only the first is used) |
| `<Imagery>` / `new Imagery({ sources })` | `RasterTileSource`, `ImageSource`, `VideoSource` (and `MapStyleSource`, see map-styles) | stacked bottom to top |

The library makes no network request of its own: every URL comes from you.

## Core Patterns

### Use quantized-mesh terrain

```tsx
import { QuantizedMeshSource, Terrain } from '@earthkit/globe/react'

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

### Use raster-dem terrain (Terrarium, Terrain-RGB)

The elevation tiles MapLibre users have: PNG or WebP tiles in Web Mercator XYZ whose colours encode heights.

```tsx
import { RasterDemSource, Terrain } from '@earthkit/globe/react'

export function Ground() {
  return (
    <Terrain>
      <RasterDemSource
        url="https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        encoding="terrarium"
        maximumZoom={15}
        attribution="Terrain: Mapzen, AWS Terrain Tiles"
      />
    </Terrain>
  )
}
```

- `encoding`: `'terrarium'`, `'mapbox'` (Terrain-RGB, MapTiler Terrain; the default, as in MapLibre) or `'custom'`
  with `redFactor`, `greenFactor`, `blueFactor` and `baseShift` (MapLibre's names and meaning). A wrong encoding
  gives terrain kilometres off, not an error: Terrarium decoded as `mapbox` lands near −10 km.
- `url` takes `{z}`, `{x}`, `{y}` or `{-y}`; or pass `tileJsonUrl` (its `tiles`, `maxzoom`, `scheme` and
  `attribution` are read).
- `maximumZoom`: the server's last zoom (Terrarium 15, MapTiler Terrain-RGB 12; default the TileJSON's `maxzoom`, or
  15). Deeper tiles reuse that zoom's tiles with no new request, until a mesh cell spans one pixel (two levels for
  256-pixel tiles, three for 512). Set it too high and each missing tile costs a 404 before its parent's raster
  stands in (the console names the zoom to set); the terrain stays whole.
- Each tile is a 65 × 65 grid with skirts (the sampling of a Cesium heightmap tile), decoded and built in a worker;
  `createWorker` starts your bundler's worker instead (`null` builds on the main thread; a worker that fails to load
  falls back to the main thread with a warning). Tile selection, fades,
  imagery, labels, the flat map and `queryTerrainElevation` work as with quantized-mesh.
- Web Mercator stops at about ±85.05°: caps built from the zoom 0 tile close the globe at the poles.
- Sea: heights at or below `seaLevelMeters` (default 0; `null` for none) are water in `terrainWaterMask`
  (`customize-terrain-shading`). Terrarium holds bathymetry, so by default the seafloor's relief is drawn under the
  imagery's sea; `flattenBelowSeaLevel` draws it at sea level instead (height queries, markers and the camera meet the
  sea's surface) while `terrainElevationMeters` keeps the true depth.
- Heights are used as ellipsoidal heights: these tiles hold heights above sea level, so the ground sits up to about
  100 m off true WGS84 heights. It only shows next to other geo-referenced 3D content. Quantized-mesh with an
  `ellipsoid` endpoint is the exact option.

Vanilla: `new Terrain({ sources: [new RasterDemSource({ url, encoding: 'terrarium' })] })`.

### Exaggerate the relief

```tsx
import { RasterDemSource, Terrain } from '@earthkit/globe/react'

export function DramaticGround({ exaggeration }: { exaggeration: number }) {
  return (
    <Terrain exaggeration={exaggeration}>
      <RasterDemSource url="https://example.com/terrarium/{z}/{x}/{y}.png" encoding="terrarium" />
    </Terrain>
  )
}
```

- MapLibre's terrain `exaggeration`: heights are multiplied by it (1.5 draws mountains half again as high, 0 flattens the
  ground onto the ellipsoid; seas below 0 m go deeper). Any terrain source, globe and flat map alike. Default 1.
- Changing it needs no reload (vanilla: `terrain.exaggeration = 2`): the drawing is a shader uniform, but each new value
  refits every tile's bounding volume, and raycasts copy each tile they test once per value. Set it from a slider or a
  short transition, not on every frame of a long animation.
- Below 1 the skirts that hide seams between tile levels shrink too; keep it at 1 or more unless you flatten on purpose.
- `queryTerrainElevation`, `unproject`, pointer events, controls, labels and markers on the terrain read the heights as
  drawn (exaggerated). Tile culling and level of detail use the scaled heights.
- Shading keeps the data's normals: slopes are lit as if not exaggerated.
- Negative or non-finite values throw, naming the fix.

### Drape raster imagery

```tsx
import { Imagery, RasterTileSource } from '@earthkit/globe/react'

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

- `url` must contain `{z}`, `{x}` and `{y}` (or `{-y}` for a TMS server, rows counted from the south);
  otherwise the constructor throws and says so.
- `tileJsonUrl`, instead of `url`: a TileJSON document. Its first `tiles` template, `maxzoom` (as `levels`),
  `scheme: 'tms'` and `attribution` are read when the layer starts (its `minzoom` and `bounds` are not: tiles
  outside them are requested and draw nothing). Pass exactly one of `url` and `tileJsonUrl`.
- `levels`: how many zoom levels the server has, z0 to z(levels - 1); default 20 (or the TileJSON's
  `maxzoom` + 1), which fits OpenStreetMap's z0 to z19. Set it to the provider's maximum zoom + 1: higher requests tiles that 404,
  lower drops the sharpest zoom.
- `tileDimensionPixels`: 256 by default; 512 for "@2x" or MapTiler-style 512 px tiles.
- `projection`: `'EPSG:3857'` (Web Mercator, default, what XYZ servers use) or `'EPSG:4326'`.
- `attribution`: the provider's required credit, text or HTML with `<a href>` links (everything else is
  stripped). Every source takes it, `QuantizedMeshSource`, `RasterDemSource` and `MapStyleSource` included; show it with
  `<AttributionControl />` (see `getting-started`). A `MapStyleSource` adds the `attribution` of its style's
  sources and their TileJSON or PMTiles metadata after loading.

Tiles decode off the main thread and are composed onto each terrain tile on the GPU.

### Drape a picture or a video over four corners

```tsx
import { ImageSource, Imagery, VideoSource } from '@earthkit/globe/react'

// Top-left, top-right, bottom-right, bottom-left, each [longitudeDegrees, latitudeDegrees].
const survey = [[-90.02, 0.02], [-89.99, 0.025], [-89.985, -0.005], [-90.025, -0.01]] as const

export function Overlays() {
  return (
    <>
      <Imagery opacity={0.8}>
        <ImageSource url="/survey.png" coordinates={survey} attribution="Survey © Example" />
      </Imagery>
      <Imagery>
        <VideoSource urls={['/radar.mp4', '/radar.webm']} coordinates={survey} />
      </Imagery>
    </>
  )
}
```

MapLibre's `image` and `video` sources. The corners need not form a rectangle in longitude and latitude: the
picture is stretched with a projective map in Web Mercator, so it lines up with the map at every zoom, across
the antimeridian too. It is drawn only into the terrain regions it covers, through the imagery compositor's
budget, and takes one terrain layer slot like any imagery source. New `coordinates` (compared by value) move it
and a new `url` swaps it, both redrawing only the terrain they touch; the old picture stays until the new one
loaded. Vanilla: `new ImageSource({ url, coordinates })`, `setUrl`, `setCoordinates`; `new VideoSource({ urls,
coordinates, autoplay, loop })` has `play()`, `pause()` and its `video` element. A `<VideoSource ref>` gives the
vanilla source.

The video is muted (browsers block unmuted autoplay) and is redrawn once per decoded frame, skipping frames while
the previous one is still drawing, so a video over a few regions is cheap and one over the whole screen runs at
the rate the compositor can draw. Pictures and videos on another origin need CORS headers. The corners must form a convex quadrilateral (else an error says so) narrower than 180° of longitude. Not supported yet:
`image` and `video` entries inside a `MapStyleSource` style (use these components next to it), and `canvas`
sources.

### Stack and fade layers

```tsx
import { Imagery, RasterTileSource } from '@earthkit/globe/react'
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
into one `MapStyleSource`); layers added before the terrain is set are logged and skipped instead. Changing `opacity` costs nothing (no
reload, no shader rebuild). Changing a source prop (`url`, `levels`…) rebuilds that layer and moves it to the top of the
stack, above layers that mounted after it.

Vanilla: `const labels = new Imagery({ sources: [...], opacity: 0.8 })`, `earth.addImagery(labels)`,
`labels.opacity = 0.5`, `earth.removeImagery(labels)`.

### Clip a layer to one side of the canvas

```tsx
import { Imagery, MapStyleSource, RasterTileSource } from '@earthkit/globe/react'

export function SplitView() {
  return (
    <>
      <Imagery screenClip={{ side: 'left', positionFraction: 0.5 }}>
        <MapStyleSource url="https://example.com/streets/style.json" />
      </Imagery>
      <Imagery screenClip={{ side: 'right', positionFraction: 0.5 }}>
        <RasterTileSource url="https://example.com/satellite/{z}/{x}/{y}.jpg" levels={20} />
      </Imagery>
    </>
  )
}
```

`screenClip` keeps everything a layer draws (its imagery, and a map style's labels and 3D buildings) on one `side`
(`'left'`, `'right'`, `'top'`, `'bottom'`) of a line at `positionFraction` (0 to 1) of the canvas's width or height,
from the left or top edge. Layers clipped to opposite sides of the same line make a split view; the terrain, the
camera and every unclipped layer are shared. It is per pixel in the shaders, so changing it costs nothing (no reload,
no shader rebuild, no extra draw). For a line that moves every frame, set `imagery.screenClip = { … }` on the layer a callback
`ref` receives (`<Imagery ref={layer => …}>`; a source change builds a new layer, which starts with the prop's clip)
and call `earth.requestFrame()`, instead of re-rendering. A swipe slider with dragging and keyboard is `@earthkit/compare`. `queryRenderedFeatures` and layer events skip a layer where
it is clipped away.

Vanilla: `new Imagery({ sources, screenClip: { side: 'left', positionFraction: 0.5 } })`, or
`imagery.screenClip = { side: 'top', positionFraction: 0.3 }` (copied: assign a new object to change it), `null` for
the whole canvas.

### Write a custom source

A source is any object with the `kind` tag and one factory method, plus an optional `getAttributions()`
(extend `AttributionTracker` to get it, `setAttribution` and change events for free). Implement the exported interfaces:

```tsx
import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { useMemo } from 'react'
import { RasterTileSource, type ImagerySource, type TerrainSource } from '@earthkit/globe'
import { useRegisterImagerySource, useRegisterTerrainSource } from '@earthkit/globe/react'

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

/* JSX components: memoise on what changes the tiles, then register with the layer around them. */
export function TenantImagery({ tenant }: { tenant: string }) {
  const source = useMemo(() => new TenantImagerySource(tenant), [tenant])
  useRegisterImagerySource(source, 'TenantImagery')
  return null
}

export function CustomTerrain({ url }: { url: string }) {
  const source = useMemo(() => new CustomTerrainSource(url), [url])
  useRegisterTerrainSource(source, 'CustomTerrain')
  return null
}

// <Terrain><CustomTerrain url="…" /></Terrain>
// <Imagery><TenantImagery tenant="acme" /></Imagery>
```

`createPlugins` returns 3d-tiles-renderer plugins for the tile renderer; `createOverlay` returns a
3d-tiles-renderer image overlay. In vanilla, pass instances in `sources`. Composing an existing source
(as above) is the safest route while the overlay types are internal.

To use them in JSX, write a component that memoises the instance on the props that change its tiles and
registers it with `useRegisterImagerySource` or `useRegisterTerrainSource` from `@earthkit/globe/react`,
as the components at the end of the example above do. It stacks with the built-in sources in the order
they register: a source mounted later, or a new instance after a prop change, goes on top of its
`<Imagery>`. Outside its layer it throws `<TenantImagery> must sit inside <Imagery>.` A new instance
rebuilds the layer (the terrain, for a terrain source), so memoise only on props that change the tiles.

## Common Mistakes

### HIGH: Two terrain sources in one `<Terrain>`

Only the first is used and the console says `only the first source is used for now`. Stacking terrain
is planned, not available.

### HIGH: A source component outside its layer

`<RasterTileSource>` directly under `<Earth>` throws `<RasterTileSource> must sit inside <Imagery>`.

### HIGH: A WMTS capabilities URL or `{s}` subdomain template

`RasterTileSource` only understands `{z}`, `{x}`, `{y}` and `{-y}` (TMS). Replace `{s}` with one subdomain,
and convert WMTS to its REST tile template. A TileJSON URL goes in `tileJsonUrl`, not `url`.

### MEDIUM: Corners in the wrong order or with swapped coordinates

`coordinates` is clockwise from the top-left and each corner is `[longitudeDegrees, latitudeDegrees]`, longitude
first (as GeoJSON and MapLibre). Latitude first puts the picture in the wrong place; counter-clockwise order
mirrors it.

### HIGH: A style's raster-dem source expected to raise the terrain

A `raster-dem` source inside a `MapStyleSource` style draws hillshade and colour relief on the ground; it does not
change the ground's shape. For terrain, put a `<RasterDemSource>` with the same tile URL in `<Terrain>`.

### MEDIUM: Imagery without terrain

Imagery drapes on terrain tiles. With no `<Terrain>`, imagery layers are registered but nothing draws.
For a smooth ellipsoid, use a quantized-mesh `ellipsoid` tileset or a flat-height endpoint.

### MEDIUM: Missing attribution

Most providers require visible credit. Set `attribution` on the source and render `<AttributionControl />`
placed with a `className` (vanilla: `new AttributionControl({ earth, container })` and draw its state); without both
nothing is shown.

### MEDIUM: Exaggeration expected to change `hillshade-exaggeration`

`<Terrain exaggeration>` raises the ground. A style's `hillshade-exaggeration` paint only darkens or lightens the
drawn shading; set each on its own.

## Completion

- `earth.inspect().imageryLayers` equals the number of `<Imagery>` layers with at least one source.
- `earth.inspect().terrain.url` is your terrain root, and `tilesLoaded` grows when you move.
- Tiles failing to load show as network 404s; check `levels` and the URL template first.
