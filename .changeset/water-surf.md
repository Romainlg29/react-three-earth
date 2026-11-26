---
'@earthkit/water': minor
---

Surf near the shore: on the wave mesh, a train of waves runs straight at the nearest shore, shortens and steepens over
the shallows and breaks with foam at 0.78 of the depth. New settings `surfHeightMeters` (default 0.6 of the wind sea's
significant wave height, 0 for none) and `surfPeriodSeconds` (default the wind sea's peak period). Without depth data
the wind's waves now also calm towards the shore, over a gently sloping beach. The depth cache keeps the distance and
direction to the nearest shore (`WaveDepthCache.sampleShore`). New exports: `peakPeriodSeconds`, `deepWavenumber`,
`shallowWavenumber`, `shoalingCoefficient`, `surfPhase` and the `SURF_*` constants.
