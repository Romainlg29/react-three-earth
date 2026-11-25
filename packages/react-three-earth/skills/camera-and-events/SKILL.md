---
name: camera-and-events
description: >
  Use when an app needs MapLibre-style map state or camera moves from @earthkit/globe: the current
  centre, zoom, heading or pitch, jumping or animating the camera (jumpTo, easeTo, flyTo, fitBounds, zoomTo,
  rotateTo, panBy), view padding, the visible bounds, converting between screen pixels and longitude /
  latitude (project, unproject), clicks and pointer moves with their position on Earth, terrain height at
  a point, a start view or a URL hash, or reacting to load, idle, move, zoom, rotate and pitch events.
metadata:
  purpose: 'Documents EarthCamera (getView, jumpTo, easeTo, flyTo, fitBounds, padding, getBounds, project, unproject, queryTerrainElevation), MapLibre zoom, pointer events, initialView, the view hash, the Earth event map, useEarthCamera and useEarthEvent.'
  type: framework
  framework: 'react'
  library: '@earthkit/globe'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthCamera.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/cameraAnimation.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/cameraLimits.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/viewHash.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Earth.tsx'
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

| MapLibre | @earthkit/globe |
| --- | --- |
| `getCenter`, `getZoom`, `getBearing`, `getPitch` | `earth.camera.getView()` → `{ longitudeDegrees, latitudeDegrees, heightMeters, zoom, headingDegrees, pitchDegrees, distanceMeters }` |
| `jumpTo` | `earth.camera.jumpTo({ … })` |
| `easeTo`, `flyTo`, `fitBounds`, `cameraForBounds` | same names on `earth.camera`; they return a promise |
| `zoomTo`, `rotateTo`, `resetNorth`, `resetNorthPitch`, `panTo`, `panBy`, `stop` | same names |
| `padding` option / `setPadding` | `earth.camera.setPadding({ leftPixels: 320 })` |
| `new Map({ center, zoom, … })` | `<Earth initialView={{ … }}>`, `new Earth({ initialView })` |
| `hash: true` | `formatViewHash(view)`, `parseViewHash(location.hash)` (same URL format) |
| `getBounds` | `earth.camera.getBounds()` → `{ westDegrees, southDegrees, eastDegrees, northDegrees }` |
| `project`, `unproject` | `earth.project(position)`, `earth.unproject({ xPixels, yPixels })` |
| `queryTerrainElevation` | `earth.queryTerrainElevation(position)` |
| `map.on('load' \| 'idle' \| 'move…' \| 'zoom…' \| 'rotate…' \| 'pitch…')` | `earth.addEventListener(…)`, `useEarthEvent(…)` |
| `map.on('click' \| 'dblclick' \| 'contextmenu' \| 'mousemove' \| 'mouseout')` with `lngLat` | `click`, `doubleclick`, `contextmenu`, `pointermove`, `pointerout` with `geographic` |

`isMoving` has no twin: read `earth.camera.animating` or follow `movestart` / `moveend`. Not there yet:
`rollDegrees`, `around` for `zoomTo`, `offset` options.

## Core Patterns

### Read the view and jump

```tsx
import { useEarth, useEarthCamera, useEarthEvent } from '@earthkit/globe/react'
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
import { Earth } from '@earthkit/globe'
import { PerspectiveCamera } from 'three'

const earth = new Earth()
const camera = new PerspectiveCamera(60, 16 / 9, 1, 1e8)
// earth.update(camera, renderer) sets both every frame; before the first frame, set them yourself:
earth.camera.setCamera(camera)
earth.camera.setViewportSize(1280, 720)
earth.camera.jumpTo({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, zoom: 11, headingDegrees: -40, pitchDegrees: -30 })
earth.addEventListener('idle', () => console.log(earth.camera.getBounds()))
```

### Animate the camera

```tsx
import type { GeographicBounds } from '@earthkit/globe'
import { useEarthCamera } from '@earthkit/globe/react'

/** Handlers for buttons outside the canvas get the camera through a hook inside `<Earth>`. */
export function useTour(france: GeographicBounds) {
  const camera = useEarthCamera()
  const flyToParis = async () => {
    // Zooms out and back in along the way (MapLibre's flyTo); resolves false when stopped.
    const arrived = await camera.flyTo({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 12, pitchDegrees: -60 })
    if (arrived) await camera.rotateTo(90, { durationSeconds: 2 })
  }
  const showFrance = () => camera.fitBounds(france, { paddingPixels: 40, pitchDegrees: -90 })
  return { flyToParis, showFrance }
}
```

- `easeTo(change, { durationSeconds = 0.5, easing })` moves along a straight line; `flyTo(change, { curve
  = 1.42, speed = 1.2, screenSpeed, maximumDurationSeconds, minimumZoom, durationSeconds })` flies, its
  duration following the distance. `zoomTo`, `rotateTo`, `resetNorth`, `resetNorthPitch`, `panTo` and
  `panBy({ xPixels, yPixels })` are `easeTo` shortcuts. Each returns a promise: true when it arrives, false
  when stopped.
- `stop()`, `jumpTo`, another animation, a morph and user input on `<EarthControls>` stop a running
  animation where it is.
- For users with `prefers-reduced-motion`, every animation jumps to its end; pass `essential: true` for
  motion that carries meaning.
- `cameraForBounds(bounds, options)` returns the view without moving; `fitBounds` flies there (`linear:
  true` eases). Options: `paddingPixels` (a number or `{ topPixels, rightPixels, bottomPixels, leftPixels
  }`), `maximumZoom` (default 22), `headingDegrees`, `pitchDegrees` (both default to the current view). The
  fit is measured on screen, so it holds on the globe and when tilted.
- `setPadding({ leftPixels: 320 })` keeps part of the screen clear, under a side panel: `getView`,
  `jumpTo`, the animations and `fitBounds` use the middle of the rest. It does not move the camera.
- Without `heightMeters`, the end sits on the terrain, read again every frame as finer tiles load.
- Animations run in `earth.update` and ask for frames, so they work with `frameloop="demand"`; before the
  first frame they wait for the camera, so calling `flyTo` at mount is fine.

### Start view and URL hash

```tsx
import { Canvas } from '@react-three/fiber'
import { formatViewHash, parseViewHash } from '@earthkit/globe'
import { Earth, useEarthCamera, useEarthEvent } from '@earthkit/globe/react'

function KeepHash() {
  const camera = useEarthCamera()
  useEarthEvent('moveend', () => history.replaceState(null, '', formatViewHash(camera.getView())))
  return null
}

export function App() {
  return (
    <Canvas camera={{ fov: 60, near: 1, far: 1e8 }}>
      <Earth initialView={parseViewHash(location.hash) ?? { longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 4 }}>
        <KeepHash />
      </Earth>
    </Canvas>
  )
}
```

`initialView` is read once, at mount. The hash is MapLibre's `#zoom/latitude/longitude/bearing/pitch`, with
MapLibre's pitch (0 looks down), so links work in both.

### Limit zoom, tilt and area

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, EarthControls } from 'react-three-earth/react'

export function AlpsMap() {
  return (
    <Canvas camera={{ fov: 60, near: 1, far: 1e8 }}>
      <Earth
        initialView={{ longitudeDegrees: 7.5, latitudeDegrees: 46.3, zoom: 8 }}
        cameraLimits={{
          minimumZoom: 6,
          maximumZoom: 16,
          maximumTiltDegrees: 60,
          maximumBounds: { westDegrees: 5, southDegrees: 43.5, eastDegrees: 16.5, northDegrees: 48.5 },
        }}
      >
        <EarthControls />
      </Earth>
    </Canvas>
  )
}
```

MapLibre's `minZoom`, `maxZoom`, `minPitch`, `maxPitch` and `maxBounds`, on the globe and the flat map. Tilt counts
from looking straight down (0) to the horizon (90), the way MapLibre's pitch does. `maximumBounds` holds the centre of
the screen inside the box (west greater than east crosses the antimeridian); the screen's edges may show beyond it.
Fields left out are unlimited. The prop is compared by value. In vanilla, pass `cameraLimits` to `new Earth` or call
`earth.camera.setLimits(limits)` (it replaces the previous limits; `{}` removes them), and read them with
`getLimits()`. Every move keeps to them: a wheel or pinch stops at a zoom limit, a rotating drag at a tilt limit,
`jumpTo` and the animations end inside (a `flyTo` flies lower rather than past `minimumZoom`), and `earth.update`
moves a camera your own code placed back inside before the frame draws.

### Zoom

`zoom` is MapLibre's: the world is `512 × 2^zoom` pixels wide, continuous, measured at the centre of the
screen. A pitched view has the zoom of a top-down view at the same distance from the centre. Helpers for
your own maths, exported from `@earthkit/globe`: `zoomToGroundMetersPerPixel(zoom, latitudeDegrees)`,
`groundMetersPerPixelToZoom`, `zoomToMercatorMetersPerPixel`, `mercatorMetersPerPixelToZoom`,
`focalLengthPixels(camera, viewportHeightPixels)`. `earth.camera.getGroundResolutionMetersPerPixel()`
gives the ground size of a CSS pixel at the centre.

The same place has the same `getView()` on the globe and on the flat map: a morph keeps centre, zoom and
heading (it turns the camera to look straight down, so pitch becomes -90).

### Screen ↔ geography

Screen positions are CSS pixels from the canvas's top-left corner, like `event.offsetX` / `offsetY`.
`<Earth>` listens to the canvas and dispatches pointer events with the position under the pointer:

```tsx
import { useEarthEvent } from '@earthkit/globe/react'

export function LogClicks() {
  useEarthEvent('click', event => {
    const position = event.geographic // computed when read; null on sky
    if (position === null) return
    console.log(position.longitudeDegrees, position.latitudeDegrees, position.heightMeters, event.screen.xPixels)
  })
  return null
}
```

`click` fires only when the pointer went down and up within 3 pixels, so a drag of the map is not a click.
`doubleclick`, `contextmenu` (right click, long press) and `pointermove` carry the same `{ screen,
geographic, originalEvent }`. Vanilla: `earth.attachPointerEvents(canvas)`, then
`earth.addEventListener('click', …)`; `detachPointerEvents()` stops it.

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

The camera and loading events fire from `earth.update`, at most once per frame each, in this order:
`movestart`, `zoomstart`, `rotatestart`, `pitchstart`, `move`, `zoom`, `rotate`, `pitch`, `zoomend`,
`rotateend`, `pitchend`, `moveend`, `load`, `idle`.

| Event | When |
| --- | --- |
| `movestart` | the camera starts moving: controls, `jumpTo`, animations, the morph or your own code |
| `move` | every frame it moves |
| `zoomstart` / `zoom` / `zoomend` | the scale at the centre (ground metres per pixel) changes, or stops |
| `rotatestart` / `rotate` / `rotateend` | the heading changes, or stops |
| `pitchstart` / `pitch` / `pitchend` | the pitch changes, or stops |
| `moveend` | the first frame it holds still |
| `load` | once, the first time the Earth is idle |
| `idle` | camera still, no morph, no terrain or imagery loading or waiting, atmosphere generated (or failed) |
| `update` | the end of every `earth.update`: camera, morph and tiles are final for the frame about to draw. Markers and popups place themselves here; see `markers-and-popups` |

`earth.loaded` and `earth.idle` tell the current state, for code that mounts after `load` fired.

`useEarthEvent(type, handler)` subscribes for the component's lifetime and may take a new handler every
render. Movement is detected by comparing the camera between frames, so nothing has to report it.

`pointerout` fires when the pointer leaves the map's element. For events over features of style layers
(`map.on('click', layerId)`, `mouseenter` / `mouseleave`), pass `{ layers }`: see
`query-features-and-layer-events`.

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

### MEDIUM: Listening to the canvas's `click` yourself

A DOM `click` also fires at the end of a drag. Use `useEarthEvent('click', …)`, which ignores drags and
gives the position on Earth.

### MEDIUM: Expecting `zoom` events while panning a globe

`getView().zoom` changes with latitude on the globe at a fixed altitude, but the `zoom` events follow the
ground scale, so a pan fires none. Read `getView().zoom` on `moveend` for the number.

### MEDIUM: Expecting `maximumBounds` to hide what lies beyond

Only the centre of the screen is held inside the box, so zoomed out the screen's edges show the world around it. Pair
it with a `minimumZoom` at which the box fills the screen.

### MEDIUM: Setting state on every `move`

`move` fires every frame of a drag. Update React state on `moveend`, or throttle.

## Completion

- `earth.inspect().camera` shows the expected centre and zoom; `earth.inspect().loaded` turns true.
- `earth.project(earth.unproject({ xPixels, yPixels })!)` returns the same pixel within 1 px.
- A `moveend` listener fires once after each drag, `jumpTo` or animation.
- `await earth.camera.flyTo(view)` resolves true and `getView()` matches `view`.
- A `click` listener logs `event.geographic` for a click, and nothing for a drag.
- With `cameraLimits`, wheeling past `maximumZoom` stops there and `getView().zoom` reads it back.
