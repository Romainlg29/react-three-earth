import { LineStringMode, PolygonMode, type DrawModeContext, type LongitudeLatitude, type PlacementModeOptions } from '@earthkit/draw'

/** A mode that draws a measurement: it shows what is being drawn, through the pointer, as it moves. */
export interface MeasureDrawMode {
  /** The vertices placed so far, then the pointer's position when it is over the map. Empty when nothing is being drawn. */
  livePositions(): LongitudeLatitude[]
  /** Called whenever the vertices or the pointer's position change. Set by `Measure`. */
  onLiveChange: (() => void) | null
}

/** True for the measure package's drawing modes (and subclasses). */
export function isMeasureDrawMode(mode: unknown): mode is MeasureDrawMode {
  return typeof mode === 'object' && mode !== null && typeof (mode as Partial<MeasureDrawMode>).livePositions === 'function' && 'onLiveChange' in mode
}

/** The context with `changed` also telling the mode's listener; everything else read through, lazily. */
function relayChanges(context: DrawModeContext, mode: MeasureDrawMode): DrawModeContext {
  const relayed = Object.create(context) as DrawModeContext & { changed: () => void }
  Object.defineProperty(relayed, 'changed', {
    value: () => {
      context.changed()
      mode.onLiveChange?.()
    },
  })
  return relayed
}

/**
 * Measures a path: a tap per vertex, a tap on the last vertex (or Enter, a double click, `finish()`) completes it as a
 * line string. Its length shows live, through the pointer, while drawing.
 */
export class DistanceMode extends LineStringMode implements MeasureDrawMode {
  override readonly name: string = 'distance'
  onLiveChange: (() => void) | null = null

  constructor(options: Omit<PlacementModeOptions, 'heightMeters'> = {}) {
    super(options)
  }

  override enter(context: DrawModeContext): void {
    super.enter(relayChanges(context, this))
  }

  livePositions(): LongitudeLatitude[] {
    if (this.vertices.length === 0) return []
    return this.hoverPosition === null ? [...this.vertices] : [...this.vertices, this.hoverPosition]
  }
}

/**
 * Measures an area: a tap per vertex, a tap on the first or last vertex (or Enter, a double click, `finish()`) closes
 * it as a polygon. Its area and perimeter show live, through the pointer, while drawing.
 */
export class AreaMode extends PolygonMode implements MeasureDrawMode {
  override readonly name: string = 'area'
  onLiveChange: (() => void) | null = null

  constructor(options: Omit<PlacementModeOptions, 'heightMeters'> = {}) {
    super(options)
  }

  override enter(context: DrawModeContext): void {
    super.enter(relayChanges(context, this))
  }

  livePositions(): LongitudeLatitude[] {
    if (this.vertices.length === 0) return []
    return this.hoverPosition === null ? [...this.vertices] : [...this.vertices, this.hoverPosition]
  }
}
