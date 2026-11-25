import type { Node } from 'three/webgpu'

/**
 * What a terrain shading reads, per fragment of a terrain tile: the material's slots as the shadings before it left
 * them. Colours are linear RGB.
 */
export interface TerrainShadingInputs {
  /**
   * The ground's colour with alpha: the terrain material's own colour (`createMaterial`, a terrain style), with the
   * imagery layers and draped layers blended over it.
   */
  color: Node<'vec4'>
  /** Roughness, 0 (mirror) to 1 (matte). */
  roughness: Node<'float'>
  /** Metalness, 0 to 1. */
  metalness: Node<'float'>
  /** The normal in view space, as `NodeMaterial.normalNode`: the globe and flat map morph included. */
  normal: Node<'vec3'>
  /** Light the surface gives off. */
  emissive: Node<'vec3'>
}

/** What a terrain shading changes: the slots it leaves out keep their input. */
export type TerrainShadingOutputs = Partial<TerrainShadingInputs>

/**
 * A plugin's change to how the terrain is shaded, above the imagery: a sea's gloss and colour, wet ground, snow. Every
 * terrain tile's material runs the registered shadings in turn, each reading what the last one left. The terrain's
 * own material (`createMaterial`, `TerrainStyle`) is the start, so the two compose. Read per-fragment terrain values
 * with `terrainElevationMeters`, `terrainWaterMask` and the other terrain nodes.
 *
 * `shade` runs once per shader, not per frame. Animate through your own `uniform`, updated in `context.onUpdate`.
 * Registering or removing a shading rebuilds the terrain's shaders, without reloading its tiles.
 */
export interface TerrainShadingDefinition {
  /** Unique on an earth, npm-style: `'@earthkit/water'`. */
  name: string
  /** Where it runs among the shadings: lower first. Shadings of the same order run in the order they were registered. Default: 0. */
  order?: number
  /** The slots it changes, built from the slots as the shadings before it left them. */
  shade(inputs: TerrainShadingInputs): TerrainShadingOutputs
}

/** Checks a definition, throwing an error that states the fix. */
export function validateTerrainShading(definition: TerrainShadingDefinition): void {
  const { name } = definition
  if (typeof name !== 'string' || name.length === 0) throw new Error('registerTerrainShading: give the shading a non-empty `name`.')
  if (typeof definition.shade !== 'function') {
    throw new Error(`registerTerrainShading("${name}"): \`shade\` must be a function returning the slots it changes ({ color, roughness, … }).`)
  }
  if (definition.order !== undefined && !Number.isFinite(definition.order)) {
    throw new Error(`registerTerrainShading("${name}"): \`order\` must be a finite number (lower runs first), got ${definition.order}.`)
  }
}

/** Listener of a registry: called after a shading was registered or removed. */
export type TerrainShadingListener = () => void

/**
 * The terrain shadings installed on one `Earth` (`earth.terrainShadings`). Plugins register through
 * `context.registerTerrainShading`; the earth's terrain applies them to its tiles.
 */
export class TerrainShadingRegistry {
  protected readonly definitions = new Map<string, TerrainShadingDefinition>()
  protected readonly listeners = new Set<TerrainShadingListener>()

  /** Adds a shading. Returns a function that removes it. Throws when the name is taken, stating the fix. */
  register(definition: TerrainShadingDefinition): () => void {
    validateTerrainShading(definition)
    if (this.definitions.has(definition.name)) {
      throw new Error(`registerTerrainShading: the terrain shading "${definition.name}" is already registered by another plugin; remove that plugin first.`)
    }
    this.definitions.set(definition.name, definition)
    this.notify()
    return () => {
      if (this.definitions.get(definition.name) !== definition) return
      this.definitions.delete(definition.name)
      this.notify()
    }
  }

  get(name: string): TerrainShadingDefinition | undefined {
    return this.definitions.get(name)
  }

  has(name: string): boolean {
    return this.definitions.has(name)
  }

  get size(): number {
    return this.definitions.size
  }

  /** The shadings in the order they run: by `order`, then by registration. */
  ordered(): TerrainShadingDefinition[] {
    // Array.prototype.sort is stable, so shadings of the same order keep their registration order.
    return [...this.definitions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /** Calls `listener` after each change. Returns a function that removes it. */
  subscribe(listener: TerrainShadingListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('TerrainShadingRegistry: a listener threw.', error)
      }
    }
  }
}
