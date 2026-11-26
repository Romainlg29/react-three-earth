---
'@earthkit/water': patch
---

Water: the foam's bubbly cells and wind streaks come from a small tiling texture built once (`createFoamTexture`, 256² texels, shared), read in one lookup, instead of cellular and fractal noise worked out for every pixel. That noise cost about 70 % of the sea's frame: on a CPU renderer a frame of the storm drops from about 3 s to 0.9 s, and GPUs gain in proportion. The look is the same.
