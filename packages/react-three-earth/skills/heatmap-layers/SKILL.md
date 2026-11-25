---
name: heatmap-layers
description: >
  Use when drawing point density as a heatmap on an earthkit globe or flat map: MapLibre heatmap layers in a
  style or as a StyleLayer over a GeoJsonSource (earthquakes, sightings, GPS traces), heatmap-weight from a feature
  property, heatmap-radius and heatmap-intensity by zoom, heatmap-color with heatmap-density, heatmap-opacity,
  switching from heat to points at high zoom, clustered sources, and checking that the heat renders.
metadata:
  purpose: 'Covers heatmap layers: their paint properties, how the kernels are drawn and composited, reach across tiles, and limits.'
  type: core
  library: '@earthkit/globe'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/heatmap/HeatmapLayers.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/heatmap/heatmapWorker.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/heatmap/heatmapKernel.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/MapStyleOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/StyleLayer.ts'
requires:
  - map-styles
---

# Heatmap layers

Read `map-styles` first: a heatmap is a layer of a `MapStyleSource`, usually over a `<GeoJsonSource>`.

A `heatmap` layer draws point density as MapLibre does. Each point adds a Gaussian kernel of height
`heatmap-weight` × `heatmap-intensity` and width `heatmap-radius` pixels; the kernels are summed, and
`heatmap-color` turns the sum (`['heatmap-density']`, 0 to 1 and clamped above) into a colour, times
`heatmap-opacity`. Every paint property works, with expressions; `heatmap-weight` and `heatmap-radius` can read the
feature.

## Setup

```tsx
import type { FeatureCollection } from 'geojson'
import { Imagery, MapStyleSource, GeoJsonSource, StyleLayer } from '@earthkit/globe/react'

export function Earthquakes({ quakes }: { quakes: FeatureCollection }) {
  return (
    <Imagery>
      <MapStyleSource url="https://example.com/style.json">
        <GeoJsonSource id="quakes" data={quakes}>
          <StyleLayer id="quake-heat" type="heatmap" paint={{ 'heatmap-weight': ['get', 'weight'] }} />
        </GeoJsonSource>
      </MapStyleSource>
    </Imagery>
  )
}
```

With no paint, MapLibre's defaults apply: radius 30 pixels, weight and intensity 1, a ramp from transparent through
blue, cyan, lime and yellow to red.

## Core Patterns

### Heat at low zoom, points when zoomed in

```tsx
import { StyleLayer } from '@earthkit/globe/react'

export function QuakeLayers() {
  return (
    <>
      <StyleLayer
        id="quake-heat"
        type="heatmap"
        maximumZoom={12}
        paint={{
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'magnitude'], 0, 0, 6, 1],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 9, 20],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 3],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(33, 102, 172, 0)', 0.2, 'rgb(103, 169, 207)', 0.6, 'rgb(253, 219, 199)', 1, 'rgb(178, 24, 43)'],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 12, 0],
        }}
      />
      <StyleLayer id="quake-points" type="circle" minimumZoom={11} paint={{ 'circle-radius': 4, 'circle-color': 'rgb(178, 24, 43)' }} />
    </>
  )
}
```

- Raise `heatmap-intensity` with the zoom: points spread apart as you zoom in, so the density falls.
- The first stop of `heatmap-color` should be transparent, or the whole layer is tinted.
- Change any property at runtime with `<StyleLayer paint>` or `source.setPaintProperty('quake-heat', 'heatmap-radius', 40)`:
  the tiles are processed again from the worker's cache, nothing is fetched.

### Vanilla

```ts
import { GeoJsonSource, MapStyleSource } from '@earthkit/globe'

const style = new MapStyleSource({ url: 'https://example.com/style.json' })
style.addGeoJsonSource(new GeoJsonSource({ id: 'sightings', data: 'data/sightings.geojson' }))
style.addLayer({ id: 'sightings-heat', type: 'heatmap', source: 'sightings', paint: { 'heatmap-radius': 20 } })
```

### How it is drawn

The heat is part of the draped map: each terrain tile's texture sums its kernels into a half-float target with
additive blending, then colours it through the layer's 256-step ramp at the layer's place in the style order. So:

- The radius is in map pixels at the zoom the terrain tile is drawn at (512-pixel tiles), like line widths. On a
  pitched globe, far kernels are smaller on screen, as roads are. Radius, intensity and opacity are taken at that
  whole zoom, so the heat steps slightly when a tile is drawn at the next zoom, where MapLibre changes smoothly.
- Kernels cross tile edges without seams: points of neighbouring tiles within reach are drawn too, up to one tile
  (512 pixels; the whole ring when the radius or weight reads the feature). Each point is counted by the tile that
  owns it, never twice.
- WebGL2 (the fallback) draws the same heat as WebGPU.

## Common Mistakes

### HIGH: Heat from a clustered source

A clustered `<GeoJsonSource>` hands the layer one point per cluster, so the heat follows clusters, not data.
Turn clustering off for the heatmap's source, or weight by `['get', 'point_count']` (with a fallback of 1 for
lone points: `['coalesce', ['get', 'point_count'], 1]`).

### MEDIUM: Very large radii

Kernels reach at most one tile (512 pixels) past their point and are cut there. A kernel reaches about 1.3 radii at
a weight × intensity of 1 (more for heavier points), so the cut starts near a 400-pixel radius. Lower the radius and
raise `heatmap-intensity` instead.

### LOW: Expecting to query the heat

Heatmap layers are not returned by `queryRenderedFeatures` or layer events. Query a circle layer over the same
source (it can be transparent) to find the points under the pointer.

## Completion

- The console shows no `MapStyleSource:` warning listing the heatmap layer as skipped.
- `earth.inspect().terrain.imageryCompositionsPending` returns to 0 and the heat shows where the points are.
- Panning so that a tile edge crosses the heat shows no straight cut or step in its colours.
