# @earthkit/measure

Headless measuring for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth): distances along paths,
areas inside polygons and the terrain's elevation profile along a line, on the globe and the flat map. Lengths and
areas are geodesic on the WGS84 ellipsoid. It is a plugin built on [`@earthkit/draw`](../draw) and the library's
public API, and it ships no UI: your app shows the figures and draws the toolbar.

```sh
pnpm add @earthkit/measure @earthkit/draw @earthkit/globe three@0.187.0
```

```tsx no-check
import { Measure, formatLength } from '@earthkit/measure'
import { useMeasureState } from '@earthkit/measure/react'
import { Earth } from '@earthkit/globe/react'

const measure = new Measure()
const plugins = [measure]

function Readout() {
  const live = useMeasureState(measure, state => state.live)
  return live?.kind === 'distance' ? <output>{formatLength(live.lengthMeters)}</output> : null
}

function App() {
  return (
    <>
      <button onClick={() => measure.setMode('distance')}>Measure a distance</button>
      <Readout />
      <Earth plugins={plugins}>{/* sources and layers */}</Earth>
    </>
  )
}
```

Vanilla three.js: `earth.addPlugin(new Measure())`.

## Agent skills

The package ships a skill for coding agents in `skills/`:

| Skill | Use when |
| --- | --- |
| `@earthkit/measure#measure-distances-and-areas` | an app measures distances, areas or elevation profiles on the map, or needs geodesic maths |

Load it with `npx @tanstack/intent@latest load @earthkit/measure#measure-distances-and-areas`.

## License

MIT. Geodesics by [GeographicLib](https://geographiclib.sourceforge.io) (MIT).
