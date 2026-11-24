import { describe, expect, it } from 'vitest'

import { bucketKey } from '../src/vector/MapStyleOverlay.js'
import { Vector3 } from 'three'
import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { rayHitsTerrain } from '../src/vector/symbols/ScreenSymbols.js'
import { boundBoxes, moveToAnchor, CollisionGrid, SymbolPlacement, type PlacementCandidate } from '../src/vector/symbols/SymbolPlacement.js'
import { SymbolStateTexture, SYMBOL_STATE_WIDTH } from '../src/vector/symbols/symbolMaterial.js'
import type { Glyph } from '../src/vector/worker/glyphs.js'
import { lineLabelPaths, radialAnchorOffset, textOffsetForAnchor, variableAnchorShifts } from '../src/vector/worker/labels.js'
import { featureKey } from '../src/vector/worker/featureState.js'
import { iconPaddingPixels, MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { ICON_GLYPH_INDEX, SDF_ICON_GLYPH_INDEX, SYMBOL_ALLOW_OVERLAP, SYMBOL_ICON, SYMBOL_ICON_ONLY, SYMBOL_KEEP_UPRIGHT, SYMBOL_LINE } from '../src/vector/worker/symbols.js'
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
  it('keeps the feature each label belongs to, and answers feature queries for labels hit on the screen', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const symbols = (await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })).symbols!
    expect(symbols.sourceLayers).toEqual(['roads', 'roads', 'places', 'places'])
    expect([...symbols.featureIndices]).toEqual([0, 0, 0, 1])
    const hit = { sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, layerId: 'places', sourceLayer: 'places', featureIndex: 0 }
    const features = await processor.queryRenderedFeatures({ geometry: [{ x: 0, y: 0 }], tiles: [], layers: null, filter: null, tolerancePixels: 0, screenLabels: [hit] })
    expect(features.map(feature => [feature.layer.id, feature.properties.name])).toEqual([['places', 'Fuji']])
    // Layer and filter options apply to them too.
    expect(await processor.queryRenderedFeatures({ geometry: [{ x: 0, y: 0 }], tiles: [], layers: ['roads'], filter: null, tolerancePixels: 0, screenLabels: [hit] })).toEqual([])
    expect(await processor.queryRenderedFeatures({ geometry: [{ x: 0, y: 0 }], tiles: [], layers: null, filter: ['==', ['get', 'rank'], 1], tolerancePixels: 0, screenLabels: [hit] })).toEqual([])
  })

  it('lays out point labels around their anchor for symbol requests, with sizes at the tile zoom and the next', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })
    expect(bucket.shapes).toBeNull()
    expect(bucket.text).toBeNull()
    const symbols = bucket.symbols!
    // The two road names come first, in layer order; point labels follow.
    expect(symbols.keys).toEqual(['road-names\u0000Long Road Name', 'road-names\u0000Long Road Name', 'places\u0000Fuji', 'over\u0000Over'])
    const points = 2
    expect([...symbols.anchors.subarray(points * 2)]).toEqual([1000, 1000, 2000, 1000])
    expect([...symbols.sizes.subarray(points * 2)]).toEqual([12, 20, 12, 12])
    expect([...symbols.sortKeys.subarray(points)]).toEqual([2, 0])
    expect([...symbols.paddings.subarray(points)]).toEqual([3, 2])
    expect(symbols.flags[points]).toBe(0)
    expect(symbols.flags[points + 1]).toBe(SYMBOL_ALLOW_OVERLAP)
    expect([...symbols.layerIndices.subarray(points)]).toEqual([2, 3])
    // "Fuji": 4 glyphs of 12-pixel advances, centred on the anchor, in pixels of a 24 px font.
    const [left, top, right, bottom] = symbols.boxes.subarray(points * 4, points * 4 + 4)
    expect(left).toBeCloseTo(-24)
    expect(right).toBeCloseTo(24)
    expect(top!).toBeLessThan(0)
    expect(bottom!).toBeGreaterThan(0)
    const roadGlyphs = 'LongRoadName'.length * 2
    expect(symbols.indices.length).toBe((roadGlyphs + 4 + 4) * 6)
    expect(symbols.labelIndices[0]).toBe(0)
    expect(symbols.labelIndices.at(-1)).toBe(3)
    // Point glyphs carry no glyph index; line glyphs carry their own.
    expect(symbols.glyphIndices.at(-1)).toBe(-1)
    expect(symbols.glyphIndices[0]).toBe(0)
    // text-opacity is baked into the colours; the halo width stays in pixels.
    const fujiVertex = roadGlyphs * 4
    expect([...symbols.colors.subarray(fujiVertex * 4, fujiVertex * 4 + 4)]).toEqual([16, 32, 48, 128])
    expect(symbols.haloWidths[fujiVertex]).toBe(2)
  })

  it('leaves every label out of draped tiles when labels face the viewer', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const draped = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
    const screen = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const request = { sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 }
    expect((await draped.processTile(request)).text?.indices.length).toBeGreaterThan(0)
    expect((await screen.processTile(request)).text).toBeNull()
  })

  it('lays out labels of GeoJSON sources, whose layers have no source-layer, with the query and state keys of their single layer', async () => {
    const { fetch } = createFakeFetch({})
    const data = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: { name: 'Peak' }, geometry: { type: 'Point', coordinates: [10, 10] } }] }
    const style = {
      version: 8,
      sources: { peaks: { type: 'geojson', data } },
      layers: [{ id: 'peak-names', type: 'symbol', source: 'peaks', layout: { 'text-field': ['get', 'name'] }, paint: { 'text-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff0000', '#000000'] } }],
    }
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const bucket = await processor.processTile({ sourceId: 'peaks', x: 0, y: 0, z: 0, zoom: 0, symbols: true })
    expect(bucket.symbols?.keys).toEqual(['peak-names\u0000Peak'])
    expect(bucket.rebuildFeatureKeys).toEqual([featureKey('peaks', undefined, 7)])
    const hit = { sourceId: 'peaks', x: 0, y: 0, z: 0, zoom: 0, layerId: 'peak-names', sourceLayer: bucket.symbols!.sourceLayers[0]!, featureIndex: 0 }
    const features = await processor.queryRenderedFeatures({ geometry: [{ x: 0, y: 0 }], tiles: [], layers: null, filter: null, tolerancePixels: 0, screenLabels: [hit] })
    expect(features.map(feature => [feature.id, feature.properties.name])).toEqual([[7, 'Peak']])
  })

  it('stores the road around each line label anchor and every glyph offset along it', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create({ style: labelStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const symbols = (await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })).symbols!
    expect(symbols.flags[0]! & SYMBOL_LINE).toBe(SYMBOL_LINE)
    expect(symbols.flags[0]! & SYMBOL_KEEP_UPRIGHT).toBe(SYMBOL_KEEP_UPRIGHT)
    expect(symbols.flags[2]! & SYMBOL_LINE).toBe(0)
    // The path is a run of points on the road (y = 3000), with the anchor inside it.
    const start = symbols.lineStarts[0]!
    const length = symbols.lineLengths[0]!
    const anchor = symbols.lineAnchors[0]!
    expect(length).toBeGreaterThanOrEqual(2)
    expect(anchor).toBeLessThan(length)
    for (let point = 0; point < length; point++) expect(symbols.linePoints[(start + point) * 2 + 1]).toBe(3000)
    expect(symbols.linePoints[(start + anchor) * 2]).toBe(symbols.anchors[0])
    expect(symbols.maximumAngles[0]).toBeCloseTo((45 * Math.PI) / 180)
    // "Long Road Name": 12 drawn glyphs, offsets from the label middle, symmetric and increasing.
    const first = symbols.glyphStarts[0]!
    const count = symbols.glyphCounts[0]!
    expect(count).toBe(12)
    const offsets = [...symbols.glyphOffsets.subarray(first, first + count)]
    for (let glyph = 1; glyph < count; glyph++) expect(offsets[glyph]!).toBeGreaterThan(offsets[glyph - 1]!)
    expect(offsets[0]! + offsets.at(-1)!).toBeCloseTo(0)
    expect(symbols.glyphHalfWidths[first]).toBeCloseTo(6)
    // Point labels keep no path.
    expect(symbols.lineLengths[2]).toBe(0)
    expect(symbols.glyphCounts[2]).toBe(0)
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
    boxes: null,
    hidden: false,
    anchorShifts: null,
    anchorScale: 1,
    anchorIndex: 0,
    anchorBoxStart: 0,
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

describe('line labels on the screen', () => {
  it('keeps the stretch of line around each anchor, one window on each side, with the anchor among its points', () => {
    const line = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 2000, y: 1000 }]
    const paths = lineLabelPaths(line, 200, { spacingUnits: 3000, center: false, extent: 4096, windowUnits: 300 })
    expect(paths).toHaveLength(1)
    const { points, anchorIndex } = paths[0]!
    // The anchor sits halfway along (1500 units: x = 1000, y = 500); the window reaches 1200 to 1800.
    expect(points[anchorIndex]).toEqual({ x: 1000, y: 500 })
    expect(points).toEqual([{ x: 1000, y: 200 }, { x: 1000, y: 500 }, { x: 1000, y: 800 }])
    // A window over a corner keeps the corner.
    const wide = lineLabelPaths(line, 200, { spacingUnits: 3000, center: false, extent: 4096, windowUnits: 700 })[0]!
    expect(wide.points).toEqual([{ x: 800, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 1000, y: 1000 }, { x: 1200, y: 1000 }])
    expect(wide.anchorIndex).toBe(2)
    // Too short for the label, or an anchor outside the tile: nothing.
    expect(lineLabelPaths(line, 5000, { spacingUnits: 3000, center: false, extent: 4096, windowUnits: 300 })).toEqual([])
    expect(lineLabelPaths(line, 200, { spacingUnits: 3000, center: false, extent: 1000, windowUnits: 300 })).toEqual([])
  })
})

describe('placing labels with one box per glyph', () => {
  it('lets a curved label sit where its bounding box overlaps another label but none of its glyphs do', () => {
    const placement = new SymbolPlacement()
    const point = candidate('point', 200, 200, { layerIndex: 2 })
    // An L-shaped road label around the point label's corner: its bounds cover the point label, its glyphs miss it.
    const road = candidate('road', 200, 200, { layerIndex: 1, minimumXPixels: 150, minimumYPixels: 150, maximumXPixels: 260, maximumYPixels: 260, boxes: [150, 150, 260, 160, 250, 150, 260, 260] })
    const crossing = candidate('crossing', 200, 200, { layerIndex: 0, minimumXPixels: 100, minimumYPixels: 195, maximumXPixels: 300, maximumYPixels: 205, boxes: [100, 195, 300, 205] })
    placement.place([point, road, crossing], 800, 600)
    expect([point.placed, road.placed, crossing.placed]).toEqual([true, true, false])
  })

  it('fades out a hidden label where it is, leaving its room to others', () => {
    const placement = new SymbolPlacement({ fadeDurationSeconds: 1 })
    const road = candidate('road', 200, 200, { layerIndex: 2 })
    placement.place([road], 800, 600)
    placement.fade(1)
    expect(road.fade?.opacity).toBe(1)
    // Its road no longer fits it on the screen: it keeps its fade state, fading out, and a label below takes the room.
    const hidden = candidate('road', 202, 200, { layerIndex: 2, hidden: true })
    const below = candidate('below', 200, 200, { layerIndex: 1 })
    placement.place([hidden, below], 800, 600)
    expect(hidden.fade).toBe(road.fade)
    expect(hidden.placed).toBe(false)
    expect(below.placed).toBe(true)
    placement.fade(0.5)
    expect(hidden.fade?.opacity).toBeCloseTo(0.5)
  })

  it('hands a hidden label\'s fade to the same label from another tile that fits', () => {
    const placement = new SymbolPlacement({ fadeDurationSeconds: 1 })
    const road = candidate('road', 200, 200, { order: 0 })
    placement.place([road], 800, 600)
    placement.fade(1)
    const hidden = candidate('road', 201, 200, { order: 0, hidden: true })
    const otherTile = candidate('road', 203, 200, { order: 1 })
    placement.place([hidden, otherTile], 800, 600)
    expect(otherTile.fade).toBe(road.fade)
    expect(otherTile.placed).toBe(true)
    expect(hidden.fade).toBeNull()
  })
})

describe('variable anchors', () => {
  const box = { minimumX: -30, minimumY: -10, maximumX: 30, maximumY: 10 }

  it('shifts the centred box so the anchor names the side touching the point, then by the offset', () => {
    const shifts = variableAnchorShifts(box, ['center', 'left', 'top-right', 'bottom'], () => ({ x: 0, y: 0 }))
    expect(shifts).toEqual([0, 0, 30, 0, -30, 10, 0, -10])
    expect(variableAnchorShifts(box, ['left'], () => ({ x: 5, y: 1 }))).toEqual([35, 1])
  })

  it('points offsets away from the point (radial on a diagonal; text-offset by its size)', () => {
    expect(radialAnchorOffset('top', 2)).toEqual({ x: 0, y: 2 })
    expect(radialAnchorOffset('right', 2)).toEqual({ x: -2, y: 0 })
    const corner = radialAnchorOffset('bottom-left', 2)
    expect(corner.x).toBeCloseTo(Math.SQRT2)
    expect(corner.y).toBeCloseTo(-Math.SQRT2)
    expect(textOffsetForAnchor('top-right', { x: -1, y: -3 })).toEqual({ x: -1, y: 3 })
    expect(textOffsetForAnchor('center', { x: 1, y: 3 })).toEqual({ x: 0, y: 0 })
  })

  it('places a label at the first anchor that fits, and keeps the anchor it showed with', () => {
    const placement = new SymbolPlacement()
    const blocker = candidate('blocker', 230, 200, { layerIndex: 2 })
    // Box 40 × 16 around (200, 200); anchors: centre, then left of the point (shifted right 30), then right (shifted left 30).
    const shifts = new Float32Array([0, 0, 30, 0, -30, 0])
    const label = candidate('label', 200, 200, { layerIndex: 1, anchorShifts: shifts })
    placement.place([blocker, label], 800, 600)
    // Centre and "left" both hit the blocker at x 210-250; "right" sits at 150-190.
    expect(label.placed).toBe(true)
    expect(label.anchorIndex).toBe(2)
    expect(label.minimumXPixels).toBe(150)
    placement.fade(1)
    // The blocker gone, the label stays on the anchor it showed with rather than jumping back to the centre.
    const again = candidate('label', 200, 200, { layerIndex: 1, anchorShifts: shifts })
    placement.place([again], 800, 600)
    expect(again.anchorIndex).toBe(2)
    // Nowhere fits: not placed, left at the anchor it tried first.
    const wall = candidate('wall', 200, 200, { layerIndex: 2, minimumXPixels: 100, maximumXPixels: 300 })
    const blocked = candidate('label', 200, 200, { layerIndex: 1, anchorShifts: shifts })
    placement.place([wall, blocked], 800, 600)
    expect(blocked.placed).toBe(false)
    expect(blocked.anchorIndex).toBe(2)
  })
})

describe('variable anchors in the worker', () => {
  it('lays the text out centred and stores a shift per anchor, radial offset in pixels of a 24 px font', async () => {
    const style = labelStyle()
    style.layers = style.layers.filter(layer => layer.id === 'over') as typeof style.layers
    Object.assign(style.layers[0]!.layout!, { 'text-variable-anchor': ['top', 'left'], 'text-radial-offset': 0.5 })
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true }, { fetch, drawLocalGlyph })
    const symbols = (await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })).symbols!
    expect(symbols.keys).toEqual(['over\u0000Over'])
    expect(symbols.anchorShiftCounts[0]).toBe(2)
    const [left, top, right, bottom] = symbols.boxes
    expect(left! + right!).toBeCloseTo(0)
    const shifts = [...symbols.anchorShifts]
    // "top": the text below the point by half its height plus 12 px; "left": right of it by half its width plus 12 px.
    expect(shifts[0]).toBeCloseTo(0)
    expect(shifts[1]).toBeCloseTo(-top! + 12)
    expect(shifts[2]).toBeCloseTo(-left! + 12)
    expect(shifts[3]).toBeCloseTo(-(top! + bottom!) / 2)
  })
})

describe('labels behind terrain', () => {
  const at = (longitudeDegrees: number, heightMeters: number) => WGS84_ELLIPSOID.getCartographicToPosition(0, (longitudeDegrees * Math.PI) / 180, heightMeters, new Vector3()) as Vector3
  // A camera 1 km up at 0°, a label on the ground at 0.2° east (about 22 km).
  const camera = at(0, 1000)
  const label = at(0.2, 0)

  it('hides a label where the ground rises above the line of sight', () => {
    const ridge = (longitude: number) => (Math.abs((longitude * 180) / Math.PI - 0.1) < 0.02 ? 2000 : 0)
    expect(rayHitsTerrain(camera, label, ridge)).toBe(true)
  })

  it('keeps it over flat ground, a low bump, missing tiles and the slope it stands on', () => {
    expect(rayHitsTerrain(camera, label, () => 0)).toBe(false)
    // The line of sight is about 500 m up halfway: a 450 m hill stays under it.
    expect(rayHitsTerrain(camera, label, longitude => (Math.abs((longitude * 180) / Math.PI - 0.1) < 0.005 ? 450 : 0))).toBe(false)
    expect(rayHitsTerrain(camera, label, () => null)).toBe(false)
    // A label 300 m up a slope that rises all the way from the camera's valley.
    expect(rayHitsTerrain(camera, at(0.2, 300), longitude => ((longitude * 180) / Math.PI / 0.2) * 300)).toBe(false)
    // The same label behind a 300 m wall just in front of it, on flat ground: hidden.
    expect(rayHitsTerrain(camera, label, longitude => ((longitude * 180) / Math.PI > 0.195 ? 300 : 0))).toBe(true)
  })
})

describe('icons', () => {
  /** A 16 × 16 image at pixel ratio 2 (8 × 8 map pixels). */
  const pin = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).fill(255), pixelRatio: 2, sdf: false }
  const peak = { ...pin, sdf: true }

  async function iconSymbols(layers: object[]) {
    const style = { ...labelStyle(), layers }
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': labelTile() })
    const processor = await MapStyleProcessor.create(
      { style, baseUrl, requestHeaders: {}, localFontFamily: 'x', screenSymbols: true, images: [['pin', pin], ['peak', peak]] },
      { fetch, drawLocalGlyph },
    )
    return processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10, symbols: true })
  }

  it('lays an icon at the point under its text, from the image atlas, sized by icon-size', async () => {
    const bucket = await iconSymbols([
      { id: 'places', type: 'symbol', source: 'base', 'source-layer': 'places', filter: ['==', ['get', 'name'], 'Fuji'], layout: { 'text-field': '{name}', 'text-size': 12, 'icon-image': 'pin', 'icon-size': 2 } },
    ])
    const symbols = bucket.symbols!
    expect(bucket.images).toEqual(['pin'])
    expect(symbols.keys).toEqual(['places\u0000Fuji\u0000pin'])
    expect(symbols.flags[0]! & (SYMBOL_ICON | SYMBOL_ICON_ONLY)).toBe(SYMBOL_ICON)
    // 8 map pixels at icon-size 1, centred; the icon keeps its own sizes (24 × icon-size), apart from the text's.
    expect([...symbols.iconBoxes.subarray(0, 4)]).toEqual([-4, -4, 4, 4])
    expect([...symbols.iconSizes.subarray(0, 2)]).toEqual([48, 48])
    expect([...symbols.sizes.subarray(0, 2)]).toEqual([12, 12])
    // The icon's quad comes first (drawn under the text), then the four glyphs.
    expect(symbols.glyphIndices[0]).toBe(ICON_GLYPH_INDEX)
    expect(symbols.glyphIndices[4]).toBe(-1)
    expect(symbols.indices.length).toBe((1 + 4) * 6)
    // Its colour stays the image's: white, at icon-opacity.
    expect([...symbols.colors.subarray(0, 4)]).toEqual([255, 255, 255, 255])
  })

  it('scales an icon alone by icon-size between zooms, tints SDF icons and records missing images', async () => {
    const bucket = await iconSymbols([
      { id: 'peaks', type: 'symbol', source: 'base', 'source-layer': 'places', filter: ['==', ['get', 'name'], 'Fuji'], layout: { 'icon-image': 'peak', 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 1, 11, 2] }, paint: { 'icon-color': '#ff0000' } },
      { id: 'missing', type: 'symbol', source: 'base', 'source-layer': 'places', filter: ['==', ['get', 'name'], 'Over'], layout: { 'icon-image': 'nowhere' } },
    ])
    const symbols = bucket.symbols!
    expect(bucket.missingImages).toEqual(['nowhere'])
    expect(symbols.keys).toEqual(['peaks\u0000\u0000peak'])
    expect(symbols.flags[0]! & SYMBOL_ICON_ONLY).toBe(SYMBOL_ICON_ONLY)
    // The label scales as a 24 px font times icon-size; its corners are in image pixels at its pixel ratio.
    expect([...symbols.sizes]).toEqual([24, 48])
    expect([...symbols.boxes.subarray(0, 4)]).toEqual([-4, -4, 4, 4])
    expect(symbols.glyphIndices[0]).toBe(SDF_ICON_GLYPH_INDEX)
    expect([...symbols.colors.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    // icon-padding is a Padding (four sides): its widest side, MapLibre's default 2.
    expect(symbols.paddings[0]).toBe(2)
  })

  it('reads icon-padding as its widest side', () => {
    expect(iconPaddingPixels({ values: [1, 6, 2, 3] })).toBe(6)
    expect(iconPaddingPixels(4)).toBe(4)
  })

  it('moves only the text box with a variable anchor; the icon box stays at the point', () => {
    const label = candidate('label', 200, 200, { anchorShifts: new Float32Array([0, 0, 10, 0]), anchorBoxStart: 4, boxes: [190, 190, 210, 210, 180, 212, 220, 228] })
    boundBoxes(label)
    moveToAnchor(label, 1)
    expect(label.boxes).toEqual([190, 190, 210, 210, 190, 212, 230, 228])
    expect([label.minimumXPixels, label.maximumXPixels]).toEqual([190, 230])
  })
})
