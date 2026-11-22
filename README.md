# react-three-earth

A WebGPU map engine for three.js and React Three Fiber v10: a 3D globe with terrain, imagery and a
physically based atmosphere, plus a 2D view (planned). Built to be easy to extend and easy for agents to drive.

> Status: spike. See [docs/spike/SPIKE.md](docs/spike/SPIKE.md) for what works and what was measured.

```tsx
import { Canvas } from '@react-three/fiber'
import { Atmosphere, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain } from 'react-three-earth/react'

export function App() {
  return (
    <Canvas>
      <Earth>
        <Terrain>
          <QuantizedMeshSource url="https://terrain.reearth.land/cesium-mesh/ellipsoid/" />
        </Terrain>
        <Imagery>
          <RasterTileSource url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        </Imagery>
        <Atmosphere />
        <EarthControls />
      </Earth>
    </Canvas>
  )
}
```

Vanilla three.js uses the same names from `react-three-earth`: `new Earth()`, `new Terrain({ sources })`,
and so on. Units are SI and spelled out in names (`heightMeters`, `memoryBudgetBytes`).

## Develop

```sh
pnpm install
pnpm dev                     # playground on http://localhost:5173
pnpm test                    # unit tests
xvfb-run -a node apps/playground/tests/run.mjs   # WebGPU browser checks (needs pnpm dev running)
```

Copy `apps/playground/.env.example` to `.env` to point the playground at your own terrain, imagery or
map style. `.env` is git-ignored. Add `?fixtures` to the URL for offline synthetic tiles.

## License

MIT. Third-party code and dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
