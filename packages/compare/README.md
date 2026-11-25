# @earthkit/compare

Headless swipe comparison for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth), like
maplibre-gl-compare: `before` imagery layers or map styles on one side of a line across the canvas, `after` layers on
the other, side by side or top and bottom. Both sides are one earth with one camera, drawn in one render; each layer is
clipped per pixel, so dragging the line costs nothing. It ships no UI: your app draws the slider's handle.

```sh
pnpm add @earthkit/compare @earthkit/globe three@0.187.0
```

```tsx no-check
import { Compare } from '@earthkit/compare'
import { useCompareHandle, useCompareImagery } from '@earthkit/compare/react'

const compare = new Compare()
const plugins = [compare]

function App() {
  const beforeRef = useCompareImagery(compare, 'before')
  const afterRef = useCompareImagery(compare, 'after')
  const handleRef = useCompareHandle(compare)
  return (
    <div style={{ position: 'relative', height: '100vh' }}>
      <Canvas>
        <Earth plugins={plugins}>
          <Imagery ref={beforeRef}>{/* streets */}</Imagery>
          <Imagery ref={afterRef}>{/* satellite */}</Imagery>
        </Earth>
      </Canvas>
      {/* .swiper { position: absolute; top: 0; bottom: 0; left: var(--compare-position) } */}
      <div ref={handleRef} className="swiper" />
    </div>
  )
}
```

Vanilla three.js: `earth.addPlugin(new Compare({ before: [streets], after: [satellite] }))`, then
`compare.attachHandle(element)`.

## Agent skills

The package ships skills for coding agents in `skills/`:

| Skill | Use when |
| --- | --- |
| `@earthkit/compare#compare-maps` | an app compares two imagery layers or map styles with a swipe slider |

Load one with `npx @tanstack/intent@latest load @earthkit/compare#compare-maps`.

## License

MIT
