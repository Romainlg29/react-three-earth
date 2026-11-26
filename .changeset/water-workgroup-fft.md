---
'@earthkit/water': patch
---

Water: the GPU's inverse FFTs run one dispatch per direction, each workgroup transforming a whole row or column in workgroup memory with barriers between the stages, instead of one dispatch per stage through the storage buffers. A frame's simulation is 4 dispatches instead of 18, reading and writing the buffers about twelve times less (8 KiB of workgroup memory at 256 texels), and encodes in a fraction of the CPU time (the plugin's update falls under 1 ms where it took 2.7 ms on a slow CPU). The waves are the same.
