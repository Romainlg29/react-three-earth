import { BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { color, float, mix, vec3, vec4 } from 'three/tsl'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { QuantizedMeshSource } from '../src/core/sources.js'
import { Terrain } from '../src/core/Terrain.js'
import { PLUGIN_API_VERSION } from '../src/plugins/plugin.js'
import { TerrainShadingRegistry, type TerrainShadingDefinition, type TerrainShadingInputs } from '../src/plugins/terrainShadings.js'
import { TileMaterialReplacementPlugin } from '../src/tiles/TileMaterialReplacementPlugin.js'
import {
  attachTerrainShadings,
  getTerrainMaterialBase,
  recomposeTerrainMaterial,
  setTerrainMaterialBase,
  TerrainShadingSet,
} from '../src/tiles/terrainMaterialSlots.js'
import { wrapOverlaysNodeMaterial } from '../src/tiles/wrapOverlaysNodeMaterial.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const glossy: TerrainShadingDefinition = { name: 'glossy', shade: () => ({ roughness: float(0.1) as unknown as Node<'float'> }) }

function setOf(...definitions: TerrainShadingDefinition[]): TerrainShadingSet {
  const set = new TerrainShadingSet()
  set.setDefinitions(definitions)
  return set
}

function layerCount(material: MeshStandardNodeMaterial, count: number): void {
  ;(material.defines as Record<string, number>).LAYER_COUNT = count
}

describe('TerrainShadingRegistry', () => {
  it('registers, refuses a taken name with the fix, and removes', () => {
    const registry = new TerrainShadingRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const remove = registry.register(glossy)
    expect(registry.get('glossy')).toBe(glossy)
    expect(() => registry.register({ ...glossy })).toThrow('the terrain shading "glossy" is already registered by another plugin; remove that plugin first')
    remove()
    expect(registry.has('glossy')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('checks definitions', () => {
    const registry = new TerrainShadingRegistry()
    expect(() => registry.register({ name: '', shade: glossy.shade })).toThrow('non-empty `name`')
    expect(() => registry.register({ name: 'x' } as TerrainShadingDefinition)).toThrow('`shade` must be a function')
    expect(() => registry.register({ name: 'x', order: Number.NaN, shade: glossy.shade })).toThrow('`order` must be a finite number')
  })

  it('orders by order, then by registration', () => {
    const registry = new TerrainShadingRegistry()
    registry.register({ name: 'a', order: 1, shade: () => ({}) })
    registry.register({ name: 'b', shade: () => ({}) })
    registry.register({ name: 'c', order: -1, shade: () => ({}) })
    registry.register({ name: 'd', shade: () => ({}) })
    expect(registry.ordered().map(definition => definition.name)).toEqual(['c', 'b', 'd', 'a'])
  })

  it('is undone with the plugin that registered it, and shows in inspect', () => {
    const earth = new Earth()
    earth.addPlugin({ name: 'sea', apiVersion: PLUGIN_API_VERSION, install: context => void context.registerTerrainShading(glossy) })
    expect(earth.terrainShadings.get('glossy')).toBe(glossy)
    expect(earth.inspect().terrainShadings).toEqual(['glossy'])
    earth.removePlugin('sea')
    expect(earth.terrainShadings.size).toBe(0)
  })
})

describe('terrain material slots', () => {
  it('run the shadings in turn over the factory nodes, each reading what the last left', () => {
    const base = color('#88aa66')
    const seen: TerrainShadingInputs[] = []
    const first: TerrainShadingDefinition = {
      name: 'first',
      shade: inputs => {
        seen.push(inputs)
        return { color: vec4(1, 0, 0, 1) as unknown as Node<'vec4'>, roughness: float(0.2) as unknown as Node<'float'> }
      },
    }
    const second: TerrainShadingDefinition = {
      name: 'second',
      shade: inputs => {
        seen.push(inputs)
        return { metalness: float(0.5) as unknown as Node<'float'> }
      },
    }
    const material = new MeshStandardNodeMaterial()
    material.colorNode = base
    attachTerrainShadings(material, setOf(first, second))

    expect(seen).toHaveLength(2)
    // The first reads the factory's colour; the second reads the first's outputs.
    expect(seen[1]!.color).not.toBe(seen[0]!.color)
    expect(seen[1]!.roughness).toBe(material.roughnessNode)
    expect(material.colorNode).toBe(seen[1]!.color)
    expect(material.metalnessNode).not.toBeNull()
    expect(getTerrainMaterialBase(material, 'color')).toBe(base)
  })

  it('leave the material as its factory made it without shadings', () => {
    const base = color('#88aa66')
    const roughness = float(0.4)
    const material = new MeshStandardNodeMaterial()
    material.colorNode = base
    material.roughnessNode = roughness
    attachTerrainShadings(material, setOf())
    expect(material.colorNode).toBe(base)
    expect(material.roughnessNode).toBe(roughness)
    expect(material.normalNode).toBeNull()
  })

  it('shade over the imagery blend: the colour input is the layers over the factory colour', () => {
    let input: Node | null = null
    const set = setOf({ name: 'read', shade: inputs => ((input = inputs.color), {}) })
    const shaded = new MeshStandardNodeMaterial()
    attachTerrainShadings(shaded, set)
    wrapOverlaysNodeMaterial(shaded)
    layerCount(shaded, 1)

    const plain = new MeshStandardNodeMaterial()
    wrapOverlaysNodeMaterial(plain)
    layerCount(plain, 1)
    // `plain` holds the blend itself; the shading read it, wrapped as a vec4.
    expect(input).not.toBeNull()
    expect(shaded.colorNode).not.toBe(plain.colorNode)
    expect(shaded.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey())
  })

  it('share nodes between tiles with the same layers, so they share one shader', () => {
    const set = setOf(glossy)
    const base = color('#336699')
    const materials = [0, 1].map(() => {
      const material = new MeshStandardNodeMaterial()
      material.colorNode = base
      attachTerrainShadings(material, set)
      wrapOverlaysNodeMaterial(material)
      layerCount(material, 2)
      return material
    })
    expect(materials[0]!.colorNode).toBe(materials[1]!.colorNode)
    expect(materials[0]!.roughnessNode).toBe(materials[1]!.roughnessNode)
    expect(materials[0]!.customProgramCacheKey()).toBe(materials[1]!.customProgramCacheKey())
  })

  it('give a clone (imagery tile splitting) the factory bases, so it neither blends nor shades twice', () => {
    const shade = vi.fn(() => ({ roughness: float(0.1) as unknown as Node<'float'> }))
    const set = setOf({ name: 'count', shade })
    const base = color('#88aa66')
    const material = new MeshStandardNodeMaterial()
    material.colorNode = base
    attachTerrainShadings(material, set)
    wrapOverlaysNodeMaterial(material)
    layerCount(material, 1)

    const clone = material.clone()
    attachTerrainShadings(clone, set)
    wrapOverlaysNodeMaterial(clone)
    layerCount(clone, 1)
    expect(getTerrainMaterialBase(clone, 'color')).toBe(base)
    expect(clone.colorNode).toBe(material.colorNode)
    expect(clone.roughnessNode).toBe(material.roughnessNode)
  })

  it('keep the factory colour under the layers on a clone without shadings (a terrain style on split tiles)', () => {
    const base = color('#88aa66')
    const material = new MeshStandardNodeMaterial()
    material.colorNode = base
    wrapOverlaysNodeMaterial(material)
    layerCount(material, 1)
    const clone = material.clone()
    wrapOverlaysNodeMaterial(clone)
    layerCount(clone, 1)
    expect(getTerrainMaterialBase(clone, 'color')).toBe(base)
    expect(clone.colorNode).toBe(material.colorNode)
  })

  it('match a clone to its own bases when materials with different slots share one imagery blend', () => {
    const base = color('#88aa66')
    const [withNormal, without] = [vec3(0, 1, 0), null].map(normal => {
      const material = new MeshStandardNodeMaterial()
      material.colorNode = base
      wrapOverlaysNodeMaterial(material)
      setTerrainMaterialBase(material, 'normal', normal)
      layerCount(material, 1)
      return material
    })
    expect(withNormal!.colorNode).toBe(without!.colorNode)
    for (const material of [withNormal!, without!]) {
      const clone = material.clone()
      wrapOverlaysNodeMaterial(clone)
      layerCount(clone, 1)
      expect(getTerrainMaterialBase(clone, 'normal')).toBe(getTerrainMaterialBase(material, 'normal'))
      expect(getTerrainMaterialBase(clone, 'color')).toBe(base)
    }
  })

  it('give the shadings the flat map normal as their input normal', () => {
    let normal: Node | null = null
    const set = setOf({ name: 'read', shade: inputs => ((normal = inputs.normal), { normal: vec3(0, 0, 1) as unknown as Node<'vec3'> }) })
    const material = new MeshStandardNodeMaterial()
    attachTerrainShadings(material, set)
    const morphed = vec3(0, 1, 0)
    setTerrainMaterialBase(material, 'normal', morphed)
    expect(normal).toBe(morphed)
    expect(material.normalNode).not.toBe(morphed)
  })

  it('rebuild after the shadings change, with a new program key', () => {
    const set = setOf()
    const material = new MeshStandardNodeMaterial()
    attachTerrainShadings(material, set)
    const before = material.customProgramCacheKey()
    const version = material.version
    set.setDefinitions([glossy])
    recomposeTerrainMaterial(material)
    expect(material.roughnessNode).not.toBeNull()
    expect(material.customProgramCacheKey()).not.toBe(before)
    expect(material.version).toBeGreaterThan(version)
  })

  it('skip a shading that throws, stating the fix', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const set = setOf(
      {
        name: 'broken',
        shade: () => {
          throw new Error('nope')
        },
      },
      glossy,
    )
    const material = new MeshStandardNodeMaterial()
    attachTerrainShadings(material, set)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Terrain shading "broken": shade threw'), expect.any(Error))
    expect(material.roughnessNode).not.toBeNull()
  })

  it('leave classic materials alone', () => {
    const material = new MeshStandardMaterial()
    attachTerrainShadings(material, setOf(glossy))
    expect(getTerrainMaterialBase(material, 'color')).toBeNull()
  })
})

describe('Terrain with shadings', () => {
  it('applies the shadings to new tile materials and to loaded ones when the earth registry changes', () => {
    const earth = new Earth()
    const terrain = new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://example.com/terrain' })] })
    earth.setTerrain(terrain)

    // A tile loaded before the shading: TileMaterialReplacementPlugin gives it the terrain's set.
    const replacement = (terrain.tiles as unknown as { plugins: object[] }).plugins.find(plugin => plugin instanceof TileMaterialReplacementPlugin) as TileMaterialReplacementPlugin
    const scene = new Group()
    const mesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial())
    scene.add(mesh)
    replacement.processTileModel(scene, {} as never)
    vi.spyOn(terrain.tiles, 'forEachLoadedModel').mockImplementation(callback => callback(scene, {} as never))
    const material = mesh.material as unknown as MeshStandardNodeMaterial
    expect(material.roughnessNode).toBeNull()

    const remove = earth.terrainShadings.register({ name: 'wet', shade: ({ roughness }) => ({ roughness: mix(roughness, float(0.2), 0.5) as unknown as Node<'float'> }) })
    expect(material.roughnessNode).not.toBeNull()
    remove()
    expect(material.roughnessNode).toBeNull()

    // A tile its plugins were still processing when the shadings changed catches up when it loads.
    const late = new Group()
    const lateMesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial())
    late.add(lateMesh)
    replacement.processTileModel(late, {} as never)
    earth.terrainShadings.register({ name: 'late', shade: () => ({ metalness: float(0.3) as unknown as Node<'float'> }) })
    const lateMaterial = lateMesh.material as unknown as MeshStandardNodeMaterial
    expect(lateMaterial.metalnessNode).toBeNull()
    ;(terrain.tiles as unknown as { dispatchEvent(event: object): void }).dispatchEvent({ type: 'load-model', scene: late, tile: {} })
    expect(lateMaterial.metalnessNode).not.toBeNull()
    // A terrain taken off the earth stops following its registry.
    earth.setTerrain(null)
    earth.terrainShadings.register(glossy)
    expect(material.roughnessNode).toBeNull()
  })
})
