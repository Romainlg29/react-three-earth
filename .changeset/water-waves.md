---
'@earthkit/water': minor
---

Waves: the physical presets draw an FFT ocean near the camera. A JONSWAP spectrum from the wind (`windSpeedMetersPerSecond`, new `windDirectionDegrees` and `fetchKilometers`) with gravity-capillary dispersion from the water (new `temperatureCelsius`, and salinity, through density and surface tension) shapes four tiles (800 m, 110 m, 15 m, 2.1 m) simulated on the CPU every frame while the camera is below 30 km and off the flat map and laid on a plane under the camera with 64-bit offsets. They tilt the sea's normal and fade out where too small to draw, the roughness taking their slopes back, so the glint stays right at every distance. `waves: false` turns them off; `state.significantWaveHeightMeters` reports the sea state. New exports: `WaveField`, `WaveSurface`, the spectrum functions.
