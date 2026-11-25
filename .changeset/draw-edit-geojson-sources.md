---
'@earthkit/draw': minor
'@earthkit/globe': minor
---

`draw.setSource(geoJsonSource)` (or `new Draw({ source })`) edits a GeoJSON source in place: Draw holds the source's own
features, with no second copy, writes each change back with `updateData` on release, and hides the feature it edits from
the source's tiles meanwhile. New `GeoJsonSource.setHiddenFeatureIds`: leaves features out of the tiles while they stay
in the data, redrawing only around them, with no tiling again. A tap in the select mode now projects only the features
near it, so selecting stays fast in large data sets.
