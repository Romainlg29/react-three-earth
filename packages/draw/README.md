# @earthkit/draw

Headless drawing and editing for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth): points, line
strings, polygons and shapes on the globe and the flat map, as GeoJSON. It is a plugin built only on the library's
public API, and it ships no UI: your app draws the toolbar.

```sh
pnpm add @earthkit/draw @earthkit/globe three@0.187.0
```

```tsx no-check
import { Draw } from '@earthkit/draw'
import { Earth } from '@earthkit/globe/react'

const draw = new Draw()
const plugins = [draw]

function App() {
  return <Earth plugins={plugins}>{/* sources and layers */}</Earth>
}
```

Vanilla three.js: `earth.addPlugin(new Draw())`.

## Agent skills

The package ships skills for coding agents in `skills/`:

| Skill | Use when |
| --- | --- |
| `@earthkit/draw#draw-features` | an app lets users draw points, lines, polygons and shapes on the map |
| `@earthkit/draw#edit-shapes` | users must reshape what they drew: vertices, push and pull, extrude |

Load one with `npx @tanstack/intent@latest load @earthkit/draw#draw-features`.

## License

MIT
