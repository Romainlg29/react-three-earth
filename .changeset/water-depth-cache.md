---
'@earthkit/water': minor
'@earthkit/globe': minor
---

Water: the sea mesh reads the ground under it from a map of the terrain drawn from above (a depth cache), so it draws only over water and at the water's own level, the height of its nearest shore (found by a jump flood on the GPU): lakes below sea level, a terrain whose sea sits on the geoid or over a drawn seafloor, polders and low coasts come out right. Its waves flatten at the shore and, with `depthFromElevation`, calm where they would break in the shallows, with the seafloor showing through. Probes report the water's level and whether the point is on land (`onWater`).

Globe: `terrain.renderTiles(renderer, camera, target, material, clearColor)` draws the terrain's tiles alone with one node material, for a plugin's own view of the ground; tile meshes sit on `TERRAIN_LAYER`.
