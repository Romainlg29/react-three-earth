---
'@earthkit/water': patch
---

Less CPU per frame: the depth cache redraws for changed tiles at most once a second (`WAVE_DEPTH_CACHE_REFRESH_SECONDS`,
was four times a second). Each redraw draws every tile again, a few milliseconds of the frame, and tiles change nearly
every frame while the camera moves. A move of the mesh still redraws it at once.
