import type { StyleCommand } from './types.js'

/** The parts of a style layer the style API reads and edits. */
export interface StyleDocumentLayer {
  id: string
  type: string
  source?: string
  'source-layer'?: string
  minzoom?: number
  maxzoom?: number
  filter?: unknown
  layout?: Record<string, unknown>
  paint?: Record<string, unknown>
  [key: string]: unknown
}

/** A MapLibre style document (version 8), as far as the style API edits it. */
export interface StyleDocument {
  version?: number
  sources: Record<string, { type: string; [key: string]: unknown }>
  layers: StyleDocumentLayer[]
  glyphs?: string
  sprite?: unknown
  state?: Record<string, { default?: unknown }>
  [key: string]: unknown
}

/** A copy whose `layers` array, layers and `sources` map can be edited without touching the original. */
export function copyStyleDocument(style: unknown): StyleDocument {
  const document = style as Partial<StyleDocument> | null
  if (typeof document !== 'object' || document === null || !Array.isArray(document.layers)) {
    throw new Error('MapStyleSource: the style must be a MapLibre style document (version 8) with a `layers` array.')
  }
  return { ...document, layers: document.layers.map(layer => ({ ...layer })), sources: { ...(document.sources ?? {}) } } as StyleDocument
}

function findLayer(document: StyleDocument, layerId: string, command: string): number {
  const position = document.layers.findIndex(layer => layer.id === layerId)
  if (position === -1) {
    throw new Error(`MapStyleSource.${command}: there is no layer "${layerId}". Add it first with addLayer, or check the id against getLayerIds().`)
  }
  return position
}

/** Sets or (for `undefined`) deletes a key, on a copy. */
function withValue<T extends object>(object: T | undefined, name: string, value: unknown): T {
  const copy = { ...(object ?? {}) } as Record<string, unknown>
  if (value === undefined) delete copy[name]
  else copy[name] = value
  return copy as T
}

/**
 * Applies one command to a style document in place, after checking it can apply: an unknown layer or source, a
 * duplicate id or a source still in use throws an error that states the fix, and leaves the document unchanged.
 * Expressions are not checked here: the worker compiles them, and reports those that fail.
 * Runtime `global-state` values (`setGlobalStateProperty`) are not part of the document: nothing changes.
 */
export function applyStyleCommand(document: StyleDocument, command: StyleCommand): void {
  const layers = document.layers
  switch (command.command) {
    case 'setPaintProperty':
    case 'setLayoutProperty': {
      const [layerId, name, value] = command.args
      const position = findLayer(document, layerId, command.command)
      const kind = command.command === 'setPaintProperty' ? 'paint' : 'layout'
      const layer = layers[position]!
      layers[position] = { ...layer, [kind]: withValue(layer[kind], name, value) }
      return
    }
    case 'setFilter': {
      const [layerId, filter] = command.args
      const position = findLayer(document, layerId, command.command)
      layers[position] = withValue(layers[position]!, 'filter', filter === null ? undefined : filter)
      return
    }
    case 'setLayerZoomRange': {
      const [layerId, minimumZoom, maximumZoom] = command.args
      const position = findLayer(document, layerId, command.command)
      if (minimumZoom !== undefined && maximumZoom !== undefined && minimumZoom > maximumZoom) {
        throw new Error(`MapStyleSource.setLayerZoomRange: the minimum zoom (${minimumZoom}) is above the maximum (${maximumZoom}) for "${layerId}".`)
      }
      layers[position] = withValue(withValue(layers[position]!, 'minzoom', minimumZoom), 'maxzoom', maximumZoom)
      return
    }
    case 'addLayer': {
      const [specification, beforeId] = command.args
      const layer = specification as StyleDocumentLayer
      if (typeof layer !== 'object' || layer === null || typeof layer.id !== 'string' || typeof layer.type !== 'string') {
        throw new Error('MapStyleSource.addLayer: a layer needs a string `id` and `type`, as in a MapLibre style.')
      }
      if (layers.some(existing => existing.id === layer.id)) {
        throw new Error(`MapStyleSource.addLayer: a layer "${layer.id}" already exists. Pick another id, or removeLayer it first.`)
      }
      if (layer.type !== 'background' && (layer.source === undefined || document.sources[layer.source] === undefined)) {
        throw new Error(`MapStyleSource.addLayer: layer "${layer.id}" reads source "${String(layer.source)}", which the style does not have. Add it first with addSource.`)
      }
      const position = beforeId === undefined ? layers.length : findLayer(document, beforeId, command.command)
      layers.splice(position, 0, { ...layer })
      return
    }
    case 'removeLayer': {
      layers.splice(findLayer(document, command.args[0], command.command), 1)
      return
    }
    case 'moveLayer': {
      const [layerId, beforeId] = command.args
      const position = findLayer(document, layerId, command.command)
      if (beforeId !== undefined) findLayer(document, beforeId, command.command)
      const [moved] = layers.splice(position, 1)
      layers.splice(beforeId === undefined ? layers.length : layers.findIndex(layer => layer.id === beforeId), 0, moved!)
      return
    }
    case 'addSource': {
      const [sourceId, source] = command.args
      if (document.sources[sourceId] !== undefined) {
        throw new Error(`MapStyleSource.addSource: a source "${sourceId}" already exists. Pick another id, or removeSource it first.`)
      }
      if (typeof source !== 'object' || source === null || typeof (source as { type?: unknown }).type !== 'string') {
        throw new Error(`MapStyleSource.addSource: source "${sourceId}" needs a \`type\` ('vector' for vector tiles), as in a MapLibre style.`)
      }
      document.sources[sourceId] = source as StyleDocument['sources'][string]
      return
    }
    case 'removeSource': {
      const [sourceId] = command.args
      if (document.sources[sourceId] === undefined) throw new Error(`MapStyleSource.removeSource: there is no source "${sourceId}"; check the id against getStyle().sources.`)
      const users = layers.filter(layer => layer.source === sourceId).map(layer => layer.id)
      if (users.length > 0) throw new Error(`MapStyleSource.removeSource: layers ${users.map(id => `"${id}"`).join(', ')} still read source "${sourceId}"; removeLayer them first.`)
      delete document.sources[sourceId]
      return
    }
    case 'setGlobalState':
      document.state = command.args[0]
      return
    case 'setGlobalStateProperty':
      return
    default: {
      const unknown: { command: string } = command
      throw new Error(`MapStyleSource: unknown style command "${unknown.command}".`)
    }
  }
}

/** Style commands the renderer can apply in place; any other difference reloads the style. */
export const APPLICABLE_COMMANDS: ReadonlySet<string> = new Set<StyleCommand['command']>([
  'setPaintProperty',
  'setLayoutProperty',
  'setFilter',
  'setLayerZoomRange',
  'addLayer',
  'removeLayer',
  'moveLayer',
  'addSource',
  'removeSource',
  'setGlobalState',
])

/**
 * Style `diff` commands that change nothing the renderer draws (camera, transitions, and root properties that
 * W16 will read): skipped rather than reloading the style.
 */
export const IGNORED_COMMANDS: ReadonlySet<string> = new Set([
  'setCenter',
  'setCenterAltitude',
  'setZoom',
  'setBearing',
  'setPitch',
  'setRoll',
  'setTransition',
  'setLight',
  'setTerrain',
  'setSky',
  'setProjection',
])
