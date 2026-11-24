import type { Node } from 'three/webgpu'

/**
 * The style layer `metadata` key that picks a symbol effect: `"metadata": { "react-three-earth:symbol-effect": "neon" }`
 * on a `symbol` layer draws its text and SDF icons with the effect registered as `neon`. Metadata is the style
 * specification's own place for extensions, so the style stays valid for MapLibre, which ignores it.
 */
export const SYMBOL_EFFECT_METADATA_KEY = 'react-three-earth:symbol-effect'

/**
 * What a symbol effect shades, per fragment of a glyph or SDF icon quad. Colours are linear RGB with straight
 * alpha. Distances are in signed distance field units: 0 far outside, `edge` on the outline, 1 deep inside.
 */
export interface SymbolEffectInputs {
  /** The glyph's (or SDF icon's) distance sample. */
  distance: Node<'float'>
  /** The outline's distance (0.75, MapLibre's 192 / 256). */
  edge: Node<'float'>
  /** Where the halo ends (`text-halo-width`), below `edge`; equal to `edge` without a halo. */
  haloEdge: Node<'float'>
  /**
   * Distance units across one screen pixel, for antialiasing. One unit is 8 pixels of a 24 px font, so a
   * 16 px label has `pixelWidth` about 0.19.
   */
  pixelWidth: Node<'float'>
  /** `text-color` (or `icon-color`), `text-opacity` included. */
  fillColor: Node<'vec4'>
  /** `text-halo-color` (or `icon-halo-color`). */
  haloColor: Node<'vec4'>
  /** 1 for an SDF icon, 0 for text. */
  isIcon: Node<'float'>
  /** The label's size on the screen over 24 px (`text-size` / 24). */
  scale: Node<'float'>
  /** What the library draws without an effect: the fill over its halo. Wrap it to add to it. */
  standardColor: Node<'vec4'>
}

/**
 * A plugin's look for map labels: replaces how the glyph's signed distance becomes colour (glows, outlines,
 * gradients, animated text) in the `symbol` layers whose metadata names it. Placement, collision, fades and
 * colour icons are unchanged.
 *
 * The effect draws inside each glyph's quad, which reaches 3 pixels of a 24 px font past the glyph (the
 * distance field's padding): a glow or outline wider than that is cut at the quad's edge.
 */
export interface SymbolEffectDefinition {
  /** The name style layers give in `metadata["react-three-earth:symbol-effect"]`. */
  name: string
  /**
   * The colour of a fragment (linear RGB, straight alpha), built once per effect per map style source. The
   * library then applies the label's fade, the layer's opacity and the flat map's luminance. Read time or
   * other changing values through your own `uniform`, updated in `context.onUpdate` (return true while it animates).
   */
  shade(inputs: SymbolEffectInputs): Node<'vec4'>
}

/** Checks a definition, throwing an error that states the fix. */
export function validateSymbolEffect(definition: SymbolEffectDefinition): void {
  const { name } = definition
  if (typeof name !== 'string' || name.length === 0) throw new Error('registerSymbolEffect: give the effect a non-empty `name`.')
  if (typeof definition.shade !== 'function') throw new Error(`registerSymbolEffect("${name}"): \`shade\` must be a function returning a vec4 colour node.`)
}

/** The effect a style layer asks for (`metadata["react-three-earth:symbol-effect"]`), or null for none. */
export function getLayerSymbolEffect(layer: object | undefined): string | null {
  const metadata = (layer as { metadata?: unknown } | undefined)?.metadata
  if (metadata === null || typeof metadata !== 'object') return null
  const name = (metadata as Record<string, unknown>)[SYMBOL_EFFECT_METADATA_KEY]
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** Listener of a registry: called after an effect was registered or removed. */
export type SymbolEffectListener = () => void

/**
 * The symbol effects installed on one `Earth` (`earth.symbolEffects`). Plugins register through
 * `context.registerSymbolEffect`; map style sources read it and draw the labels of layers that name an effect.
 */
export class SymbolEffectRegistry {
  protected readonly definitions = new Map<string, SymbolEffectDefinition>()
  protected readonly listeners = new Set<SymbolEffectListener>()

  /** Adds an effect. Returns a function that removes it. Throws when the name is taken, stating the fix. */
  register(definition: SymbolEffectDefinition): () => void {
    validateSymbolEffect(definition)
    if (this.definitions.has(definition.name)) {
      throw new Error(`registerSymbolEffect: the symbol effect "${definition.name}" is already registered by another plugin; remove that plugin first.`)
    }
    this.definitions.set(definition.name, definition)
    this.notify()
    return () => {
      if (this.definitions.get(definition.name) !== definition) return
      this.definitions.delete(definition.name)
      this.notify()
    }
  }

  get(name: string): SymbolEffectDefinition | undefined {
    return this.definitions.get(name)
  }

  has(name: string): boolean {
    return this.definitions.has(name)
  }

  get size(): number {
    return this.definitions.size
  }

  values(): IterableIterator<SymbolEffectDefinition> {
    return [...this.definitions.values()][Symbol.iterator]()
  }

  /** Calls `listener` after each change. Returns a function that removes it. */
  subscribe(listener: SymbolEffectListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('SymbolEffectRegistry: a listener threw.', error)
      }
    }
  }
}
