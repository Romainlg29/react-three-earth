import { describe, expect, it, vi } from 'vitest'

import { MapStyleSource } from '../src/core/sources.js'
import { bucketKey, MapStyleOverlay } from '../src/vector/MapStyleOverlay.js'
import { RefCountedCache } from '../src/vector/RefCountedCache.js'
import { GlyphAtlas, GlyphProvider, parseFontName, parseGlyphRange, type Glyph } from '../src/vector/worker/glyphs.js'
import { CollisionGrid, layoutLineLabels, shapeText, type ShapingOptions } from '../src/vector/worker/labels.js'
import { MapStyleProcessor, resolveTokens } from '../src/vector/worker/MapStyleProcessor.js'
import { ShapeBuilder, splitIntoDashes } from '../src/vector/worker/ShapeBuilder.js'
import { compileStyleLayers, toRgba } from '../src/vector/worker/styleLayers.js'
import { resolveTemplate } from '../src/vector/worker/tileSources.js'
import type { TileBucket } from '../src/vector/worker/types.js'
import { createFakeFetch, encodeGlyphRange, encodePMTiles } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

/** Area covered by a shape mesh's triangles (in tile units squared), counting overlaps twice. */
function triangleArea(positions: Float32Array, indices: Uint32Array, start = 0, count = indices.length): number {
  let area = 0
  for (let index = start; index < start + count; index += 3) {
    const [a, b, c] = [indices[index]!, indices[index + 1]!, indices[index + 2]!]
    const [ax, ay, bx, by, cx, cy] = [positions[a * 2]!, positions[a * 2 + 1]!, positions[b * 2]!, positions[b * 2 + 1]!, positions[c * 2]!, positions[c * 2 + 1]!]
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  return area
}

/** A fake local glyph: every character is a 10 × 14 box with a 12-pixel advance (spaces: no bitmap). */
const drawLocalGlyph = (_fontStack: string, codePoint: number): Glyph => ({
  id: codePoint,
  bitmap: codePoint === 32 ? null : new Uint8Array(16 * 20).fill(200),
  width: codePoint === 32 ? 0 : 10,
  height: codePoint === 32 ? 0 : 14,
  left: 1,
  top: -6,
  advance: 12,
})

const square = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]] as Array<[number, number]>

function testStyle(source: object) {
  return {
    version: 8,
    sources: { base: source, unused: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': ['interpolate', ['linear'], ['zoom'], 0, '#000000', 10, '#ffffff'] } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#0000ff', 'fill-opacity': 0.5 } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'primary'], paint: { 'line-color': '#ff0000', 'line-width': 4 } },
      { id: 'hillshade', type: 'hillshade', source: 'unused' },
      { id: 'places', type: 'symbol', source: 'base', 'source-layer': 'places', layout: { 'text-field': '{name}', 'text-size': 24 } },
    ],
  }
}

function testTile() {
  return encodeVectorTile([
    { name: 'water', features: [{ type: 'Polygon', geometry: [square(0, 2048)] }] },
    {
      name: 'roads',
      features: [
        { type: 'LineString', geometry: [[[0, 3000], [4096, 3000]]], properties: { class: 'primary' } },
        { type: 'LineString', geometry: [[[0, 3500], [4096, 3500]]], properties: { class: 'minor' } },
      ],
    },
    { name: 'places', features: [{ type: 'Point', geometry: [[[1000, 1000]]], properties: { name: 'Fuji' } }] },
  ])
}

describe('style layers', () => {
  it('compiles filters and properties, numbers source groups and skips unsupported layers', () => {
    const { layers, skipped } = compileStyleLayers(testStyle({ type: 'vector' }).layers)
    expect(layers.map(layer => layer.id)).toEqual(['background', 'water', 'roads', 'places'])
    expect(skipped).toEqual(['hillshade'])
    const roads = layers.find(layer => layer.id === 'roads')!
    expect(roads.accepts(10, { type: 2, properties: { class: 'primary' } })).toBe(true)
    expect(roads.accepts(10, { type: 2, properties: { class: 'minor' } })).toBe(false)
    expect(roads.evaluateColor('line-color', 10, undefined)).toEqual([255, 0, 0, 255])
    expect(layers.find(layer => layer.id === 'background')!.evaluateColor('background-color', 5, undefined)).toEqual([128, 128, 128, 255])
  })

  it('skips a layer with an invalid expression instead of failing its tiles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { layers, skipped } = compileStyleLayers([{ id: 'bad', type: 'line', source: 's', paint: { 'line-width': ['interpolate', ['linear'], ['zoom']] } }])
    expect(layers).toEqual([])
    expect(skipped).toEqual(['bad'])
    warn.mockRestore()
  })

  it('converts premultiplied style colours to straight-alpha bytes', () => {
    const { layers } = compileStyleLayers([{ id: 'fill', type: 'fill', source: 's', paint: { 'fill-color': 'rgba(255, 0, 0, 0.5)' } }])
    expect(layers[0]!.evaluateColor('fill-color', 0, undefined, 0.5)).toEqual([255, 0, 0, 64])
    expect(toRgba(undefined)).toEqual([0, 0, 0, 0])
  })

  it('resolves legacy {token} text fields', () => {
    expect(resolveTokens('{name} ({ref})', { name: 'Route', ref: 1 })).toBe('Route (1)')
    expect(resolveTokens('{missing}', {})).toBe('')
  })
})

describe('ShapeBuilder', () => {
  it('triangulates polygons with holes', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.setColor([1, 2, 3, 4])
    const hole = [{ x: 25, y: 25 }, { x: 25, y: 75 }, { x: 75, y: 75 }, { x: 75, y: 25 }]
    builder.addPolygons([[square(0, 100).map(([x, y]) => ({ x, y })), hole]])
    const mesh = builder.build()!
    expect(triangleArea(mesh.positions, mesh.indices)).toBeCloseTo(100 * 100 - 50 * 50)
    expect([...mesh.colors.subarray(0, 4)]).toEqual([1, 2, 3, 4])
  })

  it('strokes a straight line to its width, mitred corners without overlap', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], { width: 10 })
    let mesh = builder.build()!
    expect(triangleArea(mesh.positions, mesh.indices)).toBeCloseTo(1000)

    const corner = new ShapeBuilder()
    corner.setGroup(0)
    corner.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], { width: 10, join: 'miter' })
    mesh = corner.build()!
    // Two 100 × 10 bands meeting at a right angle, mitred: 2 × 1000 exactly.
    expect(triangleArea(mesh.positions, mesh.indices)).toBeCloseTo(2000)
  })

  it('adds round caps and splits dashes', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], { width: 10, cap: 'round' })
    const mesh = builder.build()!
    expect(triangleArea(mesh.positions, mesh.indices)).toBeGreaterThan(1000 + 0.9 * Math.PI * 25)
    const dashes = splitIntoDashes([{ x: 0, y: 0 }, { x: 100, y: 0 }], [10, 10])
    expect(dashes).toHaveLength(5)
    expect(dashes[1]).toEqual([{ x: 20, y: 0 }, { x: 30, y: 0 }])
  })

  it('extends square caps past the line ends', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addLine([{ x: 0, y: 0 }, { x: 10, y: 0 }], { width: 2, cap: 'square' })
    const { positions, indices } = builder.build()!
    expect(triangleArea(positions, indices)).toBeCloseTo(20 + 2 * 2)
    const xs = [...positions].filter((_, index) => index % 2 === 0)
    expect(Math.min(...xs)).toBeCloseTo(-1)
    expect(Math.max(...xs)).toBeCloseTo(11)
  })

  it('draws zero-length dashes with round caps as dots', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], { width: 4, cap: 'round', dashes: [0, 20] })
    const mesh = builder.build()!
    expect(triangleArea(mesh.positions, mesh.indices)).toBeGreaterThan(5 * 0.9 * Math.PI * 4)
  })

  it('fills round joins on the outer side only, around the line vertex, also with a gap', () => {
    const turn = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    const solid = new ShapeBuilder()
    solid.setGroup(0)
    solid.addLine(turn, { width: 10, join: 'round' })
    let mesh = solid.build()!
    // Two full 100 × 10 bands plus a quarter disc of radius 5 (polygonal, so slightly less).
    expect(triangleArea(mesh.positions, mesh.indices)).toBeGreaterThan(2000 + 0.95 * (Math.PI * 25) / 4)
    expect(triangleArea(mesh.positions, mesh.indices)).toBeLessThan(2000 + (Math.PI * 25) / 4 + 0.01)

    const casing = new ShapeBuilder()
    casing.setGroup(0)
    casing.addLine(turn, { width: 2, gapWidth: 10, join: 'round' })
    mesh = casing.build()!
    // The outer band (radii 5 to 7) gets a quarter annulus; the inner band none.
    const bands = 2 * 2 * 100 * 2
    expect(triangleArea(mesh.positions, mesh.indices)).toBeGreaterThan(bands + 0.95 * (Math.PI * (49 - 25)) / 4)
    expect(triangleArea(mesh.positions, mesh.indices)).toBeLessThan(bands + (Math.PI * (49 - 25)) / 4 + 0.01)
  })

  it('records draw groups for consecutive layers of a source', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addCircle({ x: 0, y: 0 }, 1)
    builder.setGroup(2)
    builder.addCircle({ x: 0, y: 0 }, 1)
    const { groups, indices } = builder.build()!
    expect(groups).toEqual([{ group: 0, start: 0, count: indices.length / 2 }, { group: 2, start: indices.length / 2, count: indices.length / 2 }])
  })
})

describe('glyphs', () => {
  it('decodes a glyph range PBF', () => {
    const glyphs = parseGlyphRange(encodeGlyphRange('Noto Sans Regular', '0-255', [{ id: 65, width: 12, height: 15, left: 1, top: -9, advance: 14 }, { id: 32, width: 0, height: 0, left: 0, top: 0, advance: 6 }]))
    expect(glyphs).toHaveLength(2)
    expect(glyphs[0]).toMatchObject({ id: 65, width: 12, height: 15, left: 1, top: -9, advance: 14 })
    expect(glyphs[0]!.bitmap).toHaveLength(18 * 21)
    expect(glyphs[1]).toMatchObject({ id: 32, bitmap: null, advance: 6 })
  })

  it('packs glyphs into an atlas that only grows, and reports what changed', () => {
    const atlas = new GlyphAtlas()
    const first = atlas.add(20, 30, new Uint8Array(600))!
    const second = atlas.add(20, 30, new Uint8Array(600))!
    expect(second.y).toBe(first.y)
    expect(second.x).toBeGreaterThan(first.x)
    for (let index = 0; index < 400; index++) atlas.add(40, 40, new Uint8Array(1600))
    expect(atlas.height).toBeGreaterThan(256)
    const update = atlas.takeUpdate()!
    expect(update.glyphs).toHaveLength(402)
    expect(update.height).toBe(atlas.height)
    expect(atlas.takeUpdate()).toBeNull()
  })

  it('takes glyphs from the server, falls back to local ones, and requests each range once', async () => {
    const { fetch, requests } = createFakeFetch({
      'https://glyphs.test/Noto%20Sans%20Regular/0-255.pbf': encodeGlyphRange('Noto Sans Regular', '0-255', [{ id: 65, width: 12, height: 15, left: 1, top: -9, advance: 14 }]),
    })
    const provider = new GlyphProvider({ glyphsUrl: 'https://glyphs.test/{fontstack}/{range}.pbf', requestHeaders: {}, localFontFamily: 'sans-serif', fetch, drawLocalGlyph })
    await Promise.all([provider.load('Noto Sans Regular', [65, 66]), provider.load('Noto Sans Regular', [65])])
    expect(provider.get('Noto Sans Regular', 65)).toMatchObject({ advance: 14 })
    expect(provider.get('Noto Sans Regular', 66)).toMatchObject({ advance: 12 }) // local
    expect(requests).toHaveLength(1)
  })

  it('reads weight and style from font names', () => {
    expect(parseFontName('Noto Sans Bold Italic,Arial Unicode MS Bold')).toEqual({ fontWeight: 'bold', fontStyle: 'italic' })
    expect(parseFontName('Open Sans Regular')).toEqual({ fontWeight: 'normal', fontStyle: 'normal' })
  })
})

describe('labels', () => {
  const lookup = (_fontStack: string, codePoint: number) => {
    const glyph = drawLocalGlyph('', codePoint)
    return { ...glyph, x: 0, y: 0 }
  }
  const options: ShapingOptions = { maximumWidthEms: 0, lineHeightEms: 1.2, letterSpacingEms: 0, anchor: 'center', justify: 'center' }

  it('centres a single line on its anchor', () => {
    const shaped = shapeText([{ text: 'ABCD', fontStack: 'f', scale: 1 }], options, lookup)!
    expect(shaped.glyphs).toHaveLength(4)
    expect(shaped.left).toBeCloseTo(-24)
    expect(shaped.right).toBeCloseTo(24)
  })

  it('wraps at spaces past the maximum width and aligns to the anchor', () => {
    const shaped = shapeText([{ text: 'AAAA BBBB CCCC', fontStack: 'f', scale: 1 }], { ...options, maximumWidthEms: 3, anchor: 'top-left' }, lookup)!
    expect(shaped.glyphs).toHaveLength(12)
    expect(shaped.left).toBeCloseTo(0)
    expect(shaped.top).toBeCloseTo(0)
    expect(shaped.bottom).toBeCloseTo(3 * 1.2 * 24)
  })

  it('places line labels along a line, upright, and not past its ends', () => {
    const shaped = shapeText([{ text: 'ROAD', fontStack: 'f', scale: 1 }], options, lookup)!
    const lineOptions = { pixelsToUnits: 8, spacingUnits: 2000, maximumAngleRadians: Math.PI / 4, keepUpright: true, paddingUnits: 0, center: false, extent: 4096 }
    const westward = layoutLineLabels(shaped, [{ x: 4000, y: 100 }, { x: 100, y: 100 }], lineOptions)
    expect(westward.length).toBeGreaterThan(0)
    const quads = westward[0]!.quads
    // Upright: reading order goes west to east even though the line runs east to west.
    expect(quads[0]!.corners[0].x).toBeLessThan(quads.at(-1)!.corners[0].x)
    expect(layoutLineLabels(shaped, [{ x: 0, y: 0 }, { x: 100, y: 0 }], lineOptions)).toEqual([])
  })

  it('detects overlapping label boxes', () => {
    const grid = new CollisionGrid()
    grid.insert([{ minimumX: 0, minimumY: 0, maximumX: 100, maximumY: 100 }])
    expect(grid.overlaps([{ minimumX: 50, minimumY: 50, maximumX: 150, maximumY: 150 }])).toBe(true)
    expect(grid.overlaps([{ minimumX: 600, minimumY: 0, maximumX: 700, maximumY: 100 }])).toBe(false)
  })
})

describe('MapStyleProcessor', () => {
  const baseUrl = 'https://maps.test/styles/style.json'

  it('tessellates a tile in style order, filters features and lays out labels', async () => {
    const { fetch, requests } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': testTile() })
    const processor = await MapStyleProcessor.create(
      { style: testStyle({ type: 'vector', tiles: ['../tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 }), baseUrl, requestHeaders: { authorization: 'token' }, localFontFamily: 'sans-serif' },
      { fetch, drawLocalGlyph },
    )
    expect(processor.summary.sources).toEqual([{ id: 'base', minimumZoom: 0, maximumZoom: 14 }])
    expect(processor.summary.skippedLayers).toEqual(['hillshade'])
    expect(processor.summary.backgroundByZoom[10]).toEqual([255, 255, 255, 255])

    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 })
    const shapes = bucket.shapes!
    expect(shapes.groups).toHaveLength(1)
    // Water: a 2048-unit square. Roads: only the primary one, 4 px = 32 units wide over 4096 units.
    expect(triangleArea(shapes.positions, shapes.indices)).toBeCloseTo(2048 * 2048 + 4096 * 32, -1)
    const firstColor = [...shapes.colors.subarray(0, 4)]
    expect(firstColor).toEqual([0, 0, 255, 128])
    expect(bucket.text!.indices.length).toBe(4 * 6) // "Fuji": four glyph quads
    expect(requests[0]!.headers).toEqual({ authorization: 'token' })
    expect(processor.takeAtlasUpdate()!.glyphs.length).toBe(4)
  })

  it('scales line widths with overzoom', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/14/1/2.pbf': testTile() })
    const style = testStyle({ type: 'vector', tiles: ['https://maps.test/tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 })
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    const native = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 14, zoom: 14 })
    const overzoomed = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 14, zoom: 16 })
    const roadArea = (bucket: TileBucket) => triangleArea(bucket.shapes!.positions, bucket.shapes!.indices) - 2048 * 2048
    expect(roadArea(overzoomed)).toBeCloseTo(roadArea(native) / 4, -1)
  })

  it('reads TileJSON and TMS sources, and treats missing tiles as empty', async () => {
    const { fetch, requests } = createFakeFetch({
      'https://maps.test/tiles.json': { tiles: ['https://maps.test/t/{z}/{x}/{y}.pbf'], minzoom: 2, maxzoom: 12, scheme: 'tms' },
    })
    const processor = await MapStyleProcessor.create({ style: testStyle({ type: 'vector', url: '/tiles.json' }), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    expect(processor.summary.sources[0]).toMatchObject({ minimumZoom: 2, maximumZoom: 12 })
    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 0, z: 2, zoom: 2 })
    expect(bucket).toMatchObject({ shapes: null, text: null })
    expect(requests.at(-1)!.url).toBe('https://maps.test/t/2/1/3.pbf') // TMS flips the row
  })

  it('reads PMTiles archives with range requests', async () => {
    const archive = encodePMTiles([{ z: 3, x: 4, y: 5, data: testTile() }], 0, 6)
    const { fetch, requests } = createFakeFetch({ 'https://maps.test/world.pmtiles': archive })
    const processor = await MapStyleProcessor.create(
      { style: testStyle({ type: 'vector', url: 'pmtiles://https://maps.test/world.pmtiles' }), baseUrl, requestHeaders: {}, localFontFamily: 'x' },
      { fetch, drawLocalGlyph },
    )
    expect(processor.summary.sources[0]).toMatchObject({ minimumZoom: 0, maximumZoom: 6 })
    const bucket = await processor.processTile({ sourceId: 'base', x: 4, y: 5, z: 3, zoom: 3 })
    expect(bucket.shapes).not.toBeNull()
    expect(requests.every(request => request.headers.range?.startsWith('bytes='))).toBe(true)
    expect(await processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 3, zoom: 3 })).toMatchObject({ shapes: null })
  })

  it('reads attribution from the style, TileJSON and PMTiles metadata, in the style\'s source order', async () => {
    const archive = encodePMTiles([{ z: 3, x: 4, y: 5, data: testTile() }], 0, 6, JSON.stringify({ attribution: '© Archive' }))
    const { fetch, requests } = createFakeFetch({
      'https://maps.test/tiles.json': { tiles: ['https://maps.test/t/{z}/{x}/{y}.pbf'], attribution: '© TileJSON' },
      'https://maps.test/world.pmtiles': archive,
    })
    const style = testStyle({ type: 'vector', url: '/tiles.json' }) as { sources: Record<string, object>; layers: Array<Record<string, unknown>> }
    style.sources = {
      first: { type: 'vector', url: 'pmtiles://https://maps.test/world.pmtiles' },
      second: { type: 'vector', url: '/tiles.json' },
      third: { type: 'vector', tiles: ['https://maps.test/x/{z}/{x}/{y}.pbf'], attribution: '© Inline' },
      overridden: { type: 'vector', url: '/tiles.json', attribution: '© Style wins' },
    }
    style.layers = ['first', 'second', 'third', 'overridden'].map(source => ({ id: `fill-${source}`, type: 'fill', source, 'source-layer': 'water', paint: {} }))
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    expect(processor.summary.attributions).toEqual(['© Archive', '© TileJSON', '© Inline', '© Style wins'])
    // the metadata block lies inside the first 16 KiB, so it is served from the header read: no extra request
    expect(requests.filter(request => request.url === 'https://maps.test/world.pmtiles')).toHaveLength(1)
  })

  it('credits only drawn sources, and skips the PMTiles metadata when the style has attribution', async () => {
    const archive = encodePMTiles([{ z: 3, x: 4, y: 5, data: testTile() }], 0, 6, JSON.stringify({ attribution: '© Archive' }))
    const { fetch, requests } = createFakeFetch({ 'https://maps.test/world.pmtiles': archive })
    const style = testStyle({ type: 'vector' }) as { sources: Record<string, object>; layers: Array<Record<string, unknown>> }
    style.sources = {
      used: { type: 'vector', url: 'pmtiles://https://maps.test/world.pmtiles', attribution: '© Style' },
      unused: { type: 'vector', tiles: ['https://maps.test/x/{z}/{x}/{y}.pbf'], attribution: '© Unused' },
      broken: { type: 'vector', url: '/missing.json', attribution: '© Broken' },
    }
    style.layers = ['used', 'broken'].map(source => ({ id: `fill-${source}`, type: 'fill', source, 'source-layer': 'water', paint: {} }))
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    expect(processor.summary.attributions).toEqual(['© Style'])
    // one request for the header and root directory, none for the metadata block
    expect(requests.filter(request => request.url === 'https://maps.test/world.pmtiles')).toHaveLength(1)
  })

  it('reads a replaced PMTiles archive again after invalidate', async () => {
    const files: Record<string, Uint8Array> = { 'https://maps.test/world.pmtiles': encodePMTiles([{ z: 3, x: 4, y: 5, data: testTile() }], 0, 6) }
    const { fetch } = createFakeFetch(files)
    const processor = await MapStyleProcessor.create(
      { style: testStyle({ type: 'vector', url: 'pmtiles://https://maps.test/world.pmtiles' }), baseUrl, requestHeaders: {}, localFontFamily: 'x' },
      { fetch, drawLocalGlyph },
    )
    expect(await processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 3, zoom: 3 })).toMatchObject({ shapes: null })
    files['https://maps.test/world.pmtiles'] = encodePMTiles([{ z: 3, x: 0, y: 0, data: testTile() }], 0, 6)
    processor.invalidate(null)
    expect((await processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 3, zoom: 3 })).shapes).not.toBeNull()
    expect(await processor.processTile({ sourceId: 'base', x: 4, y: 5, z: 3, zoom: 3 })).toMatchObject({ shapes: null })
  })

  it('keeps braces of URL templates when resolving them', () => {
    expect(resolveTemplate('/tiles/{z}/{x}/{y}.pbf', 'https://maps.test/a/style.json')).toBe('https://maps.test/tiles/{z}/{x}/{y}.pbf')
    expect(resolveTemplate('glyphs/{fontstack}/{range}.pbf', 'https://maps.test/a/style.json')).toBe('https://maps.test/a/glyphs/{fontstack}/{range}.pbf')
  })
})

describe('RefCountedCache', () => {
  it('loads once per key, keeps released values within the budget, and frees the rest', async () => {
    const load = vi.fn(async (key: string) => ({ key }))
    const dispose = vi.fn()
    const cache = new RefCountedCache({ load, dispose, getByteLength: () => 10, retainedBytes: 15 })
    await Promise.all([cache.lock('a'), cache.lock('a')])
    expect(load).toHaveBeenCalledTimes(1)
    cache.release('a')
    cache.release('a')
    expect(dispose).not.toHaveBeenCalled() // kept: 10 bytes of 15
    await cache.lock('a')
    expect(load).toHaveBeenCalledTimes(1) // reused
    await cache.lock('b')
    cache.release('a')
    cache.release('b')
    expect(dispose).toHaveBeenCalledWith({ key: 'a' }, 'a') // the oldest goes past the budget
    cache.dispose()
    expect(dispose).toHaveBeenCalledWith({ key: 'b' }, 'b')
  })

  it('aborts a load whose last lock goes before it finishes', async () => {
    let signal: AbortSignal | undefined
    const cache = new RefCountedCache<number>({
      load: (_key, loadSignal) => {
        signal = loadSignal
        return new Promise((_, reject) => loadSignal.addEventListener('abort', () => reject(loadSignal.reason)))
      },
      dispose: () => {},
    })
    const pending = cache.lock('a')
    cache.release('a')
    expect(signal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow()
    expect(cache.size).toBe(0)
  })
})

describe('MapStyleOverlay', () => {
  function overlayWithSource(maximumZoom: number) {
    const overlay = new MapStyleOverlay({ style: { version: 8, sources: {}, layers: [] }, baseUrl: 'https://maps.test/', createWorker: null })
    overlay.summary = { sources: [{ id: 'base', minimumZoom: 0, maximumZoom }], backgroundByZoom: [], skippedLayers: [], attributions: [] }
    return overlay as unknown as { calculateLevel(range: number[]): number; getRegionTiles(range: number[], level: number): Array<{ key: string; textOnly: boolean; column: number }> }
  }

  it('textures a 256-pixel region with the zoom whose 512-pixel tiles cover it', () => {
    const overlay = overlayWithSource(14)
    expect(overlay.calculateLevel([0, 0, 1, 1])).toBe(0)
    expect(overlay.calculateLevel([0, 0, 1 / 8, 1 / 8])).toBe(2)
    expect(overlay.calculateLevel([0, 0, 1 / 8, 1 / 16])).toBe(2) // the larger side decides
    expect(overlay.calculateLevel([0, 0, 1e-9, 1e-9])).toBe(20) // capped at maximumZoom
  })

  it('draws the covering tiles, and a ring of neighbours for labels only, wrapping at the antimeridian', () => {
    const overlay = overlayWithSource(14)
    // The north-west quarter-tile of level 1's tile (0, 0), at zoom 2: tile (0, 0) of level 2.
    const tiles = overlay.getRegionTiles([0, 0.75, 0.25, 1], 2)
    const covered = tiles.filter(tile => !tile.textOnly)
    expect(covered.map(tile => tile.key)).toEqual([bucketKey({ sourceId: 'base', x: 0, y: 0, z: 2, zoom: 2 })])
    const ring = tiles.filter(tile => tile.textOnly)
    expect(ring).toHaveLength(5) // no row above the north edge
    expect(ring.find(tile => tile.column === -1)?.key).toBe(bucketKey({ sourceId: 'base', x: 3, y: 0, z: 2, zoom: 2 }))
  })

  it('skips ring tiles that labels cannot reach from', () => {
    const overlay = overlayWithSource(2)
    // A zoom 6 region in the middle of tile (1, 1) of level 2, overzoomed 16×: labels reach 1/32 of that tile.
    const region = [0.37, 0.62, 0.38, 0.63]
    expect(overlay.getRegionTiles(region, 6).filter(tile => tile.textOnly)).toEqual([])
    expect(overlay.getRegionTiles(region, 2).filter(tile => tile.textOnly).length).toBeGreaterThan(0)
  })

  it('places the same tile at each wrapped column at zoom 0', () => {
    const overlay = overlayWithSource(14)
    const tiles = overlay.getRegionTiles([0, 0, 1, 1], 0)
    expect(tiles.map(tile => [tile.column, tile.textOnly])).toEqual([[0, false], [-1, true], [1, true]])
  })

  it('overzooms past the source maximum zoom', () => {
    const overlay = overlayWithSource(1)
    const tiles = overlay.getRegionTiles([0, 0.75, 0.25, 1], 3).filter(tile => !tile.textOnly)
    expect(tiles.map(tile => tile.key)).toEqual([bucketKey({ sourceId: 'base', x: 0, y: 0, z: 1, zoom: 3 })])
  })
})

describe('MapStyleSource', () => {
  it('needs exactly one of url and style', () => {
    expect(() => new MapStyleSource({})).toThrow(/either/)
    expect(() => new MapStyleSource({ url: 'a', style: {} })).toThrow(/either/)
    expect(new MapStyleSource({ url: 'https://maps.test/style.json' }).createOverlay({ opacity: 0.5 })).toBeInstanceOf(MapStyleOverlay)
  })
})
