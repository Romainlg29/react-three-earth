# @earthkit/terrain-style

## 0.1.0

### Minor Changes

- 4aca0a9: New package: stylised terrain with no imagery. Colour the ground per pixel by elevation, slope and aspect with
  MapLibre-style expressions (`step`, `interpolate`, `case`, comparisons, arithmetic) over `['elevation']`, `['slope']`,
  `['slope-percent']` and `['aspect']`, or a preset (`alpine`, `atlas`, `desert`, `monochrome`, `slope-classes`).
  `TerrainStyle`, `useTerrainStyle`, `compileTerrainColor` and `evaluateTerrainExpression` for legends.
- 8a6d2b2: Water on the terrain: `terrainWaterMask`, a TSL node that is 1 on sea and lakes and 0 on land, from the terrain source
  (the quantized-mesh `watermask` extension, now kept instead of dropped, or heights at or below `RasterDemSource`'s new
  `seaLevelMeters`). `RasterDemSource` gains `flattenBelowSeaLevel`, which draws bathymetry (Terrarium) at sea level while
  `terrainElevationMeters` keeps the true depth. `QuantizedMeshSource` gains `waterMask` to skip the mask. Terrain style
  expressions read the mask as `['water']`.
