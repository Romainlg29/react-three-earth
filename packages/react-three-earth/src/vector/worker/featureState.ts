import type { Rgba } from './styleLayers.js'
import type { FeatureColorUpdate, FeatureState } from './types.js'

/** The feature a feature-state belongs to, as in MapLibre's `setFeatureState`. */
export interface FeatureIdentifier {
  /** The style source id. */
  source: string
  /** The source layer, required for vector tile sources. */
  sourceLayer?: string
  /** The feature id: the tile's own id, or the property named by the source's `promoteId`. */
  id: string | number
}

const SEPARATOR = '\u001f'

/** One string per feature. Ids compare as strings, as in MapLibre (`1` and `'1'` are the same feature). */
export function featureKey(source: string, sourceLayer: string | undefined, id: string | number): string {
  return `${source}${SEPARATOR}${sourceLayer ?? ''}${SEPARATOR}${String(id)}`
}

/** The source and source layer of a key made by `featureKey`. */
export function parseFeatureKey(key: string): { source: string; sourceLayer: string; id: string } {
  const [source = '', sourceLayer = '', ...id] = key.split(SEPARATOR)
  return { source, sourceLayer, id: id.join(SEPARATOR) }
}

const MAXIMUM_TABLE_WIDTH = 1024
const MAXIMUM_TABLE_ROWS = 1024

interface Slot {
  featureKey: string
  /** Evaluates the slot's colour for a feature-state; replaced each time the slot's tile is processed. */
  evaluate: (state: FeatureState) => Rgba
}

/**
 * The worker's table of feature colours that depend on feature-state. A slot is one colour of one feature in one
 * layer at one zoom (a fill, its outline, a line, a circle, its stroke). Tiles store slot numbers in their
 * vertices; a state change re-evaluates the feature's slots and sends only the colours that changed.
 *
 * Slots live as long as the table: their number is bounded by the features of state-dependent layers seen this
 * session. Past `MAXIMUM_TABLE_ROWS` × 1024 slots, `allocate` answers 0 and the tile bakes the colour instead
 * (the caller then processes the tile again on a state change).
 */
export class FeatureColorTable {
  readonly width = MAXIMUM_TABLE_WIDTH
  /** Slot 0 means "no slot": the first usable one is 1. */
  protected readonly slots: Slot[] = [{ featureKey: '', evaluate: () => [0, 0, 0, 0] }]
  protected readonly byKey = new Map<string, number>()
  protected readonly byFeature = new Map<string, number[]>()
  protected colors = new Uint8Array(MAXIMUM_TABLE_WIDTH * 4)
  protected readonly changed = new Set<number>()
  protected rows = 1

  /** Allocates (or reuses) the slot of `slotKey`, evaluated now for `state`. Returns 0 when the table is full. */
  allocate(featureKey: string, slotKey: string, evaluate: Slot['evaluate'], state: FeatureState): number {
    let slot = this.byKey.get(slotKey)
    if (slot === undefined) {
      if (this.slots.length >= MAXIMUM_TABLE_WIDTH * MAXIMUM_TABLE_ROWS) return 0
      slot = this.slots.length
      this.slots.push({ featureKey, evaluate })
      this.byKey.set(slotKey, slot)
      let list = this.byFeature.get(featureKey)
      if (list === undefined) this.byFeature.set(featureKey, (list = []))
      list.push(slot)
      this.ensureRows(Math.floor(slot / MAXIMUM_TABLE_WIDTH) + 1)
    } else this.slots[slot]!.evaluate = evaluate
    this.write(slot, evaluate(state))
    return slot
  }

  /** Re-evaluates every slot of a feature for its new state. */
  updateFeature(featureKey: string, state: FeatureState): void {
    for (const slot of this.byFeature.get(featureKey) ?? []) this.write(slot, this.slots[slot]!.evaluate(state))
  }

  /** Colours changed since the last call, for the main thread's copy of the table. */
  takeUpdate(): FeatureColorUpdate | null {
    if (this.changed.size === 0) return null
    const slots = Uint32Array.from(this.changed)
    const colors = new Uint8Array(slots.length * 4)
    slots.forEach((slot, index) => colors.set(this.colors.subarray(slot * 4, slot * 4 + 4), index * 4))
    this.changed.clear()
    return { width: MAXIMUM_TABLE_WIDTH, height: this.rows, slots, colors }
  }

  protected write(slot: number, color: Rgba): void {
    const offset = slot * 4
    const colors = this.colors
    if (colors[offset] === color[0] && colors[offset + 1] === color[1] && colors[offset + 2] === color[2] && colors[offset + 3] === color[3]) return // the main thread's copy starts transparent too
    colors.set(color, offset)
    this.changed.add(slot)
  }

  protected ensureRows(rows: number): void {
    if (rows <= this.rows) return
    const next = Math.min(Math.max(rows, this.rows * 2), MAXIMUM_TABLE_ROWS)
    const colors = new Uint8Array(next * MAXIMUM_TABLE_WIDTH * 4)
    colors.set(this.colors)
    this.colors = colors
    this.rows = next
  }
}
