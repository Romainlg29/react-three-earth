# Third-party notices

react-three-earth depends on, and in places adapts code from, the projects below.

## 3DTilesRendererJS

- Project: https://github.com/NASA-AMMOS/3DTilesRendererJS (npm `3d-tiles-renderer`)
- License: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
- Used as a dependency. The tile plugins in `packages/react-three-earth/src/tiles/` follow the
  structure and behaviour of its `ImageOverlayPlugin`, `TilesFadePlugin` and
  `TileMaterialReplacementPlugin`, rewritten for TSL node materials.

## three-geospatial (takram)

- Project: https://github.com/takram-design-engineering/three-geospatial
  (npm `@takram/three-atmosphere`, `@takram/three-geospatial`)
- License: MIT, Copyright (c) takram design engineering
- Used as a dependency, with two small patches in `patches/` for three r185+. The files in
  `packages/react-three-earth/src/tiles/` and `src/core/EarthControls.ts` adapt the TSL ports of
  the 3DTilesRenderer plugins from its `storybook-webgpu` package. Each adapted file says so in its header.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions: The above copyright notice and this
> permission notice shall be included in all copies or substantial portions of the Software.
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
