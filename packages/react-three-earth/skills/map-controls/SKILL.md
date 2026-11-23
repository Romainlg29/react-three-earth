---
name: map-controls
description: >
  Use when an app needs buttons and widgets over the react-three-earth map, like MapLibre's controls: zoom
  in and out, a compass that resets north, a scale bar, a "find my location" button, fullscreen, or a
  2D / 3D toggle, translated labels, styling them, or making them work on iPhone Safari.
metadata:
  purpose: 'Documents <Controls>, <NavigationControl>, <ScaleControl>, <GeolocateControl>, <FullscreenControl>, <ViewControl> and their vanilla classes: placement, options, events, locale, CSS variables, touch and accessibility.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/Controls.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/NavigationControl.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/ScaleControl.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/GeolocateControl.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/FullscreenControl.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/ViewControl.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/controls/locale.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/controls.tsx'
  - 'Romainlg29/react-three-earth:apps/playground/src/MapDemo.tsx'
requires:
  - getting-started
---

# Map controls

Read `getting-started` first. `<Controls>` is a corner of the map; the controls inside it are real DOM
buttons over the canvas. `<AttributionControl>` (see `getting-started`) sits on its own in the bottom-right.

| MapLibre | react-three-earth |
| --- | --- |
| `NavigationControl({ showCompass, showZoom, visualizePitch })` | `<NavigationControl>` |
| `ScaleControl({ maxWidth, unit })` | `<ScaleControl maximumWidthPixels unit>` |
| `GeolocateControl({ trackUserLocation, positionOptions })` | `<GeolocateControl trackUser positionOptions>` |
| `FullscreenControl({ container })` | `<FullscreenControl container>` |
| `GlobeControl` | `<ViewControl>` (both ways: globe and flat map) |
| `map.addControl(control, 'top-right')` | `<Controls position="top-right">` / `control.addTo(controls)` |

Not there yet: a terrain button (needs terrain exaggeration), disabled zoom buttons at the zoom limits, dragging the compass to rotate.

## Core Patterns

```tsx
import { useState } from 'react'
import type { ViewMode } from 'react-three-earth'
import {
  Controls,
  Earth,
  EarthControls,
  FullscreenControl,
  GeolocateControl,
  NavigationControl,
  ScaleControl,
  ViewControl,
} from 'react-three-earth/react'

export function MapWithControls() {
  const [view, setView] = useState<ViewMode>('3d')
  return (
    <Earth view={view}>
      <EarthControls />
      <Controls position="top-right">
        <NavigationControl visualizePitch />
        {/* Keep <Earth view> and the button in agreement */}
        <ViewControl onViewChange={setView} />
        <GeolocateControl trackUser onGeolocate={event => console.log(event.coordinates.accuracy)} />
        <FullscreenControl />
      </Controls>
      <Controls position="bottom-left">
        <ScaleControl unit="metric" />
      </Controls>
    </Earth>
  )
}
```

- Two `<Controls>` in one corner stack instead of overlapping. Bottom corners leave room for the attribution.
- Clicks, presses and wheel turns on a control never reach the map.
- `NavigationControl`: zoom by `zoomStep` (1) levels over `durationSeconds` (0.3); presses during the ease add up.
  The compass needle turns against the heading; pressing it eases to north (and straight down with `visualizePitch`).
- `ScaleControl`: the bar is 1, 2, 3 or 5 times a power of ten of metres / kilometres, feet / miles
  (`unit="imperial"`) or nautical miles, read at the centre of the screen.
- `GeolocateControl` asks the browser for the position only when pressed (HTTPS and a user gesture are required, iPhone
  Safari included). Without `trackUser` each press flies to one fix. With it the map follows the user; moving the map
  yourself pauses following (the dot stays), pressing again resumes, a press while following stops and removes the dot.
  Callbacks: `onGeolocate`, `onError` (`error.code` 1 means denied: the button is disabled with an explanation),
  `onTrackUserLocationStart`, `onTrackUserLocationEnd`. The position is never sent anywhere by the library.
- `FullscreenControl` uses the Fullscreen API. iPhone Safari has none for elements, so by default the container
  covers the page (`position: fixed`, `100dvh`) and `Escape` or the button leaves; `unsupported="hide"` hides the
  button instead. Keep the map's container directly in the page, not under a `transform`.

### Vanilla

```ts
import { Controls, Earth, NavigationControl, ScaleControl, ViewControl } from 'react-three-earth'

export function addControls(earth: Earth, container: HTMLElement) {
  const controls = new Controls({ earth, container, position: 'top-right' })
  new NavigationControl({ showZoom: true }).addTo(controls)
  const view = new ViewControl().addTo(controls)
  view.events.addEventListener('viewchange', event => console.log(event.mode))
  new ScaleControl({ unit: 'nautical' }).addTo(controls)
  return () => controls.dispose()
}
```

A control of your own extends `MapControl` (`element`, `attach`, `detach`) and goes in with `addTo`; in React use
`useControls()` to reach the `Controls`.

### Translate and style

Every text is in `ControlsLocale`; give a partial object as `locale` to any control (`zoomIn`, `resetNorth`,
`switchTo2D`, `geolocateDenied`, `userLocation`, `unitKilometers`…). Colours and sizes are CSS variables on any ancestor:
`--react-three-earth-control-background`, `-color`, `-hover-background`, `-active-color`, `-error-color`, `-shadow`,
`-radius`, `-size`, and `--react-three-earth-controls-margin`, `--react-three-earth-controls-bottom-margin`.

```tsx
import { Controls, NavigationControl } from 'react-three-earth/react'

export const french = (
  <Controls>
    <NavigationControl locale={{ zoomIn: 'Agrandir', zoomOut: 'Réduire', resetNorth: 'Orienter vers le nord' }} />
  </Controls>
)
```

## Touch and accessibility

On touch screens (`pointer: coarse`) buttons are 44 × 44 CSS pixels, the corners keep clear of the notch and home
indicator (`env(safe-area-inset-*)`), and `touch-action: manipulation` stops double-tap zoom on the buttons. Every
button is a `<button>` with `aria-label` and `title`, toggles carry `aria-pressed`, the scale is `role="img"` with a
label, and focus rings show with the keyboard.

## Common Mistakes

- Putting a control outside `<Controls>`: it throws, `<NavigationControl> must sit inside <Controls>`.
- Holding `<Earth view>` in state and not passing `onViewChange` to `<ViewControl>`: the button changes the earth but
  your state stays behind.
- Expecting geolocation on plain HTTP: browsers refuse it; use HTTPS or `localhost`.
- Mounting `<Controls>` outside `<Earth>`: it needs `useEarth`.

## Completion

The corners show the controls, the buttons work by mouse, touch and keyboard, labels read in the app's language, and
on iPhone the buttons are 44 pixels and fullscreen covers the page.
