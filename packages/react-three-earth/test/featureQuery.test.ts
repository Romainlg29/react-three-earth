import { describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import type { EarthPointerEvent } from '../src/core/events.js'
import { geographicToMercator, screenToMercatorQuery, type RenderedFeature } from '../src/core/featureQuery.js'
import type { LayerPointerEvent } from '../src/core/LayerEvents.js'
import { clipQueryToTile, offsetLine, polygonIntersectsBoxes, polygonIntersectsBufferedLines, polygonIntersectsBufferedPoint, polygonIntersectsRings, TileFeatureIndex } from '../src/vector/worker/featureIndex.js'
import { featureKey } from '../src/vector/worker/featureState.js'
import type { Glyph } from '../src/vector/worker/glyphs.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import type { QueryTile, RenderedFeatureQuery } from '../src/vector/worker/types.js'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

const square = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]] as Array<[number, number]>
/** The same square, the other way round: a hole. */
const hole = (min: number, max: number) => square(min, max).reverse()

const drawLocalGlyph = (_fontStack: string, codePoint: number): Glyph => ({
  id: codePoint,
  bitmap: codePoint === 32 ? null : new Uint8Array(16 * 20).fill(200),
  width: codePoint === 32 ? 0 : 10,
  height: codePoint === 32 ? 0 : 14,
  left: 1,
  top: -6,
  advance: 12,
})

describe('hit tests', () => {
  it('finds points in polygons, not in their holes', () => {
    const rings = [square(0, 100).map(([x, y]) => ({ x, y })), hole(40, 60).map(([x, y]) => ({ x, y }))]
    expect(polygonIntersectsRings([{ x: 20, y: 20 }], rings)).toBe(true)
    expect(polygonIntersectsRings([{ x: 50, y: 50 }], rings)).toBe(false)
    expect(polygonIntersectsRings([{ x: 120, y: 50 }], rings)).toBe(false)
    // Within the tolerance of an edge
    expect(polygonIntersectsRings([{ x: 105, y: 50 }], rings, 6)).toBe(true)
    // A query box overlapping the polygon without holding any of its vertices
    expect(polygonIntersectsRings([{ x: -10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 20 }, { x: -10, y: 20 }], rings)).toBe(true)
  })

  it('measures lines by their half width, and circles by radius', () => {
    const line = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]]
    expect(polygonIntersectsBufferedLines([{ x: 50, y: 4 }], line, 5)).toBe(true)
    expect(polygonIntersectsBufferedLines([{ x: 50, y: 6 }], line, 5)).toBe(false)
    expect(polygonIntersectsBufferedLines([{ x: 104, y: 0 }], line, 5)).toBe(true) // round enough at the ends
    // A box crossing the line
    expect(polygonIntersectsBufferedLines([{ x: 40, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: 40, y: 10 }], line, 0)).toBe(true)
    expect(polygonIntersectsBufferedPoint([{ x: 3, y: 4 }], { x: 0, y: 0 }, 5)).toBe(true)
    expect(polygonIntersectsBufferedPoint([{ x: 3, y: 4.1 }], { x: 0, y: 0 }, 5)).toBe(false)
  })

  it('offsets lines to the right of their direction', () => {
    expect(offsetLine([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2)).toEqual([{ x: 0, y: 2 }, { x: 10, y: 2 }])
    // A right angle keeps both sides 2 away: the corner moves along the diagonal
    const [, corner] = offsetLine([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2)
    expect(corner!.x).toBeCloseTo(8)
    expect(corner!.y).toBeCloseTo(2)
  })

  it('tests label boxes widened by the tolerance', () => {
    const boxes = [{ minimumX: 10, minimumY: 10, maximumX: 20, maximumY: 20 }]
    expect(polygonIntersectsBoxes([{ x: 15, y: 15 }], boxes, 0)).toBe(true)
    expect(polygonIntersectsBoxes([{ x: 22, y: 15 }], boxes, 0)).toBe(false)
    expect(polygonIntersectsBoxes([{ x: 22, y: 15 }], boxes, 3)).toBe(true)
  })

  it('clips a query box to the tile square, and drops a point outside it', () => {
    const clipped = clipQueryToTile([{ x: -100, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 200 }, { x: -100, y: 200 }])
    expect(Math.min(...clipped.map(point => point.x))).toBe(0)
    expect(clipQueryToTile([{ x: -1, y: 5 }])).toEqual([])
  })

  it('indexes features in a grid and returns the candidates top-most first', () => {
    const bytes = encodeVectorTile([
      {
        name: 'shapes',
        features: [
          { type: 'Polygon', geometry: [square(0, 100)] },
          { type: 'Polygon', geometry: [square(3000, 3100)] },
          { type: 'Polygon', geometry: [square(0, 4096)] },
        ],
      },
    ])
    const index = new TileFeatureIndex(new VectorTile(new Pbf(bytes)).layers.shapes!)
    expect(index.query(10, 10, 20, 20)).toEqual([2, 0])
    expect(index.query(3050, 3050, 3060, 3060)).toEqual([2, 1])
  })
})

describe('screen queries', () => {
  it('converts positions to normalised Web Mercator, y to the north', () => {
    expect(geographicToMercator({ longitudeDegrees: 0, latitudeDegrees: 0 })).toEqual({ x: 0.5, y: 0.5 })
    expect(geographicToMercator({ longitudeDegrees: -180, latitudeDegrees: 89.9 }).y).toBeCloseTo(1)
  })

  it('follows a box along its outline, leaves out the sky, and unwraps the antimeridian', () => {
    // Columns of pixels map to longitudes 170° to 190° (wrapped to -170°) on the right half of the screen.
    const unproject = ({ xPixels, yPixels }: { xPixels: number; yPixels: number }) => {
      if (yPixels < 10) return null // sky
      const longitude = 170 + xPixels / 5
      return { longitudeDegrees: longitude > 180 ? longitude - 360 : longitude, latitudeDegrees: -yPixels / 10 }
    }
    const polygon = screenToMercatorQuery([{ xPixels: 0, yPixels: 0 }, { xPixels: 100, yPixels: 100 }], unproject)!
    expect(polygon.length).toBeGreaterThanOrEqual(3)
    const xs = polygon.map(point => point.x)
    // One continuous polygon 20° wide, not two halves 340° apart
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20 / 360)
    expect(screenToMercatorQuery({ xPixels: 50, yPixels: 5 }, unproject)).toBeNull()
  })

  it('samples inside a box whose outline is all sky, as when the whole globe fits the screen', () => {
    // A globe in the middle of a 100 × 100 screen: ground within 30 pixels of the centre only
    const unproject = ({ xPixels, yPixels }: { xPixels: number; yPixels: number }) =>
      Math.hypot(xPixels - 50, yPixels - 50) > 30 ? null : { longitudeDegrees: (xPixels - 50) * 2, latitudeDegrees: (50 - yPixels) * 2 }
    const polygon = screenToMercatorQuery([{ xPixels: 0, yPixels: 0 }, { xPixels: 100, yPixels: 100 }], unproject)!
    expect(polygon.length).toBeGreaterThanOrEqual(3)
    const xs = polygon.map(point => point.x)
    expect(Math.min(...xs)).toBeLessThan(0.4)
    expect(Math.max(...xs)).toBeGreaterThan(0.6)
  })
})

const TILES = 'https://maps.test/{z}/{x}/{y}.pbf'

function queryStyle() {
  return {
    version: 8,
    sources: { base: { type: 'vector', tiles: [TILES] } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      { id: 'labels', type: 'symbol', source: 'base', 'source-layer': 'places', layout: { 'text-field': '{name}', 'text-size': 24 } },
      { id: 'buildings', type: 'fill', source: 'base', 'source-layer': 'buildings', paint: { 'fill-color': '#ff0000' } },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#00ff00', 'line-width': 4 } },
      { id: 'pois', type: 'circle', source: 'base', 'source-layer': 'pois', paint: { 'circle-radius': 5, 'circle-stroke-width': 1 } },
      { id: 'hidden', type: 'fill', source: 'base', 'source-layer': 'buildings', layout: { visibility: 'none' } },
    ],
  }
}

async function createQueryProcessor() {
  const tile = encodeVectorTile([
    {
      name: 'buildings',
      features: [
        { type: 'Polygon', id: 7, geometry: [square(0, 1024)], properties: { ref: 'b-7' } },
        { type: 'Polygon', id: 8, geometry: [square(2048, 3072), hole(2304, 2816)], properties: { ref: 'b-8' } },
      ],
    },
    {
      name: 'roads',
      features: [
        { type: 'LineString', id: 3, geometry: [[[0, 3500], [4096, 3500]]] },
        { type: 'LineString', id: 4, geometry: [[[512, 0], [512, 2000]]] },
      ],
    },
    { name: 'pois', features: [{ type: 'Point', id: 9, geometry: [[[3500, 1000]]] }] },
    { name: 'places', features: [{ type: 'Point', id: 11, geometry: [[[1600, 1600]]], properties: { name: 'ABCD' } }] },
  ])
  const { fetch } = createFakeFetch({ 'https://maps.test/0/0/0.pbf': tile })
  const processor = await MapStyleProcessor.create({ style: queryStyle(), baseUrl: 'https://maps.test/', requestHeaders: {}, localFontFamily: 'x' }, { fetch, drawLocalGlyph })
  const tileZero: QueryTile = { sourceId: 'base', x: 0, y: 0, z: 0, zoom: 0, column: 0, labelsOnly: false }
  /** Queries tile units of tile 0/0/0 (8 units per pixel at zoom 0). */
  const query = (points: Array<[number, number]>, extra: Partial<RenderedFeatureQuery> = {}) =>
    processor.queryRenderedFeatures({ geometry: points.map(([x, y]) => ({ x: x / 4096, y: 1 - y / 4096 })), tiles: [tileZero], layers: null, filter: null, tolerancePixels: 0, ...extra })
  return { processor, query, tileZero }
}

const describeHits = (features: Array<{ layer: { id: string }; id: unknown }>) => features.map(feature => `${feature.layer.id}:${String(feature.id)}`)

describe('queryRenderedFeatures in the worker', () => {
  it('returns the features under a point, top style layer first, as GeoJSON in degrees', async () => {
    const { query } = await createQueryProcessor()
    const features = await query([[512, 512]])
    expect(describeHits(features)).toEqual(['roads:4', 'buildings:7'])
    const building = features[1]!
    expect(building).toMatchObject({ type: 'Feature', id: 7, properties: { ref: 'b-7' }, source: 'base', sourceLayer: 'buildings', state: {} })
    expect(building.layer).toMatchObject({ id: 'buildings', type: 'fill' })
    expect(building.geometry.type).toBe('Polygon')
    const longitudes = (building.geometry.coordinates as number[][][])[0]!.map(([longitude]) => longitude!)
    expect(Math.min(...longitudes)).toBeCloseTo(-180)
    expect(Math.max(...longitudes)).toBeCloseTo(-90)
  })

  it('leaves out holes and hidden layers', async () => {
    const { query } = await createQueryProcessor()
    expect(describeHits(await query([[2100, 2100]]))).toEqual(['buildings:8'])
    expect(await query([[2560, 2560]])).toEqual([])
  })

  it('hits lines within their half width, and further with a tolerance', async () => {
    const { query } = await createQueryProcessor()
    // 4 pixels wide: 2 pixels (16 units) each side
    expect(describeHits(await query([[2000, 3512]]))).toEqual(['roads:3'])
    expect(await query([[2000, 3524]])).toEqual([])
    expect(describeHits(await query([[2000, 3524]], { tolerancePixels: 2 }))).toEqual(['roads:3'])
  })

  it('hits circles within their radius and stroke', async () => {
    const { query } = await createQueryProcessor()
    // 5 + 1 pixels: 48 units
    expect(describeHits(await query([[3540, 1000]]))).toEqual(['pois:9'])
    expect(await query([[3556, 1000]])).toEqual([])
  })

  it('hits labels by their placed boxes, above every shape layer', async () => {
    const { query } = await createQueryProcessor()
    // The label is below the buildings in the style, but labels draw on top
    const features = await query([[1600, 1600]])
    expect(describeHits(features)).toEqual(['labels:11'])
    expect(features[0]!.geometry).toMatchObject({ type: 'Point' })
  })

  it('reads only the labels of ring tiles', async () => {
    const { processor, tileZero } = await createQueryProcessor()
    const geometry = [{ x: 512 / 4096, y: 1 - 512 / 4096 }]
    expect(await processor.queryRenderedFeatures({ geometry, tiles: [{ ...tileZero, labelsOnly: true }], layers: null, filter: null, tolerancePixels: 0 })).toEqual([])
  })

  it('narrows by layers and filter, and rejects a bad filter with the fix', async () => {
    const { query } = await createQueryProcessor()
    expect(describeHits(await query([[512, 512]], { layers: ['buildings'] }))).toEqual(['buildings:7'])
    expect(describeHits(await query([[512, 512]], { filter: ['==', ['get', 'ref'], 'b-7'] }))).toEqual(['buildings:7'])
    await expect(query([[512, 512]], { filter: ['nonsense-operator'] })).rejects.toThrow(/valid MapLibre filter/)
  })

  it('lists a feature once per layer across tiles, with its state', async () => {
    const { processor, query, tileZero } = await createQueryProcessor()
    processor.applyFeatureStates([{ key: featureKey('base', 'buildings', 7), state: { hover: true } }])
    const box: Array<[number, number]> = [[100, 100], [900, 100], [900, 900], [100, 900]]
    const features = await query(box, { layers: ['buildings'], tiles: [tileZero, tileZero] })
    expect(describeHits(features)).toEqual(['buildings:7'])
    expect(features[0]!.state).toEqual({ hover: true })
  })

  it('lays out a tile again when its labels were not kept', async () => {
    const { processor, query } = await createQueryProcessor()
    expect(describeHits(await query([[1600, 1600]]))).toEqual(['labels:11'])
    // A style change makes the kept boxes stale
    await processor.applyCommands([{ command: 'setLayoutProperty', args: ['labels', 'text-size', 48] }])
    expect(describeHits(await query([[1600, 1600]]))).toEqual(['labels:11'])
  })
})

describe('querySourceFeatures in the worker', () => {
  it('reads every feature of a source layer, drawn or not, with a filter', async () => {
    const { processor } = await createQueryProcessor()
    const tiles = [{ x: 0, y: 0, z: 0 }]
    expect((await processor.querySourceFeatures({ sourceId: 'base', sourceLayer: 'buildings', filter: null, tiles })).map(feature => feature.id)).toEqual([7, 8])
    expect(await processor.querySourceFeatures({ sourceId: 'base', sourceLayer: null, filter: null, tiles })).toHaveLength(6)
    const filtered = await processor.querySourceFeatures({ sourceId: 'base', sourceLayer: 'buildings', filter: ['==', ['get', 'ref'], 'b-8'], tiles })
    expect(filtered.map(feature => feature.id)).toEqual([8])
    expect(filtered[0]!.geometry.type).toBe('Polygon')
  })
})

/** A feature as `earth.queryRenderedFeatures` gives it. */
function renderedFeature(layer: string, id: number, setFeatureState = vi.fn()): RenderedFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {},
    source: 'base',
    sourceLayer: layer,
    state: {},
    layer: { id: layer, type: 'fill' },
    mapStyleSource: { setFeatureState } as unknown as RenderedFeature['mapStyleSource'],
  }
}

function pointerEvent(type: string, xPixels = 10): EarthPointerEvent & { type: string } {
  return { type, screen: { xPixels, yPixels: 10 }, geographic: null, originalEvent: {} as MouseEvent }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('layer events', () => {
  it('calls listeners only over features of their layers, with those features', async () => {
    const earth = new Earth()
    const features = [renderedFeature('roads', 1), renderedFeature('water', 2)]
    const query = vi.spyOn(earth, 'queryRenderedFeatures').mockResolvedValue(features)
    const roads: LayerPointerEvent[] = []
    const parks: LayerPointerEvent[] = []
    earth.layerEvents.addEventListener('click', event => roads.push(event), { layers: ['roads'] })
    earth.layerEvents.addEventListener('click', event => parks.push(event), { layers: ['parks'] })
    earth.dispatchEvent(pointerEvent('click') as never)
    await flush()
    expect(query).toHaveBeenCalledTimes(1) // one query for every listener of the event
    expect(query.mock.calls[0]![1]!.layers).toEqual(['roads', 'parks'])
    expect(roads).toHaveLength(1)
    expect(roads[0]!.features.map(feature => feature.id)).toEqual([1])
    expect(roads[0]!.screen).toEqual({ xPixels: 10, yPixels: 10 })
    expect(parks).toEqual([])
  })

  it('fires pointerenter and pointerleave on crossing a layer, and leaves when the pointer exits the map', async () => {
    const earth = new Earth()
    let under: RenderedFeature[] = []
    vi.spyOn(earth, 'queryRenderedFeatures').mockImplementation(async () => under)
    const events: string[] = []
    earth.layerEvents.addEventListener('pointerenter', event => events.push(`enter ${event.features.length}`), { layers: ['water'] })
    earth.layerEvents.addEventListener('pointerleave', event => events.push(`leave ${event.features.length}`), { layers: ['water'] })
    const move = async () => {
      earth.dispatchEvent(pointerEvent('pointermove') as never)
      await flush()
    }
    await move()
    under = [renderedFeature('water', 1)]
    await move()
    under = [renderedFeature('water', 2)]
    await move() // another feature of the same layer: no new enter
    under = []
    await move()
    under = [renderedFeature('water', 1)]
    await move()
    earth.dispatchEvent(pointerEvent('pointerout') as never)
    expect(events).toEqual(['enter 1', 'leave 0', 'enter 1', 'leave 0'])
  })

  it('keeps one move query in flight and queries the latest move next', async () => {
    const earth = new Earth()
    const resolvers: Array<(features: RenderedFeature[]) => void> = []
    const query = vi.spyOn(earth, 'queryRenderedFeatures').mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    earth.layerEvents.addEventListener('pointermove', () => {}, { layers: ['water'] })
    for (let x = 0; x < 5; x++) earth.dispatchEvent(pointerEvent('pointermove', x) as never)
    expect(query).toHaveBeenCalledTimes(1)
    resolvers.shift()!([])
    await flush()
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0]).toEqual({ xPixels: 4, yPixels: 10 })
  })

  it('queries each tolerance apart, so one listener’s tolerance does not reach another', async () => {
    const earth = new Earth()
    const query = vi.spyOn(earth, 'queryRenderedFeatures').mockImplementation(async (_screen, options) => (options?.tolerancePixels === 12 ? [renderedFeature('roads', 1), renderedFeature('pois', 2)] : []))
    const pois: LayerPointerEvent[] = []
    const roads: LayerPointerEvent[] = []
    earth.layerEvents.addEventListener('click', event => roads.push(event), { layers: ['roads'], tolerancePixels: 12 })
    earth.layerEvents.addEventListener('click', event => pois.push(event), { layers: ['pois'] })
    earth.dispatchEvent(pointerEvent('click') as never)
    await flush()
    expect(query).toHaveBeenCalledTimes(2)
    expect(roads).toHaveLength(1)
    expect(pois).toEqual([]) // the poi was only within 12 pixels
  })

  it('clears hover state when the earth is disposed', async () => {
    const earth = new Earth()
    const setFeatureState = vi.fn()
    vi.spyOn(earth, 'queryRenderedFeatures').mockResolvedValue([renderedFeature('water', 1, setFeatureState)])
    earth.layerEvents.addHoverState(['water'])
    earth.dispatchEvent(pointerEvent('pointermove') as never)
    await flush()
    earth.dispose()
    expect(setFeatureState.mock.calls.map(([, state]) => state.hover)).toEqual([true, false])
  })

  it('stops listening to the earth once the last listener is removed', async () => {
    const earth = new Earth()
    const query = vi.spyOn(earth, 'queryRenderedFeatures').mockResolvedValue([])
    const remove = earth.layerEvents.addEventListener('click', () => {}, { layers: ['roads'] })
    remove()
    earth.dispatchEvent(pointerEvent('click') as never)
    await flush()
    expect(query).not.toHaveBeenCalled()
    expect(() => earth.layerEvents.addEventListener('click', () => {}, { layers: [] })).toThrow(/at least one style layer/)
  })

  it('sets and clears hover feature-state on the top-most feature', async () => {
    const earth = new Earth()
    const setFeatureState = vi.fn()
    let under: RenderedFeature[] = []
    vi.spyOn(earth, 'queryRenderedFeatures').mockImplementation(async () => under)
    const remove = earth.layerEvents.addHoverState(['water'])
    const move = async () => {
      earth.dispatchEvent(pointerEvent('pointermove') as never)
      await flush()
    }
    under = [renderedFeature('water', 1, setFeatureState), renderedFeature('water', 2, setFeatureState)]
    await move()
    await move() // still the same feature: nothing to do
    under = [renderedFeature('water', 2, setFeatureState)]
    await move()
    under = []
    await move()
    under = [renderedFeature('water', 3, setFeatureState)]
    await move()
    remove()
    const calls = setFeatureState.mock.calls.map(([feature, state]) => `${feature.id} ${state.hover}`)
    expect(calls).toEqual(['1 true', '1 false', '2 true', '2 false', '3 true', '3 false'])
    expect(setFeatureState.mock.calls[0]![0]).toEqual({ source: 'base', sourceLayer: 'water', id: 1 })
  })

  it('shows a cursor over a layer and restores the element’s own', async () => {
    const earth = new Earth()
    const element = { style: { cursor: 'grab' } } as unknown as HTMLElement
    Object.defineProperty(earth, 'pointerEventsElement', { get: () => element })
    let under: RenderedFeature[] = []
    vi.spyOn(earth, 'queryRenderedFeatures').mockImplementation(async () => under)
    const remove = earth.layerEvents.addCursor(['water'])
    under = [renderedFeature('water', 1)]
    earth.dispatchEvent(pointerEvent('pointermove') as never)
    await flush()
    expect(element.style.cursor).toBe('pointer')
    remove()
    expect(element.style.cursor).toBe('grab')
  })
})
