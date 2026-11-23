import { describe, expect, it, vi } from 'vitest'

import { RasterTileSource } from '../src/core/sources.js'
import { readTileJson } from '../src/tiles/imagery/XYZImageryOverlay.js'
import { elevationFieldGrid } from '../src/vector/raster/RasterLayerRenderer.js'
import {
  colorReliefRamp,
  contrastFactor,
  hillshadeSlopeScale,
  MAXIMUM_COLOR_RELIEF_STOPS,
  saturationFactor,
  spinWeights,
  summarizeRasterLayers,
  type ColorReliefPaint,
  type HillshadePaint,
  type RasterPaint,
} from '../src/vector/raster/rasterLayers.js'
import { decodeDemPixels, decodeRasterTile, demUnpackFactors, rasterTileByteLength } from '../src/vector/raster/rasterTiles.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { compileStyleLayers, type CompiledStyleLayer } from '../src/vector/worker/styleLayers.js'
import { mercatorBoundingBox, quadkey, XYZFetcher } from '../src/vector/worker/tileSources.js'
import { createFakeFetch, encodePMTiles } from './helpers/encodeArchives.js'

const baseUrl = 'https://maps.test/style.json'

/** Two pixels: Terrarium 0 m and 522.5 m. */
const terrariumPixels = { width: 2, height: 1, data: new Uint8Array([128, 0, 0, 255, 130, 10, 128, 255]) }
const fakeBitmap = (bytes: Uint8Array) => ({ width: 256, height: 256, bytes, close() {} }) as unknown as ImageBitmap

function compile(layers: object[]): CompiledStyleLayer[] {
  return compileStyleLayers(layers as never).layers
}

describe('raster-dem decoding', () => {
  it('unpacks Terrarium, Mapbox Terrain-RGB and custom encodings as MapLibre does', () => {
    const decode = (rgb: number[], source: object) => decodeDemPixels([...rgb, 255], 1, 1, demUnpackFactors(source))[0]
    expect(decode([128, 0, 0], { encoding: 'terrarium' })).toBe(0)
    expect(decode([130, 10, 128], { encoding: 'terrarium' })).toBeCloseTo(522.5, 3)
    expect(decode([1, 134, 160], {})).toBeCloseTo(0, 3) // mapbox is the default
    expect(decode([1, 134, 170], { encoding: 'mapbox' })).toBeCloseTo(1, 3)
    expect(decode([1, 2, 3], { encoding: 'custom', redFactor: 100, greenFactor: 10, blueFactor: 1, baseShift: 50 })).toBe(73)
    expect(() => demUnpackFactors({ encoding: 'bogus' as never })).toThrow(/use "terrarium", "mapbox" or "custom"/)
  })

  it('decodes raster tiles to images and raster-dem tiles to elevations', async () => {
    const decoders = { decodeImage: vi.fn(async (bytes: Uint8Array) => fakeBitmap(bytes)), decodePixels: vi.fn(async () => terrariumPixels) }
    const image = await decodeRasterTile(new Uint8Array([1]), { type: 'raster' }, decoders)
    expect(image).toMatchObject({ kind: 'image', width: 256, height: 256 })
    expect(rasterTileByteLength(image)).toBe(256 * 256 * 8)
    const dem = await decodeRasterTile(new Uint8Array([1]), { type: 'raster-dem', encoding: 'terrarium' }, decoders)
    expect(dem.kind).toBe('dem')
    expect(dem.kind === 'dem' && [...dem.elevations]).toEqual([0, 522.5])
  })
})

describe('raster paint maths', () => {
  it('reproduces MapLibre\'s hue rotation, contrast and saturation factors', () => {
    expect(spinWeights(0).map(value => +value.toFixed(6))).toEqual([1, 0, 0])
    expect(spinWeights(120).map(value => +value.toFixed(6) + 0)).toEqual([0, 0, 1])
    expect(contrastFactor(0)).toBe(1)
    expect(contrastFactor(0.5)).toBe(2)
    expect(contrastFactor(-0.5)).toBe(0.5)
    expect(saturationFactor(0)).toBeCloseTo(0)
    expect(saturationFactor(-1)).toBe(1)
    expect(saturationFactor(0.5)).toBeCloseTo(1 - 1 / 0.501)
  })

  it('steepens hillshade slopes below zoom 15', () => {
    expect(hillshadeSlopeScale(15)).toBe(1)
    expect(hillshadeSlopeScale(18)).toBe(1)
    expect(hillshadeSlopeScale(5)).toBeCloseTo(2 ** 3)
    expect(hillshadeSlopeScale(3)).toBeCloseTo(2 ** (12 * 0.35))
    expect(hillshadeSlopeScale(0)).toBeCloseTo(2 ** 6)
  })
})

describe('colour relief ramps', () => {
  const ramp = (color: unknown) => colorReliefRamp(compile([{ id: 'relief', type: 'color-relief', source: 'dem', paint: { 'color-relief-color': color } }])[0]!)

  it('lists the stops of an interpolation over the elevation', () => {
    expect(ramp(['interpolate', ['linear'], ['elevation'], 0, '#000000', 1000, '#ffffff'])).toEqual({ elevations: [0, 1000], colors: [0, 0, 0, 1, 1, 1, 1, 1] })
  })

  it('turns a step into pairs of stops a centimetre apart', () => {
    const { elevations, colors } = ramp(['step', ['elevation'], '#000000', 500, '#ff0000', 1500, '#0000ff'])
    expect(elevations).toEqual([499.99, 500, 1499.99, 1500])
    expect(colors).toEqual([0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1])
  })

  it('handles a constant colour and resamples long ramps', () => {
    expect(ramp('#ff0000')).toEqual({ elevations: [0], colors: [1, 0, 0, 1] })
    const stops = Array.from({ length: 300 }, (_, index) => [index * 10, index % 2 === 0 ? '#000000' : '#ffffff']).flat()
    const long = ramp(['interpolate', ['linear'], ['elevation'], ...stops])
    expect(long.elevations).toHaveLength(MAXIMUM_COLOR_RELIEF_STOPS)
    expect(long.elevations[0]).toBe(0)
    expect(long.elevations.at(-1)).toBe(2990)
  })
})

describe('raster layer summaries', () => {
  const sources = { satellite: { type: 'raster' }, dem: { type: 'raster-dem' }, base: { type: 'vector' } }

  it('evaluates raster paint per zoom and leaves out zooms where the layer draws nothing', () => {
    const layers = compile([
      { id: 'satellite', type: 'raster', source: 'satellite', minzoom: 5, paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 12, 0], 'raster-contrast': 0.5, 'raster-resampling': 'nearest' } },
    ])
    const [summary] = summarizeRasterLayers(layers, sources)
    expect(summary).toMatchObject({ id: 'satellite', type: 'raster', source: 'satellite' })
    expect(summary!.paintByZoom[4]).toBeNull()
    expect(summary!.paintByZoom[12]).toBeNull() // opacity 0
    const paint = summary!.paintByZoom[11] as unknown as RasterPaint
    expect(paint).toMatchObject({ opacity: 0.5, contrastFactor: 2, brightnessMinimum: 0, brightnessMaximum: 1, nearest: true })
  })

  it('evaluates hillshade lights: one for the single-light methods, up to four for multidirectional', () => {
    const layers = compile([
      { id: 'standard', type: 'hillshade', source: 'dem' },
      { id: 'multi', type: 'hillshade', source: 'dem', paint: { 'hillshade-method': 'multidirectional', 'hillshade-illumination-direction': [270, 315, 0], 'hillshade-illumination-altitude': [30, 60] } },
      { id: 'wrong source', type: 'hillshade', source: 'base' },
    ])
    const summaries = summarizeRasterLayers(layers, sources)
    expect(summaries.map(summary => summary.id)).toEqual(['standard', 'multi'])
    const standard = summaries[0]!.paintByZoom[16] as unknown as HillshadePaint
    expect(standard.method).toBe(0)
    expect(standard.directionsRadians).toEqual([(335 * Math.PI) / 180])
    expect(standard.slopeScale).toBe(1)
    const multi = summaries[1]!.paintByZoom[16] as unknown as HillshadePaint
    expect(multi.method).toBe(4)
    expect(multi.directionsRadians.map(radians => Math.round((radians * 180) / Math.PI))).toEqual([270, 315, 0])
    expect(multi.altitudesRadians.map(radians => Math.round((radians * 180) / Math.PI))).toEqual([30, 60, 60]) // padded with the last
    expect(multi.shadowColors).toHaveLength(3)
  })

  it('draws a colour relief only with a colour ramp', () => {
    const layers = compile([
      { id: 'no ramp', type: 'color-relief', source: 'dem' },
      { id: 'relief', type: 'color-relief', source: 'dem', paint: { 'color-relief-opacity': 0.5, 'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#000000', 100, '#ffffff'] } },
    ])
    const [empty, relief] = summarizeRasterLayers(layers, sources)
    expect(empty!.paintByZoom.every(paint => paint === null)).toBe(true)
    expect(relief!.paintByZoom[3] as unknown as ColorReliefPaint).toMatchObject({ opacity: 0.5, elevations: [0, 100] })
  })

  it('gives each raster layer a draw group of its own', () => {
    const layers = compile([
      { id: 'background', type: 'background' },
      { id: 'land', type: 'fill', source: 'base', 'source-layer': 'land' },
      { id: 'satellite', type: 'raster', source: 'satellite' },
      { id: 'relief', type: 'color-relief', source: 'dem' },
      { id: 'hillshade', type: 'hillshade', source: 'dem' },
      { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads' },
    ])
    expect(layers.map(layer => layer.group)).toEqual([0, 0, 1, 2, 3, 4])
  })
})

describe('raster sources in the worker', () => {
  function reliefStyle(extraLayers: object[] = []) {
    return {
      version: 8,
      sources: {
        satellite: { type: 'raster', tiles: ['https://maps.test/sat/{z}/{x}/{-y}.png'], tileSize: 256, bounds: [5, 40, 10, 45] },
        dem: { type: 'raster-dem', url: '/dem.json' },
      },
      layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }, { id: 'hillshade', type: 'hillshade', source: 'dem' }, ...extraLayers],
    }
  }
  const files = {
    'https://maps.test/dem.json': { tiles: ['dem/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 12, bounds: [0, 0, 20, 50] },
    'https://maps.test/sat/1/1/0.png': new Uint8Array([7]),
    'https://maps.test/dem/2/1/1.png': new Uint8Array([8]),
  }
  const hooks = { decodeRasterImage: vi.fn(async (bytes: Uint8Array) => fakeBitmap(bytes)), decodeImage: vi.fn(async () => terrariumPixels) }

  it('summarizes raster sources with their tile size, bounds and TileJSON metadata', async () => {
    const { fetch } = createFakeFetch(files)
    const processor = await MapStyleProcessor.create({ style: reliefStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    expect(processor.summary.sources).toMatchObject([
      { id: 'satellite', type: 'raster', tileSizePixels: 256, bounds: [5, 40, 10, 45] },
      { id: 'dem', type: 'raster-dem', maximumZoom: 12, tileSizePixels: 256, bounds: [0, 0, 20, 50] },
    ])
    expect(processor.summary.rasterLayers!.map(layer => [layer.id, layer.type, layer.source])).toEqual([
      ['satellite', 'raster', 'satellite'],
      ['hillshade', 'hillshade', 'dem'],
    ])
    expect(processor.summary.skippedLayers).toEqual([])
  })

  it('decodes raster tiles (TMS rows with {-y}) and raster-dem tiles with the TileJSON encoding', async () => {
    const { fetch, requests } = createFakeFetch(files)
    const processor = await MapStyleProcessor.create({ style: reliefStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    const image = await processor.processTile({ sourceId: 'satellite', x: 1, y: 1, z: 1, zoom: 1 })
    expect(requests.at(-1)!.url).toBe('https://maps.test/sat/1/1/0.png')
    expect(image.raster).toMatchObject({ kind: 'image', width: 256 })
    expect(image.byteLength).toBe(256 * 256 * 8)
    const dem = await processor.processTile({ sourceId: 'dem', x: 1, y: 1, z: 2, zoom: 2 })
    expect(dem.raster?.kind === 'dem' && [...dem.raster.elevations]).toEqual([0, 522.5])
    const missing = await processor.processTile({ sourceId: 'dem', x: 0, y: 0, z: 2, zoom: 2 })
    expect(missing).toMatchObject({ raster: null, shapes: null, byteLength: 0 })
  })

  it('keeps compressed tiles in the worker, refetching after invalidate, and skips tiles that are not images', async () => {
    const { fetch, requests } = createFakeFetch(files)
    const processor = await MapStyleProcessor.create({ style: reliefStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    const tile = { sourceId: 'satellite', x: 1, y: 1, z: 1, zoom: 1 }
    await processor.processTile(tile)
    await processor.processTile(tile)
    expect(requests.filter(request => request.url.endsWith('/sat/1/1/0.png'))).toHaveLength(1)
    processor.invalidate(null)
    await processor.processTile(tile)
    expect(requests.filter(request => request.url.endsWith('/sat/1/1/0.png'))).toHaveLength(2)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = await MapStyleProcessor.create({ style: reliefStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, decodeRasterImage: async () => Promise.reject(new Error('not an image')) })
    expect(await failing.processTile(tile)).toMatchObject({ raster: null, byteLength: 0 })
    await failing.processTile({ ...tile, x: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/check that its server answers PNG, JPEG, WebP or AVIF/)
    warn.mockRestore()
  })

  it('finds no features in raster tiles', async () => {
    const { fetch } = createFakeFetch(files)
    const processor = await MapStyleProcessor.create({ style: reliefStyle(), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    expect(await processor.querySourceFeatures({ sourceId: 'satellite', sourceLayer: null, filter: null, tiles: [{ x: 1, y: 1, z: 1 }] })).toEqual([])
  })

  it('reads raster PMTiles archives', async () => {
    const archive = encodePMTiles([{ z: 2, x: 1, y: 1, data: new Uint8Array([9, 9]) }], 0, 4, '{}', 2)
    const { fetch } = createFakeFetch({ 'https://maps.test/sat.pmtiles': archive })
    const style = { version: 8, sources: { satellite: { type: 'raster', url: 'pmtiles://https://maps.test/sat.pmtiles' } }, layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }] }
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    expect(processor.summary.sources).toMatchObject([{ id: 'satellite', type: 'raster', maximumZoom: 4 }])
    const bucket = await processor.processTile({ sourceId: 'satellite', x: 1, y: 1, z: 2, zoom: 2 })
    expect([...(bucket.raster as unknown as { image: { bytes: Uint8Array } }).image.bytes]).toEqual([9, 9])
  })

  it('skips a layer reading a source of the wrong kind without loading the source', async () => {
    const { fetch, requests } = createFakeFetch(files)
    const style = { version: 8, sources: { dem: { type: 'raster-dem', url: '/dem.json' } }, layers: [{ id: 'land', type: 'fill', source: 'dem', 'source-layer': 'land' }] }
    const processor = await MapStyleProcessor.create({ style, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, ...hooks })
    expect(processor.summary.skippedLayers).toEqual(['land'])
    expect(processor.summary.sources).toEqual([])
    expect(requests).toEqual([])
  })
})

describe('tile URL templates', () => {
  const context = { baseUrl, requestHeaders: {}, fetch: async () => new Response(null) }

  it('fills {-y}, {quadkey} and {bbox-epsg-3857} as MapLibre does', () => {
    const fetcher = new XYZFetcher(['https://t.test/{z}/{x}/{-y}/{quadkey}?bbox={bbox-epsg-3857}'], 0, 22, false, context)
    expect(fetcher.getUrl(0, 0, 0)).toBe('https://t.test/0/0/0/?bbox=-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244')
    expect(fetcher.getUrl(3, 5, 3).startsWith('https://t.test/3/3/2/213?')).toBe(true)
    expect(quadkey(3, 5, 3)).toBe('213')
    expect(mercatorBoundingBox(1, 0, 1)).toEqual([0, 0, 20037508.342789244, 20037508.342789244])
  })
})

describe('RasterTileSource with TileJSON', () => {
  it('reads the template, zoom levels and attribution of a TileJSON, turning TMS into {-y}', () => {
    const info = readTileJson({ tiles: ['t/{z}/{x}/{y}.png'], scheme: 'tms', maxzoom: 14, attribution: '© Test' }, 'https://maps.test/a/tiles.json')
    expect(info).toEqual({ url: 'https://maps.test/a/t/{z}/{x}/{-y}.png', levels: 15, attribution: '© Test' })
    expect(readTileJson({ tiles: ['https://cdn.test/{z}/{x}/{y}.jpg'] }, 'https://maps.test/tiles.json')).toEqual({ url: 'https://cdn.test/{z}/{x}/{y}.jpg', levels: undefined, attribution: undefined })
    expect(() => readTileJson({}, 'https://maps.test/tiles.json')).toThrow(/has no `tiles`/)
  })

  it('takes either a url template (with {y} or {-y}) or a TileJSON url', () => {
    expect(new RasterTileSource({ url: 'https://t.test/{z}/{x}/{-y}.png' }).url).toBe('https://t.test/{z}/{x}/{-y}.png')
    expect(new RasterTileSource({ tileJsonUrl: 'https://t.test/tiles.json' }).tileJsonUrl).toBe('https://t.test/tiles.json')
    expect(() => new RasterTileSource({})).toThrow(/either `url`.*or `tileJsonUrl`/)
    expect(() => new RasterTileSource({ url: 'https://t.test/{z}/{x}/{y}.png', tileJsonUrl: 'https://t.test/tiles.json' })).toThrow(/either `url`/)
  })
})

describe('elevation field grid', () => {
  it('samples every source pixel centre when the region fits the resolution, rounding the range outwards', () => {
    expect(elevationFieldGrid([0, 0, 0.25, 0.25], 256, 2, 256)).toEqual({ stride: 1, step: 1 / 1024, offset: 1 / 2048, firstColumn: -1, lastColumn: 256, firstRow: 767, lastRow: 1024 })
  })

  it('skips pixels by a power of two when the region spans more pixels than the resolution', () => {
    expect(elevationFieldGrid([0, 0, 0.25, 0.25], 64, 2, 256).stride).toBe(4)
    expect(elevationFieldGrid([0, 0, 0.25, 0.25], 100, 2, 256).stride).toBe(4)
    expect(elevationFieldGrid([0, 0, 0.25, 0.25], 128, 2, 256).stride).toBe(2)
  })
})
