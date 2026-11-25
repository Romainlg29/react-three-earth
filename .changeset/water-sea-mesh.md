---
'@earthkit/water': minor
'@earthkit/globe': minor
---

Water: under WebGPU, a displaced sea mesh near the camera (geometry clipmaps, finest at the camera's feet, morphing between rings, flattening into the terrain's sea at its edge), moved by the waves' height and choppy displacement computed on the GPU (`waveMesh`, default true). Wave probes sample the sea as the mesh draws it, on the GPU with an asynchronous readback, to float a boat (`water.createProbe()`, `useWaveProbe` in React). The waves are seeded (`waveSeed`), and `waveSurface.timeSeconds` can be set to show the same sea on several WebGPU clients.

Globe: terrain shadings get a `mask` slot (`NodeMaterial.maskNode`), to discard the ground where a plugin draws geometry of its own.
