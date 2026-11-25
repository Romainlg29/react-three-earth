---
name: measure-distances-and-areas
description: >
  Use when an app lets users measure on an earthkit map, like mapbox-gl-measure, maplibre-gl-measures or turf.length /
  turf.area: tap to measure a distance along a path or the area inside a polygon, show the figure live while drawing,
  label measurements on the map, switch metric and imperial units, or chart the terrain's elevation profile along a
  line (min, max, ascent, descent). Also for geodesic maths on the WGS84 ellipsoid without the plugin: the distance
  between two positions, a path's length, a polygon's area, midpoints, densifying a line along its geodesic.
metadata:
  purpose: 'Documents @earthkit/measure: the Measure plugin (modes, state, events, elevationProfile), useMeasureState and useElevationProfile, the geodesic helpers and formatLength / formatArea.'
  type: framework
  framework: 'react'
  library: '@earthkit/measure'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/measure/src/Measure.ts'
  - 'Romainlg29/react-three-earth:packages/measure/src/modes.ts'
  - 'Romainlg29/react-three-earth:packages/measure/src/geodesic.ts'
  - 'Romainlg29/react-three-earth:packages/measure/src/profile.ts'
  - 'Romainlg29/react-three-earth:packages/measure/src/format.ts'
  - 'Romainlg29/react-three-earth:packages/measure/src/react/index.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/MeasureExample.tsx'
requires:
  - '@earthkit/globe#getting-started'
  - '@earthkit/draw#draw-features'
---

# Measure distances and areas

Read `@earthkit/globe#getting-started` first. `@earthkit/measure` is an earthkit plugin for measuring on the map:
distances along paths, areas inside rings, and the terrain's elevation profile along a line. It is built on
`@earthkit/draw` (the `Draw` is `measure.draw`): users tap vertices exactly as they draw lines and polygons, on the
globe and the flat map, with a finger or a mouse. Measurements are GeoJSON line strings and polygons.

It is headless: it drapes the lines and fills and shows the vertex handles, nothing else. No labels, no buttons, no
CSS. The app shows the numbers from the state, on the map with `<Marker>` or in a panel.

| mapbox-gl-measure / turf | @earthkit/measure |
| --- | --- |
| a measure control added to the map | `new Measure()`, `<Earth plugins={[measure]}>` or `earth.addPlugin(measure)` |
| start measuring a distance or an area | `measure.setMode('distance')`, `measure.setMode('area')` |
| `turf.length(line, { units: 'kilometers' })` | `measurement.lengthMeters` or `pathLengthMeters(positions)` |
| `turf.area(polygon)` | `measurement.areaSquareMeters` or `polygonAreaSquareMeters(rings)` |
| `turf.distance(a, b)` | `geodesicDistanceMeters(a, b)` |
| `turf.midpoint(a, b)`, `turf.along` | `geodesicMidpoint(a, b)`, `geodesicPointAt(a, b, distanceMeters)` |
| an elevation profile plugin | `measure.elevationProfile(id)`, `useElevationProfile(measure, id)` |

Figures are geodesic on the WGS84 ellipsoid (Karney's algorithms, through `geographiclib-geodesic`), so they are
exact at any size: turf's spherical figures are up to 0.5 % off. Every length is in metres and every area in square
metres; `formatLength` and `formatArea` turn them into text.

## Setup

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, EarthControls, Marker, QuantizedMeshSource, Terrain } from '@earthkit/globe/react'
import { formatArea, formatLength, Measure, type Measurement } from '@earthkit/measure'
import { useMeasureState } from '@earthkit/measure/react'
import { useMemo } from 'react'

const figure = (measurement: Measurement) => (measurement.kind === 'distance' ? formatLength(measurement.lengthMeters) : formatArea(measurement.areaSquareMeters))

/** A label at each measurement, the one being drawn included. Inside <Earth>: markers need it. */
function Labels({ measure }: { measure: Measure }) {
  const { measurements, live } = useMeasureState(measure)
  return (live === null ? measurements : [...measurements, live]).map(measurement => (
    <Marker key={measurement.id} longitudeDegrees={measurement.labelPosition[0]} latitudeDegrees={measurement.labelPosition[1]} anchor="bottom" offsetPixels={{ xPixels: 0, yPixels: -12 }} label={figure(measurement)}>
      {/* pointer-events: none, or the label over the last vertex swallows the tap that finishes the line */}
      <span style={{ pointerEvents: 'none', background: '#111', color: '#fde68a', padding: '2px 6px' }}>{figure(measurement)}</span>
    </Marker>
  ))
}

function Toolbar({ measure }: { measure: Measure }) {
  const { mode, canFinish, live } = useMeasureState(measure)
  return (
    <div className="toolbar">
      {(['static', 'distance', 'area', 'select'] as const).map(name => (
        <button key={name} aria-pressed={mode === name} onClick={() => measure.setMode(name)}>
          {name}
        </button>
      ))}
      <button disabled={!canFinish} onClick={() => measure.finish()}>Finish</button>
      <button onClick={() => measure.clear()}>Clear</button>
      {live !== null && <output>{figure(live)}</output>}
    </div>
  )
}

export function App() {
  // Once: a new Measure every render would reinstall the plugin and lose the measurements.
  const measure = useMemo(() => new Measure(), [])
  const plugins = useMemo(() => [measure], [measure])
  return (
    <>
      <Canvas>
        <Earth plugins={plugins}>
          <Terrain>
            <QuantizedMeshSource url="https://example.com/terrain/layer.json" />
          </Terrain>
          <EarthControls />
          <Labels measure={measure} />
        </Earth>
      </Canvas>
      <Toolbar measure={measure} />
    </>
  )
}
```

Vanilla:

```ts
import { Earth } from '@earthkit/globe'
import { formatLength, Measure } from '@earthkit/measure'

declare const earth: Earth
declare const distanceButton: HTMLButtonElement
declare const readout: HTMLOutputElement

const measure = new Measure()
earth.addPlugin(measure)
distanceButton.onclick = () => measure.setMode('distance')
measure.subscribe(({ live, measurements }) => {
  const shown = live ?? measurements.at(-1)
  readout.textContent = shown?.kind === 'distance' ? formatLength(shown.lengthMeters) : ''
})
```

## Core Patterns

### Modes and gestures

`'static'` (the default) leaves the map alone. `'distance'`: a tap per vertex, then a tap on the last vertex (or a
double click, Enter with `keyboard: true`, or `finish()`) completes the line. `'area'`: the same, and a tap on the first
vertex closes the ring too. One finger still pans between taps and two fingers pinch. `'select'`: a tap selects a
measurement, a second tap shows its vertices to drag (see `@earthkit/draw#edit-shapes`); measurements update after
each edit (on release, not during the drag). `undo()` removes the last vertex, `cancel()` drops the measurement in progress, `deleteSelected()`, `remove(ids)`
and `clear()` remove finished ones.

### The state

`useMeasureState(measure)` (or `getState()` and `subscribe`) gives `mode`, `drawing`, `vertexCount`, `canFinish`,
`canUndo`, `selectedIds`, `measurements` and `live`. Pass a selector to re-render on a part only:
`useMeasureState(measure, state => state.live)`.

Each measurement has `id`, `kind`, `positions` (a ring's without its closing position), `segmentLengthsMeters` (an
area's closing side last) and `labelPosition` (a line's last vertex; a ring's centroid, or a point inside a concave
ring). A `'distance'` has `lengthMeters`; an `'area'` has `areaSquareMeters` (holes of loaded polygons taken out) and
`perimeterMeters`. `live` is the measurement being drawn, through the pointer while a mouse hovers the map (touch
screens have no hover: it ends at the last tap), with the id `LIVE_MEASUREMENT_ID`. Measurements keep their identity
until their feature changes, so `React.memo` rows skip unchanged ones. The `change` event fires when finished
measurements change.

Labels per segment: `geodesicMidpoint(positions[i], positions[i + 1])` with `formatLength(segmentLengthsMeters[i])`.

### Saving and loading

Measurements are features of `measure.draw`: save `measure.draw.getFeatures()` (GeoJSON) and load with
`new Measure({ features })` or `measure.draw.addFeatures(collection)`. Line strings load as distances, polygons as
areas; other geometries are drawn but not measured.

### Units

```ts
import { formatArea, formatLength } from '@earthkit/measure'

formatLength(12_345) // '12.3 km'
formatLength(850) // '850 m'
formatLength(5000, { unitSystem: 'imperial' }) // '3.11 mi'
formatArea(42_000) // '4.2 ha'
formatArea(12_345_678, { locale: 'fr-FR' }) // '12,3 km²'
formatLength(1234.6, { significantDigits: 4 }) // '1.235 km'
```

Metric uses metres below a kilometre, then kilometres; areas square metres, hectares from 1 ha, square kilometres
from 1 km². Imperial uses feet then miles; square feet, acres, square miles. Digits and unit names follow the locale
(`Intl.NumberFormat`).

### Elevation profiles

```tsx
import type { Measure } from '@earthkit/measure'
import { useElevationProfile } from '@earthkit/measure/react'

function Profile({ measure, id }: { measure: Measure; id: string | null }) {
  const profile = useElevationProfile(measure, id, { sampleCount: 128 })
  if (profile === null) return null
  const known = profile.samples.filter(sample => sample.heightMeters !== null)
  return (
    <p>
      {known.length} of {profile.samples.length} samples, {profile.minimumHeightMeters} to {profile.maximumHeightMeters} m, up {Math.round(profile.ascentMeters)} m
    </p>
  )
}
```

`measure.elevationProfile(idOrPositions, { sampleCount })` (default 256 samples) returns `samples` evenly spaced along
the geodesics, each with `distanceMeters`, `longitudeDegrees`, `latitudeDegrees` and `heightMeters` (above the WGS84
ellipsoid, like every height in earthkit), plus `lengthMeters`, `minimumHeightMeters`, `maximumHeightMeters`,
`ascentMeters`, `descentMeters` and `complete`. An area's profile runs around its ring. It reads the terrain loaded
now, at the detail loaded now: off the loaded tiles a sample's height is null and `complete` is false. The
`terrainchange` event fires when the earth settles; `useElevationProfile` samples again on it and on every edit of the
measurement, so the profile sharpens as tiles load. `elevationProfile(positions, heightAt)` is the same sampling with
a height function of your own (a DEM service), and works without an earth.

### Geodesic helpers without the plugin

```ts
import { densifyPath, geodesicDistanceMeters, pathLengthMeters, polygonAreaSquareMeters } from '@earthkit/measure'

geodesicDistanceMeters([-73.8, 40.6], [-0.5, 51.6]) // 5_551_759.4: JFK to Heathrow
pathLengthMeters([[0, 0], [1, 0], [1, 1]])
polygonAreaSquareMeters([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]) // outer ring, then holes
densifyPath([[-73.8, 40.6], [-0.5, 51.6]], 50_000) // a position every 50 km or less along the great circle
```

Positions are `[longitude, latitude]` in degrees, like GeoJSON. Rings may be open or closed, either winding.

### Options and custom modes

`new Measure({ name, modes, mode, style, features, keyboard, createId })`. `style` is `@earthkit/draw`'s
`DrawStyleInput` (default: yellow lines and fills, sky blue when selected). `name` defaults to `'measure'`; a `Draw`
installed next to it keeps its own `'draw'` name. `modes` replaces the list: `DistanceMode` and `AreaMode` are
exported, take `properties`, and can be subclassed; a mode of your own shows a live measurement by implementing
`MeasureDrawMode` (`livePositions()` and `onLiveChange`).

## Common Mistakes

### HIGH: A new `Measure` or plugins array every render

`<Earth plugins={[new Measure()]}>` reinstalls the plugin on each render and loses every measurement. Create it once
(`useMemo`, a ref, or module scope) and keep the array stable.

### HIGH: Labels that catch taps

A `<Marker>` at `labelPosition` sits over a line's last vertex: give its content `pointer-events: none`, or the tap
meant to finish the line lands on the label instead of the map.

### HIGH: Computing lengths in degrees or on a flat projection

`Math.hypot` over longitudes and latitudes, or Web Mercator metres, are wrong away from the equator (Mercator
doubles lengths at 60° latitude). Use `measurement.lengthMeters` or the geodesic helpers.

### MEDIUM: Long segments drawn straight on the map

The draped line between two vertices is straight on the map, while its length is measured along the geodesic. Under
about 100 km the two coincide; for an ocean crossing, place more vertices, or draw a copy of the line through
`densifyPath(positions, 50_000)` to show the route that was measured.

### MEDIUM: Reading a profile before the terrain loaded

`elevationProfile` samples the tiles loaded now, so a line off screen, or just drawn far from the camera, has null
or coarse heights. Check `complete`, sample again on `terrainchange` (or use `useElevationProfile`), or fit the camera
to the line first.

### MEDIUM: Sampling a profile on every pointer move

Each sample is a terrain raycast. Profile finished lines (or throttle), not `live` on every move: 256 raycasts per
`pointermove` costs frames on a phone.

### MEDIUM: Expecting the keys without opting in

Escape, Enter, Backspace and Delete act only with `new Measure({ keyboard: true })`, while the map has focus.

## Completion

- Tool buttons call `setMode('distance' | 'area' | 'select' | 'static')`; `canFinish` and `canUndo` enable Finish and Undo.
- Taps place vertices on the globe and the flat map, with a finger too, and the figure follows the pointer while drawing.
- Labels show each measurement's figure at `labelPosition`, formatted with `formatLength` / `formatArea` in the units
  the user picked, and let taps through.
- A line's elevation profile comes from `useElevationProfile` and sharpens as terrain loads.
- `measure.draw.getFeatures()` saves the measurements as GeoJSON; `features` loads them back.
