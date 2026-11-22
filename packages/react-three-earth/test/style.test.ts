import { RenderTarget } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { MapStyleSource } from '../src/core/sources.js'
import { ImageryCompositor } from '../src/tiles/imagery/ImageryCompositor.js'
import { MapStyle, type SequencedStyleChange } from '../src/vector/MapStyle.js'
import type { MapStyleBackend } from '../src/vector/MapStyleBackend.js'
import { bucketKey, MapStyleOverlay } from '../src/vector/MapStyleOverlay.js'
import { StyleLayer } from '../src/vector/StyleLayer.js'
import { FeatureColorTable, featureKey } from '../src/vector/worker/featureState.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { applyStyleCommand, copyStyleDocument } from '../src/vector/worker/styleDocument.js'
import type { FeatureStateChange, StyleCommand, TileBucket, TileRequest } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

const TILES = 'https://maps.test/{z}/{x}/{y}.pbf'
const square = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]] as Array<[number, number]>

function baseStyle() {
  return {
    version: 8,
    state: { highlight: { default: 'none' } },
    sources: { base: { type: 'vector', tiles: [TILES] }, other: { type: 'vector', tiles: ['https://other.test/{z}/{x}/{y}.pbf'] } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      {
        id: 'buildings',
        type: 'fill',
        source: 'base',
        'source-layer': 'buildings',
        paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff0000', 'rgba(0, 0, 0, 0)'] },
      },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#00ff00', 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 8, 2] } },
      { id: 'parks', type: 'fill', source: 'other', 'source-layer': 'parks', filter: ['==', ['global-state', 'highlight'], 'parks'], paint: { 'fill-color': '#0000ff' } },
    ],
  }
}

function tileFiles() {
  const base = encodeVectorTile([
    { name: 'buildings', features: [{ type: 'Polygon', id: 7, geometry: [square(0, 1024)], properties: { ref: 'b-7' } }, { type: 'Polygon', geometry: [square(2048, 3072)] }] },
    { name: 'roads', features: [{ type: 'LineString', id: 3, geometry: [[[0, 3000], [4096, 3000]]] }] },
  ])
  const other = encodeVectorTile([{ name: 'parks', features: [{ type: 'Polygon', geometry: [square(0, 4096)] }] }])
  return { 'https://maps.test/0/0/0.pbf': base, 'https://other.test/0/0/0.pbf': other }
}

async function createProcessor(style: object = baseStyle(), extra: object = {}) {
  const { fetch } = createFakeFetch(tileFiles())
  const fetchSpy = vi.fn(fetch)
  const processor = await MapStyleProcessor.create(
    { style, baseUrl: 'https://maps.test/', requestHeaders: {}, localFontFamily: 'sans-serif', ...extra },
    { fetch: fetchSpy as typeof globalThis.fetch },
  )
  const process = (sourceId = 'base') => processor.processTile({ sourceId, x: 0, y: 0, z: 0, zoom: 0 })
  return { processor, process, fetchSpy }
}

/** Distinct (r, g, b, a) colours of a bucket's shape vertices that use no slot. */
function bakedColors(bucket: TileBucket): string[] {
  const shapes = bucket.shapes!
  const colors = new Set<string>()
  for (let vertex = 0; vertex < shapes.colors.length / 4; vertex++) {
    if ((shapes.colorSlots?.[vertex] ?? 0) !== 0) continue
    colors.add([...shapes.colors.subarray(vertex * 4, vertex * 4 + 4)].join(','))
  }
  return [...colors]
}

describe('style commands in the worker', () => {
  it('re-evaluates a changed paint property and rebuilds only the source of that layer', async () => {
    const { processor, process } = await createProcessor()
    expect(bakedColors(await process())).toContain('0,255,0,255')
    const result = await processor.applyCommands([{ command: 'setPaintProperty', args: ['roads', 'line-color', '#ffffff'] }])
    expect(result.rebuiltSources).toEqual(['base'])
    expect(result.errors).toEqual([])
    const colors = bakedColors(await process())
    expect(colors).toContain('255,255,255,255')
    expect(colors).not.toContain('0,255,0,255')
  })

  it('changes the background summary without rebuilding any source', async () => {
    const { processor } = await createProcessor()
    const result = await processor.applyCommands([{ command: 'setPaintProperty', args: ['background', 'background-color', '#ffffff'] }])
    expect(result.rebuiltSources).toEqual([])
    expect(result.summary.backgroundByZoom[3]).toEqual([255, 255, 255, 255])
  })

  it('hides a layer, filters it and limits its zoom range', async () => {
    const { processor, process } = await createProcessor()
    await processor.applyCommands([{ command: 'setLayoutProperty', args: ['roads', 'visibility', 'none'] }])
    expect(bakedColors(await process())).not.toContain('0,255,0,255')
    await processor.applyCommands([
      { command: 'setLayoutProperty', args: ['roads', 'visibility', 'visible'] },
      { command: 'setLayerZoomRange', args: ['roads', 1, undefined] },
    ])
    expect(bakedColors(await process())).not.toContain('0,255,0,255')
    await processor.applyCommands([
      { command: 'setLayerZoomRange', args: ['roads', undefined, undefined] },
      { command: 'setFilter', args: ['roads', ['==', ['id'], 4]] },
    ])
    expect(bakedColors(await process())).not.toContain('0,255,0,255')
  })

  it('adds, moves and removes layers, rebuilding the sources whose order or groups changed', async () => {
    const { processor, process } = await createProcessor()
    const added = await processor.applyCommands([
      { command: 'addLayer', args: [{ id: 'outline', type: 'line', source: 'base', 'source-layer': 'buildings', paint: { 'line-color': '#ffff00' } }, undefined] },
    ])
    expect(added.rebuiltSources).toEqual(['base'])
    expect(bakedColors(await process())).toContain('255,255,0,255')
    // Moving a base layer above the "other" layer changes base's groups only
    const moved = await processor.applyCommands([{ command: 'moveLayer', args: ['roads', 'outline'] }])
    expect(moved.rebuiltSources).toEqual(['base'])
    // A new layer of another source between base layers renumbers the groups above it
    const split = await processor.applyCommands([{ command: 'addLayer', args: [{ id: 'more-parks', type: 'fill', source: 'other', 'source-layer': 'parks' }, 'buildings'] }])
    expect(split.rebuiltSources.sort()).toEqual(['base', 'other'])
    const removed = await processor.applyCommands([{ command: 'removeLayer', args: ['outline'] }])
    expect(removed.rebuiltSources).toContain('base')
    expect(bakedColors(await process())).not.toContain('255,255,0,255')
  })

  it('loads a source added at runtime once a layer reads it, and drops a removed one', async () => {
    const style = baseStyle()
    style.layers = style.layers.filter(layer => layer.source !== 'other')
    const { processor, process } = await createProcessor(style)
    expect(processor.summary.sources.map(source => source.id)).toEqual(['base'])
    const result = await processor.applyCommands([
      { command: 'addSource', args: ['extra', { type: 'vector', tiles: ['https://other.test/{z}/{x}/{y}.pbf'], attribution: 'Extra data' }] },
      { command: 'addLayer', args: [{ id: 'extra-parks', type: 'fill', source: 'extra', 'source-layer': 'parks', paint: { 'fill-color': '#123456' } }, undefined] },
    ])
    expect(result.summary.sources.map(source => source.id)).toEqual(['base', 'extra'])
    expect(result.summary.attributions).toEqual(['Extra data'])
    expect(bakedColors(await process('extra'))).toEqual(['18,52,86,255'])
    const removed = await processor.applyCommands([
      { command: 'removeLayer', args: ['extra-parks'] },
      { command: 'removeSource', args: ['extra'] },
    ])
    expect(removed.summary.sources.map(source => source.id)).toEqual(['base'])
  })

  it('does not fetch a failed source again on unrelated changes, only once it is replaced', async () => {
    const style = baseStyle()
    style.sources.other = { type: 'vector', url: 'https://maps.test/missing.json' } as never
    const { processor, fetchSpy } = await createProcessor(style)
    const calls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('missing.json')).length
    expect(calls()).toBe(1)
    const result = await processor.applyCommands([{ command: 'setPaintProperty', args: ['background', 'background-color', '#000000'] }])
    expect(result.errors).toEqual([])
    expect(calls()).toBe(1)
  })

  it('reports an expression that does not compile and skips the layer, as at load', async () => {
    const { processor } = await createProcessor()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await processor.applyCommands([{ command: 'setPaintProperty', args: ['roads', 'line-width', ['interpolate', ['linear'], ['zoom']]] }])
    warn.mockRestore()
    expect(result.errors[0]).toMatch(/roads/)
    expect(result.summary.skippedLayers).toContain('roads')
  })

  it('evaluates global-state and rebuilds only sources whose layers read the changed name', async () => {
    const { processor, process } = await createProcessor()
    expect((await process('other')).shapes).toBeNull()
    const result = await processor.applyCommands([{ command: 'setGlobalStateProperty', args: ['highlight', 'parks'] }])
    expect(result.rebuiltSources).toEqual(['other'])
    expect(bakedColors(await process('other'))).toEqual(['0,0,255,255'])
    const unrelated = await processor.applyCommands([{ command: 'setGlobalStateProperty', args: ['unused', 1] }])
    expect(unrelated.rebuiltSources).toEqual([])
    // Back to the default from the style root `state`
    await processor.applyCommands([{ command: 'setGlobalStateProperty', args: ['highlight', undefined] }])
    expect((await process('other')).shapes).toBeNull()
  })

  it('starts from global-state values set before it loaded', async () => {
    const { process } = await createProcessor(baseStyle(), { globalState: { highlight: 'parks' } })
    expect(bakedColors(await process('other'))).toEqual(['0,0,255,255'])
  })
})

describe('feature-state in the worker', () => {
  const hoverKey = featureKey('base', 'buildings', 7)
  const roadKey = featureKey('base', 'roads', 3)

  it('gives state-dependent colours a slot, drawn even while transparent, and updates it without processing the tile', async () => {
    const { processor, process } = await createProcessor()
    const bucket = await process()
    const slots = bucket.shapes!.colorSlots!
    expect(slots).not.toBeNull()
    const slotted = [...new Set(slots)].filter(slot => slot !== 0)
    expect(slotted).toHaveLength(1) // the building with an id; the one without stays baked (and transparent: not drawn)
    expect(bucket.featureStateKeys).toEqual([hoverKey])
    expect(processor.takeFeatureColorUpdate()).toBeNull() // transparent, as the main thread's table starts
    processor.applyFeatureStates([{ key: hoverKey, state: { hover: true } }])
    const update = processor.takeFeatureColorUpdate()!
    expect([...update.slots]).toEqual(slotted)
    expect([...update.colors]).toEqual([255, 0, 0, 255])
    processor.applyFeatureStates([{ key: hoverKey, state: null }])
    expect([...processor.takeFeatureColorUpdate()!.colors]).toEqual([0, 0, 0, 0])
  })

  it('lists features whose state changes geometry, and draws them with their current state', async () => {
    const { processor, process } = await createProcessor(baseStyle(), { featureStates: [[roadKey, { selected: true }]], featureStateVersion: 5 })
    const wide = await process()
    expect(wide.rebuildFeatureKeys).toEqual([roadKey])
    expect(wide.featureStateVersion).toBe(5)
    processor.applyFeatureStates([{ key: roadKey, state: { selected: false } }])
    const narrow = await process()
    expect(narrow.featureStateVersion).toBe(6)
    expect(narrow.shapes!.positions.length).toBe(wide.shapes!.positions.length) // same vertices, narrower band
    const height = (bucket: TileBucket) => {
      const ys = [...bucket.shapes!.positions].filter((_, index) => index % 2 === 1 && bucket.shapes!.colors[(index - 1) * 2 + 1] === 255)
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(height(wide)).toBeGreaterThan(height(narrow) * 3)
  })

  it('reads feature ids from a property with promoteId', async () => {
    const style = baseStyle()
    ;(style.sources.base as Record<string, unknown>).promoteId = { buildings: 'ref' }
    const { process } = await createProcessor(style)
    expect((await process()).featureStateKeys).toEqual([featureKey('base', 'buildings', 'b-7')])
  })

  it('bakes the colour once the slot table is full', () => {
    const table = new FeatureColorTable()
    ;(table as unknown as { slots: unknown[] }).slots.length = 1024 * 1024
    expect(table.allocate('feature', 'slot', () => [1, 2, 3, 4], {})).toBe(0)
  })
})

describe('style documents', () => {
  it('checks commands against the document and states the fix', () => {
    const document = copyStyleDocument(baseStyle())
    expect(() => applyStyleCommand(document, { command: 'setPaintProperty', args: ['nope', 'fill-color', 'red'] })).toThrow(/no layer "nope".*addLayer/)
    expect(() => applyStyleCommand(document, { command: 'addLayer', args: [{ id: 'roads', type: 'line', source: 'base' }, undefined] })).toThrow(/already exists/)
    expect(() => applyStyleCommand(document, { command: 'addLayer', args: [{ id: 'x', type: 'line', source: 'missing' }, undefined] })).toThrow(/addSource/)
    expect(() => applyStyleCommand(document, { command: 'removeSource', args: ['base'] })).toThrow(/"buildings", "roads" still read source "base"; removeLayer/)
    applyStyleCommand(document, { command: 'addLayer', args: [{ id: 'x', type: 'background' }, 'roads'] })
    expect(document.layers.map(layer => layer.id)).toEqual(['background', 'buildings', 'x', 'roads', 'parks'])
    applyStyleCommand(document, { command: 'moveLayer', args: ['x', undefined] })
    expect(document.layers.at(-1)!.id).toBe('x')
  })

  it('never edits the style object the app passed', () => {
    const style = baseStyle()
    const document = copyStyleDocument(style)
    applyStyleCommand(document, { command: 'setPaintProperty', args: ['roads', 'line-color', '#123456'] })
    expect(style.layers[2]!.paint).toEqual(baseStyle().layers[2]!.paint)
  })
})

/** A loaded MapStyle and the changes it hands out. */
async function loadedStyle(style: object = baseStyle()) {
  const mapStyle = new MapStyle({ style, baseUrl: 'https://maps.test/' })
  const changes: SequencedStyleChange[] = []
  mapStyle.subscribe(batch => changes.push(...batch))
  await mapStyle.load()
  return { mapStyle, changes, commands: () => changes.flatMap(({ change }) => (change.type === 'command' ? [change.command] : [])) }
}

const microtask = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('MapStyle', () => {
  it('keeps changes made before load, applies them once loaded and reports those that fail', async () => {
    const mapStyle = new MapStyle({ style: baseStyle(), baseUrl: 'https://maps.test/' })
    const errors: Error[] = []
    mapStyle.addEventListener('error', ({ error }) => errors.push(error))
    mapStyle.setPaintProperty('roads', 'line-color', '#ffffff')
    mapStyle.removeLayer('nope')
    mapStyle.setGlobalStateProperty('highlight', 'parks')
    mapStyle.setFeatureState({ source: 'base', sourceLayer: 'buildings', id: 7 }, { hover: true })
    await mapStyle.load()
    await microtask()
    const snapshot = mapStyle.snapshot()
    expect(snapshot.style.layers[2]!.paint!['line-color']).toBe('#ffffff')
    expect(snapshot.globalState).toEqual({ highlight: 'parks' })
    expect(snapshot.featureStates).toEqual([[featureKey('base', 'buildings', 7), { hover: true }]])
    expect(errors.map(error => error.message)).toEqual([expect.stringMatching(/no layer "nope"/)])
  })

  it('batches changes per microtask, numbered, and throws on a bad change once loaded', async () => {
    const { mapStyle, changes } = await loadedStyle()
    await microtask()
    changes.length = 0
    mapStyle.setPaintProperty('roads', 'line-color', '#ffffff')
    mapStyle.setLayerVisibility('parks', false)
    expect(() => mapStyle.setFilter('nope', null)).toThrow(/no layer "nope"/)
    expect(changes).toEqual([])
    await microtask()
    expect(changes.map(change => change.sequence)).toEqual([mapStyle.sequence - 1, mapStyle.sequence])
    expect(mapStyle.getLayoutProperty('parks', 'visibility')).toBe('none')
  })

  it('merges and removes feature-state as MapLibre does, and checks the feature', async () => {
    const { mapStyle, changes } = await loadedStyle()
    const building = { source: 'base', sourceLayer: 'buildings', id: 7 }
    mapStyle.setFeatureState(building, { hover: true })
    mapStyle.setFeatureState(building, { selected: 1 })
    mapStyle.setFeatureState(building, { selected: 1 }) // no change, nothing sent
    expect(mapStyle.getFeatureState({ ...building, id: '7' })).toEqual({ hover: true, selected: 1 })
    mapStyle.removeFeatureState(building, 'hover')
    expect(mapStyle.getFeatureState(building)).toEqual({ selected: 1 })
    mapStyle.setFeatureState({ ...building, id: 8 }, { hover: true })
    mapStyle.removeFeatureState({ source: 'base', sourceLayer: 'buildings' })
    expect(mapStyle.getFeatureState(building)).toEqual({})
    expect(() => mapStyle.setFeatureState({ source: 'base', id: 1 }, {})).toThrow(/sourceLayer/)
    expect(() => mapStyle.setFeatureState({ source: 'nope', sourceLayer: 'x', id: 1 }, {})).toThrow(/no source "nope"/)
    await microtask()
    const states = changes.flatMap(({ change }) => (change.type === 'featureState' ? [[change.key.split('\u001f')[2], change.state]] : []))
    expect(states).toEqual([
      ['7', { hover: true }],
      ['7', { hover: true, selected: 1 }],
      ['7', { selected: 1 }],
      ['8', { hover: true }],
      ['7', null],
      ['8', null],
    ])
  })

  it('diffs setStyle into commands, keeping StyleLayer layers, and reloads for changes commands cannot express', async () => {
    const { mapStyle, changes, commands } = await loadedStyle()
    const highlight = new StyleLayer({ id: 'highlight', type: 'line', source: 'base', sourceLayer: 'roads', paint: { 'line-color': '#ff00ff' }, beforeId: 'parks' })
    highlight.addTo({ getMapStyle: () => mapStyle })
    await microtask()
    changes.length = 0
    const next = baseStyle()
    next.layers[2]!.paint!['line-color'] = '#ffffff'
    await mapStyle.setStyle(next)
    await microtask()
    expect(commands()).toEqual([{ command: 'setPaintProperty', args: ['roads', 'line-color', '#ffffff'] }])
    expect(mapStyle.getLayerIds()).toEqual(['background', 'buildings', 'roads', 'highlight', 'parks'])
    changes.length = 0
    await mapStyle.setStyle({ ...next, glyphs: 'https://fonts.test/{fontstack}/{range}.pbf' })
    await microtask()
    expect(changes.map(({ change }) => change.type)).toEqual(['reload'])
    expect(mapStyle.getStyle()!.glyphs).toBe('https://fonts.test/{fontstack}/{range}.pbf')
    expect(mapStyle.getLayerIds()).toContain('highlight')
  })

  it('applies changes made during setStyle to the new style, and lets the last of overlapping calls win', async () => {
    const { mapStyle } = await loadedStyle()
    const first = baseStyle()
    first.layers[2]!.paint!['line-color'] = '#111111'
    const second = baseStyle()
    second.layers[2]!.paint!['line-color'] = '#222222'
    const replaced = mapStyle.setStyle(first)
    const latest = mapStyle.setStyle(second)
    // Made while both are pending: applied after the new style, not undone by its diff.
    mapStyle.setLayerVisibility('parks', false)
    const layer = new StyleLayer({ id: 'late', type: 'line', source: 'base', sourceLayer: 'roads' })
    layer.addTo({ getMapStyle: () => mapStyle })
    const removed = new StyleLayer({ id: 'gone', type: 'line', source: 'base', sourceLayer: 'roads' })
    removed.addTo({ getMapStyle: () => mapStyle })
    removed.remove()
    expect(mapStyle.isSettled).toBe(false)
    await Promise.all([replaced, latest])
    expect(mapStyle.isSettled).toBe(true)
    expect(mapStyle.getPaintProperty('roads', 'line-color')).toBe('#222222')
    expect(mapStyle.getLayoutProperty('parks', 'visibility')).toBe('none')
    expect(mapStyle.getLayerIds()).toContain('late')
    expect(mapStyle.getLayerIds()).not.toContain('gone')
  })

  it('keeps a change made while setStyle waits for the first load, and removes a StyleLayer quietly', async () => {
    const mapStyle = new MapStyle({ style: baseStyle(), baseUrl: 'https://maps.test/' })
    const errors: Error[] = []
    mapStyle.addEventListener('error', ({ error }) => errors.push(error))
    const loading = mapStyle.load()
    const next = baseStyle()
    next.layers[2]!.paint!['line-color'] = '#222222'
    const replaced = mapStyle.setStyle(next)
    mapStyle.setPaintProperty('roads', 'line-width', 5)
    await Promise.all([loading, replaced])
    expect(mapStyle.getPaintProperty('roads', 'line-width')).toBe(5)
    // Added while settled, removed while a setStyle is pending: the diff drops it, the held removal is a no-op.
    const layer = new StyleLayer({ id: 'hl', type: 'line', source: 'base', sourceLayer: 'roads' })
    layer.addTo({ getMapStyle: () => mapStyle })
    const again = mapStyle.setStyle(baseStyle())
    layer.remove()
    await again
    await microtask()
    expect(mapStyle.getLayerIds()).not.toContain('hl')
    expect(errors).toEqual([])
  })

  it('says when the first load failed, so a new source can start over', async () => {
    const mapStyle = new MapStyle({ style: 'https://maps.test/missing.json' })
    const errors: Error[] = []
    mapStyle.addEventListener('error', ({ error }) => errors.push(error))
    const loading = mapStyle.load(async () => new Response('', { status: 404 }))
    const replaced = mapStyle.setStyle(baseStyle())
    mapStyle.setPaintProperty('roads', 'line-width', 5)
    await expect(loading).rejects.toThrow(/404/)
    await expect(replaced).rejects.toThrow(/404/)
    expect(mapStyle.loadFailed).toBe(true)
    await microtask()
    expect(errors).toEqual([])
  })

  it('updates a StyleLayer by sending only what changed', async () => {
    const { mapStyle, changes, commands } = await loadedStyle()
    const layer = new StyleLayer({ id: 'extra', type: 'line', source: 'base', sourceLayer: 'roads', paint: { 'line-color': '#ff00ff', 'line-width': 2 } })
    layer.addTo({ getMapStyle: () => mapStyle })
    await microtask()
    changes.length = 0
    layer.update({ id: 'extra', type: 'line', source: 'base', sourceLayer: 'roads', paint: { 'line-color': '#ff00ff', 'line-width': 4 }, maximumZoom: 12, beforeId: 'roads' })
    await microtask()
    expect(commands()).toEqual<StyleCommand[]>([
      { command: 'setPaintProperty', args: ['extra', 'line-width', 4] },
      { command: 'setLayerZoomRange', args: ['extra', undefined, 12] },
      { command: 'moveLayer', args: ['extra', 'roads'] },
    ])
    layer.remove()
    expect(mapStyle.getLayerIds()).not.toContain('extra')
  })

  it('rewrites requests and serves custom protocols', async () => {
    const loader = vi.fn(async () => new TextEncoder().encode('{"version":8,"sources":{},"layers":[]}'))
    const mapStyle = new MapStyle({
      style: 'offline://style.json',
      requestHeaders: { 'X-App': 'test' },
      transformRequest: (url, kind) => (kind === 'Tile' ? { url: url.replace('maps.test', 'cdn.test'), headers: { Authorization: 'token' } } : undefined),
      protocols: { offline: loader },
    })
    await mapStyle.load()
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ url: 'offline://style.json', kind: 'Style' }))
    expect(await mapStyle.resolveResource({ url: 'https://maps.test/1/2/3.pbf', kind: 'Tile', headers: { range: 'bytes=0-9' } })).toEqual({
      url: 'https://cdn.test/1/2/3.pbf',
      headers: { 'X-App': 'test', range: 'bytes=0-9', Authorization: 'token' },
    })
    await expect(mapStyle.resolveResource({ url: 'unknown://x', kind: 'Tile', headers: {} })).rejects.toThrow(/addProtocol\('unknown'/)
    expect(() => mapStyle.addProtocol('https', loader)).toThrow(/built in/)
  })
})

describe('MapStyleProcessor request routing', () => {
  it('asks the main thread about custom schemes, and about every request with transformRequest', async () => {
    const tile = encodeVectorTile([{ name: 'roads', features: [{ type: 'LineString', geometry: [[[0, 0], [4096, 4096]]] }] }])
    const { fetch } = createFakeFetch({ 'https://cdn.test/0/0/0.pbf': tile })
    const fetchSpy = vi.fn(fetch)
    const resolveResource = vi.fn(async ({ url, kind }: { url: string; kind: string }) =>
      kind === 'Source' ? { data: new TextEncoder().encode(JSON.stringify({ tiles: ['https://maps.test/{z}/{x}/{y}.pbf'] })) } : { url: url.replace('maps.test', 'cdn.test'), headers: {} },
    )
    const processor = await MapStyleProcessor.create(
      {
        style: { version: 8, sources: { base: { type: 'vector', url: 'offline://tiles.json' } }, layers: [{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads' }] },
        baseUrl: 'https://maps.test/',
        requestHeaders: {},
        localFontFamily: 'sans-serif',
        transformsRequests: true,
      },
      { fetch: fetchSpy as typeof globalThis.fetch, resolveResource },
    )
    const bucket = await processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 0, zoom: 0 })
    expect(bucket.shapes).not.toBeNull()
    expect(resolveResource.mock.calls.map(([request]) => [request.url, request.kind])).toEqual([
      ['offline://tiles.json', 'Source'],
      ['https://maps.test/0/0/0.pbf', 'Tile'],
    ])
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://cdn.test/0/0/0.pbf'])
  })
})

/** Just enough of `WebGPURenderer` for the compositor. */
function fakeRenderer(): WebGPURenderer {
  let target: RenderTarget | null = null
  let mrt: object | null = null
  return {
    autoClear: false,
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => void (target = next),
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getMRT: () => mrt,
    setMRT: (next: object | null) => void (mrt = next),
    getClearAlpha: () => 1,
    getClearColor: <T>(color: T) => color,
    setClearColor: () => {},
    render: () => {},
  } as unknown as WebGPURenderer
}

/**
 * A `MapStyleOverlay` on a fake backend: tile (2, 1) at zoom 2 of source "base" draws feature "hot" with a slot,
 * tile (0, 3) bakes feature "wide". Records processed tiles, drawn regions and messages sent.
 */
class StyleTestOverlay extends MapStyleOverlay {
  readonly processed: string[] = []
  readonly drawnRegions: string[] = []
  readonly sentStates: FeatureStateChange[][] = []
  readonly sentCommands: StyleCommand[][] = []
  rebuiltSources: string[] = ['base']
  readonly renderer = fakeRenderer()

  constructor(style: MapStyle) {
    super({ style, createWorker: null })
    this.compositor = new ImageryCompositor({ budgetMilliseconds: Infinity })
    const summary = { sources: [{ id: 'base', minimumZoom: 0, maximumZoom: 14 }, { id: 'other', minimumZoom: 0, maximumZoom: 14 }], backgroundByZoom: [], skippedLayers: [], attributions: [], backgroundPatternByZoom: [], missingBackgroundImages: [], spriteImageIds: [] }
    const backend: MapStyleBackend = {
      init: async () => summary,
      reload: async () => summary,
      processTile: async (request: TileRequest) => {
        const key = bucketKey(request)
        this.processed.push(key)
        const hot = request.sourceId === 'base' && request.x === 2 && request.y === 1
        const wide = request.sourceId === 'base' && request.x === 0 && request.y === 3
        return { shapes: null, text: null, atlas: null, images: [], missingImages: [], featureStateKeys: hot ? ['hot'] : [], rebuildFeatureKeys: wide ? ['wide'] : [], featureStateVersion: this.featureStateVersion, byteLength: 1 }
      },
      invalidate: () => {},
      updateStyle: async commands => {
        this.sentCommands.push(commands)
        return { summary, rebuiltSources: this.rebuiltSources, errors: [] }
      },
      updateFeatureStates: async changes => void this.sentStates.push(changes),
      setImage: async () => ({ rebuild: false, backgroundPatternByZoom: [], missingBackgroundImages: [] }),
      dispose: () => {},
    }
    this.backend = backend
    this.summary = summary
    this.snapshotSequence = 0
    this.unsubscribe = style.subscribe(this.receiveStyleChanges)
  }

  async settle(): Promise<void> {
    for (let frame = 0; frame < 20; frame++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      this.compositor!.render(this.renderer)
    }
  }

  protected override drawRegion(_renderer: WebGPURenderer, _compositor: ImageryCompositor, _output: RenderTarget, range: readonly number[]): void {
    this.drawnRegions.push(range.join('_'))
  }
}

// Regions of 1/8 × 1/8 are textured at zoom 2 (tiles of 1/4).
const A = [0.5, 0.5, 0.625, 0.625] // tile (2, 1)
const C = [0, 0, 0.125, 0.125] // tile (0, 3)

describe('MapStyleOverlay style changes', () => {
  async function setUp() {
    const mapStyle = new MapStyle({ style: { version: 8, sources: { base: { type: 'vector', tiles: [TILES] }, other: { type: 'vector', tiles: [TILES] } }, layers: [] }, baseUrl: 'https://maps.test/' })
    await mapStyle.load()
    const overlay = new StyleTestOverlay(mapStyle)
    void overlay.lockTexture(A)
    void overlay.lockTexture(C)
    await overlay.settle()
    overlay.processed.length = 0
    overlay.drawnRegions.length = 0
    return { mapStyle, overlay }
  }

  it('redraws only the regions drawing a feature whose slot colour changed, without processing tiles', async () => {
    const { mapStyle, overlay } = await setUp()
    // Feature keys are opaque to the overlay: emit one directly, as setFeatureState would
    ;(mapStyle as unknown as { emit(change: object): void }).emit({ type: 'featureState', key: 'hot', state: { hover: true } })
    await overlay.settle()
    expect(overlay.sentStates).toEqual([[{ key: 'hot', state: { hover: true } }]])
    expect(overlay.processed).toEqual([])
    expect(overlay.drawnRegions).toEqual([A.join('_')])
  })

  it('processes again the tiles of a feature whose state changes geometry', async () => {
    const { mapStyle, overlay } = await setUp()
    ;(mapStyle as unknown as { emit(change: object): void }).emit({ type: 'featureState', key: 'wide', state: { selected: true } })
    await overlay.settle()
    expect(overlay.processed).toEqual([bucketKey({ sourceId: 'base', x: 0, y: 3, z: 2, zoom: 2 })])
    expect(overlay.drawnRegions).toEqual([C.join('_')])
  })

  it('forgets feature-state changes that no tile in flight can have missed', async () => {
    const { mapStyle, overlay } = await setUp()
    for (let id = 0; id < 50; id++) (mapStyle as unknown as { emit(change: object): void }).emit({ type: 'featureState', key: `feature ${id}`, state: { hover: true } })
    await overlay.settle()
    expect((overlay as unknown as { featureStateChangedAt: Map<string, number> }).featureStateChangedAt.size).toBe(0)
  })

  it('sends a burst of style changes as one message and processes again only the rebuilt source', async () => {
    const { mapStyle, overlay } = await setUp()
    mapStyle.addLayer({ id: 'roads', type: 'line', source: 'other', 'source-layer': 'roads' })
    mapStyle.setPaintProperty('roads', 'line-color', '#ff0000')
    overlay.rebuiltSources = ['other']
    await overlay.settle()
    expect(overlay.sentCommands).toHaveLength(1)
    expect(overlay.sentCommands[0]!.map(command => command.command)).toEqual(['addLayer', 'setPaintProperty'])
    expect(overlay.processed.every(key => key.endsWith('/other'))).toBe(true)
    expect(overlay.processed.length).toBeGreaterThan(0)
    expect(new Set(overlay.drawnRegions)).toEqual(new Set([A.join('_'), C.join('_')]))
  })
})

describe('MapStyleSource style API', () => {
  it('shares one style model between its overlays and forwards events', async () => {
    const source = new MapStyleSource({ style: baseStyle(), baseUrl: 'https://maps.test/' })
    const first = source.createOverlay({ opacity: 1 })
    const second = source.createOverlay({ opacity: 1 })
    expect(first.mapStyle).toBe(second.mapStyle)
    const events: string[] = []
    source.addEventListener('styledata', () => events.push('styledata'))
    source.addEventListener('sourcedata', ({ sourceId, change }) => events.push(`${change} ${sourceId}`))
    source.setPaintProperty('roads', 'line-color', '#ffffff') // before load: kept
    await source.getMapStyle().load()
    source.addSource('extra', { type: 'vector', tiles: [TILES] })
    await microtask()
    expect(source.getPaintProperty('roads', 'line-color')).toBe('#ffffff')
    expect(source.getSource('extra')).toEqual({ type: 'vector', tiles: [TILES] })
    expect(events).toEqual(['styledata', 'styledata', 'add extra'])
    first.dispose()
    second.dispose()
  })
})
