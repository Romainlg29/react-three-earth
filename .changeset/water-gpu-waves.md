---
'@earthkit/water': minor
'@earthkit/globe': minor
---

Water: under WebGPU the waves are simulated in compute shaders (`WaveComputeField`), at no CPU cost, and draw foam on the crests that break: the Jacobian of the choppy displacement, thresholded so the foam covers the whitecap share (Monahan) and giving way to an even pallor where the waves fade out. WebGL2 keeps the CPU simulation. `WaveField` now writes every cascade into one array texture (`field.texture`, `cascade.slopes`). Globe: `PluginFrame.renderer`, the renderer drawing the frame, for a plugin's own GPU work.
