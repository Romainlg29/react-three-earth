# @earthkit/draw

## 0.1.0

### Minor Changes

- 74f8a91: `draw.setSource(geoJsonSource)` (or `new Draw({ source })`) edits a GeoJSON source in place: Draw holds the source's own
  features, with no second copy, writes each change back with `updateData` on release, and hides the feature it edits from
  the source's tiles meanwhile. New `GeoJsonSource.setHiddenFeatureIds`: leaves features out of the tiles while they stay
  in the data, redrawing only around them, with no tiling again. A tap in the select mode now projects only the features
  near it, so selecting stays fast in large data sets.
- 09c98c6: Extrude goes further in edit mode, as Blender's E: a line becomes a wall (pick any of it, A then E), picked edges grow
  faces straight up (a wall's top edges stack another storey), several faces extrude together as one region, and every
  edge or vertex of a face picked picks the face. What extrude made stays picked, with the move gizmo over it. New:
  `extrudeMeshFaces`, `extrudeMeshEdges`.
- 143a0c3: Edit mode picks several elements, as in Blender: Shift+tap adds or removes one, A (`draw.selectAllElements()`) picks
  them all and Alt+A (`draw.clearElementSelection()`) none, and dragging a picked element moves every picked one. What is
  picked shows a move gizmo, so a single vertex of a line, polygon or solid moves straight up, east or north (also G then
  X, Y or Z). Delete removes every picked vertex of a line or polygon. New: `offsetVertices`, `state.pickedElementCount`.
- 8c6e8ee: First release under the `@earthkit` scope: `react-three-earth` is now `@earthkit/globe` (vanilla at the root,
  React at `@earthkit/globe/react`) and `react-three-earth-draw` is now `@earthkit/draw`.
