---
name: customize-terrain-shading
description: >
  Use when changing how the ground of an earthkit globe looks: the terrain tile material,
  roughness, base colour under the imagery, slope or height visualisation, emissive overlays, wireframe
  debugging, or writing TSL node code for terrain tiles with the createMaterial option.
metadata:
  purpose: 'Explains the createMaterial factory, which node material slots are free and which the imagery owns, and how to keep custom terrain shading fast.'
  type: sub-skill
  library: '@earthkit/globe'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/TileMaterialReplacementPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/wrapOverlaysNodeMaterial.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Terrain.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Terrain.tsx'
requires:
  - terrain-and-imagery-sources
---

# Customize terrain shading

Read `terrain-and-imagery-sources` first. Every terrain tile mesh gets a material from
`createMaterial`, a function returning a three.js node material. The default is
`new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })`, which the atmosphere's sun lights.

## Core Patterns

### Supply your own material

```tsx
import { QuantizedMeshSource, Terrain } from '@earthkit/globe/react'
import { MeshStandardNodeMaterial } from 'three/webgpu'

// Module level: a stable function, so <Terrain> is not rebuilt on every render
const createMaterial = () => new MeshStandardNodeMaterial({ color: '#c8c8c8', roughness: 0.9, metalness: 0 })

export function GreyGround() {
  return (
    <Terrain createMaterial={createMaterial}>
      <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" attribution="Terrain: Re:Earth Terrain" />
    </Terrain>
  )
}
```

Vanilla: `new Terrain({ sources, createMaterial })`. The factory is called once per tile mesh.
`color` is the base colour, visible where no imagery covers the tile, and imagery is blended over it.

### Shade by slope with TSL

Imagery owns `colorNode` (see Common Mistakes), so add effects through the other slots. Build the nodes
once at module level and share them between every tile's material: the shader then compiles once.

```ts
import { float, mix, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

// Geocentric up: within 0.2 degrees of the true ground normal, enough for shading
const up = positionWorld.normalize()
const slope = float(1).sub(normalWorld.dot(up)) // 0 flat, 1 vertical
const steepness = smoothstep(0.15, 0.4, slope)
const slopeHighlight = mix(vec3(0), vec3(0.6, 0.1, 0.05), steepness)

export const createSlopeMaterial = () => {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.emissiveNode = slopeHighlight
  return material
}
```

Pass `createSlopeMaterial` as `createMaterial`. Free slots on `MeshStandardNodeMaterial` include
`emissiveNode`, `roughnessNode`, `metalnessNode`, `normalNode` and `opacityNode`. The library owns
`colorNode` (imagery) and, with `fade` on (the default), `outputNode` (tile cross-fades).

### Debug tile boundaries

```ts
import { MeshStandardNodeMaterial } from 'three/webgpu'

export const createWireframeMaterial = () => new MeshStandardNodeMaterial({ wireframe: true, roughness: 1 })
```

## Common Mistakes

### HIGH: Setting `colorNode` on a terrain material

When imagery layers attach to a tile, the overlay code replaces `material.colorNode` with its own
blend of up to 10 layers over `material.color`. Your `colorNode` is silently dropped. Use `color` for
the base, `emissiveNode` for additive effects, or an extra `<Imagery>` layer for colour.

### HIGH: An inline arrow function in JSX

`createMaterial` is a dependency of `<Terrain>`: `createMaterial={() => new ...}` creates a new function
each render, which disposes the terrain and reloads every tile. Define it at module level or with
`useCallback`.

### HIGH: A classic (non-node) material

The imagery blend is a TSL `colorNode` set on the material, which `MeshStandardMaterial` and other
classic materials ignore, so imagery disappears. Return a `NodeMaterial` from `three/webgpu`, such as
`MeshStandardNodeMaterial`.

### MEDIUM: New TSL nodes per call

Building the node graph inside the factory makes every tile compile its own shader on first sight,
which stutters while panning. Build nodes once, assign them per material.

### MEDIUM: Moving vertices with `positionNode`

Tile bounds, culling, raycasts and `EarthControls` use the original geometry. Vertical exaggeration
through `positionNode` makes tiles pop and the controls pick the wrong surface.

## Completion

- Tiles render with the custom look and imagery still drapes over them.
- Panning does not stutter more than with the default material (compare
  `earth.inspect().terrain.imageryMainThreadMilliseconds` and frame time).
