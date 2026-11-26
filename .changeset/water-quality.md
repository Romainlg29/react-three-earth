---
'@earthkit/water': minor
---

Water: a `quality` option for phones, read once. `'auto'` (the default) picks `'low'` on a touch screen and `'high'` otherwise (`detectWaterQuality`). Low simulates the waves at 128 texels a side instead of 256 and steps them every other frame, lays the mesh with 32 cells a ring instead of 48 (about 66 000 triangles instead of 146 000, same reach), and leaves out the close-up ripples, the sun's glitter and the foam's cells (`WATER_QUALITY_LEVELS`). `WaveSurface` takes `computeGridSize`, `detail` and `framesPerSimulationStep`; the mesh's innermost cell now follows its resolution.
