---
'@earthkit/water': patch
---

`water.setQuality` now changes everything at run time: the wave mesh's resolution (its rings are laid again) and the
close-up detail (ripples, foam cells, glitter), which the shaders now branch on instead of leaving out when built. A
level picked with `setQuality` stays: it turns `adaptiveQuality` off, which could otherwise take it back down.
