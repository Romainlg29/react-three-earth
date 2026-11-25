import type { Feature, FeatureCollection } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { MapStyleSource } from '../src/core/sources.js'
import { GeoJsonSource } from '../src/vector/GeoJsonSource.js'
import { MapStyle } from '../src/vector/MapStyle.js'
import { featureKey } from '../src/vector/worker/featureState.js'
import { applyGeoJsonDiff, featureRectangles, geoJsonBounds } from '../src/vector/worker/geoJsonData.js'
import { GEOJSON_LAYER } from '../src/vector/worker/geoJsonSource.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { tileOverlapsWithMargin } from '../src/vector/worker/rectangles.js'
import { applyStyleCommand, copyStyleDocument } from '../src/vector/worker/styleDocument.js'
import type { MercatorRectangle } from '../src/vector/worker/rectangles.js'
import type { StyleCommand, TileBucket } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'

const point = (id: string | number, longitude: number, latitude: number, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [longitude, latitude] },
  properties,
})
const collection = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features })

const square: Feature = {
  type: 'Feature',
  id: 'square',
  geometry: { type: 'Polygon', coordinates: [[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]] },
  properties: { kind: 'park' },
}
const route: Feature = {
  type: 'Feature',
  id: 'route',
  geometry: { type: 'LineString', coordinates: [[-100, 10], [100, 10]] },
  properties: {},
}

async function createProcessor(sources: Record<string, object>, layers: object[], files: Record<string, object> = {}) {
  const { fetch } = createFakeFetch(files)
  return MapStyleProcessor.create(
    { style: { version: 8, sources, layers }, baseUrl: 'https://maps.test/', requestHeaders: {}, localFontFamily: 'sans-serif' },
    { fetch, drawLocalGlyph: () => null },
  )
}

/** The cluster_id of the first cluster in the source's zoom 0 tile. */
async function clusterIdAt(processor: MapStyleProcessor): Promise<number> {
  const tile = await (processor as unknown as { getRawTile(source: string, x: number, y: number, z: number): Promise<{ layers: Record<string, { length: number; feature(index: number): { properties: Record<string, unknown> } }> } | null> }).getRawTile('stations', 0, 0, 0)
  const layer = tile!.layers[GEOJSON_LAYER]!
  for (let index = 0; index < layer.length; index++) {
    const properties = layer.feature(index).properties
    if (properties['cluster'] === true) return properties['cluster_id'] as number
  }
  throw new Error('no cluster')
}

/** Distinct baked RGBA colours of a bucket's shape vertices. */
function colors(bucket: TileBucket): Set<string> {
  const result = new Set<string>()
  const shapes = bucket.shapes!
  for (let vertex = 0; vertex < shapes.colors.length / 4; vertex++) result.add([...shapes.colors.subarray(vertex * 4, vertex * 4 + 4)].join(','))
  return result
}

describe('GeoJSON data helpers', () => {
  it('applies a diff in MapLibre order: removeAll, remove, add, update', () => {
    const features = [point(1, 0, 0, { name: 'a' }), point(2, 1, 1, { name: 'b', speed: 3 })]
    const applied = applyGeoJsonDiff(
      features,
      { remove: [1], add: [point(3, 2, 2)], update: [{ id: 2, newGeometry: { type: 'Point', coordinates: [5, 5] }, removeProperties: ['speed'], addOrUpdateProperties: [{ key: 'name', value: 'c' }] }] },
      undefined,
      'test',
    )
    expect(applied.features.map(feature => feature.id)).toEqual([2, 3])
    expect(applied.features[0]!.properties).toEqual({ name: 'c' })
    expect((applied.features[0]!.geometry as { coordinates: number[] }).coordinates).toEqual([5, 5])
    expect(applied.before.map(feature => feature.id)).toEqual([1, 2])
    expect(applied.after.map(feature => feature.id)).toEqual([3, 2])
    // The input is not changed
    expect(features[1]!.properties).toEqual({ name: 'b', speed: 3 })
  })

  it('chains diffs through the id index of the previous result without changing earlier lists', () => {
    const first = applyGeoJsonDiff([point(1, 0, 0)], { add: [point(2, 1, 1)] }, undefined, 'points').features
    const second = applyGeoJsonDiff(first, { remove: [1] }, undefined, 'points').features
    expect(first.map(feature => feature.id)).toEqual([1, 2])
    expect(second.map(feature => feature.id)).toEqual([2])
    // The first list's index went to the second diff: a diff on the first list again starts from its own features
    expect(applyGeoJsonDiff(first, { remove: [2] }, undefined, 'points').features.map(feature => feature.id)).toEqual([1])
    expect(applyGeoJsonDiff(second, { add: [point(3, 2, 2)] }, undefined, 'points').features.map(feature => feature.id)).toEqual([2, 3])
    // A list changed in place is indexed again
    const third = applyGeoJsonDiff([point(1, 0, 0)], { add: [point(2, 1, 1)] }, undefined, 'points').features
    third.push(point(4, 3, 3))
    expect(applyGeoJsonDiff(third, { remove: [1] }, undefined, 'points').features.map(feature => feature.id)).toEqual([2, 4])
  })

  it('matches features by the promoted property and states the fix for a missing id', () => {
    const features = [point('x', 0, 0, { code: 'A' })]
    expect(applyGeoJsonDiff(features, { remove: ['A'] }, 'code', 'test').features).toEqual([])
    expect(() => applyGeoJsonDiff([{ ...square, id: undefined }], { remove: [1] }, undefined, 'parks')).toThrow(/give every feature an `id`/)
    expect(() => applyGeoJsonDiff(features, { update: [{ id: 'nope' }] }, undefined, 'test')).toThrow(/no feature with id "nope"/)
  })

  it('bounds features, and splits rectangles at the antimeridian', () => {
    expect(geoJsonBounds([square, route])).toEqual([-100, -20, 100, 20])
    const crossing: Feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[170, 0], [190, 0]] }, properties: {} }
    const rectangles = featureRectangles([crossing])
    expect(rectangles).toHaveLength(2)
    expect(rectangles[0]!.maximumX).toBe(1)
    expect(rectangles[1]!.minimumX).toBe(0)
  })

  it('widens tiles by their buffer when matching changed areas, across the antimeridian too', () => {
    // A point just east of tile (1, 0, 1)'s west edge (x = 0.5) matches tile (0, 0, 1) only with a margin
    const area: MercatorRectangle[] = [{ minimumX: 0.501, minimumY: 0.75, maximumX: 0.501, maximumY: 0.75 }]
    expect(tileOverlapsWithMargin(0, 0, 1, area, 0)).toBe(false)
    expect(tileOverlapsWithMargin(0, 0, 1, area, 0.25)).toBe(true)
    const nearAntimeridian: MercatorRectangle[] = [{ minimumX: 0.999, minimumY: 0.75, maximumX: 1, maximumY: 0.751 }]
    expect(tileOverlapsWithMargin(0, 0, 1, nearAntimeridian, 0.25)).toBe(true)
  })
})

describe('GeoJSON sources in the worker', () => {
  it('tiles polygons and lines, read by every layer of the source whatever its source-layer', async () => {
    const processor = await createProcessor(
      { shapes: { type: 'geojson', data: collection(square, route) } },
      [
        { id: 'parks', type: 'fill', source: 'shapes', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#00ff00' } },
        { id: 'routes', type: 'line', source: 'shapes', 'source-layer': 'ignored', paint: { 'line-color': '#ff0000', 'line-width': 4 } },
      ],
    )
    expect(processor.summary.sources).toEqual([{ id: 'shapes', minimumZoom: 0, maximumZoom: 18 }])
    const bucket = await processor.processTile({ sourceId: 'shapes', x: 0, y: 0, z: 0, zoom: 0 })
    expect(colors(bucket)).toEqual(new Set(['0,255,0,255', '255,0,0,255']))
    // A tile far from the data (zoom 4, top-left corner) is empty
    const empty = await processor.processTile({ sourceId: 'shapes', x: 0, y: 0, z: 4, zoom: 4 })
    expect(empty.shapes).toBeNull()
  })

  it('loads data from a URL through the style fetch, relative to the style', async () => {
    const processor = await createProcessor({ remote: { type: 'geojson', data: 'data/points.geojson' } }, [{ id: 'dots', type: 'circle', source: 'remote' }], {
      'https://maps.test/data/points.geojson': collection(point(1, 0, 0)),
    })
    const bucket = await processor.processTile({ sourceId: 'remote', x: 0, y: 0, z: 0, zoom: 0 })
    expect(bucket.shapes).not.toBeNull()
  })

  it('applies the source filter before tiling', async () => {
    const processor = await createProcessor(
      { shapes: { type: 'geojson', data: collection(square, route), filter: ['==', ['get', 'kind'], 'park'] } },
      [{ id: 'all', type: 'line', source: 'shapes', paint: { 'line-color': '#ff0000' } }],
    )
    const bucket = await processor.processTile({ sourceId: 'shapes', x: 0, y: 0, z: 0, zoom: 0 })
    // Only the square's outline: its ring lies within 20° of the centre
    const positions = bucket.shapes!.positions
    for (let index = 0; index < positions.length; index += 2) expect(Math.abs(positions[index]! - 2048)).toBeLessThan(400)
  })

  it('promotes a property to the feature id for feature-state, with no source layer in the key', async () => {
    const processor = await createProcessor(
      { places: { type: 'geojson', data: collection(point('a', 0, 0, { code: 'P1' })), promoteId: 'code' } },
      [{ id: 'dots', type: 'circle', source: 'places', paint: { 'circle-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff0000', '#0000ff'] } }],
    )
    const bucket = await processor.processTile({ sourceId: 'places', x: 0, y: 0, z: 0, zoom: 0 })
    expect(bucket.featureStateKeys).toEqual([featureKey('places', undefined, 'P1')])
  })

  it('clusters points, with point_count, cluster properties and cluster queries', async () => {
    const data = collection(point(1, 10, 10, { seats: 2 }), point(2, 10.5, 10.2, { seats: 3 }), point(3, 10.2, 10.4, { seats: 5 }), point(4, -120, -40, { seats: 7 }))
    const processor = await createProcessor(
      { stations: { type: 'geojson', data, cluster: true, clusterRadius: 50, clusterMaxZoom: 14, clusterProperties: { seats: ['+', ['get', 'seats']] } } },
      [{ id: 'clusters', type: 'circle', source: 'stations', filter: ['has', 'point_count'], paint: { 'circle-color': '#ff0000' } }],
    )
    const tile = await (processor as unknown as { getRawTile(source: string, x: number, y: number, z: number): Promise<{ layers: Record<string, { length: number; feature(index: number): { properties: Record<string, unknown> } }> } | null> }).getRawTile('stations', 0, 0, 0)
    const layer = tile!.layers[GEOJSON_LAYER]!
    const features = Array.from({ length: layer.length }, (_, index) => layer.feature(index).properties)
    const cluster = features.find(properties => properties['cluster'] === true)!
    expect(cluster['point_count']).toBe(3)
    expect(cluster['seats']).toBe(10)
    expect(features.filter(properties => properties['cluster'] !== true)).toEqual([{ seats: 7 }])

    const clusterId = cluster['cluster_id'] as number
    const expansionZoom = (await processor.querySource('stations', { kind: 'clusterExpansionZoom', clusterId })) as number
    expect(expansionZoom).toBeGreaterThan(0)
    const leaves = (await processor.querySource('stations', { kind: 'clusterLeaves', clusterId, limit: Infinity, offset: 0 })) as Feature[]
    expect(leaves.map(leaf => leaf.id).sort()).toEqual([1, 2, 3])
    const children = (await processor.querySource('stations', { kind: 'clusterChildren', clusterId })) as Feature[]
    expect(children.length).toBeGreaterThan(0)
    await expect(processor.querySource('stations', { kind: 'clusterChildren', clusterId: 123456 })).rejects.toThrow(/has no cluster 123456/)
    // The circle layer only draws the cluster
    const bucket = await processor.processTile({ sourceId: 'stations', x: 0, y: 0, z: 0, zoom: 0 })
    expect(bucket.shapes).not.toBeNull()
  })

  it('clusters each point of a MultiPoint, and widens changed areas by the cluster radius', async () => {
    const multi: Feature = { type: 'Feature', id: 'pair', geometry: { type: 'MultiPoint', coordinates: [[10, 10], [10.1, 10.1]] }, properties: {} }
    const processor = await createProcessor({ stations: { type: 'geojson', data: collection(multi), cluster: true, buffer: 0, clusterRadius: 200 } }, [{ id: 'dots', type: 'circle', source: 'stations' }])
    const leaves = (await processor.querySource('stations', { kind: 'clusterLeaves', clusterId: await clusterIdAt(processor), limit: Infinity, offset: 0 })) as Feature[]
    expect(leaves).toHaveLength(2)
    const result = await processor.applyCommands([{ command: 'setGeoJSONSourceData', args: ['stations', collection()] }])
    expect(result.rebuiltAreas![0]!.marginTiles).toBe(200 / 512)
  })

  it('answers feature queries on its single layer, keyed for feature-state without a source layer', async () => {
    const processor = await createProcessor({ parks: { type: 'geojson', data: collection(square) } }, [{ id: 'park-fill', type: 'fill', source: 'parks' }])
    processor.applyFeatureStates([{ key: featureKey('parks', undefined, 'square'), state: { picked: true } }])
    const tile = { sourceId: 'parks', x: 0, y: 0, z: 0, zoom: 0, column: 0, labelsOnly: false }
    const hits = await processor.queryRenderedFeatures({ geometry: [{ x: 0.5, y: 0.5 }], tiles: [tile], layers: null, filter: null, tolerancePixels: 0 })
    expect(hits.map(hit => [hit.id, hit.layer.id, hit.state])).toEqual([['square', 'park-fill', { picked: true }]])
    const geometry = hits[0]!.geometry
    expect(geometry.type).toBe('Polygon')
    const ring = (geometry as { coordinates: number[][][] }).coordinates[0]!
    expect(Math.max(...ring.map(([longitude]) => longitude!))).toBeCloseTo(20, 1)
    const features = await processor.querySourceFeatures({ sourceId: 'parks', sourceLayer: null, filter: ['==', ['get', 'kind'], 'park'], tiles: [{ x: 0, y: 0, z: 0 }] })
    expect(features.map(feature => feature.id)).toEqual(['square'])
  })

  it('answers queries on a source no layer reads, and states the fix for an unclustered source', async () => {
    const processor = await createProcessor({ plain: { type: 'geojson', data: collection(point(1, 0, 0)) } }, [])
    await expect(processor.querySource('plain', { kind: 'clusterExpansionZoom', clusterId: 1 })).rejects.toThrow(/set `cluster: true`/)
    await expect(processor.querySource('missing', { kind: 'clusterExpansionZoom', clusterId: 1 })).rejects.toThrow(/no source "missing"/)
  })

  it('answers where tiles changed after setData: where the old and the new data lie', async () => {
    const processor = await createProcessor({ shapes: { type: 'geojson', data: collection(point(1, -170, 0)) } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    const result = await processor.applyCommands([{ command: 'setGeoJSONSourceData', args: ['shapes', collection(point(1, 170, 0))] }])
    expect(result.rebuiltSources).toEqual([])
    expect(result.rebuiltAreas).toHaveLength(1)
    const [area] = result.rebuiltAreas!
    expect(area!.sourceId).toBe('shapes')
    expect(area!.marginTiles).toBe(0.25)
    const xs = area!.rectangles!.map(rectangle => rectangle.minimumX)
    expect(xs.some(x => x < 0.03)).toBe(true) // the old point, near 170° W
    expect(xs.some(x => x > 0.97)).toBe(true) // the new one, near 170° E
    // The new data is drawn: the tile around 170° E at zoom 4 has a circle, the old one's tile (170° W) has none
    expect((await processor.processTile({ sourceId: 'shapes', x: 15, y: 7, z: 4, zoom: 4 })).shapes).not.toBeNull()
    expect((await processor.processTile({ sourceId: 'shapes', x: 0, y: 7, z: 4, zoom: 4 })).shapes).toBeNull()
  })

  it('answers only the changed features’ areas after updateData, and the whole data when clustered', async () => {
    const data = collection(point(1, -150, 0), point(2, 150, 0))
    const plain = await createProcessor({ shapes: { type: 'geojson', data } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    const command: StyleCommand = { command: 'updateGeoJSONSourceData', args: ['shapes', { update: [{ id: 2, newGeometry: { type: 'Point', coordinates: [140, 10] } }] }] }
    const result = await plain.applyCommands([command])
    const rectangles = result.rebuiltAreas![0]!.rectangles!
    expect(rectangles.length).toBe(2) // the point before and after its move
    expect(rectangles.every(rectangle => rectangle.minimumX > 0.8)).toBe(true)

    const clustered = await createProcessor({ shapes: { type: 'geojson', data, cluster: true } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    const clusteredResult = await clustered.applyCommands([command])
    const box = clusteredResult.rebuiltAreas![0]!.rectangles!
    expect(box.some(rectangle => rectangle.minimumX < 0.1)).toBe(true) // clusters can move anywhere in the data
  })

  it('hides features by id without tiling again, redrawing only around them, and keeps them across a reload', async () => {
    const data = collection(point(1, -150, 0), point(2, 150, 0))
    const processor = await createProcessor({ shapes: { type: 'geojson', data } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    const east = { sourceId: 'shapes', x: 14, y: 7, z: 4, zoom: 4 }
    expect((await processor.processTile(east)).shapes).not.toBeNull()
    const hide = await processor.applyCommands([{ command: 'setGeoJSONSourceHiddenFeatures', args: ['shapes', [2]] }])
    const rectangles = hide.rebuiltAreas![0]!.rectangles!
    expect(rectangles.length).toBe(1)
    expect(rectangles[0]!.minimumX).toBeGreaterThan(0.8) // around the hidden point only
    expect((await processor.processTile(east)).shapes).toBeNull()
    // An update of a hidden feature changes the data, and it stays hidden until shown
    await processor.applyCommands([{ command: 'updateGeoJSONSourceData', args: ['shapes', { update: [{ id: 2, newGeometry: { type: 'Point', coordinates: [140, 10] } }] }] }])
    expect((await processor.processTile(east)).shapes).toBeNull()
    await processor.applyCommands([{ command: 'setGeoJSONSourceHiddenFeatures', args: ['shapes', []] }])
    expect((await processor.processTile({ sourceId: 'shapes', x: 14, y: 7, z: 4, zoom: 4 })).shapes).not.toBeNull()
    // Promoted ids hide by their property
    const promoted = await createProcessor({ shapes: { type: 'geojson', data: collection(point('a', 0, 0, { code: 7 })), promoteId: 'code', hiddenFeatureIds: [7] } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    expect((await promoted.processTile({ sourceId: 'shapes', x: 0, y: 0, z: 0, zoom: 0 })).shapes).toBeNull()
    // With generateId, tiles number features by index: the hidden one is found by its own id all the same
    const generated = await createProcessor({ shapes: { type: 'geojson', data: collection(point('west', -150, 0), point('east', 150, 0)), generateId: true, hiddenFeatureIds: ['east'] } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    expect((await generated.processTile(east)).shapes).toBeNull()
    expect((await generated.processTile({ sourceId: 'shapes', x: 1, y: 7, z: 4, zoom: 4 })).shapes).not.toBeNull()
    await generated.applyCommands([{ command: 'updateGeoJSONSourceData', args: ['shapes', { remove: ['west'] }] }])
    expect((await generated.processTile(east)).shapes).toBeNull() // its index changed with the data
  })

  it('keeps the previous data when a new URL fails, and reports it', async () => {
    const processor = await createProcessor({ shapes: { type: 'geojson', data: collection(point(1, 0, 0)) } }, [{ id: 'dots', type: 'circle', source: 'shapes' }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await processor.applyCommands([{ command: 'setGeoJSONSourceData', args: ['shapes', 'missing.geojson'] }])
    warn.mockRestore()
    expect(result.errors[0]).toMatch(/keeps the previous data/)
    expect((await processor.processTile({ sourceId: 'shapes', x: 0, y: 0, z: 0, zoom: 0 })).shapes).not.toBeNull()
  })

  it('colours lines along their length with line-gradient and lineMetrics, continuing across tiles', async () => {
    const processor = await createProcessor(
      { routes: { type: 'geojson', data: collection(route), lineMetrics: true } },
      [
        {
          id: 'route',
          type: 'line',
          source: 'routes',
          paint: { 'line-width': 6, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#0000ff'] },
        },
      ],
    )
    const whole = await processor.processTile({ sourceId: 'routes', x: 0, y: 0, z: 0, zoom: 0 })
    const wholeColors = [...colors(whole)].map(color => color.split(',').map(Number))
    expect(wholeColors.length).toBeGreaterThan(20)
    expect(wholeColors.some(([r, , b]) => r! > 240 && b! < 15)).toBe(true)
    expect(wholeColors.some(([r, , b]) => b! > 240 && r! < 15)).toBe(true)
    // At zoom 1, the west tile holds the first half and its buffer (up to 45° E: progress 0.725), the east tile the
    // rest from its buffer (from 45° W: progress 0.275): the colours continue across the tiles
    const blues = async (x: number) => [...colors(await processor.processTile({ sourceId: 'routes', x, y: 0, z: 1, zoom: 1 }))].map(color => Number(color.split(',')[2]))
    const west = await blues(0)
    const east = await blues(1)
    expect(Math.min(...west)).toBeLessThan(5)
    expect(Math.max(...west)).toBeGreaterThan(175)
    expect(Math.max(...west)).toBeLessThan(195)
    expect(Math.min(...east)).toBeGreaterThan(60)
    expect(Math.min(...east)).toBeLessThan(80)
    expect(Math.max(...east)).toBeGreaterThan(250)
  })

  it('draws a line-gradient layer with line-color when the source has no line metrics', async () => {
    const processor = await createProcessor(
      { routes: { type: 'geojson', data: collection(route) } },
      [{ id: 'route', type: 'line', source: 'routes', paint: { 'line-color': '#00ff00', 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#0000ff'] } }],
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bucket = await processor.processTile({ sourceId: 'routes', x: 0, y: 0, z: 0, zoom: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lineMetrics: true/))
    warn.mockRestore()
    expect(colors(bucket)).toEqual(new Set(['0,255,0,255']))
  })
})

describe('GeoJSON in the style document and MapStyle', () => {
  it('sets and updates data in the document, and refuses updates to URL data with the fix', () => {
    const document = copyStyleDocument({ version: 8, sources: { points: { type: 'geojson', data: collection(point(1, 0, 0)) }, remote: { type: 'geojson', data: 'a.geojson' } }, layers: [] })
    applyStyleCommand(document, { command: 'updateGeoJSONSourceData', args: ['points', { add: [point(2, 1, 1)] }] })
    expect((document.sources['points']!['data'] as FeatureCollection).features.map(feature => feature.id)).toEqual([1, 2])
    applyStyleCommand(document, { command: 'setGeoJSONSourceData', args: ['points', collection()] })
    expect((document.sources['points']!['data'] as FeatureCollection).features).toEqual([])
    expect(() => applyStyleCommand(document, { command: 'updateGeoJSONSourceData', args: ['remote', { remove: [1] }] })).toThrow(/Fetch the GeoJSON in the app/)
    expect(() => applyStyleCommand(document, { command: 'setGeoJSONSourceData', args: ['nope', collection()] })).toThrow(/no source "nope"/)
  })

  it('keeps data by reference and diffs setStyle data changes into setGeoJSONSourceData', async () => {
    const data = collection(point(1, 0, 0))
    const style = new MapStyle({ style: { version: 8, sources: { points: { type: 'geojson', data } }, layers: [] }, baseUrl: 'https://maps.test/' })
    await style.load()
    const commands: StyleCommand[] = []
    style.subscribe(batch => commands.push(...batch.flatMap(({ change }) => (change.type === 'command' ? [change.command] : []))))
    const next = collection(point(2, 1, 1))
    style.setGeoJsonSourceData('points', next)
    await Promise.resolve()
    expect(commands[0]!.args[1]).toBe(next)
    await style.setStyle({ version: 8, sources: { points: { type: 'geojson', data: collection(point(3, 2, 2)) } }, layers: [] })
    await Promise.resolve()
    expect(commands.map(command => command.command)).toEqual(['setGeoJSONSourceData', 'setGeoJSONSourceData'])
  })

  it('routes cluster queries to a renderer after the changes made before them, and after a pending setStyle', async () => {
    const style = new MapStyle({ style: { version: 8, sources: { points: { type: 'geojson', data: collection() } }, layers: [] }, baseUrl: 'https://maps.test/' })
    await style.load()
    const order: string[] = []
    style.subscribe(batch => order.push(...batch.map(({ change }) => (change.type === 'command' ? change.command.command : change.type))))
    style.attachSourceQueryHandler(async () => {
      order.push('query')
      return 7
    })
    // The same task: the change reaches the renderers before the query does
    style.setGeoJsonSourceData('points', collection(point(1, 0, 0)))
    await expect(style.querySource('points', { kind: 'clusterExpansionZoom', clusterId: 1 })).resolves.toBe(7)
    expect(order).toEqual(['setGeoJSONSourceData', 'query'])

    // A setStyle in progress holds the data change: the query waits for both
    order.length = 0
    const restyled = style.setStyle({ version: 8, sources: { points: { type: 'geojson', data: collection() } }, layers: [{ id: 'dots', type: 'circle', source: 'points' }] })
    style.setGeoJsonSourceData('points', collection(point(2, 0, 0)))
    const answer = style.querySource('points', { kind: 'clusterExpansionZoom', clusterId: 1 })
    await restyled
    await answer
    expect(order.at(-1)).toBe('query')
    expect(order.indexOf('setGeoJSONSourceData')).toBeLessThan(order.indexOf('query'))
    await expect(style.querySource('nope', { kind: 'clusterExpansionZoom', clusterId: 1 })).rejects.toThrow(/no source "nope"/)
  })

  it('keys a geojson feature’s state without a source layer, whatever the app passes', async () => {
    const style = new MapStyle({ style: { version: 8, sources: { points: { type: 'geojson', data: collection(point(1, 0, 0)) } }, layers: [] }, baseUrl: 'https://maps.test/' })
    await style.load()
    style.setFeatureState({ source: 'points', sourceLayer: 'whatever', id: 1 }, { hover: true })
    expect(style.getFeatureState({ source: 'points', id: 1 })).toEqual({ hover: true })
    style.removeFeatureState({ source: 'points', sourceLayer: 'other' })
    expect(style.getFeatureState({ source: 'points', id: 1 })).toEqual({})
  })
})

describe('GeoJsonSource', () => {
  async function setUp() {
    const source = new MapStyleSource({
      style: { version: 8, sources: { route: { type: 'geojson', data: collection() } }, layers: [{ id: 'route-line', type: 'line', source: 'route' }] },
      baseUrl: 'https://maps.test/',
    })
    await source.getMapStyle().load()
    return source
  }

  it('replaces a style source of the same id, its layers still reading it, and maps options to MapLibre names', async () => {
    const source = await setUp()
    const geoJson = new GeoJsonSource({ id: 'route', data: collection(route), lineMetrics: true, clusterRadiusPixels: 30, bufferPixels: 64, maximumZoom: 12 })
    source.addGeoJsonSource(geoJson)
    expect(source.getSource('route')).toMatchObject({ type: 'geojson', lineMetrics: true, clusterRadius: 30, buffer: 64, maxzoom: 12 })
    expect(source.getLayerIds()).toEqual(['route-line'])
  })

  it('sends a new data object with setData and other option changes as a replaced source', async () => {
    const source = await setUp()
    const commands: string[] = []
    source.getMapStyle().subscribe(batch => commands.push(...batch.map(({ change }) => (change.type === 'command' ? change.command.command : change.type))))
    const data = collection(route)
    const geoJson = new GeoJsonSource({ id: 'route', data })
    geoJson.addTo(source)
    geoJson.update({ id: 'route', data })
    geoJson.update({ id: 'route', data: collection() })
    geoJson.update({ id: 'route', data: collection(), cluster: true })
    await Promise.resolve()
    expect(commands).toEqual(['setSource', 'setGeoJSONSourceData', 'setSource'])
  })

  it('folds updateData into its data, so adding it again keeps the changes', async () => {
    const source = await setUp()
    const geoJson = new GeoJsonSource({ id: 'route', data: collection(point(1, 0, 0)) })
    geoJson.addTo(source)
    geoJson.updateData({ add: [point(2, 1, 1)] })
    expect((geoJson.data as FeatureCollection).features.map(feature => feature.id)).toEqual([1, 2])
    expect(() => new GeoJsonSource({ id: 'remote', data: 'a.geojson' }).updateData({ remove: [1] })).toThrow(/loads its data from a URL/)
  })

  it('hides features in the style source, keeping them in its data, and carries the ids into a replaced source', async () => {
    const source = await setUp()
    const commands: string[] = []
    source.getMapStyle().subscribe(batch => commands.push(...batch.map(({ change }) => (change.type === 'command' ? change.command.command : change.type))))
    const geoJson = new GeoJsonSource({ id: 'route', data: collection(point(1, 0, 0), point(2, 1, 1)) })
    geoJson.addTo(source)
    geoJson.setHiddenFeatureIds([2])
    geoJson.setHiddenFeatureIds([2])
    expect(source.getSource('route')).toMatchObject({ hiddenFeatureIds: [2] })
    expect((geoJson.data as FeatureCollection).features).toHaveLength(2)
    geoJson.update({ id: 'route', data: geoJson.data, cluster: true })
    expect(source.getSource('route')).toMatchObject({ hiddenFeatureIds: [2], cluster: true })
    geoJson.setHiddenFeatureIds([])
    expect(source.getSource('route')).not.toHaveProperty('hiddenFeatureIds')
    await Promise.resolve()
    expect(commands).toEqual(['setSource', 'setGeoJSONSourceHiddenFeatures', 'setSource', 'setGeoJSONSourceHiddenFeatures'])
  })

  it('keeps updateData changes when only other options change', async () => {
    const source = await setUp()
    const data = collection(point(1, 0, 0))
    const geoJson = new GeoJsonSource({ id: 'route', data })
    geoJson.addTo(source)
    geoJson.updateData({ add: [point(2, 1, 1)] })
    // A React re-render passes the same data object again
    geoJson.update({ id: 'route', data })
    geoJson.update({ id: 'route', data, cluster: true })
    const ids = (source.getSource('route') as { data: FeatureCollection }).data.features.map(feature => feature.id)
    expect(ids).toEqual([1, 2])
    expect(data.features).toHaveLength(1) // the app's object is unchanged
    // A diff naming no feature throws to the caller and changes nothing
    expect(() => geoJson.updateData({ update: [{ id: 9, newGeometry: { type: 'Point', coordinates: [0, 0] } }] })).toThrow(/no feature with id 9/)
    expect((geoJson.data as FeatureCollection).features).toHaveLength(2)
  })

  it('removes a source added while the style still loads, once it has loaded', async () => {
    const source = new MapStyleSource({ style: { version: 8, sources: {}, layers: [] }, baseUrl: 'https://maps.test/' })
    const geoJson = new GeoJsonSource({ id: 'early', data: collection() })
    geoJson.addTo(source)
    geoJson.remove()
    await source.getMapStyle().load()
    await Promise.resolve()
    expect(source.getSource('early')).toBeUndefined()
  })

  it('survives setStyle, over the new style’s source of the same id', async () => {
    const source = await setUp()
    const data = collection(route)
    new GeoJsonSource({ id: 'route', data }).addTo(source)
    await source.setStyle({ version: 8, sources: { route: { type: 'geojson', data: collection() } }, layers: [{ id: 'route-line', type: 'line', source: 'route' }] })
    expect((source.getSource('route') as { data: FeatureCollection }).data.features).toHaveLength(1)
  })

  it('removes its source once the layers reading it are gone, and keeps it while the style still reads it', async () => {
    const source = await setUp()
    const added = new GeoJsonSource({ id: 'extra', data: collection() })
    added.addTo(source)
    source.addLayer({ id: 'extra-dots', type: 'circle', source: 'extra' })
    // React unmounts the source before its layers: the removal waits for the end of the task
    added.remove()
    source.removeLayer('extra-dots')
    await Promise.resolve()
    expect(source.getSource('extra')).toBeUndefined()
    const replacing = new GeoJsonSource({ id: 'route', data: collection(route) })
    replacing.addTo(source)
    replacing.remove()
    await Promise.resolve()
    expect(source.getSource('route')).toBeDefined()
  })

  it('states the fix for cluster queries before it is added', async () => {
    await expect(new GeoJsonSource({ id: 'points', data: collection() }).getClusterExpansionZoom(1)).rejects.toThrow(/call addTo\(mapStyleSource\) first/)
  })
})
