---
name: camera-and-events
description: >
  Use when an app needs MapLibre-style map state from react-three-earth: the current centre, zoom,
  heading or pitch, jumping the camera to a place or zoom level, the visible bounds, converting between
  screen pixels and longitude / latitude (project, unproject, a click position), terrain height at a
  point, or reacting to load, idle and move events (save the view on moveend, hide a spinner on idle).
metadata:
  purpose: 'Documents EarthCamera (getView, jumpTo, getBounds, project, unproject, queryTerrainElevation), MapLibre zoom, the Earth event map, useEarthCamera and useEarthEvent.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthCamera.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/events.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/projection.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/zoom.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/hooks.ts'
requires:
  - getting-started
---

# Camera and events

Read `getting-started` first. `earth.camera` is the map-level view of the camera the Earth is seen
through, like MapLibre's map object: it works on the globe (`view="3d"`) and on the flat map
(`view="2d"`). `Earth` hands it the camera and canvas size in every `update`, so it is ready after the
first frame.

| MapLibre | react-three-earth |
| --- | --- |
| `getCenter`, `getZoom`, `getBearing`, `getPitch` | `earth.camera.getView()` → `{ longitudeDegrees, latitudeDegrees, heightMeters, zoom, headingDegrees, pitchDegrees, distanceMeters }` |
| `jumpTo` | `earth.camera.jumpTo({ … })` |
| `getBounds` | `earth.camera.getBounds()` → `{ westDegrees, southDegrees, eastDegrees, northDegrees }` |
| `project`, `unproject` | `earth.project(position)`, `earth.unproject({ xPixels, yPixels })` |
| `queryTerrainElevation` | `earth.queryTerrainElevation(position)` |
| `map.on('load' \| 'idle' \| 'movestart' \| 'move' \| 'moveend')` | `earth.addEventListener(…)`, `useEarthEvent(…)` |

Not there yet: `easeTo`, `flyTo`, `fitBounds`, zoom / rotate / pitch events and pointer events with
geography (planned next).

## Core Patterns

### Read the view and jump

```tsx
import { useEarth, useEarthCamera, useEarthEvent } from 'react-three-earth/react'
import { useEffect } from 'react'

export function GoToParis({ onView }: { onView: (text: string) => void }) {
  const earth = useEarth()
  const camera = useEarthCamera() // the vanilla EarthCamera; never re-renders
  useEarthEvent('moveend', () => {
    const { longitudeDegrees, latitudeDegrees, zoom } = camera.getView()
    onView(`${zoom.toFixed(2)}/${latitudeDegrees.toFixed(4)}/${longitudeDegrees.toFixed(4)}`)
  })
  const goToParis = () => camera.jumpTo({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 12, pitchDegrees: -60 })
  useEarthEvent('load', goToParis)
  // `load` fires once: a component mounted later checks `earth.loaded` instead.
  useEffect(() => {
    if (earth.loaded) goToParis()
  }, [earth])
  return null
}
```

`jumpTo` changes only the fields given: moving the centre keeps zoom, heading and pitch. Give `zoom` or
`distanceMeters` (zoom wins when both are given). Without `heightMeters`, a new centre sits on the loaded
terrain (0 where none is loaded). It asks for a frame itself, so it works with `frameloop="demand"`.

Vanilla:

```ts
import { Earth } from 'react-three-earth'
import { PerspectiveCamera } from 'three'

const earth = new Earth()
const camera = new PerspectiveCamera(60, 16 / 9, 1, 1e8)
// earth.update(camera, renderer) sets both every frame; before the first frame, set them yourself:
earth.camera.setCamera(camera)
earth.camera.setViewportSize(1280, 720)
earth.camera.jumpTo({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, zoom: 11, headingDegrees: -40, pitchDegrees: -30 })
earth.addEventListener('idle', () => console.log(earth.camera.getBounds()))
```

### Zoom

`zoom` is MapLibre's: the world is `512 × 2^zoom` pixels wide, continuous, measured at the centre of the
screen. A pitched view has the zoom of a top-down view at the same distance from the centre. Helpers for
your own maths, exported from `react-three-earth`: `zoomToGroundMetersPerPixel(zoom, latitudeDegrees)`,
`groundMetersPerPixelToZoom`, `zoomToMercatorMetersPerPixel`, `mercatorMetersPerPixelToZoom`,
`focalLengthPixels(camera, viewportHeightPixels)`. `earth.camera.getGroundResolutionMetersPerPixel()`
gives the ground size of a CSS pixel at the centre.

The same place has the same `getView()` on the globe and on the flat map: a morph keeps centre, zoom and
heading (it turns the camera to look straight down, so pitch becomes -90).

### Screen ↔ geography

Screen positions are CSS pixels from the canvas's top-left corner, like `event.offsetX` / `offsetY`.

```tsx
import { useThree } from '@react-three/fiber'
import { useEarth } from 'react-three-earth/react'
import { useEffect } from 'react'

export function LogClicks() {
  const earth = useEarth()
  const canvas = useThree(state => state.renderer.domElement)
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const position = earth.unproject({ xPixels: event.offsetX, yPixels: event.offsetY })
      if (position === null) return // sky
      console.log(position.longitudeDegrees, position.latitudeDegrees, position.heightMeters)
    }
    canvas.addEventListener('click', onClick)
    return () => canvas.removeEventListener('click', onClick)
  }, [earth, canvas])
  return null
}
```

- `getBounds()` follows the screen's edges on the ellipsoid (the map's plane in 2D), reaches the horizon
  where an edge shows sky, and spans every longitude when a pole is in view; it ignores terrain.
- `unproject` hits the loaded terrain, or the ellipsoid where none is loaded; on the flat map it lands on
  the map's relief. Null on sky.
- `project(position)` returns `{ xPixels, yPixels, visible }`. `visible` is false behind the camera,
  outside the canvas or beyond the globe's horizon; terrain does not hide points. During the morph it
  follows the moving ground exactly, so an HTML label can stay glued to a place: call it in
  `useEarthFrame`, which runs after the morph and tiles update.
- `queryTerrainElevation(position)` is the ellipsoidal height of the loaded tiles there, at their current
  level of detail, or null where no tile is loaded yet.

### Events

All fire from `earth.update`, at most once per frame each, in this order:

| Event | When |
| --- | --- |
| `movestart` | the camera starts moving: controls, `jumpTo`, the morph or your own code |
| `move` | every frame it moves |
| `moveend` | the first frame it holds still |
| `load` | once, the first time the Earth is idle |
| `idle` | camera still, no morph, no terrain or imagery loading or waiting, atmosphere generated (or failed) |

`earth.loaded` and `earth.idle` tell the current state, for code that mounts after `load` fired.

`useEarthEvent(type, handler)` subscribes for the component's lifetime and may take a new handler every
render. Movement is detected by comparing the camera between frames, so nothing has to report it.

## Common Mistakes

### HIGH: Calling `earth.camera.getView()` before the first frame

Before `earth.update` has run there is no camera or canvas size and it throws, saying so. In React, read
it in an event handler, `useEarthEvent('load', …)` or `useEarthFrame`; in vanilla, call
`setCamera` / `setViewportSize` first.

### HIGH: Device pixels instead of CSS pixels

`project` and `unproject` use CSS pixels. Do not multiply by `devicePixelRatio`; use `offsetX` /
`offsetY`, or `clientX - rect.left`.

### MEDIUM: Expecting MapLibre's pitch numbers

`pitchDegrees` is the angle below the horizon, as in `setCameraView`: -90 looks straight down (MapLibre's
pitch 0), -30 is MapLibre's pitch 60. Heading is MapLibre's bearing.

### MEDIUM: `jumpTo` during a morph to 2D

The morph flies the camera itself until it ends. Wait for `moveend` (or `earth.view.transitioning` to be
false) before jumping.

### MEDIUM: Setting state on every `move`

`move` fires every frame of a drag. Update React state on `moveend`, or throttle.

## Completion

- `earth.inspect().camera` shows the expected centre and zoom; `earth.inspect().loaded` turns true.
- `earth.project(earth.unproject({ xPixels, yPixels })!)` returns the same pixel within 1 px.
- A `moveend` listener fires once after each drag or `jumpTo`.
