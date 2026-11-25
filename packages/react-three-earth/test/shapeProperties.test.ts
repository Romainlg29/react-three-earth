import { afterEach, describe, expect, it, vi } from 'vitest'

import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { ShapeBuilder } from '../src/vector/worker/ShapeBuilder.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

const baseUrl = 'https://maps.test/styles/style.json'
const tileUrl = 'https://maps.test/tiles/{z}/{x}/{y}.pbf'
const drawLocalGlyph = () => null as never

afterEach(() => vi.restoreAllMocks())

/** A processor over one tile (z 10, x 1, y 2) with these layers on source `base`. */
async function processWith(layers: object[], tile: Uint8Array) {
  const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': tile })
  const style = { version: 8, sources: { base: { type: 'vector', tiles: [tileUrl], maxzoom: 14 } }, layers }
  const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
  return { processor, bucket: await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 }) }
}

/** The smallest x and y of a shape mesh's positions. */
function minimumCorner(positions: Float32Array): { x: number; y: number } {
  let x = Infinity
  let y = Infinity
  for (let index = 0; index < positions.length; index += 2) {
    x = Math.min(x, positions[index]!)
    y = Math.min(y, positions[index + 1]!)
  }
  return { x, y }
}

const square = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]] as Array<[number, number]>

// 512-pixel tiles over 4096 units: 8 units per pixel at the tile's own zoom.
const UNITS_PER_PIXEL = 8

describe('translate', () => {
  it('moves fills, lines and circles by their translate, in pixels right and down', async () => {
    const tile = encodeVectorTile([
      { name: 'water', features: [{ type: 'Polygon', geometry: [square(1000, 2000)] }] },
      { name: 'roads', features: [{ type: 'LineString', geometry: [[[1000, 3000], [2000, 3000]]] }] },
      { name: 'places', features: [{ type: 'Point', geometry: [[[3000, 1000]]] }] },
    ])
    for (const [type, sourceLayer, paint, expected] of [
      ['fill', 'water', { 'fill-color': '#00f' }, { x: 1000, y: 1000 }],
      ['line', 'roads', { 'line-color': '#f00', 'line-width': 2 }, { x: 1000, y: 3000 - UNITS_PER_PIXEL }],
      ['circle', 'places', { 'circle-radius': 4 }, { x: 3000 - 4 * UNITS_PER_PIXEL, y: 1000 - 4 * UNITS_PER_PIXEL }],
    ] as const) {
      const { bucket } = await processWith([{ id: 'layer', type, source: 'base', 'source-layer': sourceLayer, paint: { ...paint, [`${type}-translate`]: [10, -5] } }], tile)
      const corner = minimumCorner(bucket.shapes!.positions)
      expect(corner.x).toBeCloseTo(expected.x + 10 * UNITS_PER_PIXEL, 3)
      expect(corner.y).toBeCloseTo(expected.y - 5 * UNITS_PER_PIXEL, 3)
    }
  })

  it('draws a viewport anchor as map, with a warning once that states the fix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tile = encodeVectorTile([{ name: 'water', features: [{ type: 'Polygon', geometry: [square(1000, 2000)] }, { type: 'Polygon', geometry: [square(2500, 3000)] }] }])
    const { bucket } = await processWith(
      [{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-translate': [4, 0], 'fill-translate-anchor': 'viewport' } }],
      tile,
    )
    expect(minimumCorner(bucket.shapes!.positions).x).toBeCloseTo(1000 + 4 * UNITS_PER_PIXEL, 3)
    const translateWarnings = warn.mock.calls.filter(([message]) => String(message).includes('translate-anchor'))
    expect(translateWarnings).toHaveLength(1)
    expect(translateWarnings[0]![0]).toContain('Use "map"')
  })
})

describe('sort keys', () => {
  it('draws a layer\'s features by ascending sort key, ties in tile order', async () => {
    const tile = encodeVectorTile([
      {
        name: 'water',
        features: [
          { type: 'Polygon', geometry: [square(0, 100)], properties: { rank: 3, color: '#ff0000' } },
          { type: 'Polygon', geometry: [square(200, 300)], properties: { rank: 1, color: '#00ff00' } },
          { type: 'Polygon', geometry: [square(400, 500)], properties: { rank: 2, color: '#0000ff' } },
          { type: 'Polygon', geometry: [square(600, 700)], properties: { rank: 1, color: '#ffffff' } },
        ],
      },
    ])
    const { bucket } = await processWith(
      [{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', layout: { 'fill-sort-key': ['get', 'rank'] }, paint: { 'fill-color': ['get', 'color'] } }],
      tile,
    )
    const shapes = bucket.shapes!
    // The colours in the order their vertices were added.
    const order: number[][] = []
    for (let vertex = 0; vertex < shapes.colors.length / 4; vertex++) {
      const color = [...shapes.colors.subarray(vertex * 4, vertex * 4 + 3)]
      if (order.at(-1)?.join() !== color.join()) order.push(color)
    }
    expect(order).toEqual([
      [0, 255, 0],
      [255, 255, 255],
      [0, 0, 255],
      [255, 0, 0],
    ])
  })
})

describe('blur', () => {
  it('marks a blurred line\'s vertices across its band, and leaves sharp tiles without edges', async () => {
    const tile = encodeVectorTile([{ name: 'roads', features: [{ type: 'LineString', geometry: [[[1000, 3000], [2000, 3000]]] }] }])
    const sharp = await processWith([{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-width': 4 } }], tile)
    expect(sharp.bucket.shapes!.edges).toBeNull()
    const blurred = await processWith([{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-width': 4, 'line-blur': 1 } }], tile)
    const edges = blurred.bucket.shapes!.edges!
    expect(edges.length).toBe(blurred.bucket.shapes!.positions.length)
    // Blur 1 px over a 2-pixel half width: half the band fades.
    for (let index = 0; index < edges.length; index += 2) {
      expect(Math.abs(edges[index]!)).toBeCloseTo(1, 6)
      expect(edges[index + 1]).toBeCloseTo(0.5, 6)
    }
  })

  it('marks a blurred circle from its centre (0) to its rim (1), with circle-blur as the share', async () => {
    const tile = encodeVectorTile([{ name: 'places', features: [{ type: 'Point', geometry: [[[3000, 1000]]] }] }])
    const { bucket } = await processWith([{ id: 'places', type: 'circle', source: 'base', 'source-layer': 'places', paint: { 'circle-radius': 6, 'circle-blur': 0.4 } }], tile)
    const edges = bucket.shapes!.edges!
    expect(edges[0]).toBe(0)
    expect(edges[1]).toBeCloseTo(0.4, 6)
    expect(edges[2]).toBe(1)
  })

  it('keeps shapes added before and after a blurred one sharp', () => {
    const builder = new ShapeBuilder()
    builder.setGroup(0)
    builder.addCircle({ x: 0, y: 0 }, 10)
    builder.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], { width: 10, blurWidth: 5, cap: 'round' })
    builder.addCircle({ x: 50, y: 50 }, 10)
    const mesh = builder.build()!
    const circleVertices = 17
    expect([...mesh.edges!.subarray(0, circleVertices * 2)].every(value => value === 0)).toBe(true)
    // The round cap's pivot is the band's middle; its rim is the band's edge.
    const blurShares = new Set<number>()
    for (let index = circleVertices * 2 + 1; index < mesh.edges!.length - circleVertices * 2; index += 2) blurShares.add(mesh.edges![index]!)
    expect([...blurShares]).toEqual([1])
    const after = mesh.edges!.subarray(mesh.edges!.length - circleVertices * 2)
    expect([...after].filter((_, index) => index % 2 === 1).every(value => value === 0)).toBe(true)
  })
})
