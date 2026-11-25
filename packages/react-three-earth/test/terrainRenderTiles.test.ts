import { Color, Mesh, OrthographicCamera, RenderTarget, Scene } from 'three'
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { QuantizedMeshSource } from '../src/core/sources.js'
import { Terrain, TERRAIN_LAYER } from '../src/core/Terrain.js'

describe('Terrain.renderTiles', () => {
  it('draws the tiles alone with the material given, then puts the scene and renderer back', () => {
    const terrain = new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://t.test/' })] })
    const camera = new OrthographicCamera()
    const target = new RenderTarget(4, 4)
    const material = new MeshBasicNodeMaterial()
    const renderer = {
      getRenderTarget: vi.fn(() => null),
      getMRT: vi.fn(() => 'mrt'),
      setMRT: vi.fn(),
      autoClear: true,
      getClearAlpha: () => 0.5,
      getClearColor: (color: Color) => color.set(0x123456),
      setRenderTarget: vi.fn(),
      setClearColor: vi.fn(),
      clear: vi.fn(),
      render: vi.fn((scene: Scene, seen: OrthographicCamera) => {
        expect(scene.overrideMaterial).toBe(material)
        expect(scene.background).toBeNull()
        expect(seen.layers.mask).toBe(1 << TERRAIN_LAYER)
      }),
    }
    // Not in a scene yet: nothing drawn.
    expect(terrain.renderTiles(renderer as unknown as WebGPURenderer, camera, target, material, new Color(1, 0, 0), 0)).toBe(false)
    const scene = new Scene()
    scene.background = new Color('white')
    scene.add(terrain.object)
    expect(terrain.renderTiles(renderer as unknown as WebGPURenderer, camera, target, material, new Color(1, 0, 0), 0)).toBe(true)
    expect(renderer.render).toHaveBeenCalledTimes(1)
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, target)
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null)
    expect(renderer.setMRT).toHaveBeenLastCalledWith('mrt')
    expect(renderer.autoClear).toBe(true)
    expect(renderer.setClearColor.mock.lastCall![1]).toBe(0.5)
    expect(scene.overrideMaterial).toBeNull()
    expect(scene.background).toEqual(new Color('white'))
    expect(camera.layers.mask).toBe(1)
  })

  it('puts every tile mesh on the terrain layer as it loads', () => {
    const terrain = new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://t.test/' })] })
    const tile = new Mesh()
    ;(terrain.tiles as unknown as { dispatchEvent(event: object): void }).dispatchEvent({ type: 'load-model', scene: tile, tile: {} })
    expect(tile.layers.isEnabled(TERRAIN_LAYER)).toBe(true)
    expect(tile.layers.isEnabled(0)).toBe(true)
  })
})
