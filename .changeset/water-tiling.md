---
'@earthkit/water': patch
---

The GPU simulates 256 texels a side per cascade (`WAVE_COMPUTE_GRID_SIZE`), so the waves near the camera come from longer tiles and the tiling no longer shows; the CPU path keeps 64. The seafloor (`depthFromElevation`) no longer shows where the elevation model holds no depth (sea filled at 0 m), which drew sand rectangles off coasts.
