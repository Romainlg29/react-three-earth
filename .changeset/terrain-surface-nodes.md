---
'@earthkit/globe': minor
---

Terrain materials can colour the ground by itself: new TSL nodes `terrainElevationMeters`, `terrainSlopeDegrees`,
`terrainSlopeRadians`, `terrainSlopePercent`, `terrainAspectDegrees`, `terrainAspectRadians` and
`terrainNormalEastNorthUp`, read from a `terrainSurface` attribute every terrain tile now carries. Imagery blends
over the `colorNode` a `createMaterial` factory sets instead of replacing it, so a globe with no imagery can have a
stylised look.
