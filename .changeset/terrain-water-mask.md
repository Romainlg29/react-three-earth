---
'@earthkit/globe': minor
'@earthkit/terrain-style': minor
---

Water on the terrain: `terrainWaterMask`, a TSL node that is 1 on sea and lakes and 0 on land, from the terrain source
(the quantized-mesh `watermask` extension, now kept instead of dropped, or heights at or below `RasterDemSource`'s new
`seaLevelMeters`). `RasterDemSource` gains `flattenBelowSeaLevel`, which draws bathymetry (Terrarium) at sea level while
`terrainElevationMeters` keeps the true depth. `QuantizedMeshSource` gains `waterMask` to skip the mask. Terrain style
expressions read the mask as `['water']`.
