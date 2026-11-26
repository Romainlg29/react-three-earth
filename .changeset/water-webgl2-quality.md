---
'@earthkit/water': minor
---

WebGL2 follows the quality level: the CPU's wave simulation is a quarter of the level's grid (64 texels a side at high, 32 at low and minimal, `cpuGridSizeFor`) and steps every `framesPerSimulationStep` frames, and `adaptiveQuality` judges the frame time there too. Each wave's random phase is now hashed from the seed and its wavenumber, so every quality level and device draws the same long waves for the same seed (the sea for a given seed changes once with this release).
