---
'@earthkit/globe': minor
---

Terrain shadings: plugins change how the terrain is shaded above the imagery with `context.registerTerrainShading({ name, order, shade })` (or `earth.terrainShadings.register`). Each shading reads the material's colour, roughness, metalness, normal and emission as the shadings before it left them and returns the slots it changes, so a plugin's look composes with `createMaterial`, terrain styles and imagery. Registering or removing one rebuilds the loaded tiles' shaders without reloading them; `earth.inspect().terrainShadings` lists them. Split imagery tiles now keep the factory's colour node under the layers (a terrain style no longer falls back to the plain material colour on them).
