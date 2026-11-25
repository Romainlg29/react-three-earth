import { BufferAttribute, BufferGeometry, DataTexture, Group, Matrix4, Mesh, MeshStandardMaterial, RGFormat, UnsignedByteType, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { QuantizedMeshSource } from '../src/core/sources.js'
import { computeFlatPositions } from '../src/tiles/FlatMapPlugin.js'
import { TERRAIN_ELEVATION_ATTRIBUTE, TERRAIN_SURFACE_ATTRIBUTE } from '../src/tiles/terrainSurface.js'
import { getTerrainWaterMaskState, TerrainWaterMaskPlugin, toMaskTexture } from '../src/tiles/terrainWaterMask.js'

/** The quantized-mesh loader's mask: two channels, 0 water and 255 land, as 3DTilesRenderer builds it. */
function loaderMask(water: (column: number, row: number) => boolean, size = 4): DataTexture {
  const data = new Uint8Array(size * size * 2)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const value = water(column, row) ? 0 : 255
      data[(row * size + column) * 2] = value
      data[(row * size + column) * 2 + 1] = value
    }
  }
  return new DataTexture(data, size, size, RGFormat, UnsignedByteType)
}

function tileScene(roughnessMap: DataTexture | null = null): Group {
  const scene = new Group()
  scene.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ roughnessMap })))
  return scene
}

function meshOf(scene: Group): Mesh {
  return scene.children[0] as Mesh
}

type FakeTile = { parent: FakeTile | null; children: FakeTile[]; content: { uri: string } | null; internal: { virtualChildCount: number } }

function tile(uri: string | null, parent: FakeTile | null = null, virtual = false): FakeTile {
  const result: FakeTile = { parent, children: [], content: uri === null ? null : { uri }, internal: { virtualChildCount: 0 } }
  if (parent !== null) {
    parent.children.push(result)
    if (virtual) parent.internal.virtualChildCount++
  }
  return result
}

describe('terrain water mask', () => {
  it('turns the loader mask into one channel of water, rows from the north as stored', () => {
    // The north-west quarter is water: the first rows of the mask are the tile's north edge.
    const texture = toMaskTexture(loaderMask((column, row) => column < 2 && row < 2) as never)
    const data = texture.image.data as Uint8Array
    expect(texture.image.width).toBe(4)
    expect([...data.slice(0, 4)]).toEqual([255, 255, 0, 0])
    expect([...data.slice(12, 16)]).toEqual([0, 0, 0, 0])
    expect(texture.flipY).toBe(false)
  })

  it('reads a tile mask, and nothing where a tile has none and no sea level is given', () => {
    const plugin = new TerrainWaterMaskPlugin({ tileMasks: true })
    const withMask = tileScene(loaderMask(() => true))
    const root = tile('0/0/0.terrain')
    plugin.processTileModel(withMask, root as never)
    const state = getTerrainWaterMaskState(meshOf(withMask))!
    expect(state.texture).not.toBeNull()
    expect(state.uvScale.toArray()).toEqual([1, 1])

    const without = tileScene()
    plugin.processTileModel(without, tile('0/1/0.terrain') as never)
    expect(getTerrainWaterMaskState(meshOf(without))!.texture).toBeNull()
    expect(getTerrainWaterMaskState(meshOf(without))!.mode).toBe(0)

    // Disposing the tile frees the texture it made.
    let disposed = false
    state.texture!.addEventListener('dispose', () => (disposed = true))
    plugin.disposeTile(root as never)
    expect(disposed).toBe(true)
  })

  it('gives tiles split past the data the quadrant of their parent mask, at any depth', () => {
    const plugin = new TerrainWaterMaskPlugin({ tileMasks: true })
    const root = tile('5/10/10.terrain')
    plugin.processTileModel(tileScene(loaderMask(() => true)), root as never)

    // The north-east quadrant: parent uv = child uv / 2 + (0.5, 0.5).
    const northEast = tile('tile.quantized_tile_split?bottom=false&left=false', root, true)
    const northEastScene = tileScene()
    plugin.processTileModel(northEastScene, northEast as never)
    const first = getTerrainWaterMaskState(meshOf(northEastScene))!
    expect(first.uvScale.toArray()).toEqual([0.5, 0.5])
    expect(first.uvOffset.toArray()).toEqual([0.5, 0.5])

    // Its south-west quadrant: (0.5, 0.5) + child uv / 4.
    const deeper = tile('tile.quantized_tile_split?bottom=true&left=true', northEast, true)
    const deeperScene = tileScene()
    plugin.processTileModel(deeperScene, deeper as never)
    const second = getTerrainWaterMaskState(meshOf(deeperScene))!
    expect(second.uvScale.toArray()).toEqual([0.25, 0.25])
    expect(second.uvOffset.toArray()).toEqual([0.5, 0.5])
    expect(second.texture).toBe(first.texture)

    // Split tiles share the parent's texture: disposing one does not free it.
    let disposed = false
    first.texture!.addEventListener('dispose', () => (disposed = true))
    plugin.disposeTile(deeper as never)
    expect(disposed).toBe(false)
  })

  it('gives tiles the imagery split off the same mask, their uv being the parent tile\'s', () => {
    const plugin = new TerrainWaterMaskPlugin({ tileMasks: true })
    const root = tile('3/1/1.terrain')
    plugin.processTileModel(tileScene(loaderMask(() => true)), root as never)
    const piece = tile(null, root, true)
    const scene = tileScene()
    plugin.processTileModel(scene, piece as never)
    const state = getTerrainWaterMaskState(meshOf(scene))!
    expect(state.texture).not.toBeNull()
    expect(state.uvScale.toArray()).toEqual([1, 1])
    expect(state.uvOffset.toArray()).toEqual([0, 0])
  })

  it('falls back to the elevation at or below the sea level', () => {
    const plugin = new TerrainWaterMaskPlugin({ seaLevelMeters: 0 })
    const scene = tileScene()
    plugin.processTileModel(scene, tile('dem/0/0/0.png') as never)
    const state = getTerrainWaterMaskState(meshOf(scene))!
    expect(state.mode).toBe(2)
    expect(state.seaLevelMeters).toBe(0)
    expect(() => new TerrainWaterMaskPlugin({ seaLevelMeters: Number.POSITIVE_INFINITY })).toThrow(/finite/)
  })

  it('is registered by quantized-mesh sources unless turned off', () => {
    const names = (source: QuantizedMeshSource) => source.createPlugins().map(plugin => (plugin as { name?: string }).name)
    expect(names(new QuantizedMeshSource({ url: 'https://example.com/terrain' }))).toContain('TERRAIN_WATER_MASK_PLUGIN')
    expect(names(new QuantizedMeshSource({ url: 'https://example.com/terrain', waterMask: false }))).not.toContain('TERRAIN_WATER_MASK_PLUGIN')
  })

  it('shades with the true elevation where the drawn ground was lifted', () => {
    // One vertex on the ellipsoid at 0°, 0°, drawn at 0 m but 1500 m deep.
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0]), 3))
    geometry.setAttribute(TERRAIN_ELEVATION_ATTRIBUTE, new BufferAttribute(new Float32Array([-1500]), 1))
    computeFlatPositions(geometry, new Matrix4().makeTranslation(new Vector3(6_378_137, 0, 0)), null)
    expect(geometry.getAttribute(TERRAIN_SURFACE_ATTRIBUTE).getX(0)).toBe(-1500)
  })
})
