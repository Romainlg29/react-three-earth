import { BufferAttribute, BufferGeometry, Mesh } from 'three'
import { vec4 } from 'three/tsl'
import type { MeshBasicNodeMaterial } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { PLUGIN_API_VERSION } from '../src/plugins/plugin.js'
import { getLayerSymbolEffect, SYMBOL_EFFECT_METADATA_KEY, SymbolEffectRegistry, type SymbolEffectDefinition } from '../src/plugins/symbolEffects.js'
import { ScreenSymbols, splitSymbolDrawRuns, type ScreenSymbolsHost } from '../src/vector/symbols/ScreenSymbols.js'
import { GlyphAtlasTexture, ImageAtlasTexture } from '../src/vector/VectorTileMeshes.js'
import type { SymbolMesh } from '../src/vector/worker/types.js'

const neon: SymbolEffectDefinition = { name: 'neon', shade: ({ fillColor, distance }) => vec4(fillColor.rgb, distance) }
const outline: SymbolEffectDefinition = { name: 'outline', shade: ({ standardColor }) => standardColor }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SymbolEffectRegistry', () => {
  it('registers, refuses a taken name with the fix, and removes', () => {
    const registry = new SymbolEffectRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const remove = registry.register(neon)
    expect(registry.get('neon')).toBe(neon)
    expect(() => registry.register({ ...neon })).toThrow('the symbol effect "neon" is already registered by another plugin; remove that plugin first')
    remove()
    expect(registry.has('neon')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('checks definitions', () => {
    const registry = new SymbolEffectRegistry()
    expect(() => registry.register({ name: '', shade: neon.shade })).toThrow('non-empty `name`')
    expect(() => registry.register({ name: 'x' } as SymbolEffectDefinition)).toThrow('`shade` must be a function')
  })

  it('is undone with the plugin that registered it', () => {
    const earth = new Earth()
    earth.addPlugin({ name: 'effects', apiVersion: PLUGIN_API_VERSION, install: context => void context.registerSymbolEffect(neon) })
    expect(earth.symbolEffects.get('neon')).toBe(neon)
    earth.removePlugin('effects')
    expect(earth.symbolEffects.size).toBe(0)
  })
})

describe('getLayerSymbolEffect', () => {
  it('reads the effect name from the layer metadata', () => {
    expect(getLayerSymbolEffect({ id: 'a', metadata: { [SYMBOL_EFFECT_METADATA_KEY]: 'neon' } })).toBe('neon')
    expect(getLayerSymbolEffect({ id: 'a', metadata: { other: 1 } })).toBeNull()
    expect(getLayerSymbolEffect({ id: 'a', metadata: { [SYMBOL_EFFECT_METADATA_KEY]: 3 } })).toBeNull()
    expect(getLayerSymbolEffect({ id: 'a' })).toBeNull()
    expect(getLayerSymbolEffect(undefined)).toBeNull()
  })
})

describe('splitSymbolDrawRuns', () => {
  it('splits triangles into consecutive runs per material, keeping draw order', () => {
    // Four labels, one quad (two triangles) each: labels 0 and 1 standard, 2 with an effect, 3 standard again.
    const labelIndices = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3])
    const indices = new Uint16Array(24)
    for (let quad = 0; quad < 4; quad++) indices.set([0, 1, 2, 0, 2, 3].map(corner => quad * 4 + corner), quad * 6)
    const runs = splitSymbolDrawRuns(indices, labelIndices, label => (label === 2 ? 1 : 0))
    expect(runs).toEqual([
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 6, materialIndex: 1 },
      { start: 18, count: 6, materialIndex: 0 },
    ])
  })
})

describe('symbol effects on labels facing the viewer', () => {
  function createSymbols(layerIds: string[]): SymbolMesh {
    const labelIndices = new Float32Array(layerIds.length * 4)
    const indices = new Uint16Array(layerIds.length * 6)
    layerIds.forEach((_, label) => {
      labelIndices.fill(label, label * 4, label * 4 + 4)
      indices.set([0, 1, 2, 0, 2, 3].map(corner => label * 4 + corner), label * 6)
    })
    return { keys: layerIds.map(id => `${id}\u0000text`), labelIndices, indices } as unknown as SymbolMesh
  }

  function createScreenSymbols(metadata: Record<string, string>) {
    const host: ScreenSymbolsHost = {
      summary: null,
      glyphAtlas: new GlyphAtlasTexture(),
      imageAtlas: new ImageAtlasTexture(),
      maximumZoom: 14,
      opacity: 1,
      acquireSymbolTile: () => {
        throw new Error('not in this test')
      },
      mapStyle: { getLayer: id => (id in metadata ? { id, metadata: { [SYMBOL_EFFECT_METADATA_KEY]: metadata[id] } } : { id }) },
    }
    const symbols = new ScreenSymbols(host)
    const apply = (mesh: Mesh, meshSymbols: SymbolMesh) => (symbols as unknown as { applySymbolEffects(mesh: Mesh, symbols: SymbolMesh): void }).applySymbolEffects(mesh, meshSymbols)
    return { symbols, apply }
  }

  function createMesh() {
    const mesh = new Mesh(new BufferGeometry())
    mesh.geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
    return mesh
  }

  it('draws in one call with no effect, and in style-ordered groups with effects', () => {
    const registry = new SymbolEffectRegistry()
    registry.register(neon)
    const { symbols, apply } = createScreenSymbols({ roads: 'neon' })
    symbols.setSymbolEffects(registry)
    const mesh = createMesh()

    apply(mesh, createSymbols(['places', 'places']))
    expect(Array.isArray(mesh.material)).toBe(false)
    expect(mesh.geometry.groups).toEqual([])

    apply(mesh, createSymbols(['places', 'roads', 'roads', 'places']))
    const materials = mesh.material as MeshBasicNodeMaterial[]
    expect(materials.map(material => material.name)).toEqual(['MapStyleSymbols', 'MapStyleSymbols:neon'])
    expect(mesh.geometry.groups).toEqual([
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 12, materialIndex: 1 },
      { start: 18, count: 6, materialIndex: 0 },
    ])
    symbols.dispose()
  })

  it('shares one material per effect, and rebuilds it when the effect is registered again', () => {
    const registry = new SymbolEffectRegistry()
    const remove = registry.register(neon)
    registry.register(outline)
    const { symbols, apply } = createScreenSymbols({ roads: 'neon', water: 'outline', rivers: 'neon' })
    symbols.setSymbolEffects(registry)
    const first = createMesh()
    const second = createMesh()
    apply(first, createSymbols(['roads', 'water']))
    apply(second, createSymbols(['rivers']))
    const neonMaterial = (first.material as MeshBasicNodeMaterial[])[1]!
    expect((second.material as MeshBasicNodeMaterial[])[1]).toBe(neonMaterial)
    expect((first.material as MeshBasicNodeMaterial[])[2]!.name).toBe('MapStyleSymbols:outline')

    const dispose = vi.spyOn(neonMaterial, 'dispose')
    remove()
    expect(dispose).toHaveBeenCalledOnce()
    registry.register({ ...neon })
    apply(second, createSymbols(['rivers']))
    expect((second.material as MeshBasicNodeMaterial[])[1]).not.toBe(neonMaterial)
    symbols.dispose()
  })

  it('warns once, naming the layer and the effect, when no plugin provides it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { symbols, apply } = createScreenSymbols({ roads: 'neon' })
    symbols.setSymbolEffects(new SymbolEffectRegistry())
    const mesh = createMesh()
    apply(mesh, createSymbols(['roads', 'roads']))
    apply(mesh, createSymbols(['roads']))
    expect(Array.isArray(mesh.material)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('style layer "roads" asks for the symbol effect "neon", which no installed plugin provides')
    symbols.dispose()
  })
})
