---
'@earthkit/globe': minor
---

`GeoJsonSource.updateData` on an unclustered source no longer cuts the whole source again in the tile worker: the
features changed since the last full cut are cut on their own, in a second index drawn over the first, and the whole
data is cut again once the changed and removed features pass an eighth of it (and 256). One feature changed in 50,000
polygons now takes under a millisecond in the worker instead of about 300 ms. Changed features draw above the others
until the next full cut; with `generateId` they keep their ids, and new ones get ids after the base's.
