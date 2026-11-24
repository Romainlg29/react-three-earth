---
name: write-a-plugin
description: >
  Use when extending react-three-earth from a package or an app without forking it: writing an EarthPlugin,
  installing plugins with earth.addPlugin or <Earth plugins>, custom MapLibre style layer types drawn by a plugin
  (registerStyleLayerType: a shader over built-in fills, lines or circles, or a worker module with its own
  tessellation, glows, offscreen layers), screen effects composited with the atmosphere (registerRenderPass:
  bloom, vignette, grading, EarthRenderPipeline stages), layers drawn by plugin code draped above the imagery
  (registerDrapedLayer: a selection glow, a measurement buffer), placing 3D objects at a longitude and latitude
  that follow the globe-to-map morph (createGeographicAnchor), raymarched signed-distance (SDF) shapes that
  sort against terrain and take the atmosphere's haze, per-frame plugin code, label looks (registerSymbolEffect:
  see map-labels), or reading plugin state from earth.inspect().
metadata:
  purpose: 'Documents the plugin API (EarthPlugin, PluginContext, addPlugin / removePlugin, <Earth plugins>, usePlugin), custom style layer types (registerStyleLayerType, worker modules), render passes (registerRenderPass, EarthRenderPipeline), draped layers (registerDrapedLayer), pointer interactions (addPointerInteraction, holdDoubleClickZoom), GeographicAnchor and the scene helpers (createLocalCameraPositionNode, depthFromViewZ, createFlatMapEmissionNode), with the sdf-shapes, sdf-glow, striped-fill, vignette and selection-glow example plugins.'
  type: framework
  framework: 'react'
  library: 'react-three-earth'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/plugin.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/PluginManager.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/GeographicAnchor.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/PointerInteractions.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/sceneNodes.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/Earth.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/Earth.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/hooks.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/sdf/sdfShapes.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/sdf/distance.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/styleLayerTypes.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/pluginWorker.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/customLayerMaterials.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/vector/worker/customLayers.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/styleLayers/sdfGlow.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/styleLayers/sdfGlowWorker.js'
  - 'Romainlg29/react-three-earth:apps/playground/src/styleLayers/stripedFill.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/renderPasses.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/core/EarthRenderPipeline.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/react/RenderPipeline.tsx'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/plugins/drapedLayers.ts'
  - 'Romainlg29/react-three-earth:packages/react-three-earth/src/tiles/imagery/DrapedLayerOverlay.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/effects/vignette.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/effects/selectionGlow.ts'
requires:
  - getting-started
  - coordinates-and-units
---

# Write a plugin

Read `getting-started` and `coordinates-and-units` first. A plugin is a plain object with a `name`, the
`apiVersion` it was built for and an `install(context)` method. Everything it registers through the context
is undone when it is removed, so `earth.removePlugin(plugin)` leaves the earth as it was. The playground's
`apps/playground/src/sdf/` is a complete example: raymarched signed-distance shapes on the globe.

| You want | Use |
| --- | --- |
| Install for the whole map | `<Earth plugins={plugins}>` / `earth.addPlugin(plugin)` |
| Install from one component | `usePlugin(plugin)` |
| Code every frame | `context.onUpdate(frame => …)` |
| A new MapLibre layer `type` (look over built-in geometry) | `context.registerStyleLayerType({ type, geometry: 'line', paint, createMaterial })` |
| A new layer `type` with its own tessellation | `registerStyleLayerType({ type, worker: { moduleUrl, exportName }, … })` |
| A screen effect (bloom, vignette, grading) | `context.registerRenderPass({ name, stage, build })` |
| A layer you draw yourself, draped over the imagery | `context.registerDrapedLayer({ id, bounds, draw })` → `handle.invalidate(bounds)` |
| Dragging on the map without panning it (see `react-three-earth-draw#draw-features`) | `context.addPointerInteraction({ pointerDown, pointerMove, pointerUp })` |
| A 3D object at a place, also on the flat map | `earth.createGeographicAnchor(position)` + `context.addObject(anchor)` (disposed with the plugin) |
| A raymarched or depth-writing surface | `createLocalCameraPositionNode()`, `depthFromViewZ(viewZ)` |
| Keep colour on the flat map | `createFlatMapEmissionNode(colorNode, earth.view)` |
| Hold `idle` while loading | `context.trackLoading(promise)`, or an `async install` |
| Report state to agents | the plugin's `inspect()`, read in `earth.inspect().plugins` |

## Setup

```tsx
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { Earth } from 'react-three-earth/react'

const helloPlugin: EarthPlugin = {
  name: 'hello',
  apiVersion: PLUGIN_API_VERSION,
  install(context) {
    context.onUpdate(({ morph }) => {
      // Runs at the end of every earth.update, after the camera, the morph, the tiles and the sun.
      if (morph === 1) console.log('on the flat map')
    })
  },
}

const plugins = [helloPlugin] // module scope: the array is compared by identity

export function Map() {
  return <Earth plugins={plugins}>{/* <Terrain>, <Imagery>, <Atmosphere>… */}</Earth>
}
```

Vanilla: `earth.addPlugin(helloPlugin)`, `earth.removePlugin(helloPlugin)` (or its name). `earth.dispose()`
removes every plugin, last installed first.

## Core Patterns

### The context

```ts
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three'
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'

export function spinningBox(): EarthPlugin {
  let inspectedTurns = 0
  return {
    name: 'spinning-box',
    apiVersion: PLUGIN_API_VERSION,
    install(context) {
      const anchor = context.earth.createGeographicAnchor({ longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 4500 })
      const box = new Mesh(new BoxGeometry(400, 400, 400), new MeshStandardMaterial({ color: 'orange' }))
      anchor.add(box)
      context.addObject(anchor) // removed and disposed with the plugin
      context.onDispose(() => {
        box.geometry.dispose()
        box.material.dispose()
      })
      context.addEventListener('moveend', () => context.earth.requestFrame())
      context.onUpdate(({ deltaSeconds }) => {
        box.rotation.z += deltaSeconds
        inspectedTurns = box.rotation.z / (2 * Math.PI)
        return true // keeps asking for frames under frameloop="demand"
      })
    },
    inspect: () => ({ turns: Math.floor(inspectedTurns) }),
  }
}
```

- Every `context` call is recorded and undone in reverse order on removal; `addObject` also returns a function
  that removes the object early, and a `GeographicAnchor` it added is disposed (it stops following the morph).
  Calls after removal throw.
- `install` may be `async`: until it settles the plugin is `ready: false` and the earth does not fire `idle`. A
  rejection removes the plugin and fires the earth's `pluginerror` event.
- `onUpdate` time is measured per plugin (`earth.inspect().plugins[name].updateMilliseconds`). Over 1 ms on
  average, the plugin gets one console warning.
- `addPlugin` throws, stating the fix, when the plugin targets another `PLUGIN_API_VERSION` or another plugin
  with the same name is installed. Adding the same object twice does nothing.

### Objects that follow the flat map

The terrain does not move to a flat position: each vertex is blended in the shader between the globe and the
map by `earth.view.morph`. A `GeographicAnchor` does the same for an `Object3D`: `earth.update` moves, turns
and scales it every frame, so its children stay on their spot and keep their size against the terrain. Its
frame is east-north-up in metres (x east, y north, z up), turned by `headingDegrees` clockwise. On the flat map
it is drawn on the copy of the world nearest the camera.

```ts
import { Mesh, MeshStandardMaterial, SphereGeometry } from 'three'
import type { Earth } from 'react-three-earth'

export function addBall(earth: Earth) {
  const anchor = earth.createGeographicAnchor({ longitudeDegrees: 2.3522, latitudeDegrees: 48.8566, heightMeters: 500 }, { headingDegrees: 30 })
  anchor.add(new Mesh(new SphereGeometry(100), new MeshStandardMaterial({ color: 'tomato' })))
  earth.add(anchor)
  return () => anchor.dispose() // stops the updates and removes it
}
```

On the map the atmosphere's sun fades out, so lit objects turn dark. Add the flat terrain's emission:
`material.emissiveNode = createFlatMapEmissionNode(material.colorNode, earth.view)` on a node material.

### Raymarched (SDF) shapes

A signed-distance shape is a box mesh around it whose fragment shader sphere-traces the distance function and
writes the hit's real depth. Then terrain hides it, it hides terrain, and the atmosphere's aerial perspective
hazes it like everything else. Three rules keep it exact and cheap at planet scale:

1. **Small numbers only.** ECEF positions are millions of metres; 32-bit floats lose about half a metre there.
   Build the ray from `createLocalCameraPositionNode()` (the camera in the object's frame, computed in 64-bit
   on the CPU, per object) and `positionLocal`, never from world positions.
2. **Write depth with `depthFromViewZ(viewZ)`.** It matches the renderer (`reversedDepthBuffer: true`,
   logarithmic or standard) on WebGPU and the WebGL2 fallback. Compute the view-space hit as
   `positionView + (modelViewMatrix · vec4(hitLocal − positionLocal, 0)).xyz`, again only small numbers.
3. **Tight boxes, bounded steps.** Writing depth and discarding turn off early depth rejection, so every box
   pixel pays the march. Cap the steps, let the hit tolerance grow with range (one pixel's footprint), and
   share one material per distance function with per-object uniforms (`uniform(…).onObjectUpdate`).

```ts
import { createLocalCameraPositionNode, depthFromViewZ } from 'react-three-earth'
import { BackSide } from 'three'
import { Break, Discard, float, Fn, If, Loop, modelViewMatrix, positionLocal, positionView, vec4 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

/** A sphere of 100 m traced in a box of 2 × 2 × 2 local units scaled to 100 m (mesh.scale.setScalar(100)). */
export function createSphereMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ side: BackSide }) // back faces: works with the camera inside
  const halfSizeMeters = float(100)
  const camera = createLocalCameraPositionNode().mul(halfSizeMeters) // can be millions of metres away
  const exit = positionLocal.mul(halfSizeMeters) // where the ray leaves the box: small
  const towardsExit = exit.sub(camera)
  const cameraToExit = towardsExit.length()
  const direction = towardsExit.div(cameraToExit)
  const pixelAngleRadians = float(0.001) // fov / drawing-buffer height, as a uniform in real code
  const hit = Fn(() => {
    // March backwards from the exit point, so every position stays small (simplified: from 2 box widths back).
    const start = halfSizeMeters.mul(2).min(cameraToExit)
    const travelled = float(0).toVar()
    const found = float(0).toVar()
    Loop(64, () => {
      const point = exit.sub(direction.mul(start.sub(travelled)))
      const distance = point.length().sub(100)
      // One pixel's footprint at this range: far shapes converge in a few steps.
      If(distance.lessThan(pixelAngleRadians.mul(cameraToExit.sub(start).add(travelled)).max(1e-3)), () => {
        found.assign(1)
        Break()
      })
      travelled.addAssign(distance)
      If(travelled.greaterThan(start), () => Break())
    })
    If(found.equal(0), () => Discard())
    return exit.sub(direction.mul(start.sub(travelled)))
  })().toVar()
  const viewHit = positionView.add(modelViewMatrix.mul(vec4(hit.sub(exit).div(halfSizeMeters), 0)).xyz)
  material.depthNode = depthFromViewZ(viewHit.z)
  return material
}
```

The playground's `src/sdf/sdfShapes.ts` is the full version: box entry by the slab method, per-object size,
colour and step count, a tetrahedron gradient for `normalNode` (lit by the scene's `AtmosphereLight`), flat-map
emission, and `src/sdf/distance.ts` with `sphere`, `roundedBox`, `capsule`, `torus`, `union`, `smoothUnion`,
`subtract`, `translate`. Run it with `?fixtures&sdf`.

### Custom style layer types

A style layer whose `type` a plugin registers is drawn by it in every `MapStyleSource` of the earth, at its place
in the style, with its `filter`, zoom range and properties evaluated by the library (MapLibre expressions, `zoom`,
`feature-state`, `global-state`). The worker evaluates, the main thread only draws. A style layer whose type no
plugin provides is skipped with one warning; registering the type later draws it without refetching tiles, and
removing the plugin takes it away the same way.

**Material tier**: reuse the built-in `fill`, `line` or `circle` tessellation and bring only a shader. Each paint
property becomes a vertex attribute (at most 6); `geometryInput` feeds the tessellator (`line-width`,
`line-offset`, `line-cap`, `line-join`, `circle-radius`, in pixels).

```ts
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { fract, mix, step, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export const dashedRoads: EarthPlugin = {
  name: 'dashed-roads',
  apiVersion: PLUGIN_API_VERSION,
  install(context) {
    context.registerStyleLayerType({
      type: 'dashed-road',
      geometry: 'line',
      paint: {
        'dashed-road-color': { type: 'color', default: '#ffcc00' },
        'dashed-road-width-pixels': { type: 'number', default: 3, geometryInput: 'line-width' },
      },
      createMaterial: ({ paint, tile }) => {
        const material = new MeshBasicNodeMaterial()
        // Diagonal bands 8 map pixels long: tile.position is in tile units, pixelsPerTileUnit turns it into pixels.
        const pixels = tile.position.x.add(tile.position.y).mul(tile.pixelsPerTileUnit)
        const color = paint.color('dashed-road-color') // linear RGB, straight alpha
        material.colorNode = mix(color, vec4(color.rgb.mul(0.4), color.a), step(0.5, fract(pixels.div(16))))
        return material
      },
    })
  },
}
// In the style: { "id": "roads-dashed", "type": "dashed-road", "source": "osm", "source-layer": "transportation", "paint": { "dashed-road-width-pixels": 4 } }
// Or in React: <StyleLayer id="roads-dashed" type="dashed-road" source="osm" sourceLayer="transportation" />
```

`createMaterial` runs once per type per source: one pipeline, whatever the number of layers and tiles. The library
sets blending, depth and sides, and clips the material to its tile; set `colorNode` (straight alpha).

**Geometry tier**: when the geometry itself is new (per-segment quads, splats), ship a worker module. It is
loaded into the vector tile worker with `import()`, so it must be self-contained (no bare imports; type-only
imports from `react-three-earth/plugin-worker` are fine). It gets the library's helpers through `host`, and
returns typed arrays that are transferred, not copied. `position` (2 floats, tile units 0 to 4096, y down) is
required; an attribute named after a paint property is what `paint.color(name)` / `paint.number(name)` reads;
other names must be shader identifiers, read with `attribute(name)`.

```ts no-check
// glowWorker.js, served as a file (Vite: new URL('./glowWorker.js', import.meta.url), and list the plugin in
// optimizeDeps.exclude when it ships in node_modules). A strict CSP needs its origin in worker-src/script-src.
/** @type {import('react-three-earth/plugin-worker').WorkerLayerTypeFactory} */
export const glow = host => ({
  createTileBuilder({ layer, zoom, unitsPerPixel }) {
    const positions = [], indices = []
    return {
      addFeature(feature, geometry) {
        const radius = host.clampReach(layer.evaluate('paint', 'glow-radius-pixels', zoom, feature)) * unitsPerPixel
        for (const ring of geometry) for (const point of ring) {
          const first = positions.length / 2
          positions.push(point.x - radius, point.y - radius, point.x + radius, point.y - radius, point.x + radius, point.y + radius, point.x - radius, point.y + radius)
          indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
        }
      },
      finish: () => (indices.length === 0 ? null : { attributes: { position: { array: Float32Array.from(positions), itemSize: 2 } }, indices: Uint32Array.from(indices) }),
    }
  },
})
```

Register it with `worker: { moduleUrl: new URL('./glowWorker.js', import.meta.url), exportName: 'glow' }`.

- **Reach.** A layer drawing past its features (a glow) sets `maximumReachPixels` (at most 512): neighbouring
  tiles that close are drawn too, the tile clip is dropped, and `host.clampReach` caps data-driven radii.
  Two tiles share a buffer of features, and both now draw it: use `offscreen: { blending: 'maximum' }`, or
  emit only the features `host.isInsideTile` owns. The material tier with reach requires `'maximum'`.
- **Offscreen layers.** `offscreen: { blending: 'maximum' }` draws the layer into its own half-float target first,
  so overlaps keep the strongest value instead of stacking, then composites it once at the layer's place;
  `'additive'` sums (densities; skip buffered features with `host.isInsideTile`, or neighbours count them
  twice). Write straight alpha in `colorNode` as always: the library premultiplies it into the target, and
  `composite({ layer })` turns the target texel into the drawn colour (default `vec4(layer.rgb / layer.a, layer.a)`).

The playground's `src/styleLayers/` has both tiers: `sdf-glow` (worker module, exact distance to each segment,
maximum blending) and `striped-fill`. Run them with `?fixtures&map=vector&glow`.

### Render passes

A render pass adds a screen effect to the earth's `EarthRenderPipeline`, which builds R3F's render pipeline
output in three stages:

| Stage | `color` it receives | For |
| --- | --- | --- |
| `scene` | the scene's colour, before the atmosphere | effects that should be hazed and lit like the ground |
| `radiance` | after aerial perspective and the sky, linear HDR (the scene colour without an atmosphere) | bloom, volumes with `createAerialPerspectiveAlongRay` |
| `display` | tone-mapped, in the output colour space | vignette, grading; the built-in FXAA runs last here |

```ts
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { screenUV, smoothstep, uniform, vec4 } from 'three/tsl'

export function screenEffects(): EarthPlugin {
  const strength = uniform(0.6) // change .value at runtime: no rebuild
  return {
    name: 'screen-effects',
    apiVersion: PLUGIN_API_VERSION,
    install(context) {
      context.registerRenderPass({
        name: 'bloom',
        stage: 'radiance',
        build: ({ color, disposeOnRebuild }) => {
          const glow = bloom(color, 0.4, 0.2, 1)
          disposeOnRebuild(glow) // it owns render targets
          return color.add(glow)
        },
      })
      context.registerRenderPass({
        name: 'vignette',
        stage: 'display',
        order: 0, // finite; lower runs first within the stage, ties in registration order; FXAA stays last
        build: ({ color }) => vec4(color.rgb.mul(smoothstep(0.35, 1, screenUV.sub(0.5).length().mul(Math.SQRT2)).mul(strength).oneMinus()), color.a),
      })
    },
  }
}
```

- `build({ color, depth, camera, scene, atmosphere, disposeOnRebuild })` returns the stage's new colour node (`scene`: what
  the scene pass draws, or null). It runs once per rebuild (a pass added or removed, the atmosphere or camera
  changed), never per frame: animate through uniforms, never by registering again. A build that throws is skipped.
- `color` is a texture node only for the first pass of the `scene` stage. After a fused pass it is a plain node:
  to sample neighbours (blur, edge detection), wrap it in `convertToTexture(color)` or `rtt(color)` from
  `three/tsl` and hand that to `disposeOnRebuild`, as the built-in FXAA does.
- Without `<Atmosphere>` or `<EarthRenderPipelineHost>` (both claim the pipeline), `<Earth>` hosts it itself
  while a pass is registered, so plain maps keep rendering the scene directly. An app with its own
  `useRenderPipeline` opts out with `<Earth renderPipeline={false}>` (or `useClaimRenderPipeline()` in that
  component), as with `<Atmosphere renderPipeline={false}>`: attach an `EarthRenderPipeline` there
  (atmosphere-and-sun skill) or the passes do not run.
- Cost: pure node passes are fused by three into the stage's fullscreen shader (`timing: 'fused'` in
  `earth.inspect().renderPasses`). Passes that own targets (`disposeOnRebuild`, FXAA) report `'unavailable'`:
  v1 has no GPU timestamp queries yet. Every pass costs fill rate on a phone; prefer one fused pass.

### Draped layers

A draped layer is drawn by plugin code onto terrain regions, above every `<Imagery>` layer (later layers above
earlier ones), through the imagery compositor's queue and per-frame budget. It is static: it redraws only on
`handle.invalidate(bounds)`.

```ts
import { PLUGIN_API_VERSION, type DrapedLayerHandle, type EarthPlugin, type GeographicBounds, type GeographicPosition } from 'react-three-earth'
import { Mesh, NoBlending, PlaneGeometry, Scene } from 'three'
import { smoothstep, uv, vec3, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export function selectionGlow(radiusDegrees = 0.03) {
  let selected: GeographicPosition | null = null
  let handle: DrapedLayerHandle | null = null
  const around = ({ longitudeDegrees: x, latitudeDegrees: y }: GeographicPosition): GeographicBounds => ({ westDegrees: x - radiusDegrees, southDegrees: y - radiusDegrees, eastDegrees: x + radiusDegrees, northDegrees: y + radiusDegrees })
  const material = new MeshBasicNodeMaterial({ blending: NoBlending }) // the region is cleared: write straight alpha as is
  material.colorNode = vec4(vec3(1, 0.17, 0.84), smoothstep(1, 0, uv().sub(0.5).length().mul(2)))
  const quad = new Mesh(new PlaneGeometry(1, 1), material)
  const scene = new Scene().add(quad)
  const plugin: EarthPlugin & { select(position: GeographicPosition | null): void } = {
    name: 'selection-glow',
    apiVersion: PLUGIN_API_VERSION,
    select(position) {
      if (selected !== null) handle?.invalidate(around(selected)) // where it was
      selected = position
      if (position !== null) handle?.invalidate(around(position)) // where it is now
    },
    install(context) {
      handle = context.registerDrapedLayer({
        id: 'selection-glow',
        bounds: () => (selected === null ? null : around(selected)), // regions outside get no texture, no draw
        draw: ({ renderer, region }) => {
          if (selected === null) return
          const centre = region.project(selected) // 64-bit, in the region's 0 to 1 space (y north)
          const corner = region.project({ longitudeDegrees: selected.longitudeDegrees + radiusDegrees, latitudeDegrees: selected.latitudeDegrees + radiusDegrees })
          quad.position.set(centre.x, centre.y, 0)
          quad.scale.set((corner.x - centre.x) * 2, (corner.y - centre.y) * 2, 1)
          quad.updateMatrixWorld()
          renderer.render(scene, region.camera) // the target is bound and cleared to transparent
        },
      })
      context.onDispose(() => void (handle = null)) // dispose quad and material in uninstall
    },
  }
  return plugin
}
```

- `region` gives `mercatorRange` (normalised Web Mercator, y north), `bounds` (degrees), `zoom` (MapLibre's),
  `resolutionPixels`, `camera` (spans the region's 0 to 1 space) and `project(position)`, computed in 64-bit so
  placement holds at street zooms. Place geometry with `project`, never with raw Mercator in a shader.
- `bounds` (static, a function, or null for nowhere; default everywhere) is read on each `invalidate`: regions
  outside hold a 1 × 1 transparent texture and are never drawn. Invalidate where the content was and where it is
  now; each region keeps its texture until the redraw replaces it.
- Translucent overlaps: `premultipliedAlpha: true`, drawing `rgb × alpha` blended `One, OneMinusSrcAlpha`. Regions drawn
  in one frame need their own vertex buffers (a new geometry per draw): a rewritten shared buffer draws the last one.
- Slots: imagery sources and draped layers share the terrain's 10 layer slots. Registering past them throws
  while a terrain is attached (layers added before it are logged and skipped when it attaches; remove an imagery source or a draped layer, or merge sources into one `MapStyleSource`).
- Cost: every terrain tile carries the layer whatever `bounds` says: a CPU pass for its UVs, one more varying
  and texture sample in its shader; tiles outside get a 1 × 1 texture and no draw. Registering or removing a
  layer recompiles every terrain material and rebuilds every loaded tile's UVs: register once at install,
  leave it in place (bounds null while idle) and change it with `invalidate`, which queues one compositor job
  per region inside the bounds. Animate with scene objects or render passes, not by invalidating every frame.
  `earth.inspect().drapedLayers` lists `regions` and `regionsDrawn`.

The playground's `src/effects/` has both: run `?fixtures&effects` and call
`window.effectPlugins.selectionGlow.select({ longitudeDegrees: -90, latitudeDegrees: 0 })`.

### Plugins that offer objects to React

React runs children's effects before their parent's, so a child component mounts before `<Earth plugins>`
has installed the plugin, and `useEarth().plugins.get(name)` finds nothing yet. Pass the plugin instance to
the components that use it (a prop or a context), and let its own methods (`plugin.add(shape)`) queue work until
`install` runs, as `sdfShapes()` and the playground's `<SdfShape plugin={…}>` do.

Create anchors and other per-earth objects in an effect or in the plugin, never in `useState` or `useMemo`:
under StrictMode the earth is disposed and reused once at mount, which stops every anchor made before it.

## Common Mistakes

### HIGH: A new plugins array every render

`<Earth plugins={[myPlugin()]}>` creates a new plugin each render: it is removed and installed again, and
whatever it built is lost. Create plugins at module scope or with `useState(() => myPlugin())`.

### HIGH: World positions in a raymarching shader

`cameraPosition` and `positionWorld` are ECEF metres: rays built from them shimmer by half a metre. Use
`createLocalCameraPositionNode()` and `positionLocal`.

### HIGH: Placing an object once with `toCartesian`

It stays on the globe while the terrain unrolls into the map. Use `earth.createGeographicAnchor` (or call
`anchor.update(earth.view)` yourself every frame for a `new GeographicAnchor`).

### HIGH: Bare imports in a worker module

`import { … } from 'three'` in a worker module fails in the vector tile worker (no import maps): the type is
skipped with a warning naming the URL. Use `host`, and bundle anything else into the module.

### HIGH: Animating a draped layer with `invalidate`

Each `invalidate` queues one redraw per region inside the bounds, under the compositor's budget: calling it
every frame starves imagery and still lags. Move animation into a render pass or a scene object.

### MEDIUM: Forgetting `uninstall` work, or heavy work in `onUpdate`

The context undoes what went through it; geometries, materials, textures and workers the plugin created itself need
`context.onDispose` or `uninstall`. `onUpdate` runs on the main thread every frame, inside the 60 fps budget on a
Pixel: move per-feature work to a worker or the GPU, and watch `updateMilliseconds` in `earth.inspect().plugins`.

## Completion

- `earth.inspect().plugins[name]` is listed with `ready: true`, and `earth.removePlugin(name)` leaves no object,
  listener or per-frame callback behind.
- Objects stay on their spot through `setView('2d')` and back, and keep their size against the terrain.
- A custom layer type draws at its place in the style on WebGPU and `forceWebGL`, appears when its plugin is
  installed after the style loaded, and leaves no warning but the one for types nobody provides.
- A render pass shows on WebGPU and `forceWebGL`, with and without `<Atmosphere>`, is listed `active` in
  `earth.inspect().renderPasses`, and removing its plugin restores the plain image.
- A draped layer draws above the imagery only inside its bounds (`regionsDrawn` well below `regions`), and an
  `invalidate` redraws only the regions around the change.
- A depth-writing shape is hidden where it is underground and hazed when far away; the WebGL2 fallback
  (`forceWebGL`) draws the same image.
