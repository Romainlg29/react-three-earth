import { describe, expect, it } from 'vitest'

import { bucketKey } from '../src/vector/MapStyleOverlay.js'
import { buildingElevations, extrusionTileKey, fillUnknownGridPoints } from '../src/vector/extrusions/Extrusions.js'
import { clipRingToSquare, ExtrusionBuilder, wallShade, type ExtrusionStyle } from '../src/vector/worker/extrusions.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { TILE_EXTENT, type ExtrusionMesh } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

const STYLE: ExtrusionStyle = { baseMeters: 0, heightMeters: 30, nextZoomBaseMeters: 0, nextZoomHeightMeters: 50, color: [200, 100, 50, 255], verticalGradient: false }

/** A square ring clockwise on the screen (an MVT outer ring), in tile units. */
function square(minimumX: number, minimumY: number, size: number) {
  return [
    { x: minimumX, y: minimumY },
    { x: minimumX + size, y: minimumY },
    { x: minimumX + size, y: minimumY + size },
    { x: minimumX, y: minimumY + size },
    { x: minimumX, y: minimumY },
  ]
}

/** Triangles as vertex triples. */
function triangles(mesh: ExtrusionMesh): Array<[number, number, number]> {
  const result: Array<[number, number, number]> = []
  for (let index = 0; index < mesh.indices.length; index += 3) result.push([mesh.indices[index]!, mesh.indices[index + 1]!, mesh.indices[index + 2]!])
  return result
}

function vertex(mesh: ExtrusionMesh, index: number): [number, number, number] {
  return [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!]
}

/** Face normal of a triangle (right hand: counter-clockwise faces this way), not normalised. */
function faceNormal(mesh: ExtrusionMesh, [a, b, c]: [number, number, number]): [number, number, number] {
  const [ax, ay, az] = vertex(mesh, a)
  const [bx, by, bz] = vertex(mesh, b)
  const [cx, cy, cz] = vertex(mesh, c)
  const [ux, uy, uz] = [bx - ax, by - ay, bz - az]
  const [vx, vy, vz] = [cx - ax, cy - ay, cz - az]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

describe('ExtrusionBuilder', () => {
  it('builds a box: a roof of two triangles facing up and four walls facing out', () => {
    const builder = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    builder.beginLayer('buildings', 3, 1, 0.5)
    expect(builder.addBuilding([[square(1000, 1000, 200)]], STYLE)).toBe(true)
    const mesh = builder.build()!
    // Roof: 4 vertices, 2 triangles; walls: 4 vertices and 2 triangles each.
    expect(mesh.positions.length / 3).toBe(4 + 4 * 4)
    expect(mesh.indices.length / 3).toBe(2 + 4 * 2)
    expect(Array.from(mesh.buildingVertexStarts)).toEqual([0, 20])
    expect(Array.from(mesh.buildingBounds)).toEqual([1000, 1000, 1200, 1200])
    expect(mesh.layers).toEqual([{ layerId: 'buildings', layerIndex: 3, start: 0, count: 30, opacity: 1, nextZoomOpacity: 0.5 }])
    const all = triangles(mesh)
    // Roof triangles face up (+up in the tile centre's east-north-up frame).
    for (const triangle of all.slice(0, 2)) expect(faceNormal(mesh, triangle)[2]).toBeGreaterThan(0)
    // Each wall triangle faces the way its stored normal points: away from the building's middle.
    const middle = [0, 1, 2, 3].map(index => vertex(mesh, index)).reduce<[number, number]>((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0])
    for (const triangle of all.slice(2)) {
      const normal = faceNormal(mesh, triangle)
      const stored: [number, number] = [mesh.normals[triangle[0] * 3]!, mesh.normals[triangle[0] * 3 + 1]!]
      expect(normal[0] * stored[0] + normal[1] * stored[1]).toBeGreaterThan(0)
      const [x, y] = vertex(mesh, triangle[0])
      expect((x - middle[0]!) * stored[0] + (y - middle[1]!) * stored[1]).toBeGreaterThan(0)
      expect(Math.abs(normal[2])).toBeLessThan(1e-3 * Math.hypot(normal[0], normal[1]))
    }
  })

  it('places vertices in metres: the footprint size on the ground, the roof at its height, heights moving to the next zoom', () => {
    // A tile at the equator, zoom 14: 2445.98 m across.
    const builder = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    builder.beginLayer('buildings', 0, 1, 1)
    builder.addBuilding([[square(0, 0, TILE_EXTENT / 4)]], STYLE)
    const mesh = builder.build()!
    const roof = [0, 1, 2, 3].map(index => vertex(mesh, index))
    const tileMeters = (2 * Math.PI * 6_378_137) / 2 ** 14
    expect(roof[1]![0] - roof[0]![0]).toBeCloseTo(tileMeters / 4, 0)
    // The roof stands 30 m up, less the Earth's curvature half a tile from the centre (about 0.3 m).
    for (const [, , up] of roof) expect(up).toBeGreaterThan(29)
    for (const [, , up] of roof) expect(up).toBeLessThan(30)
    // Flat map: Web Mercator metres from the centre, heights times the scale factor (1 at the equator).
    expect(mesh.flatPositions[0]).toBeCloseTo(-tileMeters / 2, 1)
    expect(mesh.flatPositions[2]).toBeCloseTo(30, 3)
    // Roof vertices move by the height's change to the next zoom; wall feet by the base's.
    expect(mesh.heightDeltas[0]).toBe(20)
    const feet = [...Array(mesh.positions.length / 3).keys()].filter(index => index >= 4 && mesh.normals[index * 3 + 2] === 0 && (index - 4) % 4 < 2)
    for (const index of feet) expect(mesh.heightDeltas[index]).toBe(0)
  })

  it('clips buildings to the tile, without walls along the cut', () => {
    const builder = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    builder.beginLayer('buildings', 0, 1, 1)
    // Half outside the tile's west edge.
    builder.addBuilding([[square(-100, 1000, 200)]], STYLE)
    const mesh = builder.build()!
    // Nothing west of the tile's edge (Web Mercator x from the tile centre: half a tile).
    const halfTileMeters = (Math.PI * 6_378_137) / 2 ** 14
    for (let index = 0; index < mesh.flatPositions.length / 3; index++) expect(mesh.flatPositions[index * 3]).toBeGreaterThanOrEqual(-halfTileMeters - 1e-3)
    // Roof (4 points) and three walls: none along the west edge.
    expect(mesh.positions.length / 3).toBe(4 + 3 * 4)
    expect(Array.from(mesh.buildingBounds)).toEqual([0, 1000, 100, 1200])
    // Wholly outside: nothing.
    const outside = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    outside.beginLayer('buildings', 0, 1, 1)
    expect(outside.addBuilding([[square(-500, 1000, 200)]], STYLE)).toBe(false)
    expect(outside.build()).toBeNull()
  })

  it('gives a courtyard walls facing into it and a roof with a hole', () => {
    const builder = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    builder.beginLayer('buildings', 0, 1, 1)
    const hole = square(1050, 1050, 100).reverse()
    builder.addBuilding([[square(1000, 1000, 200), hole]], STYLE)
    const mesh = builder.build()!
    // Roof: 8 points, 8 triangles around the hole; 8 walls.
    expect(mesh.indices.length / 3).toBe(8 + 8 * 2)
    // Walls face away from the solid: the outer ones away from the middle, the hole's towards it.
    const middle = [0, 1, 2, 3].map(index => vertex(mesh, index)).reduce<[number, number]>((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0])
    const facing = []
    for (let index = 8; index < mesh.positions.length / 3; index += 4) {
      const [x, y] = vertex(mesh, index)
      const [x2, y2] = vertex(mesh, index + 1)
      const along = (mesh.normals[index * 3]! * ((x + x2) / 2 - middle[0]!) + mesh.normals[index * 3 + 1]! * ((y + y2) / 2 - middle[1]!))
      facing.push(Math.sign(along))
    }
    expect(facing).toEqual([1, 1, 1, 1, -1, -1, -1, -1])
  })

  it('darkens wall feet with the vertical gradient on tall buildings only (MapLibre)', () => {
    expect(wallShade(0, 0, 200)).toBeCloseTo(0.84)
    expect(wallShade(1, 0, 200)).toBe(1)
    expect(wallShade(1, 0, 10)).toBeCloseTo(0.84)
    const builder = new ExtrusionBuilder({ x: 8192, y: 8192, z: 14 })
    builder.beginLayer('buildings', 0, 1, 1)
    builder.addBuilding([[square(1000, 1000, 200)]], { ...STYLE, heightMeters: 200, verticalGradient: true })
    const mesh = builder.build()!
    // A wall's foot (vertex 4) and top (vertex 6).
    expect(mesh.colors[4 * 4]).toBe(Math.round(200 * 0.84))
    expect(mesh.colors[6 * 4]).toBe(200)
    // Roofs keep their colour.
    expect(mesh.colors[0]).toBe(200)
  })
})

describe('clipRingToSquare', () => {
  it('keeps rings inside, cuts rings across a side and drops rings outside', () => {
    const inside = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }]
    expect(clipRingToSquare(inside, 0, 100)).toEqual(inside)
    const across = clipRingToSquare([{ x: -10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: -10, y: 20 }], 0, 100)
    expect(across.every(point => point.x >= 0)).toBe(true)
    expect(across).toHaveLength(4)
    expect(clipRingToSquare([{ x: -30, y: 10 }, { x: -20, y: 10 }, { x: -20, y: 20 }], 0, 100)).toEqual([])
  })
})

describe('building elevations', () => {
  it('stands each building on the lowest ground under its footprint', () => {
    // 2 × 2 cells: heights rise to the east (0, 10, 20 m), equal from north to south.
    const grid = new Float64Array([0, 10, 20, 0, 10, 20, 0, 10, 20])
    const bounds = new Float32Array([TILE_EXTENT * 0.5, 0, TILE_EXTENT * 0.75, 100, TILE_EXTENT * 0.9, 0, TILE_EXTENT, TILE_EXTENT])
    expect(Array.from(buildingElevations(grid, 2, bounds))).toEqual([10, 18])
  })

  it('takes the nearest known ground where the terrain is not read yet, and nothing when none is', () => {
    const grid = new Float64Array([Number.NaN, 5, Number.NaN, Number.NaN])
    expect(Array.from(fillUnknownGridPoints(grid, 1)!)).toEqual([5, 5, 5, 5])
    // The grid itself keeps its unknown points, read again later.
    expect(Number.isNaN(grid[0])).toBe(true)
    expect(fillUnknownGridPoints(new Float64Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]), 1)).toBeNull()
  })
})

describe('extrusion tiles', () => {
  function buildingTile() {
    return encodeVectorTile([
      {
        name: 'buildings',
        features: [
          { type: 'Polygon', id: 1, geometry: [square(1000, 1000, 200).map(({ x, y }) => [x, y] as [number, number])], properties: { height: 30, kind: 'house' } },
          { type: 'Polygon', id: 2, geometry: [square(2000, 2000, 300).map(({ x, y }) => [x, y] as [number, number])], properties: { height: 90, kind: 'tower' } },
        ],
      },
    ])
  }

  function buildingStyle() {
    return {
      version: 8,
      sources: { base: { type: 'vector', tiles: ['https://maps.test/tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
      layers: [
        {
          id: 'buildings',
          type: 'fill-extrusion',
          source: 'base',
          'source-layer': 'buildings',
          minzoom: 13,
          paint: {
            'fill-extrusion-color': ['match', ['get', 'kind'], 'tower', '#ff0000', '#00ff00'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'height']],
            'fill-extrusion-opacity': 0.8,
          },
        },
      ],
    }
  }

  it('builds walls and roofs with heights at the tile zoom and one deeper, and leaves them out of draped tiles', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/14/1/2.pbf': buildingTile() })
    const processor = await MapStyleProcessor.create({ style: buildingStyle(), baseUrl: 'https://maps.test/style.json', requestHeaders: {}, localFontFamily: 'x', extrusions: true }, { fetch })
    expect(processor.summary.extrusionLayers).toEqual([{ id: 'buildings', source: 'base', minimumZoom: 13, maximumZoom: 25 }])
    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 14, zoom: 14, extrusions: true })
    const mesh = bucket.extrusions!
    expect(mesh.buildingVertexStarts).toHaveLength(3)
    // At zoom 14 the height is 0, at 15 the full height: roofs on the ground, moving up by the camera's zoom.
    expect(Math.max(...Array.from(mesh.heightDeltas))).toBe(90)
    expect(mesh.layers[0]).toMatchObject({ layerId: 'buildings', opacity: 0.8, nextZoomOpacity: 0.8 })
    // Data-driven colour: one green house, one red tower.
    let reds = 0
    for (let index = 0; index < mesh.colors.length; index += 4) if (mesh.colors[index]! > mesh.colors[index + 1]!) reds++
    expect(reds).toBe(mesh.buildingVertexStarts[2]! - mesh.buildingVertexStarts[1]!)
    expect(bucket.byteLength).toBeGreaterThan(0)
    // The draped tile has no shapes for them.
    const draped = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 14, zoom: 14 })
    expect(draped.shapes).toBeNull()
    // Drawn flat without 3D extrusions.
    const flat = await MapStyleProcessor.create({ style: buildingStyle(), baseUrl: 'https://maps.test/style.json', requestHeaders: {}, localFontFamily: 'x' }, { fetch })
    expect((await flat.processTile({ sourceId: 'base', x: 1, y: 2, z: 14, zoom: 14 })).shapes).not.toBeNull()
  })

  it('skips layers below their minimum zoom and keys tiles apart from draped and label tiles', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/12/1/2.pbf': buildingTile() })
    const processor = await MapStyleProcessor.create({ style: buildingStyle(), baseUrl: 'https://maps.test/style.json', requestHeaders: {}, localFontFamily: 'x', extrusions: true }, { fetch })
    expect((await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 12, zoom: 12, extrusions: true })).extrusions ?? null).toBeNull()
    const request = { sourceId: 'base', x: 1, y: 2, z: 14, zoom: 15 }
    expect(bucketKey({ ...request, extrusions: true })).toBe(extrusionTileKey(request))
    expect(new Set([bucketKey(request), bucketKey({ ...request, symbols: true }), bucketKey({ ...request, extrusions: true })]).size).toBe(3)
  })
})
