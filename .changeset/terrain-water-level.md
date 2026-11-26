---
'@earthkit/globe': minor
---

`terrainWaterLevelMeters`: a TSL node for the water's surface where `terrainWaterMask` says water, in metres above the
ellipsoid: the source's sea level for `RasterDemSource`, the terrain's height under a quantized mesh's mask. For
anything drawn on the water, as the terrain's drawn height is the seafloor's where the source draws it.
