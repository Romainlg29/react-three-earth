---
'@earthkit/draw': minor
---

Extrude goes further in edit mode, as Blender's E: a line becomes a wall (pick any of it, A then E), picked edges grow
faces straight up (a wall's top edges stack another storey), several faces extrude together as one region, and every
edge or vertex of a face picked picks the face. What extrude made stays picked, with the move gizmo over it. New:
`extrudeMeshFaces`, `extrudeMeshEdges`.
