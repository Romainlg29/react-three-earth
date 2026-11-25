---
'@earthkit/water': minor
---

Waves: the physical presets draw an FFT ocean near the camera. A JONSWAP spectrum from the wind (`windSpeedMetersPerSecond`, new `windDirectionDegrees` and `fetchKilometers`) with gravity-capillary dispersion from the water (new `temperatureCelsius`, and salinity, through density and surface tension) shapes three tiles (250 m, 37 m, 5.3 m) simulated on the CPU every frame and laid on a plane under the camera with 64-bit offsets. They tilt the sea's normal and fade out where too small to draw, the roughness taking their slopes back, so the glint stays right at every distance. `waves: false` turns them off; `state.significantWaveHeightMeters` reports the sea state. New exports: `WaveField`, `WaveSurface`, the spectrum functions.
