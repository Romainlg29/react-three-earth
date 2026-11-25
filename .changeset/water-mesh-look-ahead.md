---
'@earthkit/water': minor
---

Water: the sea mesh puts its detail where the camera looks and goes finer at the water. Its rings centre ahead of the camera along the view (`lookAhead`: half the way to where the view meets the sea, at most four camera heights), so the finest lie in view rather than under and behind it, still snapping to their cells. Two more rings (`WAVE_MESH_LEVELS` 10) take the innermost cell down to 1.6 cm right at the water (`WAVE_MESH_MINIMUM_CELL_METERS`), where the short chop becomes geometry, with the same reach; about 146 000 triangles instead of 118 000.
