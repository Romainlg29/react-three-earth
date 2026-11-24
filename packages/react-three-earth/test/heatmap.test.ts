import { afterEach, describe, expect, it, vi } from 'vitest'

import { HeatmapLayers } from '../src/vector/heatmap/HeatmapLayers.js'
import { HEATMAP_GAUSS_COEFFICIENT, HEATMAP_ZERO_DENSITY, heatmapExtentRadii, heatmapKernel } from '../src/vector/heatmap/heatmapKernel.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import type { CustomLayerMesh } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

afterEach(() => vi.restoreAllMocks())

describe('heatmap kernel', () => {
  it('is a Gaussian of the distance in radii, scaled by weight × intensity, as MapLibre draws it', () => {
    expect(heatmapKernel(1, 0)).toBeCloseTo(HEATMAP_GAUSS_COEFFICIENT, 12)
    expect(heatmapKernel(3, 0)).toBeCloseTo(3 * HEATMAP_GAUSS_COEFFICIENT, 12)
    // exp(-4.5 d²): at one radius the kernel has fallen to e^-4.5 of its peak.
    expect(heatmapKernel(1, 1) / heatmapKernel(1, 0)).toBeCloseTo(Math.exp(-4.5), 12)
    expect(heatmapKernel(2, 0.5)).toBeCloseTo(2 * heatmapKernel(1, 0.5), 12)
  })

  it('reaches to where the kernel falls to the zero density, and nowhere for a point too light to show', () => {
    for (const product of [0.01, 1, 10, 1000]) {
      const extent = heatmapExtentRadii(product)
      expect(heatmapKernel(product, extent)).toBeCloseTo(HEATMAP_ZERO_DENSITY, 9)
    }
    expect(heatmapExtentRadii(1)).toBeCloseTo(1.282, 3)
    expect(heatmapExtentRadii(10)).toBeGreaterThan(heatmapExtentRadii(1))
    expect(heatmapExtentRadii(HEATMAP_ZERO_DENSITY / HEATMAP_GAUSS_COEFFICIENT / 2)).toBe(0)
    expect(heatmapExtentRadii(0)).toBe(0)
  })
})

function heatmapStyle(paint: Record<string, unknown> = {}, extra: object[] = []) {
  return {
    version: 8,
    sources: { base: { type: 'vector', tiles: ['https://maps.test/{z}/{x}/{y}.pbf'] } },
    layers: [
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#0000ff' } },
      { id: 'heat', type: 'heatmap', source: 'base', 'source-layer': 'places', paint },
      ...extra,
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#00ff00' } },
    ],
  }
}

async function createProcessor(paint: Record<string, unknown> = {}, extra: object[] = []) {
  const tile = encodeVectorTile([
    { name: 'water', features: [{ type: 'Polygon', id: 1, geometry: [[[0, 0], [1024, 0], [1024, 1024], [0, 1024], [0, 0]]] }] },
    {
      name: 'places',
      features: [
        { type: 'Point', id: 2, geometry: [[[1000, 1000]]], properties: { count: 4 } },
        { type: 'Point', id: 3, geometry: [[[2000, 3000], [2100, 3000]]], properties: { count: 0 } },
        // In the tile's buffer: the neighbouring tile draws it.
        { type: 'Point', id: 4, geometry: [[[4200, 100]]], properties: { count: 1 } },
      ],
    },
    { name: 'roads', features: [{ type: 'LineString', id: 5, geometry: [[[0, 3000], [4096, 3000]]] }] },
  ])
  const { fetch } = createFakeFetch({ 'https://maps.test/0/0/0.pbf': tile })
  const processor = await MapStyleProcessor.create({ style: heatmapStyle(paint, extra), baseUrl: 'https://maps.test/', requestHeaders: {}, localFontFamily: 'sans-serif' }, { fetch: vi.fn(fetch) as typeof globalThis.fetch })
  return { processor, process: () => processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 0, zoom: 0 }) }
}

function values(mesh: CustomLayerMesh, name: string): number[] {
  return [...mesh.attributes.find(entry => entry.name === name)!.array]
}

describe('heatmap layers in the worker', () => {
  it('are drawn, not skipped: one kernel quad per point the tile owns, in a draw group of their own', async () => {
    const { processor, process } = await createProcessor()
    expect(processor.summary.skippedLayers).toEqual([])
    expect(processor.summary.missingLayerTypes).toEqual([])
    expect(processor.summary.customLayerTypes).toEqual(['heatmap'])
    const bucket = await process()
    expect(bucket.layers).toHaveLength(1)
    const mesh = bucket.layers[0]!
    expect(mesh).toMatchObject({ layerId: 'heat', layerType: 'heatmap' })
    expect(mesh.attributes.map(entry => entry.name).sort()).toEqual(['heatmapCenter', 'heatmapRadius', 'heatmapWeight', 'position'])
    // Three points inside (a multipoint counts each), none from the buffer.
    const corners = (x: number, y: number) => [x, y, x, y, x, y, x, y]
    expect(values(mesh, 'heatmapCenter')).toEqual([...corners(1000, 1000), ...corners(2000, 3000), ...corners(2100, 3000)])
    expect(mesh.indices.length).toBe(18)
    expect(values(mesh, 'heatmapRadius')).toEqual(new Array(12).fill(30)) // MapLibre's default
    // The quad reaches as far as the kernel: radius × extent, in tile units at this zoom (4096 units per 512 px).
    const position = values(mesh, 'position')
    const halfSize = 30 * heatmapExtentRadii(1) * (4096 / 512)
    expect(position[0]).toBeCloseTo(1000 - halfSize, 3)
    expect(position[4]).toBeCloseTo(1000 + halfSize, 3)
    // Between water and roads.
    const groups = bucket.shapes!.groups.map(group => group.group)
    expect(Math.min(...groups)).toBeLessThan(mesh.group)
    expect(Math.max(...groups)).toBeGreaterThan(mesh.group)
  })

  it('sizes quads at the drawn zoom when the tile is overzoomed', async () => {
    const { processor } = await createProcessor()
    const mesh = (await processor.processTile({ sourceId: 'base', x: 0, y: 0, z: 0, zoom: 3 })).layers[0]!
    const position = values(mesh, 'position')
    // 8 times the pixels per tile at zoom 3: the same 30 px radius is an eighth as many tile units.
    expect(position[4]! - position[0]!).toBeCloseTo((2 * 30 * heatmapExtentRadii(1) * 4096) / 512 / 8, 3)
  })

  it('reads data-driven weight and radius per feature, leaving out points of no weight, and clamps the reach to a tile', async () => {
    const { process } = await createProcessor({ 'heatmap-weight': ['get', 'count'], 'heatmap-radius': ['*', 300, ['get', 'count']] })
    const mesh = (await process()).layers[0]!
    expect(values(mesh, 'heatmapWeight')).toEqual(new Array(4).fill(4)) // the zero-weight points are gone
    expect(values(mesh, 'heatmapRadius')).toEqual(new Array(4).fill(1200))
    const position = values(mesh, 'position')
    expect(position[4]! - position[0]!).toBeCloseTo(2 * 512 * 8, 3) // 512 px each way at most
  })

  it('summarises what colours each layer: the colour ramp, opacity, intensity and reach per zoom', async () => {
    const { processor } = await createProcessor(
      {
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0, 0, 0, 0)', 1, '#ff0000'],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 0.5],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 3],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 10, 10, 400],
      },
      [{ id: 'heat-2', type: 'heatmap', source: 'base', 'source-layer': 'places', paint: { 'heatmap-radius': ['get', 'count'] } }],
    )
    const [first, second] = processor.summary.heatmapLayers!
    expect(first!.id).toBe('heat')
    // Premultiplied: half density is half-red at half alpha (the style specification interpolates straight colours).
    expect([...first!.colorRamp.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...first!.colorRamp.slice(255 * 4, 256 * 4)]).toEqual([255, 0, 0, 255])
    const middle = [...first!.colorRamp.slice(128 * 4, 129 * 4)]
    expect(middle[0]).toBeCloseTo(64, -1)
    expect(middle[3]).toBeCloseTo(128, -1)
    expect(first!.opacityByZoom[0]).toBe(1)
    expect(first!.opacityByZoom[10]).toBeCloseTo(0.5)
    expect(first!.intensityByZoom[5]).toBeCloseTo(2)
    // The radius times the kernel's extent for the zoom's weight × intensity, at most a tile.
    expect(first!.reachPixelsByZoom[0]).toBeCloseTo(10 * heatmapExtentRadii(1), 6)
    expect(first!.reachPixelsByZoom[5]).toBeCloseTo(205 * heatmapExtentRadii(2), 6)
    expect(first!.reachPixelsByZoom[10]).toBe(512)
    expect(first!.opacityByZoom).toHaveLength(25)
    // A radius read from the features could be anything: it reaches as far as allowed. So does a weight.
    expect(second!.reachPixelsByZoom[0]).toBe(512)
    const { processor: weighted } = await createProcessor({ 'heatmap-weight': ['get', 'count'], 'heatmap-radius': 10 })
    expect(weighted.summary.heatmapLayers![0]!.reachPixelsByZoom[3]).toBe(512)
    // The default ramp starts transparent and ends red.
    const { processor: plain } = await createProcessor()
    const ramp = plain.summary.heatmapLayers![0]!.colorRamp
    expect(ramp[3]).toBe(0)
    expect([...ramp.slice(255 * 4)]).toEqual([255, 0, 0, 255])
  })

  it('follows setPaintProperty: the summary and the tile change', async () => {
    const { processor, process } = await createProcessor()
    const result = await processor.applyCommands([
      { command: 'setPaintProperty', args: ['heat', 'heatmap-opacity', 0.25] },
      { command: 'setPaintProperty', args: ['heat', 'heatmap-radius', 10] },
    ])
    expect(result.errors).toEqual([])
    expect(result.rebuiltSources).toContain('base')
    expect(result.summary.heatmapLayers![0]!.opacityByZoom[3]).toBe(0.25)
    expect(values((await process()).layers[0]!, 'heatmapRadius')[0]).toBe(10)
  })
})

describe('HeatmapLayers (main thread)', () => {
  const summary = (id: string, intensity: number, opacity: number) => ({
    id,
    colorRamp: new Uint8Array(1024).fill(id === 'a' ? 10 : 20),
    opacityByZoom: new Array(25).fill(opacity),
    intensityByZoom: new Array(25).fill(intensity),
    reachPixelsByZoom: Array.from({ length: 25 }, (_, zoom) => zoom * 10),
  })

  it('gives each draw its layer intensity, each composite its ramp row and opacity, and reports the reach per zoom', () => {
    const heatmap = new HeatmapLayers()
    heatmap.setLayers([summary('a', 2, 0.5), summary('b', 3, 0.75)])
    const draw = { userData: {} } as never as import('three').Object3D
    heatmap.prepareDraw(draw, 'b', 4)
    expect(draw.userData.heatmap).toEqual({ intensity: 3, rampRow: 1, opacity: 0.75 })
    heatmap.prepareComposite(draw, 'a', 30) // past the last zoom: the last value
    expect(draw.userData.heatmap).toEqual({ intensity: 2, rampRow: 0, opacity: 0.5 })
    // A layer gone from the style draws nothing.
    heatmap.prepareDraw(draw, 'gone', 4)
    expect(draw.userData.heatmap).toMatchObject({ intensity: 0, opacity: 0 })
    expect(heatmap.reachPixelsAt(7)).toBe(70)
    expect(heatmap.definition).toMatchObject({ type: 'heatmap', offscreen: { blending: 'additive' } })
    // A new copy of the same ramps (every worker summary is one) keeps the atlas; a changed ramp or row count replaces it.
    const atlas = () => (heatmap as unknown as { rampAtlas: import('three').DataTexture }).rampAtlas
    const first = atlas()
    expect(first.image.height).toBe(2)
    expect(first.image.data![1024]).toBe(20) // row 1 holds layer b
    heatmap.setLayers([summary('a', 5, 0.5), summary('b', 3, 0.75)])
    expect(atlas()).toBe(first)
    heatmap.prepareDraw(draw, 'a', 4)
    expect(draw.userData.heatmap).toMatchObject({ intensity: 5 })
    heatmap.setLayers([summary('b', 3, 0.75)])
    expect(atlas()).not.toBe(first)
    expect(atlas().image.height).toBe(1)
    heatmap.prepareDraw(draw, 'b', 4)
    expect(draw.userData.heatmap).toMatchObject({ rampRow: 0 })
    heatmap.dispose()
  })
})
