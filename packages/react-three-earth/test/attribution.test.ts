import { describe, expect, it } from 'vitest'

import { attributionText, AttributionTracker, collectAttributions, normalizeAttributions, parseAttribution, resolveCompact } from '../src/core/attribution.js'
import { Earth } from '../src/core/Earth.js'
import { Imagery } from '../src/core/Imagery.js'
import { Terrain } from '../src/core/Terrain.js'
import { MapStyleSource, QuantizedMeshSource, RasterTileSource, type ImagerySource } from '../src/core/sources.js'

const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

describe('collecting attribution', () => {
  it('trims, drops empties and de-duplicates, keeping first-seen order', () => {
    expect(normalizeAttributions(['  B ', 'A', '', '   ', 'B', 'A  \n'])).toEqual(['B', 'A'])
    expect(normalizeAttributions('one')).toEqual(['one'])
    expect(normalizeAttributions(undefined)).toEqual([])
    expect(normalizeAttributions('a   b')).toEqual(['a   b'])
    expect(normalizeAttributions(['a b', 'a   b'])).toEqual(['a b'])
  })

  it('collects from any provider in the order given', () => {
    const providers = [{ getAttributions: () => ['x', 'y'] }, { getAttributions: () => ['y', 'z'] }]
    expect(collectAttributions(providers)).toEqual(['x', 'y', 'z'])
  })

  it('returns terrain first, then imagery layers in the order added, without repeats', () => {
    const earth = new Earth()
    earth.addImagery(new Imagery({ sources: [new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png', attribution: 'Imagery one' })] }))
    earth.setTerrain(new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://t.test/', attribution: 'Terrain' })] }))
    earth.addImagery(
      new Imagery({
        sources: [
          new RasterTileSource({ url: 'https://b.test/{z}/{x}/{y}.png', attribution: ['Imagery two', 'Imagery one'] }),
          new RasterTileSource({ url: 'https://c.test/{z}/{x}/{y}.png' }),
        ],
      }),
    )
    expect(earth.getAttributions()).toEqual(['Terrain', 'Imagery one', 'Imagery two'])
  })

  it('works with any source that offers getAttributions (the plugin seam)', () => {
    const custom: ImagerySource = { kind: 'imagery', createOverlay: () => ({ opacity: 1 }), getAttributions: () => ['Custom data'] }
    const earth = new Earth()
    earth.addImagery(new Imagery({ sources: [custom, new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png' })] }))
    expect(earth.getAttributions()).toEqual(['Custom data'])
  })

  it('sources without attribution add nothing', () => {
    const earth = new Earth()
    earth.setTerrain(new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://t.test/' })] }))
    expect(earth.getAttributions()).toEqual([])
  })
})

describe('attributionchange', () => {
  it('fires when terrain or imagery is added or removed', () => {
    const earth = new Earth()
    let count = 0
    earth.addEventListener('attributionchange', () => count++)
    const imagery = new Imagery({ sources: [new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png', attribution: 'A' })] })
    earth.addImagery(imagery)
    expect(count).toBe(1)
    earth.removeImagery(imagery)
    expect(count).toBe(2)
    earth.setTerrain(new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://t.test/' })] }))
    expect(count).toBe(3)
    expect(earth.getAttributions()).toEqual([])
  })

  it('fires when a source changes its attribution, and stops after removal', () => {
    const earth = new Earth()
    const source = new RasterTileSource({ url: 'https://a.test/{z}/{x}/{y}.png', attribution: 'A' })
    const imagery = new Imagery({ sources: [source] })
    earth.addImagery(imagery)
    let count = 0
    earth.addEventListener('attributionchange', () => count++)
    source.setAttribution('B')
    expect(count).toBe(1)
    expect(earth.getAttributions()).toEqual(['B'])
    source.setAttribution('B') // unchanged
    expect(count).toBe(1)
    earth.removeImagery(imagery)
    count = 0
    source.setAttribution('C')
    expect(count).toBe(0)
  })

  it('fires when a style source finishes loading its metadata', () => {
    class Probe extends MapStyleSource {
      load(attribution: string[]) {
        this.setLoadedAttributions(attribution)
      }
    }
    const source = new Probe({ style: { version: 8, sources: {}, layers: [] }, attribution: 'Mine' })
    const earth = new Earth()
    earth.addImagery(new Imagery({ sources: [source] }))
    let count = 0
    earth.addEventListener('attributionchange', () => count++)
    source.load(['© Style', 'Mine'])
    expect(count).toBe(1)
    expect(earth.getAttributions()).toEqual(['Mine', '© Style'])
  })

  it('AttributionTracker keeps provided and loaded credits apart', () => {
    const tracker = new AttributionTracker('A')
    expect(tracker.getAttributions()).toEqual(['A'])
  })
})

describe('parseAttribution', () => {
  it('keeps plain text', () => {
    expect(parseAttribution('© Someone')).toEqual([{ text: '© Someone' }])
    expect(parseAttribution('')).toEqual([])
  })

  it('splits text and https links, in order', () => {
    expect(parseAttribution(OSM)).toEqual([
      { text: '© ' },
      { text: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
      { text: ' contributors' },
    ])
  })

  it('accepts http, single quotes and unquoted values, in any case', () => {
    expect(parseAttribution("<A HREF='http://a.test/x'>one</A>")).toEqual([{ text: 'one', href: 'http://a.test/x' }])
    expect(parseAttribution('<a href=https://a.test/y>two</a>')).toEqual([{ text: 'two', href: 'https://a.test/y' }])
  })

  it('drops script and style elements with their content', () => {
    expect(parseAttribution('Hi<script>alert(1)</script> there')).toEqual([{ text: 'Hi there' }])
    expect(parseAttribution('<style>a{color:red}</style>Text')).toEqual([{ text: 'Text' }])
    expect(parseAttribution('<SCRIPT type="x">1 < 2</SCRIPT>ok')).toEqual([{ text: 'ok' }])
    expect(parseAttribution('<iframe src="https://evil.test">inner</iframe>after')).toEqual([{ text: 'after' }])
  })

  it('refuses javascript:, data: and relative hrefs, keeping the text', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java&#9;script:alert(1)', 'java&#x0A;script:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.test/', '/relative', 'mailto:a@b.test', 'ftp://a.test/']) {
      expect(parseAttribution(`<a href="${href}">label</a>`), href).toEqual([{ text: 'label' }])
    }
    expect(parseAttribution('<a>no href</a>')).toEqual([{ text: 'no href' }])
  })

  it('strips every attribute except a safe href', () => {
    const segments = parseAttribution('<a href="https://a.test/" onclick="alert(1)" style="x" target="_self" onmouseover=alert(2)>go</a>')
    expect(segments).toEqual([{ text: 'go', href: 'https://a.test/' }])
    expect(parseAttribution('<b onclick="x">bold</b> <img src=x onerror=alert(1)>text')).toEqual([{ text: 'bold text' }])
  })

  it('flattens other tags to their text, nested or not', () => {
    expect(parseAttribution('<div><p>one <b>two <i>three</i></b></p></div>')).toEqual([{ text: 'one two three' }])
    expect(parseAttribution('<b><a href="https://a.test/">link <em>inside</em></a></b> out')).toEqual([{ text: 'link inside', href: 'https://a.test/' }, { text: ' out' }])
  })

  it('does not nest links: a new <a> ends the previous one', () => {
    expect(parseAttribution('<a href="https://a.test/">a<a href="https://b.test/">b</a>c</a>d')).toEqual([
      { text: 'a', href: 'https://a.test/' },
      { text: 'b', href: 'https://b.test/' },
      { text: 'cd' },
    ])
  })

  it('decodes entities into text, which stays text', () => {
    expect(parseAttribution('&copy; A &amp; B &lt;b&gt; &#169; &#xA9; &quot;q&quot; &apos;')).toEqual([{ text: '© A & B <b> © © "q" \'' }])
    // Decoded markup is not parsed again
    expect(parseAttribution('&lt;script&gt;alert(1)&lt;/script&gt;')).toEqual([{ text: '<script>alert(1)</script>' }])
    expect(parseAttribution('&unknown; &#0; &#x110000; &#xD800;')).toEqual([{ text: '&unknown; &#0; &#x110000; &#xD800;' }])
  })

  it('decodes entities in hrefs before checking them', () => {
    expect(parseAttribution('<a href="https://a.test/?x=1&amp;y=2">q</a>')).toEqual([{ text: 'q', href: 'https://a.test/?x=1&y=2' }])
    expect(parseAttribution('<a href="&#106;avascript:alert(1)">q</a>')).toEqual([{ text: 'q' }])
  })

  it('treats a stray "<", comments and unfinished tags as harmless text', () => {
    expect(parseAttribution('1 < 2 and 3 > 2')).toEqual([{ text: '1 < 2 and 3 > 2' }])
    expect(parseAttribution('a<!-- <a href="https://evil.test/">x</a> -->b')).toEqual([{ text: 'ab' }])
    expect(parseAttribution('a <a href="https://a.test/')[0]!.href).toBeUndefined()
    expect(parseAttribution('<scr<script>ipt>alert(1)</script>').every(segment => segment.href === undefined)).toBe(true)
  })

  it('handles quotes containing ">" inside attributes', () => {
    expect(parseAttribution('<a title="a > b" href="https://a.test/">x</a>')).toEqual([{ text: 'x', href: 'https://a.test/' }])
  })

  it('trims the ends and yields plain text', () => {
    expect(attributionText('  <a href="https://a.test/">A</a>, <b>B</b>  ')).toBe('A, B')
  })
})

describe('pathological input', () => {
  it('parses 100 KB of unclosed or nested tags in linear time', () => {
    const inputs = ['<a'.repeat(50_000), '<a href="'.repeat(11_000), "<a x='".repeat(16_000), '<a '.repeat(33_000), '<'.repeat(100_000), '<a href=x>'.repeat(10_000), '&#'.repeat(50_000)]
    for (const input of inputs) {
      const start = performance.now()
      parseAttribution(input)
      expect(performance.now() - start, input.slice(0, 12)).toBeLessThan(100)
    }
  })

  it('caps each attribution entry', () => {
    const [entry] = normalizeAttributions('x'.repeat(10_000))
    expect(entry!.length).toBe(2048)
  })
})

describe('resolveCompact', () => {
  it('follows the option when set, and the container width when automatic', () => {
    expect(resolveCompact(true, 2000)).toBe(true)
    expect(resolveCompact(false, 100)).toBe(false)
    expect(resolveCompact(undefined, 639)).toBe(true)
    expect(resolveCompact(undefined, 640)).toBe(false)
  })
})
