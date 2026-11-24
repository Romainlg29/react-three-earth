---
name: map-controls
description: >
  Use when an app needs buttons and widgets over the react-three-earth map, like MapLibre's controls: zoom
  in and out, a compass that resets north, a scale bar, a "find my location" button, fullscreen, or a
  2D / 3D toggle, translated labels, styling them, or making them work on iPhone Safari. Also when the map
  must work with a keyboard or a screen reader (arrow keys, zoom keys, the map's label, reduced motion), box zoom,
  or a map inside a scrolling page that should not catch the wheel or one finger (cooperative gestures).
metadata:
  purpose: 'Documents <Controls>, <NavigationControl>, <ScaleControl>, <GeolocateControl>, <FullscreenControl>, <ViewControl> and their vanilla classes: placement, options, events, locale, CSS variables, touch and accessibility; <EarthControls> keyboard, label, double-click zoom, box zoom and cooperative gestures.'
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
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/KeyboardControls.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthControls.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/BoxZoom.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/CooperativeGestures.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/EarthControls.tsx'
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

### Keyboard and screen readers

`<EarthControls>` makes the element around the canvas the map for assistive technology: `tabindex="0"` (an app's
own `tabindex` wins, for example -1 to keep the map out of the tab order), `role="region"` and `aria-label` from
`label` (default "Map"). While it has focus, the keys work as in MapLibre:

| Key | Does |
| --- | --- |
| Arrows | Pan 100 pixels |
| `=` / `-` | Zoom in, out one level; with `Shift` (`+` / `_` on most layouts) two levels |
| `Shift` + left / right | Turn 15° |
| `Shift` + up / down | Tilt 10° more or less (up to 80° on the globe, `maximumFlatMapTiltDegrees` on the flat map) |

Each press eases over 0.3 seconds; quick zoom, turn and tilt presses add up (arrows pan on from where the camera is,
as in MapLibre), and a held key keeps moving. Keys with `Ctrl`, `Alt` or
`Cmd` stay with the browser, and keys typed into a form field inside the map (a popup's `<input>`) never move it.
Double-click or double-tap zooms in on that point.

```tsx
import { EarthControls } from 'react-three-earth/react'

export const accessibleControls = (
  <EarthControls
    label="Map of the trail around Mont Blanc"
    keyboard={{ panStepPixels: 60, zoomStep: 0.5 }}
    doubleClickZoom={false}
  />
)
```

`keyboard={false}` turns the keys off; the map stays a named region in the tab order (give the element
`tabindex="-1"` to take it out). In vanilla, `EarthViewControls` has `label` (set before `attach`),
`doubleClickZoom`, and `keyboard` (a `KeyboardControls`: `enabled`, `setOptions`, and a protected `actionFor` to
override for other bindings); `keyboardAction(press, steps)` is the binding table on its own.

### Box zoom and cooperative gestures

`Shift` + drag with the mouse on the map draws a box; releasing eases the camera to centre the box and zoom until it
fills the screen, keeping heading and pitch (`Escape` cancels; the release is not a map `click`). It takes `Shift` + drag over from rotating: rotate with the right button, as in MapLibre.
`boxZoom={false}` gives `Shift` + drag back to rotation. The box is `.react-three-earth-box-zoom`, styled by
`--react-three-earth-box-zoom-border` and `--react-three-earth-box-zoom-background`.

For a map inside a page that scrolls, turn on `cooperativeGestures`: the wheel then zooms only with `Ctrl` (`⌘` on
Apple systems), and one finger scrolls the page while two fingers pinch, twist, pan and tilt the map. A hint over the
map says so, in a `role="status"` region screen readers announce. One-finger double-tap zoom is off in this mode.
Draggable markers, popups and controls keep their own touches, and popups and controls their wheel.

```tsx
import { EarthControls } from 'react-three-earth/react'

export const mapInArticle = (
  <EarthControls
    cooperativeGestures={{ locale: { wheel: 'Ctrl + molette pour zoomer', wheelApple: '⌘ + molette pour zoomer', touch: 'Deux doigts pour déplacer la carte' } }}
  />
)
```

The hint is `.react-three-earth-cooperative-hint`, styled by `--react-three-earth-cooperative-hint-font`, `-color` and
`-background`. In vanilla: `controls.boxZoom` (`BoxZoom`: `enabled`, `durationSeconds`) and
`controls.cooperativeGestures` (`CooperativeGestures`: `enabled`, `setLocale`, `hintDurationSeconds`, `showHint`).

Users who ask the system to reduce motion (`prefers-reduced-motion`) get no animation: camera animations, key presses
and the globe-to-map morph jump to their end. Pass `essential: true` to an animation, or to `earth.setView` (in React through
`useEarth()`), for motion that carries meaning.

## Common Mistakes

- Putting a control outside `<Controls>`: it throws, `<NavigationControl> must sit inside <Controls>`.
- Holding `<Earth view>` in state and not passing `onViewChange` to `<ViewControl>`: the button changes the earth but
  your state stays behind.
- Expecting geolocation on plain HTTP: browsers refuse it; use HTTPS or `localhost`.
- Mounting `<Controls>` outside `<Earth>`: it needs `useEarth`.
- Giving the canvas's parent a `role` or `aria-label` of your own and expecting it to stay: `<EarthControls>` sets
  them while mounted (and puts yours back after); name the map with `label` instead.
- Expecting `Shift` + left drag to rotate: with box zoom on (the default) it draws a box; rotate with the right button.
- Turning on `cooperativeGestures` for a full-screen map: there is no page to scroll, so it only gets in the way.
- Testing the keys without focusing the map first: they only work while the map's element has focus (a click or `Tab`).

## Completion

The corners show the controls, the buttons work by mouse, touch and keyboard, labels read in the app's language, and
on iPhone the buttons are 44 pixels and fullscreen covers the page. `Tab` reaches the map, a screen reader names it,
and the arrows and `+` / `-` move it.
