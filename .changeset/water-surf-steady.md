---
'@earthkit/water': patch
---

Steadier sea near the camera: the wind's waves no longer calm by the distance to the shore without depth data (the
shore map is redrawn as the camera moves, and the open sea changed with it); the surf's crests take their phase per
pixel from the shore map instead of across the mesh's triangles (no more sawtooth, stretched crests), and fade out
where the shore map is too coarse to place them.
