---
name: customize-terrain-shading
description: >
  Use when changing how the ground of a react-three-earth globe looks: the terrain tile material,
  roughness, base colour under the imagery, a stylised globe with no imagery, colouring by elevation, slope
  or aspect (terrainElevationMeters, terrainSlopeDegrees, terrainAspectDegrees), emissive overlays,
  wireframe debugging, or writing TSL node code for terrain tiles with the createMaterial option.
metadata:
  purpose: 'Explains the createMaterial factory, the terrain surface nodes (elevation, slope, aspect), which node material slots are free and which the imagery owns, and how to keep custom terrain shading fast.'
  type: sub-skill
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/TileMaterialReplacementPlugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/wrapOverlaysNodeMaterial.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/terrainSurface.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/FlatMapPlugin.ts'
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
import { QuantizedMeshSource, Terrain } from 'react-three-earth/react'
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

### Colour the ground by elevation, slope and aspect

Every terrain tile carries what it needs for this, whatever the source (quantized mesh or raster DEM), and
`react-three-earth` exports it as TSL nodes:

| Node | Value at the fragment |
| --- | --- |
| `terrainElevationMeters` | Height above the WGS84 ellipsoid, as loaded (exaggeration does not scale it) |
| `terrainSlopeDegrees`, `terrainSlopeRadians` | 0 flat, 90 vertical, as loaded (not exaggerated) |
| `terrainSlopePercent` | Grade: 100 is 45° |
| `terrainAspectDegrees`, `terrainAspectRadians` | Downhill compass direction, clockwise from north (0 north, 90 east); 0 on flat ground |
| `terrainNormalEastNorthUp` | The ground's unit normal, x east, y north, z up |

Set them on the material's `colorNode` in `createMaterial`: with no imagery the globe shows that colour, and
imagery layers blend over it.

```ts
import { terrainAspectRadians, terrainElevationMeters, terrainSlopeDegrees } from 'react-three-earth'
import { color, cos, float, mix, smoothstep } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

// Module level: every tile shares these nodes, so the shader compiles once
const lowland = mix(color('#4f7f45'), color('#c4ad7e'), smoothstep(0, 2400, terrainElevationMeters))
const rocky = mix(lowland, color('#8a8580'), smoothstep(28, 38, terrainSlopeDegrees)) // rock above about 30°
const snowy = mix(rocky, color('#f4f6fa'), smoothstep(2800, 3200, terrainElevationMeters))
// North faces a little darker, more so the steeper they are
const northness = cos(terrainAspectRadians).mul(smoothstep(0, 30, terrainSlopeDegrees))
const stylizedColor = snowy.mul(float(1).sub(northness.mul(0.12)))

export const createStylizedTerrainMaterial = () => {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.colorNode = stylizedColor
  return material
}
```

Pass `createStylizedTerrainMaterial` as `createMaterial` and leave out `<Imagery>` for a stylised globe. Hard
bands are a `step` instead of a `smoothstep`: `select(terrainSlopeDegrees.greaterThan(30), rock, grass)`.

- Values are smooth per vertex, from the source's normals, and interpolated across each triangle: a coarse tile
  far away shows broad strokes, the detail sharpens as tiles refine.
- Elevation is ellipsoidal, not above sea level: the geoid differs by up to about 100 m.
- Skirts (the strips hanging under tile edges to hide cracks) read their lowered height, so an elevation band
  can show a thin seam of the colour below it where tiles of different detail meet.
- Reading these nodes adds one vertex attribute to the tile shader. WebGPU guarantees only 8 vertex buffers, and
  three gives each attribute (every imagery layer's included) its own: with several imagery layers on WebGPU, ask
  the adapter for a higher `maxVertexBuffers` through the renderer's `requiredLimits`.
- The style layer `color-relief` (`satellite-and-relief-styles`) colours by elevation from a `raster-dem`
  source as a draped layer instead; use it when a map style already holds the elevation tiles.

### Shade by slope with emissive light

Free slots on `MeshStandardNodeMaterial` include `emissiveNode`, `roughnessNode`, `metalnessNode` and
`opacityNode`: add effects there that light should not dim.

```ts
import { terrainSlopeDegrees } from 'react-three-earth'
import { mix, smoothstep, vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

const slopeHighlight = mix(vec3(0), vec3(0.6, 0.1, 0.05), smoothstep(25, 40, terrainSlopeDegrees))

export const createSlopeMaterial = () => {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.emissiveNode = slopeHighlight
  return material
}
```

The library owns `positionNode` and `normalNode` (the globe-to-map morph and exaggeration; a factory's own
`normalNode` is kept but no longer turns with the morph) and, with `fade` on
(the default), `outputNode` (tile cross-fades). It takes over `colorNode` once the tile is set up, keeping the
factory's node under the imagery.

### Debug tile boundaries

```ts
import { MeshStandardNodeMaterial } from 'three/webgpu'

export const createWireframeMaterial = () => new MeshStandardNodeMaterial({ wireframe: true, roughness: 1 })
```

## Common Mistakes

### HIGH: Changing `colorNode` after the tile is loaded

The factory's `colorNode` is read once, when the tile is set up for imagery, and the imagery blend replaces
it from then on. Setting `material.colorNode` on a loaded tile's material is silently dropped. Build the
colour in the factory; for colours that change at runtime, read a `uniform` from the nodes and change its
`value`.

### MEDIUM: Expecting exaggerated slopes or elevations

`terrainElevationMeters` and `terrainSlopeDegrees` describe the ground as loaded. With `<Terrain exaggeration={2}>`
a 30° slope still reads 30, so colour bands stay true to the real terrain.

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
which stutters while panning. Build nodes once, assign them per material. This holds for `colorNode` too:
the imagery blend is cached per base node, so a new node per tile means a new shader per tile.

### MEDIUM: Moving vertices with `positionNode`

The library sets `positionNode` for the globe-to-map morph and exaggeration, and tile bounds, culling, raycasts
and `EarthControls` use the original geometry. Use `<Terrain exaggeration>` instead.

## Completion

- Tiles render with the custom look and imagery still drapes over them; without imagery the globe shows the
  material's own colour.
- Panning does not stutter more than with the default material (compare
  `earth.inspect().terrain.imageryMainThreadMilliseconds` and frame time).
