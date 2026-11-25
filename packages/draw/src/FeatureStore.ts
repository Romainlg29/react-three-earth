import type { FeatureCollection } from 'geojson'

import type { DrawFeature, DrawGeometry } from './types.js'

/** What changed in a `FeatureStore`, by feature id. */
export interface FeatureStoreChange {
  added: readonly string[]
  updated: readonly string[]
  removed: readonly DrawFeature[]
}

/** Called after each change. */
export type FeatureStoreListener = (change: FeatureStoreChange) => void

let fallbackCounter = 0

/** A new feature id: a random UUID where the browser has one, a counter otherwise. */
export function createFeatureId(): string {
  const crypto = globalThis.crypto as Crypto | undefined
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `feature-${Date.now().toString(36)}-${(fallbackCounter++).toString(36)}`
}

/**
 * The features a `Draw` holds, in drawing order (later on top). Features are replaced, never changed in place, so the
 * collection `toFeatureCollection` returns can be compared by identity.
 */
export class FeatureStore {
  protected readonly features = new Map<string, DrawFeature>()
  protected readonly listeners = new Set<FeatureStoreListener>()
  protected collection: FeatureCollection<DrawGeometry> | null = null

  get size(): number {
    return this.features.size
  }

  get(id: string): DrawFeature | undefined {
    return this.features.get(id)
  }

  has(id: string): boolean {
    return this.features.has(id)
  }

  /** The features in drawing order. */
  values(): IterableIterator<DrawFeature> {
    return this.features.values()
  }

  /** Every feature as a GeoJSON feature collection: the same object until something changes. */
  toFeatureCollection(): FeatureCollection<DrawGeometry> {
    this.collection ??= { type: 'FeatureCollection', features: [...this.features.values()] }
    return this.collection
  }

  /** Adds features, or replaces those whose id is taken (`updated`). */
  set(features: readonly DrawFeature[]): void {
    if (features.length === 0) return
    // All checked before any is stored: a batch with one invalid feature changes nothing.
    for (const feature of features) validateFeature(feature)
    const added: string[] = []
    const updated: string[] = []
    for (const feature of features) {
      ;(this.features.has(feature.id) ? updated : added).push(feature.id)
      this.features.set(feature.id, feature)
    }
    this.changed({ added, updated, removed: [] })
  }

  /** Removes features by id. Unknown ids are skipped. */
  remove(ids: readonly string[]): void {
    const removed: DrawFeature[] = []
    for (const id of ids) {
      const feature = this.features.get(id)
      if (feature === undefined) continue
      this.features.delete(id)
      removed.push(feature)
    }
    if (removed.length > 0) this.changed({ added: [], updated: [], removed })
  }

  /** Replaces every feature; `validated` skips checking them again (`validateFeature` passed on each). */
  replace(features: readonly DrawFeature[], { validated = false }: { validated?: boolean } = {}): void {
    if (!validated) for (const feature of features) validateFeature(feature)
    const nextIds = new Set(features.map(feature => feature.id))
    const removed = [...this.features.values()].filter(feature => !nextIds.has(feature.id))
    const added: string[] = []
    const updated: string[] = []
    const previous = new Set(this.features.keys())
    this.features.clear()
    for (const feature of features) {
      ;(previous.has(feature.id) ? updated : added).push(feature.id)
      this.features.set(feature.id, feature)
    }
    if (added.length + updated.length + removed.length > 0) this.changed({ added, updated, removed })
  }

  subscribe(listener: FeatureStoreListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected changed(change: FeatureStoreChange): void {
    this.collection = null
    for (const listener of [...this.listeners]) listener(change)
  }
}

const GEOMETRY_TYPES = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon'])

/** Whether a `Draw` can hold a feature (`validateFeature` would not throw). */
export function isDrawableFeature(feature: DrawFeature): boolean {
  try {
    validateFeature(feature)
    return true
  } catch {
    return false
  }
}

/** Throws, stating the fix, for a feature a `Draw` cannot hold. */
export function validateFeature(feature: DrawFeature): void {
  if (feature?.type !== 'Feature') throw new Error('Draw: features must be GeoJSON features ({ type: "Feature", geometry, properties }).')
  if (typeof feature.id !== 'string' || feature.id.length === 0) throw new Error('Draw: give every feature a string `id` (createFeatureId() makes one).')
  if (!GEOMETRY_TYPES.has(feature.geometry?.type)) {
    throw new Error(`Draw: feature "${feature.id}" has a ${feature.geometry?.type ?? 'missing'} geometry; Draw holds Point, LineString, Polygon and MultiPolygon features (split MultiPoint, MultiLineString and GeometryCollection geometries into features).`)
  }
  validateCoordinates(feature.id, feature.geometry)
}

/** Throws, stating the fix, for coordinates not shaped as the geometry's type requires. */
function validateCoordinates(id: string, geometry: DrawGeometry): void {
  const fail = (path: string, problem: string, fix: string) => {
    throw new Error(`Draw: feature "${id}" (${geometry.type}) has ${problem} at coordinates${path}; ${fix}.`)
  }
  const position = (value: unknown, path: string) => {
    if (!Array.isArray(value) || value.length < 2) fail(path, 'a position that is not [longitude, latitude]', 'give each position as [longitude, latitude] or [longitude, latitude, altitudeMeters]')
    const [longitude, latitude, altitude] = value as unknown[]
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || typeof latitude !== 'number' || !Number.isFinite(latitude)) {
      fail(path, `the position ${JSON.stringify(value)}`, 'give the longitude and latitude as finite numbers of degrees')
    }
    if (Math.abs(latitude as number) > 90) fail(path, `the latitude ${latitude}`, 'give latitudes between -90 and 90 degrees (positions are [longitude, latitude], longitude first)')
    if ((value as unknown[]).length > 2 && (typeof altitude !== 'number' || !Number.isFinite(altitude))) {
      fail(path, `the altitude ${JSON.stringify(altitude)}`, 'give the altitude as a finite number of metres above the ellipsoid, or leave it out to drape the position on the terrain')
    }
  }
  const line = (value: unknown, path: string, minimum: number, fix: string) => {
    if (!Array.isArray(value) || value.length < minimum) fail(path, Array.isArray(value) ? `${value.length} positions` : 'no array of positions', fix)
    ;(value as unknown[]).forEach((entry, index) => position(entry, `${path}[${index}]`))
  }
  const ringFix = 'give each ring 4 or more positions, the first repeated at the end'
  const polygon = (value: unknown, path: string) => {
    if (!Array.isArray(value) || value.length === 0) fail(path, 'no rings', 'give a polygon as an array of rings: the exterior, then any holes')
    ;(value as unknown[]).forEach((ring, index) => line(ring, `${path}[${index}]`, 4, ringFix))
  }
  const coordinates: unknown = geometry.coordinates
  if (geometry.type === 'Point') position(coordinates, '')
  else if (geometry.type === 'LineString') line(coordinates, '', 2, 'give a line string 2 or more positions')
  else if (geometry.type === 'Polygon') polygon(coordinates, '')
  else {
    if (!Array.isArray(coordinates) || coordinates.length === 0) fail('', 'no polygons', 'give a multipolygon as an array of polygons (a mesh: one per face), or remove the feature')
    ;(coordinates as unknown[]).forEach((entry, index) => polygon(entry, `[${index}]`))
  }
}
