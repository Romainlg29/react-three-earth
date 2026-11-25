---
'@earthkit/water': minor
---

Water: foam lasts. On the GPU each wave tile keeps the foam its breaking crests leave, fading over `WAVE_FOAM_LIFETIME_SECONDS` (4 s), so foam trails behind the waves that broke; crests breaking at once are `WAVE_BREAKING_SHARE` of the whitecap coverage, the rest is the foam they left. Near the camera the foam breaks into bubbly cells that open into a web as it thins.
