---
name: flat-map-2d
description: >
  Use when showing a react-three-earth map flat (2D, Web Mercator, like MapLibre) instead of as a globe,
  switching between globe and flat map with a transition, tuning that transition, limiting zoom on the
  flat map, or lighting terrain on the flat map.
metadata:
  purpose: 'Explains the 2D view, the unroll transition, repeated worlds and the zoom limit on the flat map, and the lighting rules in 2D.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/view/ViewMorph.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthControls.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Earth.tsx'
  - 'Romainlg29/react-three-earth:docs/spike/SPIKE.md'
requires:
  - getting-started
---

# Flat map (2D)

`<Earth view="2d">` shows the same terrain and imagery as a flat Web Mercator map, the projection XYZ raster
servers use. On the flat map:

- The world repeats east and west.
- You cannot zoom out past the height where the whole map (±85°) fills the screen.
- You cannot pan past the poles.
- `<EarthControls>` pans, zooms and rotates, looking straight down.

Changing `view` plays a transition:

- **Towards the map:** the camera keeps its place and turns to look straight down. The map unrolls off
  the globe from the point looked at outwards, with a thin glowing seam on the front. From high up, the
  camera eases down to the flat map's height limit.
- **Towards the globe:** the map rolls back up from its edges inwards.

The default length is 1.8 s.

## Setup

```tsx
import { Earth, EarthControls } from 'react-three-earth/react'
```

The view lives on the vanilla `Earth` (`earth.setView`, `earth.view`), so it works the same without React.

## Core Patterns

### Toggle between globe and flat map

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, EarthControls } from 'react-three-earth/react'
import { useState } from 'react'

export function Map() {
  const [view, setView] = useState<'2d' | '3d'>('3d')
  return (
    <>
      <Canvas>
        <Earth view={view} viewTransitionSeconds={2.4}>
          {/* <Terrain>, <Imagery>, <Atmosphere> */}
          <EarthControls />
        </Earth>
      </Canvas>
      <button onClick={() => setView(view === '3d' ? '2d' : '3d')}>{view === '3d' ? '2D' : '3D'}</button>
    </>
  )
}
```

The first `view` value applies at once, without a transition. Switching back halfway plays the
transition in reverse from where it is.

### Vanilla

```ts
import { Earth, EarthViewControls } from 'react-three-earth'

const earth = new Earth({ view: '3d' })
const controls = new EarthViewControls(earth)
// each frame, before rendering:
// controls.update(deltaSeconds); earth.update(camera, renderer, deltaSeconds)
earth.setView('2d', { durationSeconds: 2.4 }) // a slower unroll
```

`earth.update` returns true while a transition runs. Hosts that render on demand use it to ask for another frame.

### Read the state

```ts
import type { Earth } from 'react-three-earth'

function describe(earth: Earth) {
  const { mode, morph } = earth.inspect().view // morph: 0 globe, 1 flat map
  return { mode, morph, copies: earth.view.worldCopyCount, transitioning: earth.view.transitioning }
}
```

## Common Mistakes

- **Own lights in 2D.** Without `<Atmosphere>`, your lights keep shining on the flat map, while the tiles
  also emit their imagery colour there, so the map looks too bright. Scale your lights by
  `1 - earth.view.morph`, for example in `useEarthFrame`.
- **Moving the `Earth` away from the scene origin.** The view and the controls read the camera in world
  space as ECEF metres.
- **Expecting input during a transition.** Controls ignore input until `earth.view.transitioning` is false.

## Completion

- Toggling `view` unrolls or rolls up the map without a camera jump, and imagery stays aligned.
- On the flat map, zooming out stops when the map's height fills the screen, and the world repeats
  sideways when the screen is wider than the map.
