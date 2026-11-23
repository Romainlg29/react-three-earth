import type { MapStyle } from './MapStyle.js'
import type { StyleDocumentLayer } from './worker/styleDocument.js'

/** A style layer, in MapLibre's terms with the library's names for the zoom range and source layer. */
export interface StyleLayerOptions {
  id: string
  /** `fill`, `line`, `circle`, `symbol`, `background` or `fill-extrusion` (drawn flat). */
  type: 'fill' | 'line' | 'circle' | 'symbol' | 'background' | 'fill-extrusion' | (string & {})
  /** The style source the layer reads; not for `background`. */
  source?: string
  /** The layer inside the vector tiles (`source-layer`). */
  sourceLayer?: string
  /** MapLibre paint properties. @example { 'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#f80', '#888'] } */
  paint?: Record<string, unknown>
  /** MapLibre layout properties. */
  layout?: Record<string, unknown>
  /** A MapLibre filter expression. */
  filter?: unknown
  /** Lowest zoom it draws at (inclusive). */
  minimumZoom?: number
  /** Zoom from which it stops drawing (exclusive). */
  maximumZoom?: number
  /** The layer it sits below; on top without it. */
  beforeId?: string
}

/** What a `StyleLayer` is added to: a `MapStyleSource`. */
export interface StyleLayerHost {
  getMapStyle(): MapStyle
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * One style layer the app owns, added to a `MapStyleSource` and updated by diffing: `update(options)` sends only the
 * properties that changed (`setPaintProperty`…), and a new type or source replaces the layer in place. It survives
 * `setStyle`. `<StyleLayer>` in React wraps it.
 */
export class StyleLayer {
  readonly id: string
  protected options: StyleLayerOptions
  protected style: MapStyle | null = null

  constructor(options: StyleLayerOptions) {
    this.id = options.id
    this.options = { ...options }
  }

  /** Where `setStyle` puts the layer back. */
  get beforeId(): string | undefined {
    return this.options.beforeId
  }

  /** The MapLibre layer object. */
  toSpecification(): StyleDocumentLayer {
    const { id, type, source, sourceLayer, paint, layout, filter, minimumZoom, maximumZoom } = this.options
    return {
      id,
      type,
      ...(source !== undefined ? { source } : {}),
      ...(sourceLayer !== undefined ? { 'source-layer': sourceLayer } : {}),
      ...(paint !== undefined ? { paint } : {}),
      ...(layout !== undefined ? { layout } : {}),
      ...(filter !== undefined ? { filter } : {}),
      ...(minimumZoom !== undefined ? { minzoom: minimumZoom } : {}),
      ...(maximumZoom !== undefined ? { maxzoom: maximumZoom } : {}),
    }
  }

  /** Adds the layer to a source's style, below `beforeId` (default: the option). */
  addTo(host: StyleLayerHost, beforeId: string | undefined = this.options.beforeId): this {
    if (this.style !== null) throw new Error(`StyleLayer "${this.id}" is already added; remove() it first.`)
    const style = host.getMapStyle()
    this.options = { ...this.options, ...(beforeId !== undefined ? { beforeId } : {}) }
    style.addLayer(this.toSpecification(), beforeId)
    style.manageLayer(this)
    this.style = style
    return this
  }

  /** Removes the layer from its style (if it is still there). */
  remove(): void {
    const style = this.style
    if (style === null) return
    this.style = null
    style.unmanageLayer(this)
    if (style.isSettled && !style.getLayerIds().includes(this.id)) return // already removed (by setStyle, say)
    style.removeLayer(this.id)
  }

  /** Applies new options, sending only what changed. The id cannot change: make another layer. */
  update(next: StyleLayerOptions): void {
    if (next.id !== this.id) throw new Error(`StyleLayer.update: the id cannot change ("${this.id}" to "${next.id}"); create another StyleLayer.`)
    const previous = this.options
    this.options = { ...next }
    const style = this.style
    if (style === null) return
    if (previous.type !== next.type || previous.source !== next.source || previous.sourceLayer !== next.sourceLayer) {
      // Replaced where it is: below the layer that follows it now
      const ids = style.getLayerIds()
      const position = ids.indexOf(this.id)
      const following = position === -1 ? next.beforeId : ids[position + 1]
      style.removeLayer(this.id)
      style.addLayer(this.toSpecification(), following)
      return
    }
    for (const kind of ['paint', 'layout'] as const) {
      const before = previous[kind] ?? {}
      const after = next[kind] ?? {}
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (same(before[name], after[name])) continue
        if (kind === 'paint') style.setPaintProperty(this.id, name, after[name])
        else style.setLayoutProperty(this.id, name, after[name])
      }
    }
    if (!same(previous.filter, next.filter)) style.setFilter(this.id, next.filter)
    if (previous.minimumZoom !== next.minimumZoom || previous.maximumZoom !== next.maximumZoom) style.setLayerZoomRange(this.id, next.minimumZoom, next.maximumZoom)
    if (previous.beforeId !== next.beforeId) style.moveLayer(this.id, next.beforeId)
  }
}
