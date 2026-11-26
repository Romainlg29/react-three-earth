---
'@earthkit/water': minor
---

Water: four-point buoyancy. `water.createBuoyancy(hull)` (React: `useWaveBuoyancy`) floats a hull of `lengthMeters` by `beamMeters` at a heading on four probes at its corners and gives its `heightMeters`, `pitchRadians` and `rollRadians`, followed with a lag of `responseSeconds` (`WAVE_BUOYANCY_RESPONSE_SECONDS`, 0.35 s) so it rides the swell rather than every ripple; `draftMeters` sinks it to its waterline. `hullCorners` gives the corners.
