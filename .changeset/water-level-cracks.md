---
'@earthkit/water': patch
---

No more plateaus and lines in the sea near coasts: the water's level near a shore is now the lowest water drawn at or
above sea level within about a kilometre (it was 64 m), so a coarse terrain tile whose coastal triangles climb under
its water mask no longer lifts the sea into a step with a stretched wall; and the one-texel cracks between terrain
tiles of different detail are filled before the shore pass, so they no longer cut green lines out of the sea.
