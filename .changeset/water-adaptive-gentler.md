---
'@earthkit/water': patch
---

Water: `adaptiveQuality` is gentler. It only judges frames while the wave mesh is drawn, waits 10 s after a start or a change (shaders compile, tiles stream) and 5 s of slow frames before acting, and lowers high to low only, never to `'minimal'`: a busy GPU kept dropping to the level without a wave mesh, so the waves seemed gone. `'minimal'` is still picked for a software renderer under `quality: 'auto'`, or by choice (`water.setQuality('minimal')`).
