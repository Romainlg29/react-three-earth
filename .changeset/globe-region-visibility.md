---
'@earthkit/globe': patch
---

Fix an occasional crash in `earth:update` (a bare `Error` from `setRegionVisible`): 3DTilesRenderer's overlay plugin
can report a tile hidden whose showing it never counted, and its overlay threw. The imagery, map style and draped
overlays now drop that unmatched hide.
