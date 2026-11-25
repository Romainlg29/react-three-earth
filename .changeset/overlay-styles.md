---
'@earthkit/globe': minor
---

CSS hooks renamed from `react-three-earth-*` to `earthkit-*` (classes and CSS variables). The library now finds markers,
popups and controls by data attributes (`data-earthkit-marker`, `-popup`, `-markers`, `-controls`), so `Controls` has
no class of its own and `CONTROLS_CLASS_NAME` is replaced by `CONTROLS_ATTRIBUTE`. New `defaultOverlayStyles: false`
on the Earth (and `<Earth>`) turns off the built-in marker and popup look for apps that bring their own CSS.
