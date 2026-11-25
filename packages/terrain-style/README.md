# @earthkit/terrain-style

Stylised terrain for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth): colour the ground per pixel
by elevation, slope and aspect with MapLibre-style expressions, or pick a ready-made look. The globe looks finished
with no imagery, and imagery layers blend over the style when you add some.

```sh
pnpm add @earthkit/terrain-style @earthkit/globe three@0.187.0
```

```tsx no-check
import { Earth, RasterDemSource, Terrain } from '@earthkit/globe/react'
import { useTerrainStyle } from '@earthkit/terrain-style/react'

function App() {
  const createMaterial = useTerrainStyle({
    color: ['case', ['>', ['slope'], 30], '#8a8580', ['>=', ['elevation'], 3000], '#ffffff', '#4f7f45'],
  })
  return (
    <Earth>
      <Terrain createMaterial={createMaterial}>
        <RasterDemSource url="https://example.com/terrarium/{z}/{x}/{y}.png" encoding="terrarium" />
      </Terrain>
    </Earth>
  )
}
```

- Inputs: `['elevation']` (metres), `['slope']` (degrees), `['slope-percent']`, `['aspect']` (degrees from north).
- Operators: `step`, `interpolate`, `case`, comparisons, `all` / `any` / `!`, arithmetic, `rgb`.
- Presets: `alpine`, `atlas`, `desert`, `monochrome`, `slope-classes` (`TERRAIN_STYLE_PRESETS`).
- `evaluateTerrainExpression` computes the same colours on the CPU, for legends.

## Agent skill

`style-terrain` (in `skills/`): presets, the expression language, legends and common mistakes.

## License

MIT
