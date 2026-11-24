import type { MapViewChange } from '../core/EarthCamera.js'
import type { RasterDemSourceOptions } from '../core/sources.js'
import type { ViewMode } from '../view/ViewMorph.js'
import type { DemEncoding } from './raster/rasterTiles.js'
import type { StyleDocument } from './worker/styleDocument.js'
import { resolveTemplate, resolveUrl } from './worker/tileSources.js'

/** The root `terrain` of a style, as a terrain source the earth can build. */
export interface StyleTerrain {
  /** The `raster-dem` source the style's `terrain` names. */
  sourceId: string
  /** Options for a `RasterDemSource` reading that source's tiles, URLs resolved against the style's URL. */
  source: RasterDemSourceOptions
  /** `terrain.exaggeration`. Default: 1. */
  exaggeration: number
}

/** What the root of a MapLibre style asks of the map, read by `readStyleRoot`. */
export interface StyleRoot {
  /** `center`, `zoom`, `bearing` and `pitch` as a camera view; null when the style has none of them. */
  initialView: MapViewChange | null
  /**
   * `projection.type`: `'mercator'` is the flat map (`'2d'`); `'globe'`, `'vertical-perspective'` and expressions
   * (MapLibre's globe is an expression that flattens as it zooms in) are the globe (`'3d'`). Null without one.
   */
  view: ViewMode | null
  /** The root `terrain`, or null without one (or when its source cannot be read: see `warnings`). */
  terrain: StyleTerrain | null
  /** Why a root property could not be honoured, each stating the fix. */
  warnings: string[]
}

const ENCODINGS: readonly DemEncoding[] = ['terrarium', 'mapbox', 'custom']

/**
 * Reads a style's root `center`, `zoom`, `bearing`, `pitch`, `projection` and `terrain`. MapLibre's pitch (0 looks
 * straight down) becomes `pitchDegrees` (-90 looks straight down) and its bearing `headingDegrees`. Root `light`,
 * `sky` and `fog` are not read: the atmosphere lights and hazes the scene from the sun's real position.
 * `customRequests`: the style's source sets `requestHeaders` or `transformRequest`, which terrain cannot use (warned).
 */
export function readStyleRoot(style: StyleDocument, baseUrl: string, { customRequests = false }: { customRequests?: boolean } = {}): StyleRoot {
  const warnings: string[] = []
  const terrain = readTerrain(style, baseUrl, warnings)
  if (terrain !== null && customRequests) {
    warnings.push(`MapStyleSource: the style's terrain tiles load without its requestHeaders and transformRequest (terrain sources take none). If "${terrain.sourceId}" needs them, put a <RasterDemSource> in the <Terrain> with a URL that works without them.`)
  }
  return { initialView: readInitialView(style), view: readProjection(style, warnings), terrain, warnings }
}

function readInitialView(style: StyleDocument): MapViewChange | null {
  const view: MapViewChange = {}
  const { center, zoom, bearing, pitch } = style
  if (Array.isArray(center) && center.length >= 2 && center.slice(0, 2).every(isFiniteNumber)) {
    view.longitudeDegrees = center[0] as number
    view.latitudeDegrees = center[1] as number
  }
  if (isFiniteNumber(zoom)) view.zoom = zoom
  if (isFiniteNumber(bearing)) view.headingDegrees = bearing
  if (isFiniteNumber(pitch)) view.pitchDegrees = pitch - 90
  return Object.keys(view).length === 0 ? null : view
}

function readProjection(style: StyleDocument, warnings: string[]): ViewMode | null {
  const projection = style.projection as { type?: unknown } | undefined
  if (projection === undefined || projection === null) return null
  const type = projection.type
  if (type === 'mercator') return '2d'
  if (type === 'globe' || type === 'vertical-perspective' || Array.isArray(type)) return '3d'
  warnings.push(`MapStyleSource: the style's projection type ${JSON.stringify(type)} is not one of 'mercator', 'globe' or 'vertical-perspective'; it is ignored. Pass <Earth view> to choose the view.`)
  return null
}

function readTerrain(style: StyleDocument, baseUrl: string, warnings: string[]): StyleTerrain | null {
  const terrain = style.terrain as { source?: unknown; exaggeration?: unknown } | undefined
  if (terrain === undefined || terrain === null) return null
  const sourceId = terrain.source
  const fix = 'or put a <RasterDemSource> in the <Terrain> yourself'
  if (typeof sourceId !== 'string') {
    warnings.push(`MapStyleSource: the style's terrain needs a \`source\` naming a raster-dem source; it is ignored. Add one, ${fix}.`)
    return null
  }
  const source = style.sources[sourceId] as Record<string, unknown> | undefined
  if (source === undefined || source.type !== 'raster-dem') {
    warnings.push(`MapStyleSource: the style's terrain names "${sourceId}", which is ${source === undefined ? 'not a source of the style' : `a ${String(source.type)} source`}; it is ignored. Name a raster-dem source, ${fix}.`)
    return null
  }
  let exaggeration = 1
  if (terrain.exaggeration !== undefined) {
    if (isFiniteNumber(terrain.exaggeration) && terrain.exaggeration >= 0) exaggeration = terrain.exaggeration
    else warnings.push(`MapStyleSource: the style's terrain exaggeration must be a number of 0 or more, got ${JSON.stringify(terrain.exaggeration)}; 1 is used.`)
  }

  const options: RasterDemSourceOptions = {}
  const tiles = source.tiles
  const url = source.url
  const tms = source.scheme === 'tms'
  if (Array.isArray(tiles) && typeof tiles[0] === 'string') {
    const template = resolveTemplate(tiles[0], baseUrl)
    options.url = tms ? template.replace('{y}', '{-y}') : template
  } else if (typeof url === 'string') {
    options.tileJsonUrl = resolveUrl(url, baseUrl)
  } else {
    warnings.push(`MapStyleSource: the terrain source "${sourceId}" has neither \`tiles\` nor a TileJSON \`url\`; the terrain is ignored. Give it one, ${fix}.`)
    return null
  }
  if (options.url !== undefined && !(['{z}', '{x}'].every(part => options.url!.includes(part)) && /{-?y}/.test(options.url))) {
    warnings.push(`MapStyleSource: the terrain source "${sourceId}" tiles ${options.url} need {z}, {x} and {y} placeholders (terrain reads no {quadkey} or {bbox-epsg-3857}); the terrain is ignored. Use a {z}/{x}/{y} URL, ${fix}.`)
    return null
  }
  const location = options.url ?? options.tileJsonUrl!
  if (!/^(https?|blob|data|file):/i.test(location)) {
    warnings.push(`MapStyleSource: the terrain source "${sourceId}" loads from ${location}, a scheme terrain cannot load (protocols, transformRequest and pmtiles:// serve the drape only); the terrain is ignored. Use an http(s) URL, ${fix}.`)
    return null
  }
  if (typeof source.encoding === 'string' && (ENCODINGS as readonly string[]).includes(source.encoding)) options.encoding = source.encoding as DemEncoding
  for (const [from, to] of [['redFactor', 'redFactor'], ['greenFactor', 'greenFactor'], ['blueFactor', 'blueFactor'], ['baseShift', 'baseShift'], ['maxzoom', 'maximumZoom']] as const) {
    if (isFiniteNumber(source[from])) options[to] = source[from]
  }
  if (typeof source.attribution === 'string') options.attribution = source.attribution
  return { sourceId, source: options, exaggeration }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
