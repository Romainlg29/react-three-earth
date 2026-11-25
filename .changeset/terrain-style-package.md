---
'@earthkit/terrain-style': minor
---

New package: stylised terrain with no imagery. Colour the ground per pixel by elevation, slope and aspect with
MapLibre-style expressions (`step`, `interpolate`, `case`, comparisons, arithmetic) over `['elevation']`, `['slope']`,
`['slope-percent']` and `['aspect']`, or a preset (`alpine`, `atlas`, `desert`, `monochrome`, `slope-classes`).
`TerrainStyle`, `useTerrainStyle`, `compileTerrainColor` and `evaluateTerrainExpression` for legends.
