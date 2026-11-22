---
name: coordinates-and-units
description: >
  Use when placing markers, meshes, models or the camera at a longitude, latitude and height on a
  react-three-earth globe, converting geographic coordinates to scene positions, orienting objects to the
  local ground, or wondering why objects jitter or collapse at planet scale. Also covers the library's
  naming rules for units.
metadata:
  purpose: 'Explains the ECEF scene frame, the geographic helpers, local east-north-up orientation, centimetre precision, and the units-in-names convention.'
  type: core
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/camera.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/PrecisionTest.tsx'
---

# Coordinates and units

The scene frame is Earth-centred, Earth-fixed (ECEF) on the WGS84 ellipsoid, in metres: the origin is the
centre of the Earth, +Z points to the north pole, +X to longitude 0 on the equator, +Y to 90° east. A point
on the ground is about 6.4 million metres from the origin. Heights are ellipsoidal (above WGS84), not above
sea level; the geoid differs by up to about 100 m.

## Setup

```ts
import { setCameraView, toCartesian } from 'react-three-earth'
```

Both helpers are in the root entry (vanilla), and work the same from React.

## Core Patterns

### Place an object at a longitude, latitude and height

```tsx
import { toCartesian } from 'react-three-earth'
import { Earth } from 'react-three-earth/react'
import { useMemo } from 'react'

const summit = { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 3776 }

function SummitMarker() {
  const position = useMemo(() => toCartesian(summit), [])
  return (
    <mesh position={position}>
      <sphereGeometry args={[50, 16, 16]} />
      <meshStandardNodeMaterial color="red" />
    </mesh>
  )
}

export function Scene() {
  return (
    <Earth>
      <SummitMarker />
    </Earth>
  )
}
```

`toCartesian(position, result?)` writes into `result` when given, so reuse a `Vector3` in per-frame code.
Children of `<Earth>` are in ECEF metres, the same frame as the terrain.

### Orient an object to the local ground (east-north-up)

At any point, local "up" is the ellipsoid normal, not the scene's +Y. Use 3d-tiles-renderer's ellipsoid
(installed with this library) to build the frame:

```ts
import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Matrix4, Mesh } from 'three'

export function placeOnGround(object: Mesh, longitudeDegrees: number, latitudeDegrees: number, heightMeters: number) {
  const frame = new Matrix4()
  WGS84_ELLIPSOID.getEastNorthUpFrame(MathUtils.degToRad(latitudeDegrees), MathUtils.degToRad(longitudeDegrees), heightMeters, frame)
  // local +X east, +Y north, +Z up
  frame.decompose(object.position, object.quaternion, object.scale)
}
```

Note the argument order: 3d-tiles-renderer takes latitude first, in radians. The library's own helpers
take named degrees to avoid that mistake.

### Point the camera at a place

```ts
import { setCameraView } from 'react-three-earth'
import { PerspectiveCamera } from 'three'

const camera = new PerspectiveCamera(60, 16 / 9, 1, 1e8)
setCameraView(camera, {
  longitudeDegrees: 2.2945,
  latitudeDegrees: 48.8584,
  heightMeters: 100, // height of the point looked at
  distanceMeters: 2000, // from the camera to that point
  headingDegrees: 0, // compass direction the camera faces, clockwise from north
  pitchDegrees: -30, // below the horizon; -90 looks straight down
})
```

In React, call it in a `useLayoutEffect` with `useThree(state => state.camera)`, inside or beside
`<Earth>`. `<EarthControls>` continues from wherever the camera is.

### Name things with their units

Public names spell out SI units: `heightMeters`, `distanceMeters`, `memoryBudgetBytes`,
`imageryCompositionBudgetMilliseconds`, `longitudeDegrees`, `sunAngularRadiusRadians`. Follow the same
rule in code built on the library, so an agent reading a call site never has to guess a unit.

## Common Mistakes

### CRITICAL: Turning `renderer.highPrecision` off, or rendering ECEF geometry without `<Earth>`

At 6.4e6 m a 32-bit float resolves only about 0.5 m, so vertices jitter and nearby objects collapse
into one. `Earth.connect` (and `<Earth>`) sets `renderer.highPrecision = true`: model-view matrices are
computed in 64-bit on the CPU relative to the camera. The playground's precision check shows 1 cm =
128 px with it on, and two cubes 1 cm apart collapsing or vanishing with it off.

### HIGH: Building geometry with absolute ECEF vertex positions

`highPrecision` fixes the object's matrix, not its vertices. Put the ECEF position on `object.position`
(or a parent group) and keep vertex coordinates small and local. A `BufferGeometry` whose vertices are
millions of metres from its origin still jitters.

### HIGH: `InstancedMesh` or `SkinnedMesh` under `<Earth>`

three's 64-bit precision mode does not support `InstancedMesh` or `SkinnedMesh` (three r187
`Renderer`): at ECEF distances they jitter or misplace. Use separate meshes, or put the instances in a
local frame: a parent `Group` at the ECEF position (`toCartesian`) and instance matrices in metres
relative to it, kept small.

### HIGH: Treating scene +Y as up

The scene is ECEF, so "up" depends on where you are. Use `getEastNorthUpFrame` (above) or the normal
from `WGS84_ELLIPSOID.getPositionToNormal`.

### MEDIUM: Passing heights above sea level

`heightMeters` is ellipsoidal. Mount Fuji's summit is 3776 m above sea level and about 3817 m above the
ellipsoid. For markers on the ground, raycast the terrain or add the geoid height.

## Completion

- The object appears where expected and stays still while zooming to a few metres away.
- `toCartesian({ longitudeDegrees: 0, latitudeDegrees: 0 })` is `(6378137, 0, 0)`; the north pole is
  `(0, 0, 6356752.3)`.
