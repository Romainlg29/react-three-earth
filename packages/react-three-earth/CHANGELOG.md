# @earthkit/globe

## 0.1.0

### Minor Changes

- e45e667: The atmosphere's light now reflects the sky in glossy materials: below roughness 0.6 a surface mirrors the sky's
  radiance along its reflected direction (through the lighting model's indirect specular term, so Fresnel applies), and
  rougher surfaces get the even sky. A smooth sea turns blue overhead and pale towards the horizon. Matte materials skip
  the lookup; they gain only their small, previously missing specular share of the skylight. New:
  `AtmosphereContext.getSkyRadiance` for the sky's light along any direction from a point.
- bc47c3a: Camera limits: `<Earth cameraLimits>` and `earth.camera.setLimits` hold the camera within a minimum and maximum zoom,
  tilt and a box for the centre of the screen (MapLibre's `minZoom`, `maxZoom`, `minPitch`, `maxPitch`, `maxBounds`).
- 74f8a91: `draw.setSource(geoJsonSource)` (or `new Draw({ source })`) edits a GeoJSON source in place: Draw holds the source's own
  features, with no second copy, writes each change back with `updateData` on release, and hides the feature it edits from
  the source's tiles meanwhile. New `GeoJsonSource.setHiddenFeatureIds`: leaves features out of the tiles while they stay
  in the data, redrawing only around them, with no tiling again. A tap in the select mode now projects only the features
  near it, so selecting stays fast in large data sets.
- 8c6e8ee: First release under the `@earthkit` scope: `react-three-earth` is now `@earthkit/globe` (vanilla at the root,
  React at `@earthkit/globe/react`) and `react-three-earth-draw` is now `@earthkit/draw`.
- 26e6f3a: `GeoJsonSource.updateData` on an unclustered source no longer cuts the whole source again in the tile worker: the
  features changed since the last full cut are cut on their own, in a second index drawn over the first, and the whole
  data is cut again once the changed and removed features pass an eighth of it (and 256). One feature changed in 50,000
  polygons now takes under a millisecond in the worker instead of about 300 ms. Changed features draw above the others
  until the next full cut; with `generateId` they keep their ids, and new ones get ids after the base's.
- 12a1712: `Imagery.screenClip` (and `<Imagery screenClip>`): keep a layer, with a map style's labels and 3D buildings, to one side of a line across the canvas, for split and swipe views. `<Imagery ref>` gives the vanilla layer.
- f2e8e07: CSS hooks renamed from `react-three-earth-*` to `earthkit-*` (classes and CSS variables). The library now finds markers,
  popups and controls by data attributes (`data-earthkit-marker`, `-popup`, `-markers`, `-controls`), so `Controls` has
  no class of its own and `CONTROLS_CLASS_NAME` is replaced by `CONTROLS_ATTRIBUTE`. New `defaultOverlayStyles: false`
  on the Earth (and `<Earth>`) turns off the built-in marker and popup look for apps that bring their own CSS.
- bc47c3a: Map styles draw `fill-translate`, `line-translate` and `circle-translate` (queries follow them), the `fill-sort-key`,
  `line-sort-key` and `circle-sort-key` layout properties, and `line-blur` and `circle-blur`.
- 8fd8955: Terrain shadings: plugins change how the terrain is shaded above the imagery with `context.registerTerrainShading({ name, order, shade })` (or `earth.terrainShadings.register`). Each shading reads the material's colour, roughness, metalness, normal and emission as the shadings before it left them and returns the slots it changes, so a plugin's look composes with `createMaterial`, terrain styles and imagery. Registering or removing one rebuilds the loaded tiles' shaders without reloading them; `earth.inspect().terrainShadings` lists them.
- e09a9b4: Terrain materials can colour the ground by itself: new TSL nodes `terrainElevationMeters`, `terrainSlopeDegrees`,
  `terrainSlopeRadians`, `terrainSlopePercent`, `terrainAspectDegrees`, `terrainAspectRadians` and
  `terrainNormalEastNorthUp`, read from a `terrainSurface` attribute every terrain tile now carries. Imagery blends
  over the `colorNode` a `createMaterial` factory sets instead of replacing it, so a globe with no imagery can have a
  stylised look.
- be1d4d9: `terrainWaterLevelMeters`: a TSL node for the water's surface where `terrainWaterMask` says water, in metres above the
  ellipsoid: the source's sea level for `RasterDemSource`, the terrain's height under a quantized mesh's mask. For
  anything drawn on the water, as the terrain's drawn height is the seafloor's where the source draws it.
- 8a6d2b2: Water on the terrain: `terrainWaterMask`, a TSL node that is 1 on sea and lakes and 0 on land, from the terrain source
  (the quantized-mesh `watermask` extension, now kept instead of dropped, or heights at or below `RasterDemSource`'s new
  `seaLevelMeters`). `RasterDemSource` gains `flattenBelowSeaLevel`, which draws bathymetry (Terrarium) at sea level while
  `terrainElevationMeters` keeps the true depth. `QuantizedMeshSource` gains `waterMask` to skip the mask. Terrain style
  expressions read the mask as `['water']`.
- 52c976d: Water: the sea mesh reads the ground under it from a map of the terrain drawn from above (a depth cache), so it draws only over water and at the water's own level, the height of its nearest shore (found by a jump flood on the GPU): lakes below sea level, a terrain whose sea sits on the geoid or over a drawn seafloor, polders and low coasts come out right. Its waves flatten at the shore and, with `depthFromElevation`, calm where they would break in the shallows, with the seafloor showing through. Probes report the water's level and whether the point is on land (`onWater`).

  Globe: `terrain.renderTiles(renderer, camera, target, material, clearColor)` draws the terrain's tiles alone with one node material, for a plugin's own view of the ground; tile meshes sit on `TERRAIN_LAYER`.

- ce8ef3d: Water: under WebGPU the waves are simulated in compute shaders (`WaveComputeField`), at no CPU cost, and draw foam on the crests that break: the Jacobian of the choppy displacement, thresholded so the foam covers the whitecap share (Monahan) and giving way to an even pallor where the waves fade out. WebGL2 keeps the CPU simulation. `WaveField` now writes every cascade into one array texture (`field.texture`, `cascade.slopes`). Globe: `PluginFrame.renderer`, the renderer drawing the frame, for a plugin's own GPU work.
- c406142: New package `@earthkit/water`: a physically based sea as a plugin (`new Water()`, `<Water>` from `@earthkit/water/react`). Wherever the terrain is water, it shades over the imagery and terrain styles: the colour from the water's optics (seawater, phytoplankton and dissolved matter absorption and scattering, from `chlorophyllMilligramsPerCubicMeter` and `salinityPartsPerThousand`), the gloss from the wind after Cox & Munk (so under `<Atmosphere>` the sea mirrors the sky and the glint widens with the wind), whitecaps after Monahan, the seafloor through shallow water (`depthFromElevation`), and a map colour on the flat map. Presets: `map`, `calm`, `breeze`, `open-ocean`, `storm`, `coastal`. Settings update uniforms only.

  `@earthkit/globe` exports `terrainFlatMorph`, 0 on the globe and 1 on the flat map, for terrain shadings that fade to a map colour.

- f0208e1: Water: under WebGPU, a displaced sea mesh near the camera (geometry clipmaps, finest at the camera's feet, morphing between rings, flattening into the terrain's sea at its edge), moved by the waves' height and choppy displacement computed on the GPU (`waveMesh`, default true). Wave probes sample the sea as the mesh draws it, on the GPU with an asynchronous readback, to float a boat (`water.createProbe()`, `useWaveProbe` in React). The waves are seeded (`waveSeed`), and `waveSurface.timeSeconds` can be set to show the same sea on several WebGPU clients.

  Globe: terrain shadings get a `mask` slot (`NodeMaterial.maskNode`), to discard the ground where a plugin draws geometry of its own.

### Patch Changes

- be1177b: Fix an occasional crash in `earth:update` (a bare `Error` from `setRegionVisible`): 3DTilesRenderer's overlay plugin
  can report a tile hidden whose showing it never counted, and its overlay threw. The imagery, map style and draped
  overlays now drop that unmatched hide.
