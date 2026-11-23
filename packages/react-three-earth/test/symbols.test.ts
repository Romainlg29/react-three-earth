import { describe, expect, it } from 'vitest'

import { bucketKey } from '../src/vector/MapStyleOverlay.js'
import { CollisionGrid, SymbolPlacement, type PlacementCandidate } from '../src/vector/symbols/SymbolPlacement.js'
import { SymbolStateTexture, SYMBOL_STATE_WIDTH } from '../src/vector/symbols/symbolMaterial.js'
import type { Glyph } from '../src/vector/worker/glyphs.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { SYMBOL_ALLOW_OVERLAP } from '../src/vector/worker/symbols.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

/** Every character is a 10 × 14 box with a 12-pixel advance (spaces: no bitmap), as in vector.test.ts. */
const drawLocalGlyph = (_fontStack: string, codePoint: number): Glyph => ({
  id: codePoint,
  bitmap: codePoint === 32 ? null : new Uint8Array(16 * 20).fill(200),
  width: codePoint === 32 ? 0 : 10,
  height: codePoint === 32 ? 0 : 14,
  left: 1,
  top: -6,
  advance: 12,
})

const baseUrl = 'https://maps.test/style.json'

function labelStyle() {
  return {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['https://maps.test/tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
    layers: [
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#ff0000', 'line-width': 2 } },
      { id: 'road-names', type: 'symbol', source: 'base', 'source-layer': 'roads', layout: { 'symbol-placement': 'line', 'text-field': '{name}', 'text-size': 12 } },
      {
        id: 'places',
        type: 'symbol',
        source: 'base',
        'source-layer': 'places',
        layout: {
          'text-field': '{name}',
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 11, 20],
          'text-padding': 3,
          'symbol-sort-key': ['get', 'rank'],
        },
        filter: ['!=', ['get', 'name'], 'Over'],
        paint: { 'text-color': '#102030', 'text-halo-color': '#ffffff', 'text-halo-width': 2, 'text-opacity': 0.5 },
      },
      {
        id: 'over',
        type: 'symbol',
        source: 'base',
        'source-layer': 'places',
        filter: ['==', ['get', 'name'], 'Over'],
        layout: { 'text-field': '{name}', 'text-size': 12, 'text-allow-overlap': true },
      },
    ],
  }
}

function labelTile() {
  return encodeVectorTile([
    { name: 'roads', features: [{ type: 'LineString', geometry: [[[0, 3000], [4096, 3000]]], properties: { name: 'Long Road Name' } }] },
    {
      name: 'places',
      features: [
        { type: 'Point', geometry: [[[1000, 1000]]], properties: { name: 'Fuji', rank: 2 } },
        { type: 'Point', geometry: [[[2000, 1000]]], properties: { name: 'Over', rank: 1 } },
        // Outside the tile: its neighbour lays it out.
        { type: 'Point', geometry: [[[4200, 1000]]], properties: { name: 'Elsewhere', rank: 1 } },
      ],
    },
  ])
}

describe('labels facing the viewer, in the worker', () => {
  it('lays out point labels around their anchor for symbol requests, with sizes at the tile zoom and the next', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })
    expect(bucket.shapes).toBeNull()
    expect(bucket.text).toBeNull()
    const symbols = bucket.symbols!
    expect(symbols.keys).toEqual(['places\u0000Fuji', 'over\u0000Over'])
    expect([...symbols.anchors]).toEqual([1000, 1000, 2000, 1000])
    expect([...symbols.sizes]).toEqual([12, 20, 12, 12])
    expect([...symbols.sortKeys]).toEqual([2, 0])
    expect([...symbols.paddings]).toEqual([3, 2])
    expect(symbols.flags[0]).toBe(0)
    expect(symbols.flags[1]).toBe(SYMBOL_ALLOW_OVERLAP)
    expect([...symbols.layerIndices]).toEqual([2, 3])
    // "Fuji": 4 glyphs of 12-pixel advances, centred on the anchor, in pixels of a 24 px font.
    const [left, top, right, bottom] = symbols.boxes.subarray(0, 4)
    expect(left).toBeCloseTo(-24)
    expect(right).toBeCloseTo(24)
    expect(top!).toBeLessThan(0)
    expect(bottom!).toBeGreaterThan(0)
    expect(symbols.indices.length).toBe((4 + 4) * 6)
    expect(symbols.labelIndices.length).toBe((4 + 4) * 4)
    expect(symbols.labelIndices[0]).toBe(0)
    expect(symbols.labelIndices.at(-1)).toBe(1)
    // text-opacity is baked into the colours; the halo width stays in pixels.
    expect([...symbols.colors.subarray(0, 4)]).toEqual([16, 32, 48, 128])
    expect(symbols.haloWidths[0]).toBe(2)
  })

  it('leaves point labels out of draped tiles, keeping line labels there', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const draped = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    const screen = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const request = { sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 }
    const glyphQuads = (indices: Uint32Array | undefined) => (indices?.length ?? 0) / 6
    const all = glyphQuads((await draped.processTile(request)).text?.indices)
    const linesOnly = glyphQuads((await screen.processTile(request)).text?.indices)
    expect(linesOnly).toBeGreaterThan(0)
    expect(all - linesOnly).toBe(4 + 4) // Fuji and Over
  })

  it('keys symbol tiles apart from draped tiles of the same coordinates', () => {
    const request = { sourceId: 'base', x: 1, y: 2, z: 10, zoom: 11 }
    expect(bucketKey({ ...request, symbols: true })).not.toBe(bucketKey(request))
    expect(bucketKey({ ...request, symbols: true })).toBe('s:11/10/1/2/base')
  })
})

function candidate(key: string, x: number, y: number, options: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    key,
    xPixels: x,
    yPixels: y,
    minimumXPixels: x - 20,
    minimumYPixels: y - 8,
    maximumXPixels: x + 20,
    maximumYPixels: y + 8,
    layerIndex: 0,
    sortKey: 0,
    allowOverlap: false,
    ignorePlacement: false,
    order: 0,
    fade: null,
    placed: false,
    match: null,
    ...options,
  }
}

describe('CollisionGrid', () => {
  it('finds boxes overlapping across cells, and none that only touch', () => {
    const grid = new CollisionGrid(64)
    grid.reset(500, 300)
    grid.insert(50, 50, 150, 80)
    expect(grid.hits(140, 70, 200, 90)).toBe(true)
    expect(grid.hits(150, 50, 200, 80)).toBe(false)
    // Boxes partly off the screen are clamped into the grid.
    grid.insert(-50, -50, 10, 10)
    expect(grid.hits(-10, -10, 0, 0)).toBe(true)
    grid.reset(500, 300)
    expect(grid.hits(140, 70, 200, 90)).toBe(false)
  })
})

describe('SymbolPlacement', () => {
  it('places top layers first, then by sort key, and hides what collides', () => {
    const placement = new SymbolPlacement()
    const low = candidate('a', 100, 100, { layerIndex: 1 })
    const high = candidate('b', 110, 100, { layerIndex: 2 })
    const sortedFirst = candidate('c', 300, 100, { sortKey: 1 })
    const sortedSecond = candidate('d', 310, 100, { sortKey: 5, order: -1 })
    placement.place([low, high, sortedSecond, sortedFirst], 800, 600)
    expect(high.placed).toBe(true)
    expect(low.placed).toBe(false)
    expect(sortedFirst.placed).toBe(true)
    expect(sortedSecond.placed).toBe(false)
  })

  it('lets allow-overlap labels through and ignore-placement labels leave no box', () => {
    const placement = new SymbolPlacement()
    const first = candidate('a', 100, 100, { ignorePlacement: true, layerIndex: 3 })
    const second = candidate('b', 105, 100, { layerIndex: 2 })
    const third = candidate('c', 110, 100, { allowOverlap: true, layerIndex: 1 })
    placement.place([first, second, third], 800, 600)
    expect([first.placed, second.placed, third.placed]).toEqual([true, true, true])
  })

  it('does not place labels off the screen', () => {
    const placement = new SymbolPlacement()
    const outside = candidate('a', -100, 100)
    placement.place([outside], 800, 600)
    expect(outside.placed).toBe(false)
  })

  it('drops duplicates of the same label from overlapping tiles, and carries the fade to its replacement', () => {
    const placement = new SymbolPlacement({ fadeDurationSeconds: 0.2 })
    const parent = candidate('town', 200, 200, { order: 2 })
    const child = candidate('town', 203, 201, { order: 1 })
    placement.place([parent, child], 800, 600)
    // The child places first (lower order); the parent repeats it.
    expect(child.placed).toBe(true)
    expect(parent.fade).toBeNull()
    placement.fade(0.1)
    expect(child.fade!.opacity).toBeCloseTo(0.5)
    // The parent tile goes away; a new copy of the child (another zoom) takes over its fade state.
    const replacement = candidate('town', 205, 202)
    placement.place([replacement], 800, 600)
    expect(replacement.fade).toBe(child.fade)
    placement.fade(0.1)
    expect(replacement.fade!.opacity).toBeCloseTo(1)
  })

  it('keeps a label that shows over an equal one that would replace it', () => {
    const placement = new SymbolPlacement({ fadeDurationSeconds: 0 })
    const shown = candidate('a', 100, 100, { order: 5 })
    placement.place([shown], 800, 600)
    placement.fade(0.016)
    const newcomer = candidate('b', 110, 100, { order: 0 })
    placement.place([newcomer, shown], 800, 600)
    expect(shown.placed).toBe(true)
    expect(newcomer.placed).toBe(false)
  })

  it('fades collided labels out and forgets them once hidden and unseen', () => {
    const placement = new SymbolPlacement({ fadeDurationSeconds: 0.3 })
    const label = candidate('a', 100, 100)
    placement.place([label], 800, 600)
    expect(placement.fade(0.3)).toBe(false)
    expect(label.fade!.opacity).toBe(1)
    placement.place([], 800, 600)
    expect(placement.fade(0.15)).toBe(true)
    expect(label.fade!.opacity).toBeCloseTo(0.5)
    placement.fade(0.15)
    expect(placement.fadeCount).toBe(0)
  })
})

describe('SymbolStateTexture', () => {
  it('hands out slot ranges, reuses freed ones and grows when full', () => {
    const state = new SymbolStateTexture()
    const a = state.allocate(600)
    const b = state.allocate(300)
    expect([a, b]).toEqual([0, 600])
    state.write(a, 10, 20, 0.5, 1)
    state.release(a, 600)
    expect(state.data[3]).toBe(0)
    expect(state.allocate(500)).toBe(0)
    const c = state.allocate(SYMBOL_STATE_WIDTH)
    expect(c).toBe(900)
    expect(state.capacity).toBe(SYMBOL_STATE_WIDTH * 2)
    // Freed neighbours merge back into one range.
    state.release(0, 500)
    state.release(600, 300)
    state.release(500, 100)
    expect(state.allocate(900)).toBe(0)
  })
})
