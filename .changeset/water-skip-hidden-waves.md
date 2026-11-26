---
'@earthkit/water': patch
---

Water: the terrain's fragments skip the waves wherever none can show: on land, on the flat map, under the wave mesh (which draws the sea there itself), with the waves off, and farther than the largest cascade reaches (beyond about 6 m a pixel). They used to sample every cascade, the close-up ripples and the foam for every terrain pixel and weigh it away. On a CPU renderer the sea with its waves off costs a third less, the full storm about 15 % less; a view over land gains the most. `WaveSurface.sampleWaves` takes an optional `where` condition, and `fragmentPlane()` gives a terrain fragment's place on the wave plane.
