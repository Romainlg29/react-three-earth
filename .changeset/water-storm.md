---
'@earthkit/water': minor
---

Water: a storm that looks like one. From 8 m/s of wind the waves steepen (choppiness 1 to 1.3 by 20 m/s, `choppinessForWind`), the foam left behind lies in streaks along the wind, longer as it rises (`WAVE_FOAM_STREAK_STRETCH_PER_METER_PER_SECOND`), and from 15 m/s spume whitens the faces around the breaking crests. A new `cloudCover` setting (0 to 1; 0.9 in the `storm` preset, 0 in the others) dims the sun's glow through the crests, its glitter and the light under the waves. Presets gain a `cloudCover` value, and `WaterState` reports it.
