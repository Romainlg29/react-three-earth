import { PerspectiveCamera } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { Imagery } from '../src/core/Imagery.js'
import { MapStyleSource, QuantizedMeshSource, RasterDemSource } from '../src/core/sources.js'
import { Terrain } from '../src/core/Terrain.js'
import { readStyleRoot } from '../src/vector/styleRoot.js'
import type { StyleDocument } from '../src/vector/worker/styleDocument.js'

const BASE_URL = 'https://maps.test/styles/style.json'

function style(root: Record<string, unknown> = {}): StyleDocument {
  return {
    version: 8,
    sources: {
      dem: { type: 'raster-dem', tiles: ['../dem/{z}/{x}/{y}.png'], encoding: 'terrarium', maxzoom: 12, attribution: '© DEM' },
      base: { type: 'vector', tiles: ['https://maps.test/{z}/{x}/{y}.pbf'] },
    },
    layers: [],
    ...root,
  }
}

describe('readStyleRoot', () => {
  it('reads nothing from a style without root properties', () => {
    expect(readStyleRoot(style(), BASE_URL)).toEqual({ initialView: null, view: null, terrain: null, warnings: [] })
  })

  it("maps center, zoom, bearing and pitch onto a view, MapLibre's pitch 0 looking straight down", () => {
    const root = readStyleRoot(style({ center: [2.35, 48.86], zoom: 11, bearing: 30, pitch: 60 }), BASE_URL)
    expect(root.initialView).toEqual({ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 11, headingDegrees: 30, pitchDegrees: -30 })
    expect(readStyleRoot(style({ zoom: 3 }), BASE_URL).initialView).toEqual({ zoom: 3 })
    expect(readStyleRoot(style({ pitch: 0 }), BASE_URL).initialView).toEqual({ pitchDegrees: -90 })
  })

  it('skips malformed view properties', () => {
    expect(readStyleRoot(style({ center: ['a', 1], zoom: 'far', bearing: null }), BASE_URL).initialView).toBeNull()
  })

  it('maps the projection onto the view mode', () => {
    expect(readStyleRoot(style({ projection: { type: 'mercator' } }), BASE_URL).view).toBe('2d')
    expect(readStyleRoot(style({ projection: { type: 'globe' } }), BASE_URL).view).toBe('3d')
    expect(readStyleRoot(style({ projection: { type: 'vertical-perspective' } }), BASE_URL).view).toBe('3d')
    expect(readStyleRoot(style({ projection: { type: ['interpolate', ['linear'], ['zoom'], 10, 'vertical-perspective', 12, 'mercator'] } }), BASE_URL).view).toBe('3d')
    const unknown = readStyleRoot(style({ projection: { type: 'equirectangular' } }), BASE_URL)
    expect(unknown.view).toBeNull()
    expect(unknown.warnings[0]).toMatch(/Pass <Earth view>/)
  })

  it('builds raster-dem source options from the terrain, URLs resolved against the style', () => {
    const root = readStyleRoot(style({ terrain: { source: 'dem', exaggeration: 1.5 } }), BASE_URL)
    expect(root.terrain).toEqual({
      sourceId: 'dem',
      source: { url: 'https://maps.test/dem/{z}/{x}/{y}.png', encoding: 'terrarium', maximumZoom: 12, attribution: '© DEM' },
      exaggeration: 1.5,
    })
    expect(() => new RasterDemSource(root.terrain!.source)).not.toThrow()
  })

  it('reads a TileJSON url, TMS rows and custom factors', () => {
    const tileJson = style({ terrain: { source: 'dem' } })
    tileJson.sources.dem = { type: 'raster-dem', url: 'dem.json' }
    expect(readStyleRoot(tileJson, BASE_URL).terrain).toEqual({ sourceId: 'dem', source: { tileJsonUrl: 'https://maps.test/styles/dem.json' }, exaggeration: 1 })

    const tms = style({ terrain: { source: 'dem' } })
    tms.sources.dem = { type: 'raster-dem', tiles: ['https://dem.test/{z}/{x}/{y}.png'], scheme: 'tms', encoding: 'custom', redFactor: 2, greenFactor: 3, blueFactor: 4, baseShift: 5 }
    expect(readStyleRoot(tms, BASE_URL).terrain?.source).toEqual({ url: 'https://dem.test/{z}/{x}/{-y}.png', encoding: 'custom', redFactor: 2, greenFactor: 3, blueFactor: 4, baseShift: 5 })
  })

  it('ignores a terrain it cannot load, with a warning that states the fix', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ terrain: {} }, /needs a `source`/],
      [{ terrain: { source: 'missing' } }, /not a source of the style/],
      [{ terrain: { source: 'base' } }, /a vector source.*Name a raster-dem source/],
    ]
    for (const [root, message] of cases) {
      const read = readStyleRoot(style(root), BASE_URL)
      expect(read.terrain).toBeNull()
      expect(read.warnings[0]).toMatch(message)
      expect(read.warnings[0]).toMatch(/<RasterDemSource>/)
    }
    const pmtiles = style({ terrain: { source: 'dem' } })
    pmtiles.sources.dem = { type: 'raster-dem', url: 'pmtiles://https://maps.test/dem.pmtiles' }
    expect(readStyleRoot(pmtiles, BASE_URL).warnings[0]).toMatch(/scheme terrain cannot load/)
    const quadkey = style({ terrain: { source: 'dem' } })
    quadkey.sources.dem = { type: 'raster-dem', tiles: ['https://dem.test/{quadkey}.png'] }
    expect(readStyleRoot(quadkey, BASE_URL).terrain).toBeNull()
    expect(readStyleRoot(quadkey, BASE_URL).warnings[0]).toMatch(/need \{z\}, \{x\} and \{y\} placeholders/)
    const headers = readStyleRoot(style({ terrain: { source: 'dem' } }), BASE_URL, { customRequests: true })
    expect(headers.terrain).not.toBeNull()
    expect(headers.warnings[0]).toMatch(/without its requestHeaders and transformRequest/)
    const bad = readStyleRoot(style({ terrain: { source: 'dem', exaggeration: -1 } }), BASE_URL)
    expect(bad.terrain?.exaggeration).toBe(1)
    expect(bad.warnings[0]).toMatch(/exaggeration must be a number of 0 or more/)
  })
})

describe('Earth following a style root', () => {
  afterEach(() => vi.restoreAllMocks())

  function styleSource(root: Record<string, unknown>) {
    return new MapStyleSource({ style: style(root), baseUrl: BASE_URL, createWorker: null })
  }

  async function loaded(source: MapStyleSource): Promise<void> {
    await vi.waitFor(() => expect(source.getStyle()).not.toBeNull())
    await Promise.resolve()
  }

  it("builds terrain from the style's terrain when the app sets none, and gives way to the app's", async () => {
    const earth = new Earth()
    const source = styleSource({ terrain: { source: 'dem', exaggeration: 2 } })
    earth.addImagery(new Imagery({ sources: [source] }))
    await loaded(source)
    await vi.waitFor(() => expect(earth.terrain).not.toBeNull())
    const styleTerrain = earth.terrain!
    expect(styleTerrain.exaggeration).toBe(2)
    expect(earth.inspect().terrain).toMatchObject({ url: 'https://maps.test/dem/{z}/{x}/{y}.png', fromStyle: true })
    expect(earth.getAttributions()).toContain('© DEM')

    const appTerrain = new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://example.com/terrain' })] })
    const dispose = vi.spyOn(styleTerrain, 'dispose')
    earth.setTerrain(appTerrain)
    expect(earth.terrain).toBe(appTerrain)
    expect(earth.inspect().terrain?.fromStyle).toBe(false)
    expect(dispose).toHaveBeenCalled()

    earth.setTerrain(null)
    expect(earth.terrain).not.toBeNull()
    expect(earth.terrain).not.toBe(appTerrain)
    expect(earth.inspect().terrain?.fromStyle).toBe(true)
  })

  it('applies a new exaggeration in place and drops the terrain with the style', async () => {
    const earth = new Earth()
    const source = styleSource({ terrain: { source: 'dem' } })
    const imagery = new Imagery({ sources: [source] })
    earth.addImagery(imagery)
    await loaded(source)
    await vi.waitFor(() => expect(earth.terrain).not.toBeNull())
    const terrain = earth.terrain!
    source.setStyle(style({ terrain: { source: 'dem', exaggeration: 3 } }))
    await vi.waitFor(() => expect(terrain.exaggeration).toBe(3))
    expect(earth.terrain).toBe(terrain)

    earth.removeImagery(imagery)
    expect(earth.terrain).toBeNull()
  })

  it("takes the style's projection and view unless the app chose them", async () => {
    const earth = new Earth()
    const source = styleSource({ projection: { type: 'mercator' }, center: [10, 20], zoom: 5 })
    earth.addImagery(new Imagery({ sources: [source] }))
    await loaded(source)
    await vi.waitFor(() => expect(earth.view.mode).toBe('2d'))
    expect((earth as unknown as { pendingInitialView: unknown }).pendingInitialView).toEqual({ longitudeDegrees: 10, latitudeDegrees: 20, zoom: 5 })

    const chosen = new Earth({ view: '3d', initialView: { zoom: 2 } })
    const other = styleSource({ projection: { type: 'mercator' }, center: [10, 20], zoom: 5 })
    chosen.addImagery(new Imagery({ sources: [other] }))
    await loaded(other)
    expect(chosen.view.mode).toBe('3d')
    expect((chosen as unknown as { pendingInitialView: unknown }).pendingInitialView).toEqual({ zoom: 2 })
  })

  it('leaves a camera the app put outside the Earth where it is', async () => {
    const earth = new Earth()
    const camera = new PerspectiveCamera()
    camera.position.set(7e6, 0, 0)
    ;(earth as unknown as { lastCamera: unknown }).lastCamera = camera
    const source = styleSource({ center: [10, 20], zoom: 5 })
    earth.addImagery(new Imagery({ sources: [source] }))
    await loaded(source)
    expect((earth as unknown as { pendingInitialView: unknown }).pendingInitialView).toBeNull()
  })

  it("leaves a camera already placed by the app where it is", async () => {
    const earth = new Earth()
    Object.defineProperty(earth.camera, 'hasPlacedView', { get: () => true })
    const source = styleSource({ center: [10, 20], zoom: 5 })
    earth.addImagery(new Imagery({ sources: [source] }))
    await loaded(source)
    expect((earth as unknown as { pendingInitialView: unknown }).pendingInitialView).toBeNull()
  })
})
