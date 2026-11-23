/**
 * GeoJSON helpers shared by the main thread (the style document) and the vector tile worker. Worker-safe: no
 * three.js, no DOM.
 */

import type { Feature, FeatureCollection, GeoJSON, Geometry, GeoJsonProperties } from 'geojson'

import { boundsToMercatorRectangles, type MercatorRectangle } from './rectangles.js'

/** A feature id, as in GeoJSON (or the property named by `promoteId`). */
export type GeoJsonFeatureId = string | number

/** One feature's change in `updateData`, as in MapLibre's `GeoJSONFeatureDiff`. */
export interface GeoJsonFeatureUpdate {
  id: GeoJsonFeatureId
  /** Replaces the feature's geometry. */
  newGeometry?: Geometry
  /** Drops every property before `addOrUpdateProperties` applies. */
  removeAllProperties?: boolean
  /** Property names to drop. */
  removeProperties?: string[]
  /** Properties to set. */
  addOrUpdateProperties?: Array<{ key: string; value: unknown }>
}

/**
 * A change to a GeoJSON source's features, by id, as in MapLibre's `GeoJSONSourceDiff`. Applied in this order:
 * `removeAll`, `remove`, `add`, `update`. Every feature needs an id (its `id`, or the `promoteId` property).
 * @example { add: [{ type: 'Feature', id: 'bus-12', geometry: { type: 'Point', coordinates: [2.35, 48.85] }, properties: {} }], remove: ['bus-7'] }
 */
export interface GeoJsonSourceDiff {
  removeAll?: boolean
  remove?: GeoJsonFeatureId[]
  /** New features; one with the id of an existing feature replaces it. */
  add?: Feature[]
  update?: GeoJsonFeatureUpdate[]
}

/** A longitude-latitude box, in degrees: west, south, east, north. */
export type GeoJsonBounds = [number, number, number, number]

/** GeoJSON as a list of features: a geometry becomes a feature with no properties. */
export function toFeatures(data: GeoJSON | null | undefined): Feature[] {
  if (data === null || data === undefined || typeof data !== 'object') return []
  if (data.type === 'FeatureCollection') return Array.isArray(data.features) ? data.features : []
  if (data.type === 'Feature') return [data]
  return [{ type: 'Feature', geometry: data, properties: {} }]
}

/** The id `updateData` matches a feature by: its `id`, or the `promoteId` property. */
export function geoJsonFeatureId(feature: Feature, promoteId: string | undefined): GeoJsonFeatureId | undefined {
  const id = promoteId === undefined ? feature.id : (feature.properties?.[promoteId] as unknown)
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/** What applying a diff did: the new features, and the features that changed (before and after the change). */
export interface AppliedGeoJsonDiff {
  features: Feature[]
  /** Removed features, and updated ones as they were. */
  before: Feature[]
  /** Added features, and updated ones as they are now. */
  after: Feature[]
}

/**
 * The id index of a feature list a diff produced, so the next diff on that list costs O(changes) for the lookups,
 * not O(features). Taken (deleted) by the next diff: a list's index is never shared.
 */
const featureIndexes = new WeakMap<readonly Feature[], { promoteId: string | undefined; byId: Map<GeoJsonFeatureId, Feature> }>()

/**
 * Applies a diff to a list of features, without changing it (or its features). Throws an error that states the fix
 * when a feature has no id or an update names no feature.
 */
export function applyGeoJsonDiff(features: readonly Feature[], diff: GeoJsonSourceDiff, promoteId: string | undefined, sourceId: string): AppliedGeoJsonDiff {
  const missingId = `updateGeoJsonSourceData: source "${sourceId}" has a feature without an id; give every feature an \`id\` (or set \`promoteId\`) to update it by id, or call setData instead.`
  const before: Feature[] = []
  const after: Feature[] = []
  let byId: Map<GeoJsonFeatureId, Feature>
  if (diff.removeAll === true) {
    before.push(...features)
    byId = new Map()
  } else {
    const index = featureIndexes.get(features)
    featureIndexes.delete(features)
    if (index !== undefined && index.promoteId === promoteId) byId = index.byId
    else {
      byId = new Map()
      for (const feature of features) {
        const id = geoJsonFeatureId(feature, promoteId)
        if (id === undefined) throw new Error(missingId)
        byId.set(id, feature)
      }
    }
  }
  for (const id of diff.remove ?? []) {
    const removed = byId.get(id)
    if (removed === undefined) continue
    byId.delete(id)
    before.push(removed)
  }
  for (const feature of diff.add ?? []) {
    const id = geoJsonFeatureId(feature, promoteId)
    if (id === undefined) throw new Error(missingId)
    const replaced = byId.get(id)
    if (replaced !== undefined) before.push(replaced)
    byId.set(id, feature)
    after.push(feature)
  }
  for (const update of diff.update ?? []) {
    const current = byId.get(update.id)
    if (current === undefined) {
      throw new Error(`updateGeoJsonSourceData: source "${sourceId}" has no feature with id ${JSON.stringify(update.id)} to update; add it with \`add\` first.`)
    }
    let properties: GeoJsonProperties = update.removeAllProperties === true ? {} : { ...(current.properties ?? {}) }
    for (const name of update.removeProperties ?? []) delete properties[name]
    if (update.addOrUpdateProperties !== undefined) {
      properties = { ...properties }
      for (const { key, value } of update.addOrUpdateProperties) properties[key] = value
    }
    const next: Feature = { ...current, geometry: update.newGeometry ?? current.geometry, properties }
    byId.set(update.id, next)
    before.push(current)
    after.push(next)
  }
  const result = [...byId.values()]
  featureIndexes.set(result, { promoteId, byId })
  return { features: result, before, after }
}

/** The box around the features' coordinates, or null when they have none. Longitudes are not wrapped. */
export function geoJsonBounds(features: readonly Feature[]): GeoJsonBounds | null {
  const bounds: GeoJsonBounds = [Infinity, Infinity, -Infinity, -Infinity]
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return
    if (typeof coordinates[0] === 'number') {
      const [longitude, latitude] = coordinates as number[]
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
      bounds[0] = Math.min(bounds[0], longitude!)
      bounds[1] = Math.min(bounds[1], latitude!)
      bounds[2] = Math.max(bounds[2], longitude!)
      bounds[3] = Math.max(bounds[3], latitude!)
      return
    }
    for (const child of coordinates) visit(child)
  }
  const visitGeometry = (geometry: Geometry | null | undefined): void => {
    if (geometry === null || geometry === undefined) return
    if (geometry.type === 'GeometryCollection') for (const child of geometry.geometries) visitGeometry(child)
    else visit(geometry.coordinates)
  }
  for (const feature of features) visitGeometry(feature.geometry)
  return bounds[0] <= bounds[2] ? bounds : null
}

/** Above this many rectangles, a change redraws the one box around them all instead. */
const MAXIMUM_RECTANGLES = 32

/**
 * The Web Mercator rectangles that features cover, one or two per feature (two across the antimeridian), merged
 * into one box when there are many. Empty when the features have no coordinates.
 */
export function featureRectangles(features: readonly Feature[]): MercatorRectangle[] {
  const rectangles: MercatorRectangle[] = []
  for (const feature of features) {
    const bounds = geoJsonBounds([feature])
    if (bounds !== null) rectangles.push(...boundsRectangles(bounds))
  }
  if (rectangles.length <= MAXIMUM_RECTANGLES) return rectangles
  const all = geoJsonBounds(features)
  return all === null ? [] : boundsRectangles(all)
}

/** Rectangles of a longitude-latitude box; latitudes past the poles are clamped. */
export function boundsRectangles([west, south, east, north]: GeoJsonBounds): MercatorRectangle[] {
  const clampedSouth = Math.max(-90, Math.min(90, south))
  const clampedNorth = Math.max(-90, Math.min(90, north))
  // A box wider than the world spans every longitude; otherwise the span runs east from `west`.
  if (east - west >= 360) return boundsToMercatorRectangles({ westDegrees: -180, southDegrees: clampedSouth, eastDegrees: 180, northDegrees: clampedNorth })
  return boundsToMercatorRectangles({ westDegrees: west, southDegrees: clampedSouth, eastDegrees: west + (east - west), northDegrees: clampedNorth })
}

/** GeoJSON as a feature collection (a copy of the list, not of the features). */
export function toFeatureCollection(data: GeoJSON | null | undefined): FeatureCollection {
  return { type: 'FeatureCollection', features: [...toFeatures(data)] }
}
