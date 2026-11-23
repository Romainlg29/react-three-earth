# Third-party notices

react-three-earth depends on, and in places adapts code from, the projects below.

## 3DTilesRendererJS

- Project: https://github.com/NASA-AMMOS/3DTilesRendererJS (npm `3d-tiles-renderer`)
- License: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
- Used as a dependency. The GPU imagery compositor in `src/tiles/imagery/` adapts its region
  composition code. The tile plugins in `packages/react-three-earth/src/tiles/` follow the
  structure and behaviour of its `ImageOverlayPlugin`, `TilesFadePlugin` and
  `TileMaterialReplacementPlugin`, rewritten for TSL node materials.

## Precomputed Atmospheric Scattering (Eric Bruneton)

- Project: https://github.com/ebruneton/precomputed_atmospheric_scattering
- License: BSD 3-Clause, Copyright (c) 2017 Eric Bruneton
- `packages/react-three-earth/src/atmosphere/AtmosphereModel.ts` and `precompute.ts` port its
  `functions.glsl` to TSL.

> Redistribution and use in source and binary forms, with or without modification, are permitted
> provided that the following conditions are met: 1. Redistributions of source code must retain the
> above copyright notice, this list of conditions and the following disclaimer. 2. Redistributions in
> binary form must reproduce the above copyright notice, this list of conditions and the following
> disclaimer in the documentation and/or other materials provided with the distribution. 3. Neither
> the name of the copyright holders nor the names of its contributors may be used to endorse or
> promote products derived from this software without specific prior written permission.
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
> IMPLIED WARRANTIES ARE DISCLAIMED.

## geojson-vt and supercluster

- Projects: https://github.com/mapbox/geojson-vt and https://github.com/mapbox/supercluster (npm `geojson-vt`,
  `supercluster`)
- License: ISC, Copyright (c) Mapbox
- Used as dependencies, in the vector tile worker (`src/vector/worker/geoJsonSource.ts`): GeoJSON tiling and point
  clustering.

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
> granted, provided that the above copyright notice and this permission notice appear in all copies.
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.

## MapLibre GL JS

- Project: https://github.com/maplibre/maplibre-gl-js
- License: BSD 3-Clause, Copyright (c) 2023 MapLibre contributors
- Not a dependency (its `@maplibre/maplibre-gl-style-spec` is). `src/vector/worker/geoJsonSource.ts` follows its
  GeoJSON worker source: option defaults scaled to the tile extent, and `clusterProperties` compiled into
  supercluster's `map` and `reduce`.

## three-geospatial (takram)

- Project: https://github.com/takram-design-engineering/three-geospatial
  (npm `@takram/three-atmosphere`, `@takram/three-geospatial`)
- License: MIT, Copyright (c) takram design engineering
- Not a dependency. The files in `packages/react-three-earth/src/tiles/` and `src/core/EarthControls.ts`
  adapt the TSL ports of the 3DTilesRenderer plugins from its `storybook-webgpu` package, and
  `src/atmosphere/` follows the structure of its TSL atmosphere. Each adapted file says so in its header.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions: The above copyright notice and this
> permission notice shall be included in all copies or substantial portions of the Software.
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
