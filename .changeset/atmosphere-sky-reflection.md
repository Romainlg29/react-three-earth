---
'@earthkit/globe': minor
---

The atmosphere's light now reflects the sky in glossy materials: below roughness 0.6 a surface mirrors the sky's
radiance along its reflected direction (through the lighting model's indirect specular term, so Fresnel applies), and
rougher surfaces get the even sky. A smooth sea turns blue overhead and pale towards the horizon. Matte materials skip
the lookup; they gain only their small, previously missing specular share of the skylight. New:
`AtmosphereContext.getSkyRadiance` for the sky's light along any direction from a point.
