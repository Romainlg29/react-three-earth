import { describe, expect, it, vi } from 'vitest'

import { RasterDemSource } from '../src/core/sources.js'
import { buildDemTileSurface, buildPolarCapSurface, buildSurface, demTileGeometricError, sampleRaster, webMercatorTileBounds, type ElevationRaster, type TerrainSurface } from '../src/tiles/dem/demSurface.js'
import type { DemImageDecoder } from '../src/tiles/dem/demTasks.js'
import { RasterDemTerrainPlugin } from '../src/tiles/RasterDemTerrainPlugin.js'
import { DemMeshBuilder } from '../src/tiles/dem/DemMeshBuilder.js'
import { demUnpackFactors } from '../src/vector/raster/rasterTiles.js'
import { ecefToGeodetic, WEB_MERCATOR_MAX_LATITUDE_RADIANS, type GeodeticRadians } from '../src/view/webMercator.js'

const DEGREES = Math.PI / 180

/** Geodetic coordinates of every vertex of a surface. */
function vertices(surface: TerrainSurface): GeodeticRadians[] {
  const result: GeodeticRadians[] = []
  for (let index = 0; index < surface.positions.length / 3; index++) {
    result.push(
      ecefToGeodetic(
        surface.positions[index * 3]! + surface.center[0],
        surface.positions[index * 3 + 1]! + surface.center[1],
        surface.positions[index * 3 + 2]! + surface.center[2],
        { longitude: 0, latitude: 0, heightMeters: 0 },
      ),
    )
  }
  return result
}

/** A raster whose pixels (centres) hold a function of their position in the raster, `u` east and `v` down. */
function rasterOf(size: number, height: (u: number, v: number) => number): ElevationRaster {
  const elevations = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) elevations[y * size + x] = height((x + 0.5) / size, (y + 0.5) / size)
  return { width: size, height: size, elevations }
}

/** The up component (along the ellipsoid normal) of each triangle's face normal, skirts left out. */
function triangleUps(surface: TerrainSurface, gridCount: number): number[] {
  const { positions, indices, center } = surface
  const ups: number[] = []
  for (let first = 0; first < indices.length; first += 3) {
    const [a, b, c] = [indices[first]!, indices[first + 1]!, indices[first + 2]!]
    if (a >= gridCount || b >= gridCount || c >= gridCount) continue
    const p = (i: number) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
    const [pa, pb, pc] = [p(a), p(b), p(c)]
    const e1 = pb.map((value, axis) => value - pa[axis]!)
    const e2 = pc.map((value, axis) => value - pa[axis]!)
    const normal = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const up = pa.map((value, axis) => value + center[axis]!)
    const length = Math.hypot(...up)
    ups.push((normal[0]! * up[0]! + normal[1]! * up[1]! + normal[2]! * up[2]!) / length)
  }
  return ups
}

describe('terrain surfaces from elevation rasters', () => {
  it('builds a grid with skirts hanging below its edges, facing up', () => {
    const longitudes = [0, 0.01, 0.02]
    const latitudes = [0.5, 0.51]
    const heights = [100, 200, 300, 400, 500, 600]
    const surface = buildSurface({ longitudes, latitudes, heights, skirtLengthMeters: 50, skirtEdges: { west: true, south: true, east: true, north: true } })
    // 6 grid vertices, then the south (3), east (2), north (3) and west (2) skirts.
    expect(surface.positions.length / 3).toBe(6 + 10)
    expect(surface.minimumHeightMeters).toBe(100)
    expect(surface.maximumHeightMeters).toBe(600)
    const geodetic = vertices(surface)
    geodetic.slice(0, 6).forEach((vertex, index) => {
      expect(vertex.longitude).toBeCloseTo(longitudes[index % 3]!, 7)
      expect(vertex.latitude).toBeCloseTo(latitudes[Math.floor(index / 3)]!, 7)
      expect(vertex.heightMeters).toBeCloseTo(heights[index]!, 1)
    })
    // The south skirt sits 50 m under the south row.
    for (let column = 0; column < 3; column++) expect(geodetic[6 + column]!.heightMeters).toBeCloseTo(heights[column]! - 50, 1)
    // Every grid triangle faces up; every skirt triangle faces out of the tile.
    expect(Math.min(...triangleUps(surface, 6))).toBeGreaterThan(0)
    for (let index = 0; index < surface.normals.length / 3; index++) {
      expect(Math.hypot(surface.normals[index * 3]!, surface.normals[index * 3 + 1]!, surface.normals[index * 3 + 2]!)).toBeCloseTo(1, 5)
    }
  })

  it('turns skirt walls outwards on every edge', () => {
    const size = 4
    const longitudes = Array.from({ length: size }, (_, index) => index * 0.001)
    const latitudes = Array.from({ length: size }, (_, index) => index * 0.001)
    const surface = buildSurface({ longitudes, latitudes, heights: new Array(size * size).fill(0), skirtLengthMeters: 10, skirtEdges: { west: true, south: true, east: true, north: true } })
    const { positions, indices, center } = surface
    const tileCenter = [0, 0, 0]
    for (let index = 0; index < size * size; index++) for (let axis = 0; axis < 3; axis++) tileCenter[axis]! += positions[index * 3 + axis]! / (size * size)
    let walls = 0
    for (let first = 0; first < indices.length; first += 3) {
      const corners = [indices[first]!, indices[first + 1]!, indices[first + 2]!]
      if (corners.every(corner => corner < size * size)) continue
      walls++
      const p = corners.map(i => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!])
      const e1 = p[1]!.map((value, axis) => value - p[0]![axis]!)
      const e2 = p[2]!.map((value, axis) => value - p[0]![axis]!)
      const normal = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
      const outwards = p[0]!.map((value, axis) => value - tileCenter[axis]!)
      expect(normal[0]! * outwards[0]! + normal[1]! * outwards[1]! + normal[2]! * outwards[2]!).toBeGreaterThan(0)
    }
    expect(walls).toBe(4 * (size - 1) * 2)
    expect(center).toHaveLength(3)
  })

  it('samples rasters at pixel centres', () => {
    const raster = rasterOf(4, (u, v) => 1000 * u + 10 * v)
    expect(sampleRaster(raster, 0.375, 0.625)).toBeCloseTo(375 + 6.25, 4)
    // Within half a pixel of the edge, the edge pixels' values.
    expect(sampleRaster(raster, 0, 0)).toBeCloseTo(125 + 1.25, 4)
  })

  it('lays a tile on its Web Mercator bounds, at the raster heights', () => {
    const raster = rasterOf(256, () => 1234)
    const surface = buildDemTileSurface(raster, { x: 3, y: 2, z: 3, subview: [0, 0, 1, 1], segments: 8, skirtLengthMeters: 20 })
    const bounds = webMercatorTileBounds(3, 2, 3)
    const grid = vertices(surface).slice(0, 81)
    expect(Math.min(...grid.map(vertex => vertex.longitude))).toBeCloseTo(bounds.west, 7)
    expect(Math.max(...grid.map(vertex => vertex.longitude))).toBeCloseTo(bounds.east, 7)
    expect(Math.min(...grid.map(vertex => vertex.latitude))).toBeCloseTo(bounds.south, 7)
    expect(Math.max(...grid.map(vertex => vertex.latitude))).toBeCloseTo(bounds.north, 7)
    // Float32 positions on a tile 5000 km wide: centimetres.
    for (const vertex of grid) expect(vertex.heightMeters).toBeCloseTo(1234, 0)
    expect(Math.min(...triangleUps(surface, 81))).toBeGreaterThan(0)
  })

  it('draws ground below the floor at the floor and keeps the true heights for shading', () => {
    // West half 2000 m deep, east half 300 m high.
    const raster = rasterOf(256, u => (u < 0.5 ? -2000 : 300))
    const request = { x: 3, y: 2, z: 3, subview: [0, 0, 1, 1] as const, segments: 8, skirtLengthMeters: 20 }
    const relief = buildDemTileSurface(raster, request)
    expect(relief.elevations).toBeUndefined()
    expect(relief.minimumHeightMeters).toBeCloseTo(-2000, 0)

    const flat = buildDemTileSurface(raster, { ...request, floorHeightMeters: 0 })
    const grid = vertices(flat).slice(0, 81)
    expect(Math.min(...grid.map(vertex => vertex.heightMeters))).toBeCloseTo(0, 0)
    expect(Math.max(...grid.map(vertex => vertex.heightMeters))).toBeCloseTo(300, 0)
    expect(flat.minimumHeightMeters).toBe(0)
    // One true height per vertex, skirts included: the seafloor's depth, the land's height.
    expect(flat.elevations).toHaveLength(flat.positions.length / 3)
    expect(Math.min(...flat.elevations!)).toBeCloseTo(-2000, 0)
    expect(flat.elevations![80]).toBeCloseTo(300, 0)
    // Skirts take their top's true height.
    expect(flat.elevations![81]).toBe(flat.elevations![0])
    // The flattened sea faces straight up.
    expect(Math.min(...triangleUps(flat, 81))).toBeGreaterThan(0)
  })

  it('gives a tile deeper than the data the heights of its ancestor at the same places', () => {
    const raster = rasterOf(256, (u, v) => 3000 * Math.sin(7 * u) * Math.cos(5 * v))
    const parent = buildDemTileSurface(raster, { x: 4, y: 6, z: 4, subview: [0, 0, 1, 1], segments: 64, skirtLengthMeters: 0 })
    // The north-east grandchild reads the top-right sixteenth.
    const child = buildDemTileSurface(raster, { x: 4 * 4 + 3, y: 6 * 4, z: 6, subview: [0.75, 0, 1, 0.25], segments: 64, skirtLengthMeters: 0 })
    const parentVertices = vertices(parent)
    const childVertices = vertices(child)
    // Every 4th child vertex lands on a parent vertex.
    for (let row = 0; row <= 64; row += 4) {
      for (let column = 0; column <= 64; column += 4) {
        const childVertex = childVertices[row * 65 + column]!
        const parentVertex = parentVertices[(48 + row / 4) * 65 + 48 + column / 4]!
        expect(childVertex.longitude).toBeCloseTo(parentVertex.longitude, 7)
        expect(childVertex.latitude).toBeCloseTo(parentVertex.latitude, 7)
        expect(childVertex.heightMeters).toBeCloseTo(parentVertex.heightMeters, 1)
      }
    }
  })

  it('closes the globe with caps from the edge of Web Mercator to the poles', () => {
    const raster = rasterOf(256, (u, v) => (v < 0.5 ? 100 + 100 * u : 2000))
    for (const north of [true, false]) {
      const surface = buildPolarCapSurface(raster, { north, rings: 4, segments: 16, skirtLengthMeters: 500 })
      const grid = vertices(surface).slice(0, 5 * 17)
      const latitudes = grid.map(vertex => vertex.latitude)
      const edgeLatitude = north ? WEB_MERCATOR_MAX_LATITUDE_RADIANS : -WEB_MERCATOR_MAX_LATITUDE_RADIANS
      expect(north ? Math.min(...latitudes) : Math.max(...latitudes)).toBeCloseTo(edgeLatitude, 7)
      expect(north ? Math.max(...latitudes) : Math.min(...latitudes)).toBeCloseTo(north ? Math.PI / 2 : -Math.PI / 2, 6)
      const pole = grid.find(vertex => Math.abs(vertex.latitude) > Math.PI / 2 - 1e-6)!
      // The pole is at the mean of the edge row's 16 samples (u from 0 to 15/16).
      expect(pole.heightMeters).toBeCloseTo(north ? 100 + 100 * (7.5 / 16) : 2000, 0)
      expect(Math.min(...triangleUps(surface, 5 * 17).filter(up => Math.abs(up) > 1e-3))).toBeGreaterThan(0)
      // One skirt, along the edge.
      expect(surface.positions.length / 3).toBe(5 * 17 + 17)
    }
  })

  it('lengthens skirts where edge pixels step, so neighbours sampling their own edge pixels leave no crack', () => {
    // A slope of 50 m per pixel eastwards.
    const raster = rasterOf(256, u => 50 * 256 * u)
    const surface = buildDemTileSurface(raster, { x: 0, y: 0, z: 10, subview: [0, 0, 1, 1], segments: 4, skirtLengthMeters: 1 })
    const geodetic = vertices(surface)
    // The south skirt's first vertex hangs under the south-west corner by three half-pixel steps (25 m each).
    expect(geodetic[0]!.heightMeters - geodetic[25]!.heightMeters).toBeCloseTo(75, 0)
  })

  it('matches quantized-mesh geometric errors for tiles as wide', () => {
    // Zoom 1 Web Mercator tiles are as wide as quantized-mesh level 0 (two tiles round the equator).
    const quantizedMeshLevel0 = (6_378_137 * 2 * Math.PI * 0.25) / (65 * 2)
    expect(demTileGeometricError(0, 0, 1, 64)).toBeCloseTo(quantizedMeshLevel0 * Math.cos(0), 3)
    expect(demTileGeometricError(5, 15, 5, 64)).toBeCloseTo(quantizedMeshLevel0 / 16, 3)
    // Away from the equator, tiles are narrower on the ground.
    expect(demTileGeometricError(5, 2, 5, 64)).toBeLessThan(quantizedMeshLevel0 / 16 / 2)
  })
})

describe('RasterDemSource', () => {
  it('checks its URL and reads its encoding', () => {
    expect(() => new RasterDemSource({})).toThrow(/either `url`/)
    expect(() => new RasterDemSource({ url: 'https://example.com/dem.png' })).toThrow(/{z}, {x} and {y}/)
    expect(new RasterDemSource({ url: 'https://example.com/{z}/{x}/{y}.png', encoding: 'terrarium' }).factors).toEqual(demUnpackFactors({ encoding: 'terrarium' }))
    // MapLibre's default encoding.
    expect(new RasterDemSource({ url: 'https://example.com/{z}/{x}/{y}.png' }).factors).toEqual(demUnpackFactors({ encoding: 'mapbox' }))
  })

  it('checks its sea level and adds the water mask plugin', () => {
    const url = 'https://example.com/{z}/{x}/{y}.png'
    expect(() => new RasterDemSource({ url, seaLevelMeters: Number.NaN })).toThrow(/seaLevelMeters/)
    expect(() => new RasterDemSource({ url, seaLevelMeters: null, flattenBelowSeaLevel: true })).toThrow(/needs a sea level/)
    const plugins = new RasterDemSource({ url, flattenBelowSeaLevel: true }).createPlugins()
    expect(plugins.map(plugin => (plugin as { name: string }).name)).toEqual(['RASTER_DEM_TERRAIN_PLUGIN', 'TERRAIN_WATER_MASK_PLUGIN'])
  })
})

/** Terrarium pixels of a constant height. */
function terrariumDecoder(heightMeters: number, size = 256): DemImageDecoder {
  return async () => {
    const value = heightMeters + 32768
    const data = new Uint8Array(size * size * 4)
    for (let index = 0; index < size * size; index++) data.set([Math.floor(value / 256), Math.floor(value) % 256, Math.floor((value % 1) * 256), 255], index * 4)
    return { width: size, height: size, data }
  }
}

function fakeTiles() {
  return {
    errorTarget: 16,
    rootURL: 'https://example.com/dem/{z}/{x}/{y}.png',
    fetchOptions: {},
    ellipsoid: {},
    invokeOnePlugin: vi.fn(),
    preprocessTileset: vi.fn(),
  }
}

type PluginTile = Parameters<RasterDemTerrainPlugin['parseToMesh']>[1]

describe('RasterDemTerrainPlugin', () => {
  async function start(maximumZoom: number) {
    const plugin = new RasterDemTerrainPlugin({
      url: 'https://example.com/dem/{z}/{x}/{-y}.png',
      maximumZoom,
      factors: demUnpackFactors({ encoding: 'terrarium' }),
      createWorker: null,
      decodeImage: terrariumDecoder(500),
    })
    const tiles = fakeTiles()
    plugin.init(tiles as never)
    const tileset = (await plugin.loadRootTileset()) as { root: { children: PluginTile[] } }
    return { plugin, tiles, tileset }
  }

  async function parse(plugin: RasterDemTerrainPlugin, tile: PluginTile) {
    const setRegionData = vi.fn()
    ;(tile as unknown as { engineData: object }).engineData = { boundingVolume: { setRegionData } }
    const url = tile.content!.uri
    const mesh = await plugin.parseToMesh(new ArrayBuffer(8), tile, 'png', url, new AbortController().signal)
    return { mesh, setRegionData }
  }

  it('starts from zoom 0 and two polar caps', async () => {
    const { tiles, tileset } = await start(3)
    expect(tiles.errorTarget).toBe(2)
    expect(tiles.preprocessTileset).toHaveBeenCalledOnce()
    const [level0, northCap, southCap] = tileset.root.children
    expect(level0!.content!.uri).toBe('https://example.com/dem/0/0/0.png')
    expect(level0!.boundingVolume.region!.slice(0, 4)).toEqual([-Math.PI, -WEB_MERCATOR_MAX_LATITUDE_RADIANS, Math.PI, WEB_MERCATOR_MAX_LATITUDE_RADIANS].map(value => expect.closeTo(value, 12)))
    expect(northCap!.boundingVolume.region![3]).toBe(Math.PI / 2)
    expect(southCap!.boundingVolume.region![1]).toBe(-Math.PI / 2)
    expect(northCap!.geometricError).toBe(0)
  })

  it('builds meshes, fits regions to their heights and adds children', async () => {
    const { plugin, tileset } = await start(3)
    const level0 = tileset.root.children[0]!
    const { mesh, setRegionData } = await parse(plugin, level0)
    expect(mesh).toBeTruthy()
    expect(level0.boundingVolume.region![4]).toBeCloseTo(500, 3)
    expect(level0.boundingVolume.region![5]).toBeCloseTo(500, 3)
    expect(setRegionData).toHaveBeenCalledOnce()
    expect(level0.children.map(child => child.content!.uri)).toEqual([
      'https://example.com/dem/1/0/1.png',
      'https://example.com/dem/1/1/1.png',
      'https://example.com/dem/1/0/0.png',
      'https://example.com/dem/1/1/0.png',
    ])
    // Children start from the parent's heights, widened.
    expect(level0.children[0]!.boundingVolume.region![4]).toBeLessThan(500)
    expect(level0.children[0]!.boundingVolume.region![5]).toBeGreaterThan(500)
    // Parsing again (the tile reloaded) keeps the children.
    await parse(plugin, level0)
    expect(level0.children).toHaveLength(4)
    // The caps build too, with no children.
    const cap = tileset.root.children[1]!
    expect(await parse(plugin, cap).then(result => result.mesh)).toBeTruthy()
    expect(cap.children).toHaveLength(0)
  })

  it('draws past the data from kept rasters, down to a cell per pixel', async () => {
    const { plugin, tileset } = await start(0)
    const level0 = tileset.root.children[0]!
    await parse(plugin, level0)
    // 256-pixel rasters on 64-cell grids: two levels past the data.
    const child = level0.children[0]!
    expect(child.content!.uri).toBe('https://example.com/dem/0/0/0.png')
    // Served from the kept raster, with no request.
    expect(plugin.fetchData('https://example.com/dem/0/0/0.png')).toBeInstanceOf(ArrayBuffer)
    expect(plugin.fetchData('https://example.com/dem/1/0/0.png')).toBeUndefined()
    await parse(plugin, child)
    const grandchild = child.children[0]!
    expect(grandchild.content!.uri).toBe('https://example.com/dem/0/0/0.png')
    await parse(plugin, grandchild)
    expect(grandchild.children).toHaveLength(0)
  })

  it('lets the nearest ancestor the server has stand in for a missing tile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const requested: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      requested.push(url)
      return /\/0\/0\/0\.png$/.test(url) ? new Response(new Uint8Array(8)) : new Response(null, { status: 404 })
    })
    try {
      const { plugin, tileset } = await start(3)
      const level0 = tileset.root.children[0]!
      await parse(plugin, level0)
      const child = level0.children[0]!
      const served = await plugin.fetchData(child.content!.uri)
      expect(served).toBeInstanceOf(ArrayBuffer)
      expect(requested).toEqual(['https://example.com/dem/1/0/1.png', 'https://example.com/dem/0/0/0.png'])
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no elevation tiles at zoom 1 .* set maximumZoom to 0/))
      // The child reads the zoom 0 raster, and so do its children, with no further request.
      await parse(plugin, child)
      expect(child.children[0]!.content!.uri).toBe('https://example.com/dem/0/0/0.png')
      expect(plugin.fetchData('https://example.com/dem/0/0/0.png')).toBeInstanceOf(ArrayBuffer)
      // Asked again (the tile reloaded), the missing tile goes straight to its stand-in.
      requested.length = 0
      await plugin.fetchData(child.content!.uri)
      expect(requested).toEqual([])
    } finally {
      fetchMock.mockRestore()
      warn.mockRestore()
    }
  })

  it('reads the template, zoom range and attribution from a TileJSON', async () => {
    const onTileJson = vi.fn()
    const plugin = new RasterDemTerrainPlugin({ tileJsonUrl: 'https://example.com/tiles.json', factors: demUnpackFactors({}), createWorker: null, onTileJson })
    const tiles = fakeTiles()
    tiles.invokeOnePlugin.mockImplementation(async () => new Response(JSON.stringify({ tiles: ['dem/{z}/{x}/{y}.webp'], maxzoom: 12, attribution: '© DEM' })))
    plugin.init(tiles as never)
    const tileset = (await plugin.loadRootTileset()) as { root: { children: PluginTile[] } }
    expect(tileset.root.children[0]!.content!.uri).toBe('https://example.com/dem/0/0/0.webp')
    expect(onTileJson).toHaveBeenCalledWith(expect.objectContaining({ attribution: '© DEM', levels: 13 }))
  })

  it('names the source when a tile cannot be decoded', async () => {
    const plugin = new RasterDemTerrainPlugin({ url: 'https://example.com/{z}/{x}/{y}.png', factors: demUnpackFactors({}), createWorker: null, decodeImage: async () => Promise.reject(new Error('not an image')) })
    plugin.init(fakeTiles() as never)
    const tileset = (await plugin.loadRootTileset()) as { root: { children: PluginTile[] } }
    await expect(parse(plugin, tileset.root.children[0]!)).rejects.toThrow(/RasterDemSource: the elevation tile .* could not be decoded \(not an image\)/)
  })
})

describe('DemMeshBuilder', () => {
  it('builds the pending tiles on the main thread when the worker fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null as ((event: { message?: string }) => void) | null }
    const builder = new DemMeshBuilder(demUnpackFactors({ encoding: 'terrarium' }), () => worker as unknown as Worker, terrariumDecoder(42, 16))
    const result = builder.build(new ArrayBuffer(8), { kind: 'tile', x: 0, y: 0, z: 1, subview: [0, 0, 1, 1], segments: 2, skirtLengthMeters: 1 })
    worker.onerror!({ message: 'failed to load' })
    expect((await result).surface.maximumHeightMeters).toBeCloseTo(42, 3)
    expect(worker.terminate).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/main thread/))
    // Later tiles skip the worker.
    await builder.build(new ArrayBuffer(8), { kind: 'tile', x: 0, y: 0, z: 1, subview: [0, 0, 1, 1], segments: 2, skirtLengthMeters: 1 })
    expect(worker.postMessage).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
