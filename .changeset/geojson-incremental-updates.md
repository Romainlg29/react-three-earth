---
'@earthkit/globe': minor
---

`GeoJsonSource.updateData` no longer cuts the whole source again in the tile worker: the changed features are cut on
their own, in a second index drawn over the first, and the whole data is cut again only once the changes reach an eighth
of it. One feature changed in 50,000 polygons now takes under a millisecond in the worker instead of about 300 ms. Changed
features draw above the others, and with `generateId` they get ids after the base's.
