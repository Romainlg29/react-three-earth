---
name: markers-and-popups
description: >
  Use when an app needs HTML pinned to a place on the globe or flat map in react-three-earth, like
  MapLibre's Marker and Popup: pins and labels at a longitude and latitude, a popup that opens when a
  marker is clicked, a draggable pin that reports where it was dropped, a tooltip that follows the
  pointer, markers that hide behind the horizon or terrain, or styling and keyboard access for them.
metadata:
  purpose: 'Documents <Marker>, <Popup>, useMarker and the vanilla Marker and Popup: placement, terrain height, occlusion, dragging, popups, CSS variables, accessibility and the Earth update event.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Marker.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Popup.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/markerLayout.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/ScreenOverlay.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/events.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Marker.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Popup.tsx'
  - 'Romainlg29/react-three-earth:apps/playground/src/MapDemo.tsx'
requires:
  - getting-started
---

# Markers and popups

Read `getting-started` first. A `Marker` is an HTML element pinned to a place on the earth, over the
canvas; a `Popup` is a box of HTML pointing at a place, usually the one a marker opens when clicked. They
follow MapLibre's `Marker` and `Popup`, on the globe (`view="3d"`) and the flat map (`view="2d"`).

| MapLibre | react-three-earth |
| --- | --- |
| `new Marker({ element, anchor, offset, rotation, draggable })` | `<Marker anchor offsetPixels rotationDegrees draggable>` / `new Marker({ … })` |
| `marker.setPopup(popup)` | `<Marker><Popup>…</Popup></Marker>` / `marker.setPopup(popup)` |
| `new Popup({ closeOnClick, maxWidth })` | `<Popup closeOnClick maximumWidthPixels>` / `new Popup({ … })` |
| `marker.on('dragend')` | `onDragEnd`, `marker.addEventListener('dragend', …)` |

Markers are DOM elements: fine for tens to a few hundred places. Not there yet: clustering, and wheel
zoom over a marker when a vanilla container is not inside the controls' element.

## Setup

Place `<Marker>` anywhere inside `<Earth>`. Its DOM goes in the element around the canvas (the `<Canvas>`
wrapper), which is made `position: relative` when it is static. It needs no CSS import: the styles are
injected once per document.

## Core Patterns

### A pin that opens a popup

```tsx
import { Earth, EarthControls, Marker, Popup } from 'react-three-earth/react'

export function Peak() {
  return (
    <Earth>
      <EarthControls />
      <Marker longitudeDegrees={138.7274} latitudeDegrees={35.3606} label="Mount Fuji">
        <Popup>
          <strong>Mount Fuji</strong>
          <div>3776 m</div>
        </Popup>
      </Marker>
    </Earth>
  )
}
```

Without an element of its own a marker shows the default pin (27 × 41 px, anchored at its bottom tip;
`color` sets its colour). A `<Popup>` anywhere inside `<Marker>` (wrapped in your own component too)
opens on click, Enter or Space and closes on the × button, `Escape`, a click on the map or another
click on the marker. The React layer renders through `react-dom`, which the app must have installed.

### Content of your own

Anything else in `<Marker>` is the marker's content, real React in the page's DOM (`useEarth`, context and
hooks work inside). It is anchored at its centre unless you give `anchor`.

```tsx
import { Marker, Popup, useEarth } from 'react-three-earth/react'

function Badge({ text }: { text: string }) {
  const earth = useEarth() // the content shares the app's React context
  return <span title={earth.loaded ? 'ready' : 'loading'}>{text}</span>
}

export function Label() {
  return (
    <Marker
      longitudeDegrees={2.3522}
      latitudeDegrees={48.8566}
      heightMeters={0}
      anchor="bottom-left"
      offsetPixels={{ xPixels: 6, yPixels: -6 }}
      rotationDegrees={-15}
      rotationAlignment="map"
      occludedOpacity={0}
      label="Paris"
    >
      <Badge text="Paris" />
      <Popup anchor="auto" offsetPixels={8} maximumWidthPixels={200}>
        The capital of France.
      </Popup>
    </Marker>
  )
}
```

- `heightMeters` is a number (ellipsoidal metres) or `'terrain'`, the default: the marker sits on the
  loaded terrain (0 until a tile is there), re-read a few times a second as finer tiles arrive.
- `anchor` is the point of the element on the position: `'center' | 'top' | 'bottom' | 'left' | 'right' |
  'top-left' | …`. `offsetPixels` shifts it after anchoring, in CSS pixels.
- `rotationDegrees` turns it clockwise; `rotationAlignment="map"` turns it with the map's heading and
  `pitchAlignment="map"` lays it on the ground as the camera tilts. Both default to `'viewport'`.
- `occludedOpacity` (default 0.2) is the opacity while terrain hides it; 0 hides it fully. Behind the
  globe's horizon it is always hidden.
- `label` is the accessible name screen readers announce. Give every marker one.

### Draggable markers: store the new position

```tsx
import { useState } from 'react'
import { Marker } from 'react-three-earth/react'

export function DraggablePin() {
  const [place, setPlace] = useState({ longitudeDegrees: 138.75, latitudeDegrees: 35.3 })
  return (
    <Marker
      {...place}
      draggable
      color="#e8590c"
      label="Meeting point"
      onDragEnd={position => setPlace({ longitudeDegrees: position.longitudeDegrees, latitudeDegrees: position.latitudeDegrees })}
    />
  )
}
```

The marker follows the pointer on the ground (terrain included) and `onDragEnd` gives its new place.
Leave `heightMeters` out of the stored state to keep following the terrain. `onDragStart` and `onDrag`
(every pointer move) exist too. A drag does not move the camera; dragging a marker that is not
`draggable` pans the map, as in MapLibre, and does not count as a click.

### A standalone popup: controlled, or following the pointer

```tsx
import { useState } from 'react'
import { Popup } from 'react-three-earth/react'

export function Controlled() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(value => !value)}>Toggle</button>
      <Popup longitudeDegrees={2.35} latitudeDegrees={48.86} open={open} onClose={() => setOpen(false)} closeOnMove>
        Paris
      </Popup>
    </>
  )
}

export function Tooltip() {
  return (
    <Popup trackPointer closeButton={false} focusAfterOpen={false} offsetPixels={12}>
      Move over the map
    </Popup>
  )
}
```

Outside a `<Marker>` a popup needs `longitudeDegrees` and `latitudeDegrees` (or `trackPointer`) and opens
when it mounts unless `open` is set. With `open`, always give `onClose`: the user closes it (×, `Escape`,
a click on the map) and your state must follow. On a marker with `open` set, a click on the marker calls
`onOpen` instead of opening the popup (set your state there), and closes it when open. A click closes a
popup only when it lands on the map (the canvas or a marker), not on a control or another popup. Props: `anchor` (`'auto'` opens above or wherever it
fits), `offsetPixels` (a distance, or `{ xPixels, yPixels }`), `closeOnClick` (default true),
`closeOnMove` (default false), `closeButton`, `maximumWidthPixels` (default 240), `label`, `onOpen`.

### Reading the marker

`useMarker()` returns the vanilla `Marker` of the nearest `<Marker>`, in its content too. `ref` on
`<Marker>` or `<Popup>` gives the vanilla object: `marker.getPosition()`, `marker.visibility`,
`marker.togglePopup()`.

```tsx
import { Marker, useMarker } from 'react-three-earth/react'

function VisibilityText() {
  const marker = useMarker()
  return <span>{marker?.visibility ?? 'hidden'}</span>
}

export function Debug() {
  return (
    <Marker longitudeDegrees={0} latitudeDegrees={0} heightMeters={0}>
      <VisibilityText />
    </Marker>
  )
}
```

### Vanilla

```ts
import { Earth, Marker, Popup } from 'react-three-earth'

declare const earth: Earth
declare const canvas: HTMLCanvasElement

const container = canvas.parentElement! // the element the canvas fills
const marker = new Marker({ longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, label: 'Mount Fuji', draggable: true })
marker.setPopup(new Popup({ content: 'Mount Fuji, 3776 m' }))
marker.addEventListener('dragend', ({ position }) => marker.setPosition(position))
marker.addTo(earth, container)

const tooltip = new Popup({ closeButton: false, offsetPixels: 12, content: 'Hello' }).trackPointer()
tooltip.addTo(earth, container)

// later
marker.remove() // off the map, can be added again
marker.dispose() // for good
```

Both extend three's `EventDispatcher`. Marker events: `dragstart`, `drag`, `dragend` (each with
`position`) and `click`. Popup events: `open`, `close`. Setters (`setPosition`, `setAnchor`, `setOffset`,
`setRotation`, `setDraggable`, `setLabel`, `setContent`, …) return `this` and re-place the element at
once. Pass an element as `content` or `element` for rich HTML.

### Styling

The CSS is injected once per document (it needs `style-src 'unsafe-inline'` under a strict CSP). Restyle
with variables on any ancestor, or override the classes `react-three-earth-marker`,
`react-three-earth-popup`, `-popup-content`, `-popup-close`, `-popup-tip`:

```css
.map-wrapper {
  --react-three-earth-marker-color: #e8590c;
  --react-three-earth-popup-background: #1b1b1f;
  --react-three-earth-popup-color: #f4f4f5;
  --react-three-earth-popup-radius: 10px;
  --react-three-earth-popup-padding: 12px 14px;
  --react-three-earth-popup-font: 14px / 1.4 system-ui, sans-serif;
  --react-three-earth-popup-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
```

`className` on `<Marker>` and `<Popup>` adds your own classes. A marker's root carries
`data-visibility="visible" | "occluded" | "hidden"`, `data-draggable` and `data-dragging`, so CSS can react.

### Keyboard and focus

Markers are focusable buttons: the vanilla default pin is a `<button>`, other elements (and every React
marker) get `role="button"` and `tabindex="0"`. Enter and Space on the marker itself click it, which
toggles its popup (`aria-haspopup`, `aria-expanded` follow); keys typed in its content stay there. A popup
is a `role="dialog"` named by `label`. Opened from its marker, it moves focus inside (`focusAfterOpen`);
opened by the app, it takes focus only when its content has a control, and a `trackPointer` tooltip never
does. `Escape` closes it and returns focus to the marker. Keys and presses inside a popup do not reach the
map controls.

### Visibility and the `update` event

`marker.visibility` is `'visible'`, `'occluded'` (terrain is between the camera and the marker; faded to
`occludedOpacity`) or `'hidden'` (behind the camera, or beyond the globe's horizon). Markers and popups
place themselves in the Earth's `update` event, fired at the end of every `earth.update`, so they sit in
the frame that draws. Use it for your own screen-space overlays:

```ts
import type { Earth } from 'react-three-earth'

export function followScreen(earth: Earth, element: HTMLElement) {
  const onUpdate = () => {
    const screen = earth.project({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, heightMeters: 0 })
    element.style.transform = `translate(${screen.xPixels}px, ${screen.yPixels}px)`
    element.hidden = !screen.visible
  }
  earth.addEventListener('update', onUpdate)
  return () => earth.removeEventListener('update', onUpdate)
}
```

All markers and popups of an earth share one overlay with a budget of 4 terrain raycasts a frame (height
reads and occlusion tests), served in turn so every marker gets its checks however many there are; each
marker re-checks at most every 250 ms, and only after the camera moved or tiles loaded. With
`frameloop="demand"` the overlay asks for a frame when a check had to wait, so answers settle after the
camera stops. A marker can show for a quarter of a second after terrain starts to hide it.

## Common Mistakes

### HIGH: Not storing the dragged position

`<Marker>` is controlled by its props. If `onDragEnd` does not update the state behind `longitudeDegrees`
and `latitudeDegrees`, the marker stays where it was dropped only until a prop changes, then jumps back
where the props say. Store the position (see
the draggable example).

### MEDIUM: Text alone as a marker's content

The default pin shows while the marker has no element of its own, and text nodes are not elements:
`<Marker>Paris</Marker>` shows the pin and the text. Wrap text in an element (`<span>Paris</span>`).

### HIGH: The wrong container (vanilla)

`addTo(earth, container)` needs the element the canvas fills. Positions are measured from its top-left
corner; a container that does not match the canvas puts markers off by the difference, and one outside
the controls' element does not zoom with the wheel. In React the default (the canvas's parent) is right.

### MEDIUM: Thousands of markers

Each marker is a DOM element placed every frame. Past a few hundred, draw the places as map symbols
(vector style symbol layers, see `map-styles`) and use markers for the few the user interacts with.

### MEDIUM: Moving the camera after `earth.update`

Markers place themselves at the end of `earth.update`. Move the camera before it (as `EarthControls` does),
or markers show it one frame late. `jumpTo` and the controls are already safe.

### MEDIUM: Expecting HTML from a string

`content: '<b>Fuji</b>'` shows the tags as text; it is never parsed. In React, give JSX; in vanilla, give
an element (`content: element`) or fill `popup.contentElement`.

### MEDIUM: Expecting terrain occlusion everywhere

Terrain hides a marker only on the globe at rest. On the flat map the tiles are moved on the GPU, so the
meshes do not match what is drawn, and during the morph the test is skipped; markers there are only
`'hidden'` or `'visible'`. Occluded markers still take clicks.

### MEDIUM: A marker on the terrain before tiles load

`heightMeters="terrain"` reads 0 until a tile covers the place, then moves up. Pass a number when you
know the height, or accept the settle.

## Completion

- The pin's tip sits on `earth.project(position)` within 1 px while the camera moves.
- Clicking a marker with a `<Popup>` opens it above the pin with focus inside; `Escape` closes it and
  focus returns to the marker.
- A dragged marker stays where it was dropped after a re-render, and the camera did not move.
- A marker beyond the horizon or behind a ridge has `visibility` `'hidden'` or `'occluded'`.
