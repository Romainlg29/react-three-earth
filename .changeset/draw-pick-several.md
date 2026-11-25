---
'@earthkit/draw': minor
---

Edit mode picks several elements, as in Blender: Shift+tap adds or removes one, A (`draw.selectAllElements()`) picks
them all and Alt+A (`draw.clearElementSelection()`) none, and dragging a picked element moves every picked one. What is
picked shows a move gizmo, so a single vertex of a line, polygon or solid moves straight up, east or north (also G then
X, Y or Z). Delete removes every picked vertex of a line or polygon. New: `offsetVertices`, `state.pickedElementCount`.
