import type { Material } from 'three'
import { materialColor, materialEmissive, materialMetalness, materialNormal, materialRoughness, vec4 } from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'

import type { TerrainShadingDefinition, TerrainShadingInputs } from '../plugins/terrainShadings.js'

/**
 * A terrain tile material's slots are built in layers: the material's own nodes (its factory, `createMaterial`), the
 * library's (the flat map's normal), the imagery blend over the colour, then the plugins' terrain shadings. This module
 * owns the slots' node properties on terrain materials and rebuilds them when a layer changes, as
 * `wrapFadeNodeMaterial` owns `outputNode`.
 */

export type TerrainMaterialSlot = keyof TerrainShadingInputs

const SLOTS = ['color', 'roughness', 'metalness', 'normal', 'emissive'] as const satisfies readonly TerrainMaterialSlot[]

const SLOT_PROPERTIES = {
  color: 'colorNode',
  roughness: 'roughnessNode',
  metalness: 'metalnessNode',
  normal: 'normalNode',
  emissive: 'emissiveNode',
} as const satisfies Record<TerrainMaterialSlot, string>

type SlotNodes = Record<TerrainMaterialSlot, Node | null>

let nextSetId = 0

/** The shadings one terrain applies, shared by its tile materials. */
export class TerrainShadingSet {
  /** Tells the shaders of two terrains apart in the program cache. */
  readonly id = nextSetId++
  protected definitionsValue: readonly TerrainShadingDefinition[] = []
  protected versionValue = 0
  /** Built slots by key: tiles with the same layers share nodes, and so shaders. */
  readonly composed = new Map<string, SlotNodes>()

  get definitions(): readonly TerrainShadingDefinition[] {
    return this.definitionsValue
  }

  get version(): number {
    return this.versionValue
  }

  /** Replaces the shadings, in the order they run. Recompose the materials after (`recomposeTerrainMaterial`). */
  setDefinitions(definitions: readonly TerrainShadingDefinition[]): void {
    this.definitionsValue = [...definitions]
    this.versionValue++
    this.composed.clear()
  }
}

interface TerrainMaterialState {
  bases: SlotNodes
  /** The imagery blend over a base colour, or null before the overlays first set it. */
  overlay: ((baseColor: Node | null) => Node) | null
  overlayKey: string
  shadings: TerrainShadingSet | null
  /** The program cache key of the slots as built. */
  key: string
}

const STATE = Symbol('TERRAIN_MATERIAL_STATE')
type TerrainMaterial = NodeMaterial & { [STATE]?: TerrainMaterialState }

/**
 * The layers behind each colour node this module built. A material cloned from a terrain material (imagery tile
 * splitting) copies the built nodes but not the state: it finds its layers here, so its bases are the factory's,
 * not the built nodes (which would blend the imagery, or run the shadings, twice). Its shadings come from its terrain's
 * plugins (`attachTerrainShadings`): an imagery blend without shadings is shared by every terrain.
 */
const origins = new WeakMap<Node, SlotNodes>()
/** Built slots of materials outside any set (no terrain shadings), by key. */
const composedWithoutSet = new Map<string, SlotNodes>()

function isNodeMaterial(material: Material): material is NodeMaterial {
  return (material as { isNodeMaterial?: boolean }).isNodeMaterial === true
}

function slotNode(material: NodeMaterial, slot: TerrainMaterialSlot): Node | null {
  return ((material as unknown as Record<string, Node | null | undefined>)[SLOT_PROPERTIES[slot]] ?? null) as Node | null
}

function ensureState(material: TerrainMaterial): TerrainMaterialState {
  const existing = material[STATE]
  if (existing !== undefined) return existing

  const color = slotNode(material, 'color')
  const origin = color === null ? undefined : origins.get(color)
  const bases = origin === undefined ? (Object.fromEntries(SLOTS.map(slot => [slot, slotNode(material, slot)])) as SlotNodes) : { ...origin }
  const state: TerrainMaterialState = { bases, overlay: null, overlayKey: 'none', shadings: null, key: '' }
  material[STATE] = state

  const baseProgramCacheKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${baseProgramCacheKey()}:terrain:${state.key}`
  return state
}

/**
 * Gives a terrain material the shadings of its terrain. `TileMaterialReplacementPlugin` calls it on each new material,
 * `ImageOverlayPlugin` on each material it wraps (clones included).
 */
export function attachTerrainShadings(material: Material, shadings: TerrainShadingSet | null): void {
  if (!isNodeMaterial(material)) return
  const state = ensureState(material)
  if (state.shadings === shadings && state.key !== '') return
  state.shadings = shadings
  compose(material, state)
}

/** The node a layer below the shadings set in a slot (the factory's, or the library's), or null. */
export function getTerrainMaterialBase(material: Material, slot: TerrainMaterialSlot): Node | null {
  return isNodeMaterial(material) ? ensureState(material).bases[slot] : null
}

/** Sets the node under the imagery and shadings in a slot: the flat map's normal. */
export function setTerrainMaterialBase(material: Material, slot: TerrainMaterialSlot, node: Node | null): void {
  if (!isNodeMaterial(material)) return
  const state = ensureState(material)
  if (state.bases[slot] === node) return
  state.bases[slot] = node
  compose(material, state)
}

/**
 * Sets the imagery blend over the base colour. `key` names the blend in the program cache (its layer count):
 * `blend` must give the same node for the same key and base.
 */
export function setTerrainMaterialOverlay(material: Material, key: string, blend: (baseColor: Node | null) => Node): void {
  if (!isNodeMaterial(material)) return
  const state = ensureState(material)
  if (state.overlay !== null && state.overlayKey === key) return
  state.overlay = blend
  state.overlayKey = key
  compose(material, state)
}

/** Rebuilds a terrain material's slots after its terrain's shadings changed. Does nothing to other materials. */
export function recomposeTerrainMaterial(material: Material): void {
  const state = (material as TerrainMaterial)[STATE]
  if (state !== undefined && isNodeMaterial(material)) compose(material, state)
}

function compose(material: TerrainMaterial, state: TerrainMaterialState): void {
  const { bases, shadings } = state
  const basesKey = SLOTS.map(slot => bases[slot]?.id ?? '-').join(',')
  const cacheKey = `${basesKey}:${state.overlayKey}`
  const cache = shadings?.composed ?? composedWithoutSet
  let nodes = cache.get(cacheKey)
  if (nodes === undefined) {
    nodes = buildSlots(state)
    cache.set(cacheKey, nodes)
    if (nodes.color !== null && nodes.color !== bases.color) origins.set(nodes.color, { ...bases })
  }

  state.key = `${cacheKey}:shadings${shadings === null ? '-' : `${shadings.id}.${shadings.version}`}`
  let changed = false
  const properties = material as unknown as Record<string, Node | null>
  for (const slot of SLOTS) {
    const property = SLOT_PROPERTIES[slot]
    if ((properties[property] ?? null) === nodes[slot]) continue
    properties[property] = nodes[slot]
    changed = true
  }
  if (changed) material.needsUpdate = true
}

function buildSlots({ bases, overlay, shadings }: TerrainMaterialState): SlotNodes {
  const color = overlay === null ? bases.color : overlay(bases.color)
  const definitions = shadings?.definitions ?? []
  if (definitions.length === 0) return { ...bases, color }

  let inputs: TerrainShadingInputs = {
    color: vec4((color ?? materialColor) as Node<'vec4'>) as unknown as Node<'vec4'>,
    roughness: (bases.roughness ?? materialRoughness) as Node<'float'>,
    metalness: (bases.metalness ?? materialMetalness) as Node<'float'>,
    normal: (bases.normal ?? materialNormal) as Node<'vec3'>,
    emissive: (bases.emissive ?? materialEmissive) as Node<'vec3'>,
  }
  for (const definition of definitions) {
    let outputs: Partial<TerrainShadingInputs>
    try {
      outputs = definition.shade(inputs)
    } catch (error) {
      console.error(`Terrain shading "${definition.name}": shade threw, the terrain is drawn without it. Fix its shade function.`, error)
      continue
    }
    const next = { ...inputs }
    for (const slot of SLOTS) {
      const node = outputs?.[slot]
      if (node != null) (next as Record<TerrainMaterialSlot, Node>)[slot] = node
    }
    inputs = next
  }
  return inputs
}
