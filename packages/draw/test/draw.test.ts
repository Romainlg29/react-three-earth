import { GeoJsonSource } from '@earthkit/globe'
import type { Feature, FeatureCollection } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { Draw } from '../src/Draw.js'
import { FeatureStore } from '../src/FeatureStore.js'
import { closeRing, distanceMeters, fromMercator, geometryBounds, pointInPolygon, toMercator, triangulatePolygon, unwrapPositions, wrapLongitude } from '../src/geometry.js'
import { DrawMode, StaticMode, type DrawModeContext } from '../src/modes/DrawMode.js'
import { LineStringMode, PointMode, PolygonMode } from '../src/modes/PathModes.js'
import type { OverlayContent } from '../src/render/LiveOverlay.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

describe('geometry', () => {
  it('converts to Web Mercator and back', () => {
    const { x, y } = toMercator([2.35, 48.85])
    const [longitude, latitude] = fromMercator({ x, y })
    expect(longitude).toBeCloseTo(2.35, 9)
    expect(latitude).toBeCloseTo(48.85, 9)
    expect(toMercator([-180, 0])).toEqual({ x: 0, y: 0.5 })
  })

  it('keeps lines over the antimeridian continuous', () => {
    expect(unwrapPositions([[179, 0], [-179, 1], [-178, 2]])).toEqual([[179, 0], [181, 1], [182, 2]])
    expect(wrapLongitude(181)).toBe(-179)
    expect(wrapLongitude(180)).toBe(180)
  })

  it('measures great-circle distances', () => {
    // One degree of longitude on the equator.
    expect(distanceMeters([0, 0], [1, 0])).toBeCloseTo(111_195, -1)
  })

  it('triangulates polygons with holes, and tests points inside them', () => {
    const outer = closeRing([[0, 0], [10, 0], [10, 10], [0, 10]])
    const hole = closeRing([[4, 4], [6, 4], [6, 6], [4, 6]])
    const { vertices, indices } = triangulatePolygon([outer, hole])
    expect(vertices.length).toBe(16) // 8 positions, the closing ones dropped
    expect(indices.length).toBe(8 * 3) // 8 triangles around the hole
    expect(pointInPolygon([2, 2], [outer, hole])).toBe(true)
    expect(pointInPolygon([5, 5], [outer, hole])).toBe(false)
    expect(pointInPolygon([12, 5], [outer, hole])).toBe(false)
  })

  it('bounds geometries', () => {
    expect(geometryBounds({ type: 'LineString', coordinates: [[1, 2], [3, -4]] })).toEqual({ westDegrees: 1, southDegrees: -4, eastDegrees: 3, northDegrees: 2 })
  })
})

describe('FeatureStore', () => {
  const point = (id: string, longitude = 0): DrawFeature => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Point', coordinates: [longitude, 0] } })

  it('reports added, updated and removed features, and replaces its collection on each change', () => {
    const store = new FeatureStore()
    const changes: unknown[] = []
    store.subscribe(change => changes.push(change))
    store.set([point('a')])
    const first = store.toFeatureCollection()
    expect(store.toFeatureCollection()).toBe(first)
    store.set([point('a', 1), point('b')])
    expect(store.toFeatureCollection()).not.toBe(first)
    store.remove(['a', 'missing'])
    expect(changes).toEqual([
      { added: ['a'], updated: [], removed: [] },
      { added: ['b'], updated: ['a'], removed: [] },
      { added: [], updated: [], removed: [point('a', 1)] },
    ])
    expect(store.toFeatureCollection().features.map(feature => feature.id)).toEqual(['b'])
  })

  it('refuses features it cannot hold, stating the fix', () => {
    const store = new FeatureStore()
    expect(() => store.set([{ ...point('a'), id: '' }])).toThrow(/string `id`/)
    expect(() => store.set([{ type: 'Feature', id: 'm', properties: {}, geometry: { type: 'MultiPoint', coordinates: [] } } as unknown as DrawFeature])).toThrow(/split Multi/)
  })

  it('changes nothing when one feature of a batch is invalid', () => {
    const store = new FeatureStore()
    const changes = vi.fn()
    store.subscribe(changes)
    expect(() => store.set([point('a'), { ...point('b'), id: '' }])).toThrow()
    expect(store.size).toBe(0)
    expect(changes).not.toHaveBeenCalled()
  })
})

describe('Draw', () => {
  it('loads features the same way from the constructor as from addFeatures, numeric and missing ids included', () => {
    const draw = new Draw({
      createId: () => 'made',
      features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: null, geometry: { type: 'Point', coordinates: [1, 2] } }, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [3, 4] } }] },
    })
    expect(draw.getFeatures().features.map(feature => [feature.id, feature.properties])).toEqual([['7', {}], ['made', {}]])
  })
})

describe('Draw editing a GeoJSON source in place', () => {
  const pointFeature = (id: string | number | undefined, longitude: number, properties: Record<string, unknown> | null = {}): Feature => ({
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    properties,
    geometry: { type: 'Point', coordinates: [longitude, 0] },
  })
  const features = (source: GeoJsonSource) => (source.data as FeatureCollection).features

  /** A mode that shows some features live (as the select mode does with the selection). */
  class LiveMode extends DrawMode {
    readonly name = 'live'
    live: string[] = []
    override liveFeatureIds(): readonly string[] {
      return this.live
    }
  }

  it('holds the source’s own feature objects, and writes each change back by id', () => {
    const a = pointFeature('a', 1)
    const lines: Feature = { type: 'Feature', id: 'lines', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] } }
    const source = new GeoJsonSource({ id: 'places', data: { type: 'FeatureCollection', features: [a, pointFeature('b', 2), lines] } })
    const draw = new Draw({ source })
    expect(draw.getSource()).toBe(source)
    expect(draw.getFeature('a')).toBe(a) // no copy
    expect(draw.getFeatures().features.map(feature => feature.id)).toEqual(['a', 'b']) // the MultiLineString is not editable

    const updates = vi.spyOn(source, 'updateData')
    draw.addFeatures([{ ...pointFeature('a', 5), properties: { moved: true } } as never, pointFeature('c', 3) as never])
    draw.removeFeatures(['b'])
    expect(updates).toHaveBeenCalledTimes(2)
    expect(features(source).map(feature => feature.id)).toEqual(['a', 'lines', 'c'])
    expect(features(source)[0]).toMatchObject({ properties: { moved: true }, geometry: { coordinates: [5, 0] } })

    draw.setSource(null)
    expect(draw.getFeatures().features).toEqual([])
    expect(features(source)).toHaveLength(3) // the source keeps its data
  })

  it('gives features without an id one in a single setData, and keeps numeric ids numeric in the source', () => {
    const source = new GeoJsonSource({ id: 'places', data: { type: 'FeatureCollection', features: [pointFeature(7, 1, null), pointFeature(undefined, 2)] } })
    const setData = vi.spyOn(source, 'setData')
    const draw = new Draw({ source, createId: () => 'made' })
    expect(setData).toHaveBeenCalledTimes(1)
    expect(features(source).map(feature => feature.id)).toEqual([7, 'made'])
    expect(draw.getFeatures().features.map(feature => feature.id)).toEqual(['7', 'made'])
    draw.addFeatures([{ ...pointFeature('7', 9) } as never])
    expect(features(source).map(feature => feature.id)).toEqual([7, 'made'])
    expect((features(source)[0]!.geometry as { coordinates: number[] }).coordinates[0]).toBe(9)
    draw.removeFeatures(['7'])
    expect(features(source).map(feature => feature.id)).toEqual(['made'])
  })

  it('finds features by the promoted property, and gives new ones that property', () => {
    const source = new GeoJsonSource({ id: 'places', promoteId: 'code', data: { type: 'FeatureCollection', features: [pointFeature('x', 1, { code: 12 })] } })
    const draw = new Draw({ source })
    expect(draw.getFeatures().features.map(feature => feature.id)).toEqual(['12'])
    draw.addFeatures([{ ...pointFeature('12', 4, { code: 12 }) } as never, pointFeature('new', 5) as never])
    expect(features(source).map(feature => [feature.id, feature.properties?.['code']])).toEqual([['x', 12], [undefined, 'new']])
  })

  it('hides the features it draws live from the source’s tiles, and drapes none itself', () => {
    const source = new GeoJsonSource({ id: 'places', data: { type: 'FeatureCollection', features: [pointFeature(1, 1), pointFeature(2, 2)] } })
    const live = new LiveMode()
    const draw = new Draw({ source, modes: [new StaticMode(), live] })
    live.live = ['1', 'unknown']
    draw.setMode('live')
    expect(source.hiddenFeatureIds).toEqual([1])
    draw.setMode('static')
    expect(source.hiddenFeatureIds).toEqual([])
    live.live = ['2']
    draw.setMode('live')
    draw.setSource(null)
    expect(source.hiddenFeatureIds).toEqual([]) // shown again when editing stops
  })

  it('adds a removed feature back under the id the source knew (an undo), numeric and promoted alike', () => {
    const numeric = new GeoJsonSource({ id: 'numeric', data: { type: 'FeatureCollection', features: [pointFeature(7, 1)] } })
    const draw = new Draw({ source: numeric })
    const removed = draw.getFeature('7')!
    draw.removeFeatures(['7'])
    draw.addFeatures([removed])
    expect(features(numeric).map(feature => feature.id)).toEqual([7])

    const promoted = new GeoJsonSource({ id: 'promoted', promoteId: 'code', data: { type: 'FeatureCollection', features: [pointFeature('x', 1, { code: 12 })] } })
    draw.setSource(promoted)
    const promotedFeature = draw.getFeature('12')!
    draw.removeFeatures(['12'])
    draw.addFeatures([promotedFeature, { ...pointFeature(undefined, 2, { code: 99 }) } as never])
    expect(features(promoted).map(feature => [feature.id, feature.properties?.['code']])).toEqual([['x', 12], [undefined, 99]])
    expect(draw.getFeature('99')).toBeDefined()
  })

  it('reloads the same source after a change made elsewhere, and drops the selection when the source changes', () => {
    const source = new GeoJsonSource({ id: 'places', data: { type: 'FeatureCollection', features: [pointFeature('a', 1)] } })
    const other = new GeoJsonSource({ id: 'other', data: { type: 'FeatureCollection', features: [pointFeature('a', 9)] } })
    const draw = new Draw({ source })
    source.setData({ type: 'FeatureCollection', features: [pointFeature('a', 1), pointFeature('b', 2)] })
    draw.setSource(source)
    expect(draw.getFeatures().features.map(feature => feature.id)).toEqual(['a', 'b'])
    draw.select(['a'])
    draw.setSource(other)
    expect(draw.getSelectedIds()).toEqual([])
  })

  it('states the fix for two features whose ids read the same', () => {
    const source = new GeoJsonSource({ id: 'places', data: { type: 'FeatureCollection', features: [pointFeature(1, 1), pointFeature('1', 2)] } })
    expect(() => new Draw({ source })).toThrow(/distinct id/)
  })

  it('states the fix for data loaded from a URL', () => {
    expect(() => new Draw({ source: new GeoJsonSource({ id: 'remote', data: 'places.geojson' }) })).toThrow(/fetch the GeoJSON in the app/)
  })
})

/** A mode context whose projection puts longitude, latitude at x = longitude × 100, y = latitude × 100 pixels. */
function createContext() {
  const created: DrawFeature[] = []
  let ids = 0
  const context: DrawModeContext = {
    earth: null as never,
    store: new FeatureStore(),
    heights: { remember: vi.fn(), heightAt: () => 0 } as never,
    style: () => DEFAULT_DRAW_STYLE,
    createId: () => `feature-${++ids}`,
    project: ([longitude, latitude]) => ({ x: longitude * 100, y: latitude * 100 }),
    changed: vi.fn(),
    create: features => void created.push(...features),
    update: vi.fn(),
    projectAtHeight: ([longitude, latitude]) => ({ x: longitude * 100, y: latitude * 100 }),
    remove: vi.fn(),
    setCursor: vi.fn(),
    holdDoubleClickZoom: vi.fn(),
    releaseDoubleClickZoom: vi.fn(),
  }
  return { context, created }
}

function tap(longitude: number, latitude: number, pointerType = 'mouse'): DrawPointerEvent {
  return { screen: { xPixels: longitude * 100, yPixels: latitude * 100 }, geographic: { longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters: 0 }, pointerType, originalEvent: {} as MouseEvent }
}

describe('placement modes', () => {
  it('places a point per tap, holding double-click zoom off', () => {
    const { context, created } = createContext()
    const mode = new PointMode({ properties: { kind: 'pin' } })
    mode.enter(context)
    mode.click(tap(1, 2))
    expect(context.holdDoubleClickZoom).toHaveBeenCalled()
    expect(created).toEqual([{ type: 'Feature', id: 'feature-1', properties: { kind: 'pin' }, geometry: { type: 'Point', coordinates: [1, 2] } }])
  })

  it('draws a line string, finishing on a tap on its last vertex', () => {
    const { context, created } = createContext()
    const mode = new LineStringMode()
    mode.enter(context)
    mode.click(tap(0, 0))
    // A second tap on the only vertex is a double tap: nothing to finish yet, and nothing placed.
    mode.click(tap(0.01, 0))
    expect(mode.status()).toEqual({ drawing: true, vertexCount: 1, canFinish: false, canUndo: true })
    mode.click(tap(1, 1))
    mode.click(tap(1.05, 1)) // 5 pixels from the last vertex
    expect(created).toHaveLength(1)
    expect(created[0]!.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })
    expect(mode.status().drawing).toBe(false)
  })

  it('closes a polygon on a tap on its first vertex, with wider tolerance for fingers', () => {
    const { context, created } = createContext()
    const mode = new PolygonMode()
    mode.enter(context)
    for (const [longitude, latitude] of [[0, 0], [1, 0], [1, 1]] as const) mode.click(tap(longitude, latitude, 'touch'))
    mode.click(tap(0.15, 0.1, 'touch')) // 18 pixels away: a finger's tap still hits
    expect(created[0]!.geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
  })

  it('undoes, cancels and finishes from the keyboard', () => {
    const { context, created } = createContext()
    const mode = new PolygonMode()
    mode.enter(context)
    for (const [longitude, latitude] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) mode.click(tap(longitude, latitude))
    expect(mode.keyDown(key('Backspace'))).toBe(true)
    expect(mode.status().vertexCount).toBe(3)
    expect(mode.keyDown(key('Enter'))).toBe(true)
    expect(created).toHaveLength(1)
    mode.click(tap(5, 5))
    expect(mode.keyDown(key('Escape'))).toBe(true)
    expect(mode.status().drawing).toBe(false)
    expect(created).toHaveLength(1)
  })

  it('draws the feature in progress through the mouse, with its vertices as handles', () => {
    const { context } = createContext()
    const mode = new PolygonMode()
    mode.enter(context)
    mode.click(tap(0, 0))
    mode.click(tap(1, 0))
    mode.hover(tap(1, 1))
    const content: OverlayContent = { features: [], lines: [], handles: [] }
    mode.overlay(content)
    expect(content.features[0]!.feature.geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
    expect(content.handles.map(handle => handle.position)).toEqual([[0, 0], [1, 0]])
  })
})

function key(name: string): KeyboardEvent {
  return { key: name } as KeyboardEvent
}
