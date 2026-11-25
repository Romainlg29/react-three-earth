---
'@earthkit/water': minor
---

Water: the wave mesh reflects with water's index of refraction (`WATER_INDEX_OF_REFRACTION`, 1.34) and glows where the atmosphere's sun shines through the crests towards the camera, turquoise from the water's optics: `computeWaterOptics` and `water.state` give the new `crestTransmittance` per band (sunlight scattered once through `WATER_CREST_THICKNESS_METERS` of water). The mesh's shading callback receives the view at each fragment (`WaveMeshView`: normal, direction to the camera, wave height) and may return an `emissive` colour.
