---
name: react-hooks-and-frame-loop
description: >
  Use when React UI or per-frame code needs the react-three-earth globe: reading tile counts or other
  Earth state into components (HUD, loading indicator), running code every frame after tiles update,
  getting the vanilla Earth object inside R3F, ordering frame callbacks, or using frameloop="demand"
  to save battery.
metadata:
  purpose: 'Documents useEarth, useEarthFrame and useEarthState, the R3F v10 scheduler ids the library registers, and on-demand rendering.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/hooks.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/context.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Earth.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/EarthControls.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Terrain.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/events.ts'
requires:
  - getting-started
---

# React hooks and the frame loop

Read `getting-started` first. All hooks must be called inside `<Earth>`, which sits inside `<Canvas>`.

## Core Patterns

### Get the vanilla Earth

```tsx
import { useEarth } from 'react-three-earth/react'

export function LogOnce() {
  const earth = useEarth() // the vanilla Earth (a three.js Group); reading it never re-renders
  console.log(earth.inspect())
  return null
}
```

Everything the vanilla API offers is available from there: `earth.terrain`, `earth.atmosphere`,
`earth.date`, `earth.camera`, `earth.inspect()`. `useEarthCamera()` returns `earth.camera`, and
`useEarthEvent('moveend', handler)` listens to the Earth's events (see `camera-and-events`).

### Show Earth state in the UI without re-rendering every frame

`useEarthState(selector, { hz })` polls `selector` at most `hz` times a second (default 10) and
re-renders only when the result changes by `Object.is`. Return primitives or memoised values: a new
object every call re-renders at every poll.

A component under `<Canvas>` lives in the R3F renderer and cannot return DOM elements. Keep the HUD
outside `<Canvas>` and pass values out through a callback or a store:

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, useEarthState } from 'react-three-earth/react'
import { useEffect, useState } from 'react'

function ReportTiles({ onChange }: { onChange: (tiles: number) => void }) {
  const tiles = useEarthState(earth => earth.inspect().terrain?.tilesLoaded ?? 0, { hz: 4 })
  useEffect(() => onChange(tiles), [tiles, onChange])
  return null
}

export function App() {
  const [tiles, setTiles] = useState(0)
  return (
    <>
      <Canvas renderer={{ reversedDepthBuffer: true }}>
        <Earth>
          <ReportTiles onChange={setTiles} />
        </Earth>
      </Canvas>
      <div style={{ position: 'absolute', top: 8, left: 8 }}>{tiles} tiles</div>
    </>
  )
}
```

### Run code every frame, after tiles update

```tsx
import { useEarthFrame } from 'react-three-earth/react'
import { useRef } from 'react'
import type { Mesh } from 'three'

export function Spinner() {
  const mesh = useRef<Mesh>(null)
  useEarthFrame((earth, deltaSeconds) => {
    if (mesh.current) mesh.current.rotation.z += deltaSeconds
  })
  return (
    <mesh ref={mesh}>
      <boxGeometry args={[100, 100, 100]} />
      <meshStandardNodeMaterial />
    </mesh>
  )
}
```

`useEarthFrame` runs after the `earth:update` job and never causes a React render.

### Order your own frame jobs

The library registers two R3F v10 scheduler jobs in the `update` phase:

| id | does | order |
| --- | --- | --- |
| `earth:controls` | moves the camera from input, refits near/far | before `earth:update` |
| `earth:update` | selects and loads tiles for the camera, composes imagery, aims the sun | then render |

A camera animation must run before `earth:update` so tiles are chosen for the final camera:

```tsx
import { useFrame } from '@react-three/fiber'

export function FlyNorth() {
  useFrame(({ camera }, deltaSeconds) => {
    camera.position.z += 1000 * deltaSeconds
    camera.updateMatrixWorld()
  }, { phase: 'update', before: 'earth:update', after: 'earth:controls' })
  return null
}
```

### Render only when something changes

`<Canvas frameloop="demand">` works: `<Terrain>` invalidates when tiles finish loading or imagery is
still being composed, `<Atmosphere>` invalidates once its lookup textures are ready, and `<Earth>`
invalidates on `earth.camera.jumpTo` (the `framerequest` event) and for one more frame after the camera
moves, so `moveend` fires. Call
`useThree(state => state.invalidate)()` after your own changes (moving a marker, changing `earth.date`),
and also after changing `<Earth date>`, `<Imagery opacity>` or `<Atmosphere exposure>`: those props
update the vanilla objects without requesting a frame.

`<EarthControls>` does not request frames on pointer input yet, so with `frameloop="demand"` dragging
does nothing until something else invalidates. Use demand mode for static or scripted views, and keep the
default loop for interactive maps.

## Common Mistakes

### HIGH: Calling `earth.inspect()` in render or in a `setState` every frame

`inspect()` allocates a fresh object; calling it in `useFrame` and setting state re-renders React 60
times a second. Use `useEarthState` with a primitive selector and a low `hz`.

### HIGH: Moving the camera after `earth:update`

Tiles are selected for the previous camera, so the first frame after a jump shows coarse or missing
tiles. Order camera code `before: 'earth:update'`.

### MEDIUM: Returning DOM from a component inside `<Canvas>`

`<div>` inside the R3F tree is not a DOM element. Keep HUDs outside `<Canvas>` (pattern above).

### MEDIUM: Creating vanilla objects in render

Create library classes once (`useState(() => new X())` or `useMemo`), as the library's own components
do, and dispose them in an effect cleanup. A new `Terrain` per render reloads every tile.

## Completion

- The HUD updates a few times a second while the React profiler shows no per-frame renders.
- With `frameloop="demand"` on a static view, the globe still finishes loading and the atmosphere appears.
