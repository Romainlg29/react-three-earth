---
'@earthkit/water': patch
---

The sea mesh no longer floats in a plateau metres above the sea near coasts, with stretched walls where two shores met.
Its level now comes from the terrain's own water level (`terrainWaterLevelMeters`: sea level on a raster DEM, the drawn
height under a quantized mesh's mask), taken only from flat water and spread from the nearest flat water to the coast.
On a flattened Terrarium sea the old rule kept only the coast's climbing triangles, 4 to 11 m up at Étretat. The level is
stored over sea level rather than over the wave plane, so its half floats keep millimetres instead of up to 12 cm. Land
within half a cache texel of the coast is no longer cut away under the mesh.
