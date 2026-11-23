import { MeshBasicNodeMaterial } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { PLUGIN_API_VERSION } from '../src/plugins/plugin.js'
import { StyleLayerTypeRegistry, type StyleLayerTypeDefinition, type WorkerLayerTypeDescriptor } from '../src/plugins/styleLayerTypes.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { collectTransferables, type CustomLayerMesh } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

const square = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]] as Array<[number, number]>

const stripes: StyleLayerTypeDefinition = {
  type: 'stripes',
  geometry: 'fill',
  paint: {
    'stripes-color': { type: 'color', default: '#ff0000' },
    'stripes-width-pixels': { type: 'number', default: 4 },
  },
  createMaterial: () => new MeshBasicNodeMaterial(),
}

const glowModuleHref = new URL('../../../apps/playground/src/styleLayers/sdfGlowWorker.js', import.meta.url).href
const glow: StyleLayerTypeDefinition = {
  type: 'sdf-glow',
  paint: {
    'sdf-glow-color': { type: 'color', default: '#ffffff' },
    'sdf-glow-radius-pixels': { type: 'number', default: 12 },
    'sdf-glow-intensity': { type: 'number', default: 1 },
  },
  worker: { moduleUrl: glowModuleHref, exportName: 'sdfGlow' },
  maximumReachPixels: 64,
  createMaterial: () => new MeshBasicNodeMaterial(),
}

function describeTypes(...definitions: StyleLayerTypeDefinition[]): WorkerLayerTypeDescriptor[] {
  const registry = new StyleLayerTypeRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry.describe('https://app.test/')
}

function style(layers: object[]) {
  return {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['https://maps.test/{z}/{x}/{y}.pbf'] } },
    layers: [
      { id: 'buildings', type: 'fill', source: 'base', 'source-layer': 'buildings', paint: { 'fill-color': '#000000' } },
      ...layers,
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#00ff00' } },
    ],
  }
}

async function createProcessor(layers: object[], layerTypes: WorkerLayerTypeDescriptor[] = []) {
  const tile = encodeVectorTile([
    { name: 'buildings', features: [{ type: 'Polygon', id: 1, geometry: [square(0, 1024)], properties: { tone: '#0000ff' } }, { type: 'Polygon', id: 2, geometry: [square(2048, 3072)], properties: {} }] },
    { name: 'roads', features: [{ type: 'LineString', id: 3, geometry: [[[0, 3000], [2048, 3000], [4096, 3000]]], properties: {} }] },
  ])
  const { fetch } = createFakeFetch({ 'https://maps.test/0/0/0.pbf': tile })
  const fetchSpy = vi.fn(fetch)
  const processor = await MapStyleProcessor.create({ style: style(layers), baseUrl: 'https://maps.test/', requestHeaders: {}, localFontFamily: 'sans-serif', layerTypes }, { fetch: fetchSpy as typeof globalThis.fetch })
  const process = () => processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 0, zoom: 0 })
  return { processor, process, fetchSpy }
}

function attribute(mesh: CustomLayerMesh, name: string) {
  return mesh.attributes.find(entry => entry.name === name)
}

afterEach(() => vi.restoreAllMocks())

describe('StyleLayerTypeRegistry', () => {
  it('registers, lists, describes and removes a type, telling its listeners', () => {
    const registry = new StyleLayerTypeRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const remove = registry.register({ ...glow, worker: { moduleUrl: './glow.js', exportName: 'sdfGlow' } })
    expect(registry.has('sdf-glow')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    const [descriptor] = registry.describe('https://app.test/maps/')
    expect(descriptor).toMatchObject({ type: 'sdf-glow', geometry: null, module: { href: 'https://app.test/maps/glow.js', exportName: 'sdfGlow' }, maximumReachPixels: 64 })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor) // posted to the worker
    remove()
    expect(registry.size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('refuses invalid definitions and taken names, stating the fix', () => {
    const registry = new StyleLayerTypeRegistry()
    expect(() => registry.register({ ...stripes, type: 'line' })).toThrow(/MapLibre layer type; pick another name/)
    expect(() => registry.register({ ...stripes, worker: glow.worker! })).toThrow(/exactly one of `geometry`/)
    expect(() => registry.register({ ...glow, maximumReachPixels: 600 })).toThrow(/between 0 and 512/)
    expect(() => registry.register({ ...stripes, paint: { mode: { type: 'enum', default: 'a' } } })).toThrow(/needs its `values`/)
    expect(() => registry.register({ ...glow, paint: { width: { type: 'number', default: 1, geometryInput: 'line-width' } } })).toThrow(/only material-tier types/)
    expect(() => registry.register({ ...stripes, maximumReachPixels: 8 })).toThrow(/needs `offscreen: \{ blending: 'maximum' \}`/)
    registry.register(stripes)
    expect(() => registry.register({ ...stripes })).toThrow(/already registered by another plugin; remove that plugin first/)
  })

  it('is undone with the plugin that registered through its context', () => {
    const earth = new Earth()
    earth.addPlugin({ name: 'stripes', apiVersion: PLUGIN_API_VERSION, install: context => void context.registerStyleLayerType(stripes) })
    expect(earth.styleLayerTypes.has('stripes')).toBe(true)
    earth.removePlugin('stripes')
    expect(earth.styleLayerTypes.has('stripes')).toBe(false)
  })
})

describe('custom style layer types in the worker', () => {
  it('material tier: tessellates with the built-in fill, paint values per vertex, in its own draw group', async () => {
    const { process } = await createProcessor([{ id: 'striped', type: 'stripes', source: 'base', 'source-layer': 'buildings', paint: { 'stripes-color': ['to-color', ['get', 'tone'], '#ff0000'] } }], describeTypes(stripes))
    const bucket = await process()
    expect(bucket.layers).toHaveLength(1)
    const mesh = bucket.layers[0]!
    expect(mesh).toMatchObject({ layerId: 'striped', layerType: 'stripes' })
    const position = attribute(mesh, 'position')!
    const vertexCount = position.array.length / 2
    expect(vertexCount).toBe(10) // two closed rings of 5
    const color = attribute(mesh, 'paint0')!
    expect(color).toMatchObject({ itemSize: 4, normalized: true })
    // Data-driven: the first square is blue, the second takes the default red.
    expect([...color.array.slice(0, 4)]).toEqual([0, 0, 255, 255])
    expect([...color.array.slice(20, 24)]).toEqual([255, 0, 0, 255])
    expect([...attribute(mesh, 'paint1')!.array]).toEqual(new Array(vertexCount).fill(4))
    // Between buildings and roads, which no longer share a group.
    const groups = bucket.shapes!.groups.map(group => group.group)
    expect(Math.min(...groups)).toBeLessThan(mesh.group)
    expect(Math.max(...groups)).toBeGreaterThan(mesh.group)
  })

  it('geometry tier: runs the worker module, its attributes named for the shader', async () => {
    const { process } = await createProcessor([{ id: 'glow', type: 'sdf-glow', source: 'base', 'source-layer': 'roads', paint: { 'sdf-glow-radius-pixels': 100 } }], describeTypes(glow))
    const bucket = await process()
    const mesh = bucket.layers[0]!
    expect(mesh.attributes.map(entry => entry.name).sort()).toEqual(['paint0', 'paint1', 'paint2', 'position', 'segmentEnd', 'segmentStart'])
    expect(mesh.indices.length).toBe(12) // one quad per segment
    // The radius is clamped to the type's maximum reach.
    expect([...attribute(mesh, 'paint1')!.array]).toEqual(new Array(8).fill(64))
  })

  it('applies the layer filter before the worker module sees a feature', async () => {
    const { process } = await createProcessor([{ id: 'glow', type: 'sdf-glow', source: 'base', 'source-layer': 'roads', filter: ['==', ['get', 'class'], 'primary'] }], describeTypes(glow))
    expect((await process()).layers).toEqual([])
  })

  it('skips layers of a type nobody provides, and draws them once it is registered, without fetching again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { processor, process, fetchSpy } = await createProcessor([{ id: 'striped', type: 'stripes', source: 'base', 'source-layer': 'buildings' }])
    expect(processor.summary.missingLayerTypes).toEqual([['striped', 'stripes']])
    expect(processor.summary.skippedLayers).not.toContain('striped')
    expect((await process()).layers).toEqual([])
    const fetches = fetchSpy.mock.calls.length

    const result = await processor.setLayerTypes(describeTypes(stripes))
    expect(result.rebuiltSources).toEqual(['base'])
    expect(result.summary.missingLayerTypes).toEqual([])
    expect(result.summary.customLayerTypes).toEqual(['stripes'])
    expect((await process()).layers).toHaveLength(1)
    expect(fetchSpy.mock.calls.length).toBe(fetches)

    const removed = await processor.setLayerTypes([])
    expect(removed.rebuiltSources).toEqual(['base'])
    expect((await process()).layers).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('applies layer type changes in the order sent, even while a worker module is still importing', async () => {
    const { processor, process } = await createProcessor([
      { id: 'striped', type: 'stripes', source: 'base', 'source-layer': 'buildings' },
      { id: 'glow', type: 'sdf-glow', source: 'base', 'source-layer': 'roads' },
    ])
    // The first change imports a module; the second, sent right after, must win.
    const first = processor.setLayerTypes(describeTypes(glow))
    const second = processor.setLayerTypes(describeTypes(glow, stripes))
    await Promise.all([first, second])
    expect(processor.summary.customLayerTypes.sort()).toEqual(['sdf-glow', 'stripes'])
    expect((await process()).layers.map(layer => layer.layerId)).toEqual(['striped', 'glow'])
  })

  it('skips the layers of a type whose worker module does not load, naming the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { ...glow, worker: { moduleUrl: glowModuleHref, exportName: 'missing' } }
    const { process, processor } = await createProcessor([{ id: 'glow', type: 'sdf-glow', source: 'base', 'source-layer': 'roads' }], describeTypes(broken))
    expect(warn.mock.calls[0]?.[0]).toMatch(/worker module of layer type "sdf-glow" \(.*sdfGlowWorker\.js\) did not load.*no export "missing"/)
    expect((await process()).layers).toEqual([])
    // Registered, so not reported as a missing plugin: the warning above names the module instead.
    expect(processor.summary.missingLayerTypes).toEqual([])
  })

  it('rebuilds the other sources whose draw groups a custom layer renumbers', async () => {
    const tile = encodeVectorTile([{ name: 'buildings', features: [{ type: 'Polygon', id: 1, geometry: [square(0, 1024)], properties: {} }] }])
    const { fetch } = createFakeFetch({ 'https://a.test/0/0/0.pbf': tile, 'https://b.test/0/0/0.pbf': tile })
    const twoSources = {
      version: 8,
      sources: { a: { type: 'vector', tiles: ['https://a.test/{z}/{x}/{y}.pbf'] }, b: { type: 'vector', tiles: ['https://b.test/{z}/{x}/{y}.pbf'] } },
      layers: [
        { id: 'a-fill', type: 'fill', source: 'a', 'source-layer': 'buildings' },
        { id: 'a-striped', type: 'stripes', source: 'a', 'source-layer': 'buildings' },
        { id: 'a-fill-2', type: 'fill', source: 'a', 'source-layer': 'buildings' },
        { id: 'b-fill', type: 'fill', source: 'b', 'source-layer': 'buildings' },
      ],
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const processor = await MapStyleProcessor.create({ style: twoSources, baseUrl: 'https://a.test/', requestHeaders: {}, localFontFamily: 'sans-serif' }, { fetch: fetch as typeof globalThis.fetch })
    const result = await processor.setLayerTypes(describeTypes(stripes))
    expect(result.rebuiltSources.sort()).toEqual(['a', 'b'])
  })

  it("copies a worker module's arrays and refuses ones that cannot reach the GPU", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // One quad index array reused for every tile, as a module might cache it.
    const source = `
      const quad = new Uint16Array([0, 1, 2, 0, 2, 3])
      export const reused = () => ({ createTileBuilder: () => ({ addFeature() {}, finish: () => ({ attributes: { position: { array: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), itemSize: 2 } }, indices: quad }) }) })
      export const plain = () => ({ createTileBuilder: () => ({ addFeature() {}, finish: () => ({ attributes: { position: { array: new Float32Array([0, 0, 1, 0, 1, 1]), itemSize: 2 } }, indices: [0, 1, 2] }) }) })
      export const packed = () => ({ createTileBuilder: () => ({ addFeature() {}, finish: () => ({ attributes: { position: { array: new Float32Array([0, 0, 1, 0, 1, 1]), itemSize: 2 }, tint: { array: new Uint8Array(9), itemSize: 3 } }, indices: new Uint16Array([0, 1, 2]) }) }) })`
    const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`
    const type = (exportName: string): StyleLayerTypeDefinition => ({ type: `quad-${exportName}`, worker: { moduleUrl, exportName }, createMaterial: () => new MeshBasicNodeMaterial() })
    const layer = (exportName: string) => ({ id: exportName, type: `quad-${exportName}`, source: 'base', 'source-layer': 'roads' })
    const { process } = await createProcessor([layer('reused'), layer('plain'), layer('packed')], describeTypes(type('reused'), type('plain'), type('packed')))
    for (let round = 0; round < 2; round++) {
      const bucket = await process()
      expect(bucket.layers.map(mesh => mesh.layerId)).toEqual(['reused'])
      structuredClone(bucket, { transfer: collectTransferables(bucket) }) // what the worker does: detaches the copies only
    }
    const messages = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(messages).toMatch(/quad-plain.*`indices` as a Uint16Array or Uint32Array/)
    expect(messages).toMatch(/quad-packed.*"tint" of 8 or 16 bits needs an itemSize of 1, 2 or 4/)
  })
})
