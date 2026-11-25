---
'@earthkit/water': minor
'@earthkit/globe': minor
---

New package `@earthkit/water`: a physically based sea as a plugin (`new Water()`, `<Water>` from `@earthkit/water/react`). Wherever the terrain is water, it shades over the imagery and terrain styles: the colour from the water's optics (seawater, phytoplankton and dissolved matter absorption and scattering, from `chlorophyllMilligramsPerCubicMeter` and `salinityPartsPerThousand`), the gloss from the wind after Cox & Munk (so under `<Atmosphere>` the sea mirrors the sky and the glint widens with the wind), whitecaps after Monahan, the seafloor through shallow water (`depthFromElevation`), and a map colour on the flat map. Presets: `map`, `calm`, `breeze`, `open-ocean`, `storm`, `coastal`. Settings update uniforms only.

`@earthkit/globe` exports `terrainFlatMorph`, 0 on the globe and 1 on the flat map, for terrain shadings that fade to a map colour.
