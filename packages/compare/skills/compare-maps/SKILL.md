---
name: compare-maps
description: >
  Use when an app shows two maps to compare on an earthkit globe, like maplibre-gl-compare or mapbox-gl-compare: a
  swipe slider between before and after imagery (two years of satellite pictures, a flood, a fire, a construction
  site), a street map against satellite, two MapLibre styles, side by side (vertical line) or top and bottom
  (horizontal line), a line that follows the mouse, a keyboard-accessible slider handle (headless: the app draws it),
  synced cameras, or a split view on a phone.
metadata:
  purpose: 'Documents @earthkit/compare: the Compare plugin (layers per side, orientation, position, followPointer, attachHandle, events, state), the React hooks useCompareImagery, useCompareHandle, useCompareState and useCompareEvent, and the Imagery.screenClip core it is built on.'
  type: framework
  framework: 'react'
  library: '@earthkit/compare'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/compare/src/Compare.ts'
  - 'Romainlg29/react-three-earth:packages/compare/src/react/index.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/screenClip.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Imagery.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Imagery.tsx'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/CompareExample.tsx'
requires:
  - '@earthkit/globe#getting-started'
  - '@earthkit/globe#terrain-and-imagery-sources'
---

# Compare maps with a swipe slider

Read `@earthkit/globe#getting-started` and `@earthkit/globe#terrain-and-imagery-sources` first. `@earthkit/compare`
shows `before` imagery layers on one side of a line across the canvas and `after` layers on the other. It is headless:
it ships no slider, the app draws the handle and `attachHandle` makes it work.

| maplibre-gl-compare | @earthkit/compare |
| --- | --- |
| `new Compare(beforeMap, afterMap, container)` | `new Compare({ before: [imagery], after: [imagery] })`, `earth.addPlugin(compare)` or `<Earth plugins={[compare]}>` |
| two maps, cameras synced by events | one earth, one camera: nothing to sync |
| `{ orientation: 'vertical' \| 'horizontal' }` | the same, `compare.orientation = 'horizontal'` |
| `{ mousemove: true }` | `{ followPointer: true }`, `compare.followPointer = true` |
| `compare.setSlider(x)` (pixels) | `compare.setPosition(fraction)` (0 to 1), `compare.setPositionFromScreen({ xPixels, yPixels })` |
| `compare.on('slideend', …)` | `compare.addEventListener('slideend', …)`, also `slidestart`, `slide`, `change` |
| the plugin's swiper element and CSS | your element: `compare.attachHandle(element)` / `useCompareHandle(compare)` |

Both sides are one render of one earth: the terrain, the camera, the atmosphere and every layer not listed are shared,
and each listed layer is clipped per pixel (`Imagery.screenClip`). Moving the line costs nothing: no reload, no shader
rebuild, no extra draw, so a drag holds 60 fps on a phone. Two `Earth`s would load and draw everything twice.

## Setup

```tsx
import { Compare } from '@earthkit/compare'
import { useCompareHandle, useCompareImagery } from '@earthkit/compare/react'
import { Earth, Imagery, MapStyleSource, QuantizedMeshSource, RasterTileSource, Terrain } from '@earthkit/globe/react'
import { Canvas } from '@react-three/fiber'
import { useMemo } from 'react'

function Handle({ compare }: { compare: Compare }) {
  const handleRef = useCompareHandle(compare, { label: 'Before and after' })
  return <div ref={handleRef} className="swiper" />
}

export function BeforeAfter() {
  const compare = useMemo(() => new Compare({ orientation: 'vertical' }), [])
  const plugins = useMemo(() => [compare], [compare])
  const streetsRef = useCompareImagery(compare, 'before')
  const satelliteRef = useCompareImagery(compare, 'after')
  return (
    <div style={{ position: 'relative', height: '100vh' }}>
      <Canvas>
        <Earth plugins={plugins}>
          <Terrain>
            <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" />
          </Terrain>
          <Imagery ref={streetsRef}>
            <MapStyleSource url="https://example.com/streets/style.json" />
          </Imagery>
          <Imagery ref={satelliteRef}>
            <RasterTileSource url="https://example.com/satellite/{z}/{x}/{y}.jpg" levels={19} />
          </Imagery>
        </Earth>
      </Canvas>
      <Handle compare={compare} />
    </div>
  )
}
```

```css no-check
/* --compare-position is set on the handle by @earthkit/compare: '37.5%'. */
.swiper { position: absolute; top: 0; bottom: 0; left: var(--compare-position); width: 44px; margin-left: -22px; cursor: ew-resize; }
.swiper::before { content: ''; position: absolute; top: 0; bottom: 0; left: 21px; width: 2px; background: white; }
.swiper[aria-orientation='vertical'] { top: var(--compare-position); bottom: auto; left: 0; right: 0; width: auto; height: 44px; margin: -22px 0 0; cursor: ns-resize; }
```

Put the handle in the box that holds the canvas (the canvas fills it), above it. Vanilla:

```ts
import { Compare } from '@earthkit/compare'
import type { Earth, Imagery } from '@earthkit/globe'

export function addComparison(earth: Earth, streets: Imagery, satellite: Imagery, handle: HTMLElement): () => void {
  const compare = new Compare({ before: [streets], after: [satellite] })
  earth.addPlugin(compare)
  const detach = compare.attachHandle(handle)
  return () => {
    detach()
    earth.removePlugin(compare) // both layers show on the whole canvas again
  }
}
```

## Core Patterns

### Sides, orientation and position

```ts
import { Compare } from '@earthkit/compare'
import type { Imagery } from '@earthkit/globe'

export function configure(compare: Compare, older: Imagery, recent: Imagery, labels: Imagery) {
  compare.addImagery(older, 'before') // left, or above
  compare.addImagery(recent, 'after') // right, or below; a layer on the other side moves
  compare.removeImagery(labels) // shown on the whole canvas
  compare.orientation = 'horizontal' // a horizontal line: before above, after below
  compare.setPosition(0.3) // 0 to 1 of the width (or height), clamped
  compare.followPointer = true // the line follows the mouse over the map
}
```

- Layers not listed stay on the whole canvas, on both sides: a shared labels layer on top, or a basemap under two
  partial layers. Stacking order is still mount order (`<Imagery>`), as without a comparison.
- A map style on a side is clipped whole: its imagery, its labels and its 3D buildings.
- Clicks, layer events and `queryRenderedFeatures` skip a layer where it is clipped away.
- The clip only applies while the plugin is installed; removing it shows every layer everywhere again.
- `compare.getState()` is an immutable snapshot (`orientation`, `positionFraction`, `followPointer`, `dragging`,
  `before`, `after`); `compare.subscribe(listener)` hears every change. `earth.inspect().plugins.compare.details` reports
  it for agents.

### The handle

`attachHandle(element)` (React: `useCompareHandle(compare)`) wires an element the app styled:

- Dragging it moves the line by the pointer's movement over the canvas, with pointer capture: the map never pans, on
  touch or mouse. It sets `touch-action: none` on the element.
- `role="slider"`, a tab stop, `aria-valuenow` (0 to 100), `aria-valuetext`, `aria-orientation` (`'horizontal'` for a
  vertical line: the handle moves sideways) and an `aria-label` (`label`, default `'Comparison position'`) unless the
  element has one. Arrow keys move by `keyboardStepFraction` (default 0.01), Page Up / Page Down ten times as far, Home
  and End to the edges.
- The `--compare-position` CSS property (`COMPARE_POSITION_PROPERTY`), kept current: place the handle with it and a
  drag re-renders no React component.
- The returned function (or unmounting the ref's element) restores the element.

### React hooks

```tsx
import { Compare } from '@earthkit/compare'
import { useCompareEvent, useCompareState } from '@earthkit/compare/react'

export function CompareToolbar({ compare }: { compare: Compare }) {
  const orientation = useCompareState(compare, state => state.orientation)
  useCompareEvent(compare, 'slideend', ({ positionFraction }) => console.log('settled at', positionFraction))
  return (
    <button type="button" onClick={() => (compare.orientation = orientation === 'vertical' ? 'horizontal' : 'vertical')}>
      {orientation === 'vertical' ? 'Top and bottom' : 'Side by side'}
    </button>
  )
}
```

`useCompareImagery(compare, side)` returns a ref for `<Imagery ref>`; a layer rebuilt when its sources change is
followed, and an unmounted one leaves the comparison. `useCompareState(compare, selector?)` re-renders only when the
selected part changes: select `orientation` or `dragging`, not `positionFraction`, in components that should not
re-render through a drag.

### Without the plugin (core)

`Imagery.screenClip` is what `Compare` sets: `{ side: 'left' | 'right' | 'top' | 'bottom', positionFraction }`, or
`<Imagery screenClip={…}>` for a fixed split. Use it directly for a static split view or another shape of control.

## Common Mistakes

### HIGH: Two `<Earth>` (or two canvases) to compare

Wrong: two maps side by side with their cameras synced by events, as with maplibre-gl-compare. It loads and draws the
terrain twice, doubles GPU memory and drifts by a frame while moving. Correct: one `<Earth>` and a `Compare` with the
layers on each side.

### HIGH: A new `Compare` or plugins array every render

`<Earth plugins>` compares by identity: create both in `useMemo` (or at module scope), or each render reinstalls the
plugin and resets the slider.

### MEDIUM: Re-rendering the map on every drag frame

Wrong: `const { positionFraction } = useCompareState(compare)` in the component that renders `<Canvas>`, to place the
handle with `style={{ left }}`. Correct: place it with `var(--compare-position)`, or read the position in a small
component of its own.

### MEDIUM: Expecting the terrain, the atmosphere or the date to differ per side

Both sides share everything but the listed imagery layers: terrain, exaggeration, sun, atmosphere and markers are the
same on both. Compare imagery and map styles, not scenes.

## Completion

- `earth.inspect().plugins.compare.details` shows the layer counts on each side and the position.
- The handle has `role="slider"` and a current `aria-valuenow`; dragging it moves the line and leaves the camera still.
- Each listed layer's `imagery.screenClip` names its side; unlisted layers' is `null`.
