---
name: satellite-and-relief-styles
description: >
  Use when a react-three-earth MapStyleSource style has satellite or scanned-map imagery or elevation shading:
  MapLibre raster and raster-dem sources (XYZ, TileJSON, PMTiles, TMS, Terrarium or Mapbox Terrain-RGB
  encodings), raster layers with hue, saturation, contrast and brightness, hillshade (all hillshade-method
  values, several lights) and color-relief ramps over elevation, drawn under roads and labels; and the style root's
  terrain (3D terrain from a raster-dem source, exaggeration), center, zoom, bearing, pitch and projection.
metadata:
  purpose: 'Covers raster and raster-dem style sources, the raster, hillshade and color-relief layers, their paint, the style root (terrain, starting view, projection), and what differs from MapLibre.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyleOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/tileSources.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/tileProviders.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/raster/rasterLayers.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/raster/rasterTiles.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/raster/RasterLayerRenderer.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/styleRoot.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
requires:
  - map-styles
---

# Satellite and relief styles

Read `map-styles` first: these layers are part of a `MapStyleSource` style. For imagery on its own, without a
style, `RasterTileSource` (`terrain-and-imagery-sources`) is simpler.

## Setup

A style's `raster` sources (satellite, scanned maps) and `raster-dem` sources (elevation) draw in style order
with its vector layers: roads and labels listed after a raster layer draw on top of it.

```tsx
import { Imagery, MapStyleSource } from 'react-three-earth/react'

const reliefStyle = {
  version: 8,
  sources: {
    satellite: { type: 'raster', tiles: ['https://example.com/satellite/{z}/{x}/{y}.jpg'], tileSize: 256, maxzoom: 19 },
    elevation: { type: 'raster-dem', url: 'https://example.com/terrarium.json', encoding: 'terrarium' },
    base: { type: 'vector', url: 'pmtiles://https://example.com/planet.pmtiles' },
  },
  layers: [
    { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-saturation': -0.2 } },
    {
      id: 'relief',
      type: 'color-relief',
      source: 'elevation',
      paint: {
        'color-relief-opacity': 0.5,
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#3f8f4f', 1500, '#e8d77a', 3500, '#ffffff'],
      },
    },
    { id: 'hillshade', type: 'hillshade', source: 'elevation', paint: { 'hillshade-method': 'multidirectional' } },
    { id: 'roads', type: 'line', source: 'base', 'source-layer': 'transportation', paint: { 'line-color': '#ffffff' } },
  ],
}

export function ReliefMap() {
  return (
    <Imagery>
      <MapStyleSource style={reliefStyle} />
    </Imagery>
  )
}
```

- Raster and raster-dem sources take XYZ `tiles` (`{z}`, `{x}`, `{y}`, `{-y}`, `{quadkey}`,
  `{bbox-epsg-3857}`), a TileJSON `url`, or `pmtiles://` archives of PNG, JPEG, WebP or AVIF tiles, with
  `scheme`, `bounds` (no request outside them), `minzoom`, `maxzoom` and `tileSize` (MapLibre's default, 512).
- `encoding` of a raster-dem source: `'mapbox'` (Terrain-RGB, the default), `'terrarium'`, or `'custom'` with
  `redFactor`, `greenFactor`, `blueFactor` and `baseShift`. Elevation is decoded in the worker.
- `raster` paint: every MapLibre property (`raster-opacity`, `raster-hue-rotate`, `raster-brightness-min`,
  `raster-brightness-max`, `raster-saturation`, `raster-contrast`, `raster-resampling`), with MapLibre's maths.
- `hillshade` paint: every property, `hillshade-method` included (`standard`, `basic`, `combined`, `igor`,
  `multidirectional` with up to 4 lights). Shading is continuous across tile and texture edges.
- `color-relief`: `color-relief-color` is an `interpolate` or `step` over `['elevation']` (up to 256 stops;
  longer ramps are resampled), with `color-relief-opacity`.
- A raster-dem source shades and colours the drape; it does not raise the terrain. Elevation comes from the
  `<Terrain>` source: for terrain from the same tiles, put a `<RasterDemSource>` there (`terrain-and-imagery-sources`).

## Core Patterns

### Steps instead of gradients

`['step', ['elevation'], '#3f8f4f', 500, '#e8d77a', 1500, '#9c6b3f']` draws hard bands. A step ramp of more than
128 stops is resampled and its bands blend, with a warning.

### Terrain, starting view and projection from the style root

The earth follows a style's root properties when the app does not set them itself:

| Style root | Becomes | Unless |
| --- | --- | --- |
| `terrain: { source, exaggeration }` | a `RasterDemSource` of that raster-dem source, with its exaggeration | the app sets a terrain source |
| `center`, `zoom`, `bearing`, `pitch` | the starting camera (`pitch` 0 is `pitchDegrees: -90`) | `initialView`, or the app placed the camera first (`setCameraView`, `jumpTo`) |
| `projection.type` | `'mercator'`: `view="2d"`; `'globe'`, `'vertical-perspective'`, expressions: `'3d'` | `<Earth view>` is given |

```tsx
import { Earth, Imagery, MapStyleSource, Terrain } from 'react-three-earth/react'

const style = {
  version: 8,
  center: [7.66, 45.98],
  zoom: 11,
  pitch: 60,
  terrain: { source: 'dem', exaggeration: 1.5 },
  sources: {
    dem: { type: 'raster-dem', tiles: ['https://example.com/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', maxzoom: 15 },
    satellite: { type: 'raster', tiles: ['https://example.com/satellite/{z}/{x}/{y}.jpg'], tileSize: 256 },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
}

export function StyleTerrain() {
  return (
    <Earth>
      {/* Empty: the earth builds the terrain from the style's root `terrain`. */}
      <Terrain />
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </Earth>
  )
}
```

- A terrain source in `<Terrain>` wins: the style's `terrain` (exaggeration included) is ignored, and the earth
  drops the terrain it built. Removing that source brings the style's terrain back.
- A new `terrain.exaggeration` (`setStyle`) applies in place; a new source rebuilds the terrain.
- The terrain source's `tiles` (`{z}/{x}/{y}`) or TileJSON `url` resolve against the style URL. Protocols and
  `pmtiles://` serve the drape only: such a terrain source warns and is skipped. `requestHeaders` and
  `transformRequest` do not reach terrain tiles either (a warning says so). Put a `<RasterDemSource>` in
  `<Terrain>` instead when the DEM needs them.
- The starting view applies once, from the first style that has one, with the centre on the ellipsoid (the terrain
  is not loaded yet), so a pitched view over high ground starts slightly short of `center`.
- Root `light`, `sky` and `fog` are not read: the atmosphere lights and hazes the scene from the sun's real
  position (`date`), and the flat map is unlit.
- `earth.inspect().terrain.fromStyle` is true for the terrain the earth built; `source.getStyleRoot()` returns what
  was read (vanilla: the same, `earth.setTerrain(null)` leaves the style's terrain in place).

## Common Mistakes

### HIGH: A Terrarium DEM without `encoding`

A raster-dem source without `encoding` is read as Mapbox Terrain-RGB, MapLibre's default: Terrarium tiles
then give elevations off by kilometres, and hillshade turns into noise. Set `encoding: 'terrarium'` (or put it
in the TileJSON).

### MEDIUM: `hillshade-illumination-anchor: 'viewport'`

On a globe the screen's up turns with the camera, so `viewport` is read as `map`: the light comes from the
direction measured from north. The light does not follow the atmosphere's sun.

### MEDIUM: Expecting the relief to raise the terrain

A raster-dem source only shades and colours the drape. Elevation comes from the `<Terrain>` source, or from the
style's root `terrain` when `<Terrain>` has none (above); a `<RasterDemSource>` with the same `tiles` URL and
`encoding` raises the ground from the same data.

### MEDIUM: A hillshade on a vector source, or a raster layer on a raster-dem source

Layers reading a source of the wrong kind are skipped with one warning listing them, and the source is not loaded.

## Completion

- The console has no `MapStyleSource:` warning about skipped layers or tiles that are not images.
- `earth.inspect().terrain.imageryCompositionsPending` returns to 0 with the imagery under the vector layers.
- Hillshade shows no lines at tile edges; colour relief bands sit at the elevations of the ramp.
- With a root `terrain` and an empty `<Terrain>`, `earth.inspect().terrain.fromStyle` is true and
  `earth.queryTerrainElevation` reads heights times the exaggeration.
