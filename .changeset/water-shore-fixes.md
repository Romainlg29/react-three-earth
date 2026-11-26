---
'@earthkit/water': patch
---

Fix the sea mesh on real coastlines: each shore takes its level from the lowest water drawn at or above sea level
within four texels, so water no longer floats in patches over beaches whose triangles climb under the water mask; the
surf's dispersion no longer overflows to NaN (spikes) on GPUs whose `tanh` does for large arguments; the surf zone's
sand and distant foam are fainter.
