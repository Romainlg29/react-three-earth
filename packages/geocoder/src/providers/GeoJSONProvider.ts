import type { GeographicBounds, GeographicPosition } from '@earthkit/globe'
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'

import { matchScore, normalizeText } from '../text.js'
import type { GeocoderProvider, GeocoderResult, GeocoderReverseOptions, GeocoderSearchOptions } from '../types.js'

/** Reads a text from a feature: a property name, or a function. */
export type FeatureText = string | ((feature: Feature) => string | null | undefined)

export interface GeoJSONProviderOptions {
  /** The features to search: a collection or an array. Replace them later with `setFeatures`. */
  features: FeatureCollection | readonly Feature[]
  /** Default: 'geojson'. */
  name?: string
  /** The feature's name, which results show and searches match. Default: the `name` property. */
  nameProperty?: FeatureText
  /** Other properties searches match too (alternative names, codes, tags), never shown. Default: none. */
  searchProperties?: readonly FeatureText[]
  /** The second line of a result. Default: empty. */
  description?: FeatureText
  /** The result's `category`. Default: the geometry's type, in lower case (`'point'`, `'polygon'`). */
  category?: FeatureText
  /** How far from a point or a line a reverse search still finds it. Polygons are found when they contain the position. Default: 500. */
  reverseToleranceMeters?: number
}

/** One searchable feature, prepared once. */
interface IndexEntry {
  feature: Feature
  order: number
  result: GeocoderResult
  /** The normalised texts to match: the name first. */
  texts: string[]
}

const EARTH_RADIUS_METERS = 6_371_008.8
const RADIANS = Math.PI / 180

/**
 * Searches features the app already has (its stores, trails, assets), in memory, with no request: names and other
 * properties, case and accent-insensitive, whole names first, then names starting with the query, then words starting
 * with it, then names containing it. Reverse search finds the polygons containing a position and the points and lines
 * near it. Put it first in a `Geocoder`'s providers to show your own places above a service's.
 */
export class GeoJSONProvider implements GeocoderProvider {
  readonly name: string
  readonly autocomplete = true
  /** Answers at once from data that `setFeatures` changes: never cached. */
  readonly cacheable = false
  protected readonly options: GeoJSONProviderOptions
  protected entries: IndexEntry[] = []

  constructor(options: GeoJSONProviderOptions) {
    this.options = options
    this.name = options.name ?? 'geojson'
    this.setFeatures(options.features)
  }

  /** Replaces the features searched. */
  setFeatures(features: FeatureCollection | readonly Feature[]): void {
    const list = 'features' in features ? features.features : features
    this.entries = list.flatMap((feature, order) => {
      const entry = this.createEntry(feature, order)
      return entry === null ? [] : [entry]
    })
  }

  /** How many features can be found: those with a geometry and a name. */
  get size(): number {
    return this.entries.length
  }

  search(query: string, { limit, proximity, bounds }: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const normalized = normalizeText(query)
    if (normalized === '') return Promise.resolve([])
    const matches: { entry: IndexEntry; score: number; distance: number }[] = []
    for (const entry of this.entries) {
      if (bounds !== null && bounds !== undefined && !containsPoint(bounds, entry.result)) continue
      let score = Number.POSITIVE_INFINITY
      for (const text of entry.texts) score = Math.min(score, matchScore(text, normalized))
      if (score === Number.POSITIVE_INFINITY) continue
      const distance = proximity === null || proximity === undefined ? 0 : distanceMeters(proximity, entry.result)
      matches.push({ entry, score, distance })
    }
    matches.sort((a, b) => a.score - b.score || a.distance - b.distance || a.entry.result.name.length - b.entry.result.name.length || a.entry.order - b.entry.order)
    return Promise.resolve(matches.slice(0, limit).map(match => match.entry.result))
  }

  reverse(position: GeographicPosition, { limit }: GeocoderReverseOptions): Promise<GeocoderResult[]> {
    const tolerance = this.options.reverseToleranceMeters ?? 500
    const containing: { result: GeocoderResult; area: number }[] = []
    const near: { result: GeocoderResult; distance: number }[] = []
    for (const { feature, result } of this.entries) {
      const geometry = feature.geometry
      if (geometry === null) continue
      const polygons = polygonsOf(geometry)
      if (polygons.length > 0 && result.bounds !== null && containsPoint(result.bounds, position) && polygonContains(polygons, position)) {
        containing.push({ result, area: boundsArea(result.bounds) })
        continue
      }
      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') continue
      const distance = geometryDistanceMeters(geometry, position)
      if (distance <= tolerance) near.push({ result, distance })
    }
    // The closest point or line first, then the smallest polygon around (the building before the district).
    near.sort((a, b) => a.distance - b.distance)
    containing.sort((a, b) => a.area - b.area)
    return Promise.resolve([...near.map(each => each.result), ...containing.map(each => each.result)].slice(0, limit))
  }

  protected createEntry(feature: Feature, order: number): IndexEntry | null {
    const geometry = feature.geometry
    if (geometry === null || geometry === undefined) return null
    const name = readText(feature, this.options.nameProperty ?? 'name')
    if (name === null) return null
    const bounds = geometryBounds(geometry)
    if (bounds === null) return null
    const point = geometry.type === 'Point' ? geometry.coordinates : null
    const longitudeDegrees = point === null ? (bounds.westDegrees + bounds.eastDegrees) / 2 : (point[0] ?? 0)
    const latitudeDegrees = point === null ? (bounds.southDegrees + bounds.northDegrees) / 2 : (point[1] ?? 0)
    const texts = [name, ...(this.options.searchProperties ?? []).map(property => readText(feature, property))]
      .filter((text): text is string => text !== null)
      .map(normalizeText)
    const isPoint = bounds.westDegrees === bounds.eastDegrees && bounds.southDegrees === bounds.northDegrees
    return {
      feature,
      order,
      texts,
      result: {
        id: feature.id === undefined || feature.id === null ? `${this.name}:#${order}` : `${this.name}:${feature.id}`,
        name,
        description: readText(feature, this.options.description ?? (() => '')) ?? '',
        longitudeDegrees,
        latitudeDegrees,
        bounds: isPoint ? null : bounds,
        category: readText(feature, this.options.category ?? (each => each.geometry.type.toLowerCase())),
        provider: this.name,
        raw: feature,
      },
    }
  }
}

function readText(feature: Feature, text: FeatureText): string | null {
  const value = typeof text === 'function' ? text(feature) : feature.properties?.[text]
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Every position of a geometry, flattened. */
function positionsOf(geometry: Geometry): Position[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates]
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.flat()
    case 'MultiPolygon':
      return geometry.coordinates.flat(2)
    case 'GeometryCollection':
      return geometry.geometries.flatMap(positionsOf)
  }
}

/** The box around a geometry, or null for an empty one. Does not split across the antimeridian. */
export function geometryBounds(geometry: Geometry): GeographicBounds | null {
  let westDegrees = Number.POSITIVE_INFINITY
  let southDegrees = Number.POSITIVE_INFINITY
  let eastDegrees = Number.NEGATIVE_INFINITY
  let northDegrees = Number.NEGATIVE_INFINITY
  for (const [longitude, latitude] of positionsOf(geometry)) {
    if (longitude === undefined || latitude === undefined) continue
    westDegrees = Math.min(westDegrees, longitude)
    eastDegrees = Math.max(eastDegrees, longitude)
    southDegrees = Math.min(southDegrees, latitude)
    northDegrees = Math.max(northDegrees, latitude)
  }
  return westDegrees === Number.POSITIVE_INFINITY ? null : { westDegrees, southDegrees, eastDegrees, northDegrees }
}

function containsPoint(bounds: GeographicBounds, { longitudeDegrees, latitudeDegrees }: GeographicPosition): boolean {
  if (latitudeDegrees < bounds.southDegrees || latitudeDegrees > bounds.northDegrees) return false
  return bounds.westDegrees <= bounds.eastDegrees
    ? longitudeDegrees >= bounds.westDegrees && longitudeDegrees <= bounds.eastDegrees
    : longitudeDegrees >= bounds.westDegrees || longitudeDegrees <= bounds.eastDegrees
}

function boundsArea(bounds: GeographicBounds): number {
  return (bounds.eastDegrees - bounds.westDegrees) * (bounds.northDegrees - bounds.southDegrees)
}

/** Whether a ring holds a position, by the even-odd rule on longitude and latitude. */
function ringContains(ring: Position[], { longitudeDegrees: x, latitudeDegrees: y }: GeographicPosition): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi = 0, yi = 0] = ring[index] ?? []
    const [xj = 0, yj = 0] = ring[previous] ?? []
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The polygons of a geometry, those inside a collection too. */
function polygonsOf(geometry: Geometry): Position[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(polygonsOf)
  return []
}

/** Whether polygons (outer ring, then holes) hold a position. */
function polygonContains(polygons: Position[][][], position: GeographicPosition): boolean {
  return polygons.some(([outer, ...holes]) => outer !== undefined && ringContains(outer, position) && !holes.some(hole => ringContains(hole, position)))
}

/** Great-circle distance, by the haversine formula. */
export function distanceMeters(a: GeographicPosition, b: GeographicPosition): number {
  const latitudeA = a.latitudeDegrees * RADIANS
  const latitudeB = b.latitudeDegrees * RADIANS
  const sinLatitude = Math.sin((latitudeB - latitudeA) / 2)
  const sinLongitude = Math.sin(((b.longitudeDegrees - a.longitudeDegrees) * RADIANS) / 2)
  const h = sinLatitude * sinLatitude + Math.cos(latitudeA) * Math.cos(latitudeB) * sinLongitude * sinLongitude
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Distance from a position to a point, line or their multi forms, on a local flat projection (fine within kilometres). */
function geometryDistanceMeters(geometry: Geometry, position: GeographicPosition): number {
  const toLocal = ([longitude = 0, latitude = 0]: Position): [number, number] => [
    (((longitude - position.longitudeDegrees + 540) % 360) - 180) * RADIANS * EARTH_RADIUS_METERS * Math.cos(position.latitudeDegrees * RADIANS),
    (latitude - position.latitudeDegrees) * RADIANS * EARTH_RADIUS_METERS,
  ]
  const lines: Position[][] =
    geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : geometry.type === 'GeometryCollection' ? [] : [positionsOf(geometry)]
  let best = Number.POSITIVE_INFINITY
  if (geometry.type === 'GeometryCollection') {
    for (const each of geometry.geometries) best = Math.min(best, geometryDistanceMeters(each, position))
    return best
  }
  const isLine = geometry.type === 'LineString' || geometry.type === 'MultiLineString'
  for (const line of lines) {
    const local = line.map(toLocal)
    for (let index = 0; index < local.length; index++) {
      const [ax, ay] = local[index] as [number, number]
      best = Math.min(best, Math.hypot(ax, ay))
      if (!isLine || index === 0) continue
      const [bx, by] = local[index - 1] as [number, number]
      const dx = ax - bx
      const dy = ay - by
      const lengthSquared = dx * dx + dy * dy
      if (lengthSquared === 0) continue
      const t = Math.max(0, Math.min(1, -(bx * dx + by * dy) / lengthSquared))
      best = Math.min(best, Math.hypot(bx + t * dx, by + t * dy))
    }
  }
  return best
}
