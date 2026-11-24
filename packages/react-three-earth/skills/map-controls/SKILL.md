---
name: map-controls
description: >
  Use when an app needs buttons and widgets over the react-three-earth map, like MapLibre's controls: zoom
  in and out, a compass that resets north, a scale bar, a "find my location" button, fullscreen, or a
  2D / 3D toggle, built headless with hooks (useNavigationControl, useScaleControl…) and styled by the app, translated
  labels, or making them work on iPhone Safari. Also when the map must work with a keyboard or a screen reader (arrow
  keys, zoom keys, the map's label, reduced motion), box zoom, or a map inside a scrolling page that should not catch
  the wheel or one finger (cooperative gestures).
metadata:
  purpose: 'Documents the headless controls: <Controls>, useNavigationControl, useScaleControl, useGeolocateControl, useFullscreenControl, useViewControl and their vanilla classes (state, actions, button props, events, locale, accessibility); <EarthControls> keyboard, label, double-click zoom, box zoom and cooperative gestures.'
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
  - 'Romainlg29/react-three-earth:apps/playground/src/controls/MapControls.tsx'
requires:
  - getting-started
---

# Map controls

Read `getting-started` first. The controls are headless, like Base UI: the library gives each control's state, its
actions and accessible props, and draws nothing; the app renders its own buttons and owns all the CSS. `<Controls>` is
an unstyled `<div>` over the map for that HTML. `<AttributionControl>` and `useAttributionControl` (see `getting-started`) work the same
way for the credits.

| MapLibre | react-three-earth (React) | Vanilla |
| --- | --- | --- |
| `NavigationControl({ showCompass, showZoom, visualizePitch })` | `useNavigationControl({ visualizePitch })` | `NavigationControl` |
| `ScaleControl({ maxWidth, unit })` | `useScaleControl({ maximumWidthPixels, unit })` | `ScaleControl` |
| `GeolocateControl({ trackUserLocation, positionOptions })` | `useGeolocateControl({ trackUser, positionOptions })` | `GeolocateControl` |
| `FullscreenControl({ container })` | `useFullscreenControl({ container })` | `FullscreenControl` |
| `GlobeControl` | `useViewControl()` (both ways: globe and flat map) | `ViewControl` |
| `map.addControl(control, 'top-right')` | `<Controls className="your-corner">` | `new Controls({ container })` |

Not there yet: a terrain button (needs terrain exaggeration), zoom limits in the state, dragging the compass to rotate.

## Setup

The hooks work anywhere inside `<Earth>`. `<Earth>` sits in the R3F `<Canvas>`, which cannot hold HTML, so put the
components that render buttons inside `<Controls>`: its children are rendered as HTML in the element around the canvas,
with every context bridged (`useEarth`, the hooks and `<Marker>` work there).

```tsx
import { Canvas } from '@react-three/fiber'
import { Controls, Earth, EarthControls, useNavigationControl } from 'react-three-earth/react'

function Zoom() {
  const navigation = useNavigationControl()
  return (
    <div {...navigation.groupProps}>
      <button {...navigation.zoomInButtonProps}>+</button>
      <button {...navigation.zoomOutButtonProps}>−</button>
    </div>
  )
}

export function App() {
  return (
    <Canvas>
      <Earth>
        <EarthControls />
        {/* No CSS ships: place the element yourself */}
        <Controls style={{ position: 'absolute', top: 10, right: 10 }}>
          <Zoom />
        </Controls>
      </Earth>
    </Canvas>
  )
}
```

## Core Patterns

Each hook returns the control's state (spread on the result), its actions, the vanilla `control`, and prop objects for
your elements: `…ButtonProps` carry `type="button"`, `aria-label`, `title` and `onClick` (and `aria-pressed`,
`aria-busy`, `disabled`, `hidden` where they apply), so a spread `<button>` is accessible as it is.

```tsx
import { useState } from 'react'
import type { ViewMode } from 'react-three-earth'
import {
  Controls,
  Earth,
  Marker,
  useFullscreenControl,
  useGeolocateControl,
  useNavigationControl,
  useScaleControl,
  useViewControl,
} from 'react-three-earth/react'

function Compass() {
  const navigation = useNavigationControl({ visualizePitch: true })
  return (
    <button {...navigation.compassButtonProps} data-north={navigation.north}>
      <span style={{ display: 'inline-block', transform: navigation.compassTransform }}>▲</span>
    </button>
  )
}

function ViewSwitch({ onViewChange }: { onViewChange: (mode: ViewMode) => void }) {
  // `label` is "2D" while the globe shows, "3D" while the flat map does
  const view = useViewControl({ onViewChange })
  return <button {...view.buttonProps}>{view.label}</button>
}

function Geolocate() {
  const geolocate = useGeolocateControl({ trackUser: true, onError: event => console.warn(event.error.code) })
  const location = geolocate.userLocation
  return (
    <>
      {/* `label` explains the status: waiting, following, denied… */}
      <button {...geolocate.buttonProps} data-status={geolocate.status}>⌖</button>
      {location === null ? null : (
        <Marker longitudeDegrees={location.longitudeDegrees} latitudeDegrees={location.latitudeDegrees} anchor="center" label={geolocate.userLocationLabel}>
          <div className="user-dot" data-stale={geolocate.stale} />
        </Marker>
      )}
    </>
  )
}

function Fullscreen() {
  const fullscreen = useFullscreenControl()
  return <button {...fullscreen.buttonProps}>{fullscreen.active ? '⤡' : '⤢'}</button>
}

function Scale() {
  const scale = useScaleControl({ unit: 'metric' })
  return (
    <div {...scale.scaleProps} className="scale" style={{ width: scale.widthPixels }}>
      {scale.label}
    </div>
  )
}

export function MapWithControls() {
  const [view, setView] = useState<ViewMode>('3d')
  return (
    <Earth view={view}>
      <Controls className="corner top-right">
        <Compass />
        {/* Keep <Earth view> and the button in agreement */}
        <ViewSwitch onViewChange={setView} />
        <Geolocate />
        <Fullscreen />
      </Controls>
      <Controls className="corner bottom-left">
        <Scale />
      </Controls>
    </Earth>
  )
}
```

- `<Controls>` has no CSS: give it `className` or `style`. Clicks, presses and wheel turns inside it never reach the map.
  Its element has the class `react-three-earth-controls`; buttons of yours over the map outside a `<Controls>` should
  carry it too, or a press on them pauses a following geolocate.
- `useNavigationControl`: `zoomIn` / `zoomOut` zoom by `zoomStep` (1) levels over `durationSeconds` (0.3); calls during
  the ease add up. `compassTransform` is a CSS transform that turns a needle against the heading (and tilts it with
  `visualizePitch`; `compassRotateDegrees` and `compassTiltDegrees` are the numbers); `north` is true when there is
  nothing to reset; `resetNorth` eases to north (and straight down with `visualizePitch`).
- `useScaleControl`: `widthPixels` and `label` of a bar 1, 2, 3 or 5 times a power of ten of metres / kilometres, feet /
  miles (`unit: 'imperial'`) or nautical miles, read at the centre of the screen; `visible` is false before the camera
  has a view.
- `useGeolocateControl` asks the browser for the position only in `trigger` (the button's `onClick`; HTTPS and a user
  gesture are required, iPhone Safari included). Without `trackUser` each trigger flies to one fix. With it the map
  follows the user; moving the map yourself pauses following (`status: 'background'`, the position stays), triggering
  again resumes, a trigger while following stops and clears `userLocation`. Draw the dot from `userLocation` and an
  accuracy circle `accuracyDiameterPixels` wide (a `<Marker pitchAlignment="map">`). A `<Marker>` is a focusable
  button by default: for the dot, take its element out of the tab order (`useMarker()` inside it gives the vanilla
  marker; remove `tabindex`, set `role="img"`), and hide the circle with `aria-hidden`. The pause on user input and the
  early "access blocked" check run while the control has a listener (the hook always has one; in vanilla, `subscribe`). `disabled` is true where geolocation
  is missing or denied, and `label` says which. Callbacks: `onGeolocate`, `onError` (`error.code` 1 means denied),
  `onTrackUserLocationStart`, `onTrackUserLocationEnd`. The position is never sent anywhere by the library.
- `useFullscreenControl` uses the Fullscreen API on the element around the canvas (or `container`). iPhone Safari has
  none for elements, so by default it covers the page with an inline `position: fixed` and `height: 100dvh` (taken off
  again on exit) and `Escape` leaves; with `unsupported: 'hide'` it reports `available: false` (the button props get
  `hidden`). Keep the map's container directly in the page, not under a `transform`.
- `useViewControl`: `mode`, `nextMode`, `label` ("2D" / "3D") and `toggle`, following the earth when other code
  changes the view.

The playground's `apps/playground/src/controls/MapControls.tsx` and `mapControls.css` are a complete styled set
(MapLibre's look, 44-pixel buttons on touch screens, safe-area insets) to copy.

### Vanilla

Each vanilla control takes the earth, computes its state, and exposes `getState()` and `subscribe(listener)` (which
returns the unsubscribe). It listens to the earth only while it has a listener.

```ts
import { Controls, Earth, NavigationControl, ScaleControl, ViewControl } from 'react-three-earth'

export function addControls(earth: Earth, container: HTMLElement) {
  const controls = new Controls({ container })
  controls.element.style.cssText = 'position: absolute; top: 10px; right: 10px; display: grid; gap: 4px'

  const navigation = new NavigationControl({ earth })
  const zoomIn = document.createElement('button')
  zoomIn.textContent = '+'
  zoomIn.setAttribute('aria-label', navigation.getState().zoomInLabel)
  zoomIn.onclick = navigation.zoomIn

  const view = new ViewControl({ earth })
  const viewButton = document.createElement('button')
  viewButton.onclick = view.toggle
  const drawView = () => {
    viewButton.textContent = view.getState().label
    viewButton.setAttribute('aria-label', view.getState().accessibleLabel)
  }
  drawView()
  const stopView = view.subscribe(drawView)
  view.events.addEventListener('viewchange', event => console.log(event.mode))

  const bar = document.createElement('div')
  bar.setAttribute('role', 'img')
  const scale = new ScaleControl({ earth, unit: 'nautical' })
  const stopScale = scale.subscribe(state => {
    bar.hidden = !state.visible
    bar.style.width = `${state.widthPixels}px`
    bar.textContent = state.label
    bar.setAttribute('aria-label', state.accessibleLabel)
  })

  controls.element.append(zoomIn, viewButton, bar)
  return () => {
    stopView()
    stopScale()
    controls.dispose()
  }
}
```

`GeolocateControl` takes the `container` whose presses pause following; `FullscreenControl` needs the `container` that
goes fullscreen. A control of your own extends `MapControl<State>` (`computeState`, `attach`, `detach`).

### Translate

Every text is in `ControlsLocale`; give a partial object as `locale` to any hook or class (`zoomIn`, `resetNorth`,
`switchTo2D`, `geolocateDenied`, `userLocation`, `unitKilometers`…). The state carries the translated labels.

```tsx
import { useNavigationControl } from 'react-three-earth/react'

export function FrenchZoomIn() {
  const navigation = useNavigationControl({ locale: { zoomIn: 'Agrandir', zoomOut: 'Réduire', resetNorth: 'Orienter vers le nord' } })
  return <button {...navigation.zoomInButtonProps}>+</button>
}
```

## Touch and accessibility

The look is yours, so is the touch size: make buttons at least 44 × 44 CSS pixels on touch screens (`@media (pointer:
coarse)`), keep corners clear of the notch and home indicator (`env(safe-area-inset-*)`), and set
`touch-action: manipulation` to stop double-tap zoom on them. Spread the button props on real `<button>`s: they carry the
accessible name, `aria-pressed` for toggles (fullscreen, a following geolocate) and `aria-busy` while waiting; give the
scale bar `scaleProps` (`role="img"` with its label).

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
Draggable markers, popups and `<Controls>` keep their own touches, and popups and `<Controls>` their wheel.

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

- Rendering `<button>`s straight inside `<Earth>`: the R3F tree holds no HTML. Put them in `<Controls>`.
- Calling the hooks outside `<Earth>`: they need `useEarth` and throw.
- Expecting the library to style the controls: it ships no CSS for them; `<Controls>` is an unplaced `<div>` until you
  give it a `className` or `style`.
- Writing your own `aria-label` and forgetting it changes with the state (the geolocate button explains why it is
  disabled): spread the `…ButtonProps` instead.
- Holding `<Earth view>` in state and not passing `onViewChange` to `useViewControl`: the button changes the earth but
  your state stays behind.
- Expecting geolocation on plain HTTP: browsers refuse it; use HTTPS or `localhost`.
- Giving the canvas's parent a `role` or `aria-label` of your own and expecting it to stay: `<EarthControls>` sets
  them while mounted (and puts yours back after); name the map with `label` instead.
- Expecting `Shift` + left drag to rotate: with box zoom on (the default) it draws a box; rotate with the right button.
- Turning on `cooperativeGestures` for a full-screen map: there is no page to scroll, so it only gets in the way.
- Testing the keys without focusing the map first: they only work while the map's element has focus (a click or `Tab`).

## Completion

The app's own buttons show over the map, work by mouse, touch and keyboard, read their labels in the app's language,
and on iPhone are 44 pixels with fullscreen covering the page. `Tab` reaches the map, a screen reader names it,
and the arrows and `+` / `-` move it.
