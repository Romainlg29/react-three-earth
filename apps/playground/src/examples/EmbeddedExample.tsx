import { Imagery, RasterTileSource } from '@earthkit/globe/react'

import { rasterAttribution, rasterTilesUrl } from './data'
import { ExampleShell } from './ExampleShell'

/**
 * `?example=embedded`: a map inside a scrolling article. Cooperative gestures (`<EarthControls cooperativeGestures>`)
 * let the page scroll past it: one finger or a plain wheel scrolls the page and a hint says how to move the map;
 * two fingers, or Ctrl / ⌘ with the wheel, move it. Once the map has focus, the keyboard moves it too.
 */
export function EmbeddedExample() {
  return (
    <main className="example-article">
      <a className="example-article-back" href={`${import.meta.env.BASE_URL}examples.html`}>
        ‹ All examples
      </a>
      <h1>A map in a scrolling page</h1>
      <p>
        Maps in articles have a classic problem: the reader scrolls down the page, the finger lands on the map, and the map pans instead of the page
        scrolling. Cooperative gestures fix it. On this page, scroll with one finger or a mouse wheel and the page moves; the map shows a hint instead.
      </p>
      <p>
        To move the map, use <strong>two fingers</strong> on a phone, or hold <kbd>Ctrl</kbd> (<kbd>⌘</kbd> on a Mac) while scrolling. Click or tab into the map to
        use the keyboard: arrows pan, <kbd>+</kbd> and <kbd>-</kbd> zoom, <kbd>Shift</kbd> with the arrows rotates and tilts.
      </p>
      <ExampleShell
        title="Mount Fuji"
        description=""
        showCard={false}
        className="example-embedded"
        controls={{ cooperativeGestures: true }}
        camera={{ longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: 45_000, headingDegrees: -30, pitchDegrees: -22 }}
      >
        <Imagery>
          <RasterTileSource url={rasterTilesUrl} levels={19} attribution={rasterAttribution} />
        </Imagery>
      </ExampleShell>
      <p>
        Mount Fuji rises 3,776 metres above the Pacific coast of Honshu, the highest mountain in Japan. Its near-symmetrical cone last erupted in 1707, during the
        Hōei eruption, which spread ash as far as Edo, a hundred kilometres away.
      </p>
      <p>
        The five lakes on its northern side, Kawaguchi, Yamanaka, Sai, Shōji and Motosu, formed when lava flows dammed the rivers. Scroll back up over the map: the
        page keeps scrolling.
      </p>
      <p className="example-article-spacer">Keep scrolling: the map stays put until you ask it to move.</p>
    </main>
  )
}
