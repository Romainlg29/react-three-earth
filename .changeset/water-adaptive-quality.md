---
'@earthkit/water': minor
---

Water: a `'minimal'` quality level for devices without a GPU (64 texels simulated every third frame, no wave mesh), picked by `quality: 'auto'` when the first frame shows a software renderer (`isSoftwareRenderer`: SwiftShader, llvmpipe, Microsoft's Basic Render Driver, a fallback adapter). New `adaptiveQuality` option (default true): while frames average slower than 30 a second for 2 s, the quality steps down a level (high, low, minimal) and the console says so. `water.quality` now reports the level drawn now, `water.setQuality(level)` changes it at run time, and `WaveSurface.setLevel` changes the simulation's size, pace and detail.
