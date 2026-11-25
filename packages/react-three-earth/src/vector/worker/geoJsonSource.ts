import { createExpression, featureFilter, type FeatureFilter, type StyleExpression } from '@maplibre/maplibre-gl-style-spec'
import type { Feature, GeoJSON } from 'geojson'
import GeoJSONVT, { type LegacyFeature } from 'geojson-vt'
import Supercluster from 'supercluster'

import { applyGeoJsonDiff, boundsRectangles, featureRectangles, geoJsonBounds, geoJsonFeatureId, toFeatures, type GeoJsonFeatureId, type GeoJsonSourceDiff } from './geoJsonData.js'
import type { MercatorRectangle } from './rectangles.js'
import type { Point } from './ShapeBuilder.js'
import { tileFeatureGeometry, type TileSourceSpecification, type VectorTileFeatureLike, type VectorTileLayerLike, type VectorTileLike, type VectorTileProvider, type VectorTileProviderFactory } from './tileProviders.js'
import { resolveUrl, type FetcherContext } from './tileSources.js'
import { TILE_EXTENT, TILE_SIZE_PIXELS, type GeoJsonSourceQuery } from './types.js'

/** The name of the one layer of a GeoJSON source's tiles (MapLibre's, so `['get', …]` code ports as it is). */
export const GEOJSON_LAYER = '_geojsonTileLayer'

/** A `geojson` style source, as MapLibre defines it. */
export interface GeoJsonSourceSpecification extends TileSourceSpecification {
  type: 'geojson'
  /** GeoJSON, or a URL (relative to the style) that answers GeoJSON. */
  data?: GeoJSON | string
  maxzoom?: number
  buffer?: number
  tolerance?: number
  cluster?: boolean
  clusterRadius?: number
  clusterMaxZoom?: number
  clusterMinPoints?: number
  /** `{ name: [operator or reduce expression, map expression] }`, as in MapLibre. */
  clusterProperties?: Record<string, [unknown, unknown]>
  lineMetrics?: boolean
  generateId?: boolean
  promoteId?: string
  filter?: unknown
  /**
   * Ids of features left out of the tiles while they stay in the data (an editor draws them itself meanwhile).
   * An earthkit runtime extension, not in MapLibre's specification: `GeoJsonSource.setHiddenFeatureIds` sets it.
   */
  hiddenFeatureIds?: GeoJsonFeatureId[]
}

/** Map pixels per tile unit: GeoJSON options in pixels are multiplied by this. */
const UNITS_PER_PIXEL = TILE_EXTENT / TILE_SIZE_PIXELS

/** A change of a GeoJSON source's data: where its tiles changed. */
export interface GeoJsonDataChange {
  /** Areas whose tiles must be processed again; null for everywhere. */
  rectangles: MercatorRectangle[] | null
  /** How far beyond a tile its data reaches (the tile buffer), in tiles: widens `rectangles` per zoom. */
  marginTiles: number
}

/** The options of a GeoJSON source, with MapLibre's defaults. */
interface ResolvedOptions {
  maximumZoom: number
  bufferPixels: number
  tolerancePixels: number
  cluster: boolean
  clusterRadiusPixels: number
  clusterMaximumZoom: number
  clusterMinimumPoints: number
  clusterProperties: Record<string, [unknown, unknown]> | undefined
  lineMetrics: boolean
  generateId: boolean
  promoteId: string | undefined
  filter: unknown
}

function resolveOptions(source: GeoJsonSourceSpecification): ResolvedOptions {
  const maximumZoom = Math.min(Math.max(source.maxzoom ?? 18, 0), 24)
  return {
    maximumZoom,
    bufferPixels: source.buffer ?? 128,
    tolerancePixels: source.tolerance ?? 0.375,
    cluster: source.cluster === true,
    clusterRadiusPixels: source.clusterRadius ?? 50,
    clusterMaximumZoom: Math.min(source.clusterMaxZoom ?? maximumZoom - 1, maximumZoom - 1),
    clusterMinimumPoints: Math.max(2, source.clusterMinPoints ?? 2),
    clusterProperties: source.clusterProperties,
    lineMetrics: source.lineMetrics === true,
    generateId: source.generateId === true,
    promoteId: typeof source.promoteId === 'string' ? source.promoteId : undefined,
    filter: source.filter,
  }
}

/** The tile index of one data set: geojson-vt for shapes, supercluster for clustered points. */
interface TileIndex {
  getTile(z: number, x: number, y: number): { features: LegacyFeature[] } | null
}

/** A geojson-vt cut of some features: its tile index, and the features in the order it numbered them (`generateId`). */
interface FeatureCut {
  index: TileIndex
  drawn: readonly Feature[]
}

/** A tile feature, with the id its tile gives it. */
interface TileEntry {
  feature: LegacyFeature
  id: unknown
}

/**
 * `updateData` cuts only the changed features, in a second index over the first; past this share of the data (and
 * `MINIMUM_REBUILD_FEATURES`), the whole data is cut again and the second index starts empty.
 */
const OVERLAY_REBUILD_SHARE = 1 / 8
const MINIMUM_REBUILD_FEATURES = 256

/**
 * A GeoJSON style source in the vector tile worker. Tiles the data with geojson-vt (and clusters points with
 * supercluster when `cluster` is on), as MapLibre does, and hands the style processor tiles shaped like decoded
 * vector tiles, with one layer.
 *
 * `setData` and `updateData` replace the data (an object, or a URL fetched through the style's request
 * rewriting) and answer the areas whose tiles changed, so only those regions are redrawn.
 */
export class GeoJsonTileSource implements VectorTileProvider {
  attribution?: string
  readonly minimumZoom = 0
  readonly maximumZoom: number
  readonly singleLayer = GEOJSON_LAYER
  /** Settles once every `setData` and `updateData` call so far has applied (or failed). */
  ready: Promise<void> = Promise.resolve()
  protected readonly options: ResolvedOptions
  /** Every feature of the data, before the source `filter`. */
  protected features: Feature[] = []
  /** Clustered points: supercluster over every point, made again on each change (points cluster fast). */
  protected clusters: Supercluster | null = null
  /** Shapes: the cut of the whole data at the last `setData` (or rebuild). */
  protected base: FeatureCut | null = null
  /** Features added or changed by `updateData` since, by id: cut on their own (`overlayCut`), drawn over the base. */
  protected readonly overlay = new Map<GeoJsonFeatureId, Feature>()
  protected overlayCut: FeatureCut | null = null
  /** Ids whose version in the base is out of date (changed or removed since): the base's tiles leave them out. */
  protected readonly superseded = new Set<GeoJsonFeatureId>()
  protected readonly filter: FeatureFilter | null
  /** Ids of the features left out of the tiles (`hiddenFeatureIds`), still in the data. */
  protected hidden: ReadonlySet<GeoJsonFeatureId>
  /** With clusters, the ids tiles carry for the hidden points: their own, or with `generateId` their index among the points. */
  protected hiddenTileIds: ReadonlySet<unknown> = new Set()

  protected constructor(
    protected readonly sourceId: string,
    source: GeoJsonSourceSpecification,
    protected readonly context: FetcherContext,
  ) {
    this.options = resolveOptions(source)
    this.maximumZoom = this.options.maximumZoom
    if (typeof source.attribution === 'string') this.attribution = source.attribution
    this.filter = source.filter === undefined ? null : compileFilter(source.filter, sourceId)
    this.hidden = new Set(source.hiddenFeatureIds ?? [])
    this.hiddenTileIds = this.hidden
    if (this.options.cluster && this.options.clusterProperties !== undefined) compileClusterProperties(this.options.clusterProperties, sourceId) // throws early
  }

  /** Loads the source's `data` (fetching a URL); throws an error that states the fix when it cannot. */
  static async create(sourceId: string, source: GeoJsonSourceSpecification, context: FetcherContext): Promise<GeoJsonTileSource> {
    const tileSource = new GeoJsonTileSource(sourceId, source, context)
    await tileSource.setData(source.data ?? { type: 'FeatureCollection', features: [] })
    return tileSource
  }

  /**
   * How far a tile's data reaches past its edges, in tiles: the buffer, or for clusters the cluster radius
   * (supercluster pads each tile by it, whatever the buffer).
   */
  get marginTiles(): number {
    const { bufferPixels, cluster, clusterRadiusPixels } = this.options
    return (cluster ? Math.max(bufferPixels, clusterRadiusPixels) : bufferPixels) / TILE_SIZE_PIXELS
  }

  /**
   * Replaces the data: GeoJSON, or a URL answering GeoJSON (relative to the style). Answers where tiles changed:
   * where the old and the new data lie. A URL that fails keeps the previous data and rejects. Calls apply in order.
   */
  setData(data: GeoJSON | string): Promise<GeoJsonDataChange> {
    return this.enqueue(async () => {
      const loaded = typeof data === 'string' ? await this.fetchData(data) : data
      const before = this.drawnFeatures(this.features)
      this.buildIndex(toFeatures(loaded))
      // The old and the new data, one box each: clusters never leave the box of their points.
      return { rectangles: [...boxOf(before), ...boxOf(this.drawnFeatures(this.features))], marginTiles: this.marginTiles }
    })
  }

  /**
   * Applies a diff (`updateData`). Answers where tiles changed: around the changed features, or where the old and
   * new data lie when points are clustered (a cluster moves with any of its points).
   */
  updateData(diff: GeoJsonSourceDiff): Promise<GeoJsonDataChange> {
    return this.enqueue(async () => {
      if (this.options.cluster) {
        const before = this.drawnFeatures(this.features)
        this.buildIndex(applyGeoJsonDiff(this.features, diff, this.options.promoteId, this.sourceId).features)
        return { rectangles: [...boxOf(before), ...boxOf(this.drawnFeatures(this.features))], marginTiles: this.marginTiles }
      }
      const applied = applyGeoJsonDiff(this.features, diff, this.options.promoteId, this.sourceId)
      this.features = applied.features
      this.applyToOverlay(applied.before, applied.after, diff.removeAll === true)
      return { rectangles: featureRectangles([...this.drawnFeatures(applied.before), ...this.drawnFeatures(applied.after)]), marginTiles: this.marginTiles }
    })
  }

  /**
   * Cuts the changed features on their own, over the base, whose versions of them are left out from now on: an edit
   * costs the size of the edits so far, not of the data. Past a share of the data, everything is cut again.
   */
  protected applyToOverlay(before: readonly Feature[], after: readonly Feature[], removedAll: boolean): void {
    const promoteId = this.options.promoteId
    // Changes before additions: a replaced feature is removed, then added back as it is now.
    for (const feature of before) {
      const id = geoJsonFeatureId(feature, promoteId)
      if (id === undefined) continue
      this.superseded.add(id)
      this.overlay.delete(id)
    }
    for (const feature of after) {
      const id = geoJsonFeatureId(feature, promoteId)
      if (id === undefined) continue
      this.superseded.add(id)
      this.overlay.set(id, feature)
    }
    const baseSize = this.base?.drawn.length ?? 0
    if (removedAll || this.overlay.size > Math.max(MINIMUM_REBUILD_FEATURES, baseSize * OVERLAY_REBUILD_SHARE)) {
      this.buildIndex(this.features)
      return
    }
    const drawn = this.drawnFeatures([...this.overlay.values()])
    this.overlayCut = drawn.length === 0 ? null : { index: this.cut(drawn), drawn }
  }

  /**
   * Leaves the features of these ids out of the tiles (replacing the previous ids), keeping them in the data: no
   * tiling again, only the tiles around the features that appear or disappear are processed again (around the whole
   * data when points are clustered; hidden points still count in their clusters, and clusters are never hidden). Applies in order with data changes.
   */
  setHiddenFeatures(ids: readonly GeoJsonFeatureId[]): Promise<GeoJsonDataChange> {
    return this.enqueue(async () => {
      const next = new Set(ids)
      const changed = new Set<GeoJsonFeatureId>()
      for (const id of next) if (!this.hidden.has(id)) changed.add(id)
      for (const id of this.hidden) if (!next.has(id)) changed.add(id)
      this.hidden = next
      this.hiddenTileIds = this.tileIdsOf(next)
      if (changed.size === 0) return { rectangles: [], marginTiles: this.marginTiles }
      if (this.options.cluster) return { rectangles: boxOf(this.drawnFeatures(this.features)), marginTiles: this.marginTiles }
      const promoteId = this.options.promoteId
      const touched = this.features.filter(feature => {
        const id = geoJsonFeatureId(feature, promoteId)
        return id !== undefined && changed.has(id)
      })
      return { rectangles: featureRectangles(this.drawnFeatures(touched)), marginTiles: this.marginTiles }
    })
  }

  /** Runs data changes one after the other, in the order called. */
  protected enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.ready.then(task)
    this.ready = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async loadTile(x: number, y: number, z: number): Promise<VectorTileLike | null> {
    await this.ready
    const entries: TileEntry[] = []
    if (this.clusters !== null) {
      for (const feature of this.clusters.getTile(z, x, y)?.features ?? []) {
        if (this.hiddenTileIds.size === 0 || !this.isHiddenPoint(feature as LegacyFeature)) entries.push({ feature: feature as LegacyFeature, id: (feature as LegacyFeature).id })
      }
    } else {
      // The base without its out-of-date and hidden features, then the changed features over it.
      const left = (id: GeoJsonFeatureId | undefined) => id === undefined || (!this.superseded.has(id) && !this.hidden.has(id))
      const base = this.base
      const overlay = this.overlayCut
      for (const feature of base?.index.getTile(z, x, y)?.features ?? []) if (left(this.originalId(feature, base!))) entries.push({ feature, id: feature.id })
      for (const feature of overlay?.index.getTile(z, x, y)?.features ?? []) {
        // Generated ids follow on from the base's, so feature-state keys stay distinct.
        if (!this.hidden.has(this.originalId(feature, overlay!)!)) entries.push({ feature, id: this.options.generateId ? (base?.drawn.length ?? 0) + (feature.id as number) : feature.id })
      }
    }
    return entries.length === 0 ? null : new GeoJsonTile(entries)
  }

  /** The id of a cut's tile feature in the data: its `id` or `promoteId` property, or with `generateId` its feature's. */
  protected originalId(feature: LegacyFeature, cut: FeatureCut): GeoJsonFeatureId | undefined {
    const promoteId = this.options.promoteId
    if (this.options.generateId) {
      const source = cut.drawn[feature.id as number]
      return source === undefined ? undefined : geoJsonFeatureId(source, promoteId)
    }
    const id = promoteId === undefined ? feature.id : (feature.tags as Record<string, unknown> | null)?.[promoteId]
    return typeof id === 'string' || typeof id === 'number' ? id : undefined
  }

  /** Whether a clustered tile feature is a hidden point (`hiddenFeatureIds`). Clusters never are. */
  protected isHiddenPoint(feature: LegacyFeature): boolean {
    // A cluster's id is supercluster's own number, which may equal a hidden point's id.
    if ((feature.tags as Record<string, unknown> | null)?.['cluster'] === true) return false
    const promoteId = this.options.promoteId
    const id = promoteId === undefined || this.options.generateId ? feature.id : (feature.tags as Record<string, unknown> | null)?.[promoteId]
    return id !== undefined && id !== null && this.hiddenTileIds.has(id)
  }

  /**
   * With clusters, the ids tiles carry for points of these ids: the same, or with `generateId` their index among the
   * clustered points (a MultiPoint's points each).
   */
  protected tileIdsOf(ids: ReadonlySet<GeoJsonFeatureId>): ReadonlySet<unknown> {
    if (ids.size === 0 || !this.options.generateId || !this.options.cluster) return ids
    const promoteId = this.options.promoteId
    const indexes = new Set<number>()
    let index = 0
    for (const feature of this.drawnFeatures(this.features)) {
      const count = clusterablePoints(feature).length
      const id = geoJsonFeatureId(feature, promoteId)
      if (id !== undefined && ids.has(id)) for (let each = 0; each < count; each++) indexes.add(index + each)
      index += count
    }
    return indexes
  }

  /** Answers a cluster query (`getClusterExpansionZoom`, `getClusterChildren`, `getClusterLeaves`). */
  async query(query: GeoJsonSourceQuery): Promise<unknown> {
    await this.ready
    const clusters = this.clusters
    if (clusters === null) {
      throw new Error(`GeoJsonSource: source "${this.sourceId}" does not cluster its points; set \`cluster: true\` on it to query clusters.`)
    }
    try {
      switch (query.kind) {
        case 'clusterExpansionZoom':
          return clusters.getClusterExpansionZoom(query.clusterId)
        case 'clusterChildren':
          return clusters.getChildren(query.clusterId)
        case 'clusterLeaves':
          return clusters.getLeaves(query.clusterId, query.limit, query.offset)
      }
    } catch (error) {
      throw new Error(`GeoJsonSource: source "${this.sourceId}" has no cluster ${query.clusterId} (${(error as Error).message}); use a \`cluster_id\` of a feature drawn now.`)
    }
  }

  protected async fetchData(url: string): Promise<GeoJSON> {
    const absolute = resolveUrl(url, this.context.baseUrl)
    const response = await this.context.fetch(absolute, { headers: this.context.requestHeaders }, 'Source')
    if (!response.ok) throw new Error(`GeoJsonSource: ${absolute} answered ${response.status}.`)
    return (await response.json()) as GeoJSON
  }

  /** The features the source `filter` keeps (all of them without one). */
  protected drawnFeatures(features: readonly Feature[]): Feature[] {
    const filter = this.filter
    if (filter === null) return [...features]
    return features.filter(feature => {
      const id = feature.id
      const styleFeature = { type: feature.geometry?.type ?? 'Unknown', properties: feature.properties ?? {}, ...(id !== undefined ? { id } : {}) }
      return filter.filter({ zoom: 0 }, styleFeature as never) === true
    })
  }

  /** Keeps every feature and tiles those the filter keeps, all over again. */
  protected buildIndex(features: Feature[]): void {
    this.features = features
    this.overlay.clear()
    this.overlayCut = null
    this.superseded.clear()
    const drawn = this.drawnFeatures(features)
    const options = this.options
    if (options.cluster) {
      // With `generateId`, a point's tile id is its index, which the new data may change.
      if (options.generateId) this.hiddenTileIds = this.tileIdsOf(this.hidden)
      const points = drawn.flatMap(clusterablePoints)
      const clusters = new Supercluster({
        minZoom: 0,
        maxZoom: Math.max(options.clusterMaximumZoom, 0),
        minPoints: options.clusterMinimumPoints,
        radius: options.clusterRadiusPixels * UNITS_PER_PIXEL,
        extent: TILE_EXTENT,
        generateId: options.generateId,
        ...(options.clusterProperties !== undefined ? compileClusterProperties(options.clusterProperties, this.sourceId) : {}),
      }).load(points as never)
      this.clusters = clusters
      return
    }
    this.clusters = null
    this.base = { index: this.cut(drawn), drawn }
  }

  /** A geojson-vt index over features, with the source's options. */
  protected cut(drawn: Feature[]): TileIndex {
    const options = this.options
    return new GeoJSONVT(
      { type: 'FeatureCollection', features: drawn },
      {
        maxZoom: options.maximumZoom,
        buffer: options.bufferPixels * UNITS_PER_PIXEL,
        tolerance: options.tolerancePixels * UNITS_PER_PIXEL,
        extent: TILE_EXTENT,
        lineMetrics: options.lineMetrics,
        generateId: options.generateId,
      },
    ) as TileIndex
  }
}

/** Creates the provider of a `geojson` style source. */
export const createGeoJsonTileProvider: VectorTileProviderFactory = (source, context, sourceId) =>
  GeoJsonTileSource.create(sourceId, source as GeoJsonSourceSpecification, context)

/** The points supercluster indexes: a Point, or each point of a MultiPoint (with the feature's id and properties). */
function clusterablePoints(feature: Feature): Feature[] {
  const geometry = feature.geometry
  if (geometry?.type === 'Point') return [feature]
  if (geometry?.type !== 'MultiPoint') return []
  return geometry.coordinates.map(coordinates => ({ ...feature, geometry: { type: 'Point', coordinates } }))
}

/** One rectangle (two across the antimeridian) around all the features; none when they have no coordinates. */
function boxOf(features: readonly Feature[]): MercatorRectangle[] {
  const bounds = geoJsonBounds(features)
  return bounds === null ? [] : boundsRectangles(bounds)
}

function compileFilter(filter: unknown, sourceId: string): FeatureFilter {
  try {
    return featureFilter(filter as never, `sources.${sourceId}.filter`)
  } catch (error) {
    throw new Error(`GeoJsonSource: the \`filter\` of source "${sourceId}" does not compile (${(error as Error).message}); write it as a MapLibre filter expression.`)
  }
}

/**
 * Supercluster's `map` and `reduce` from MapLibre's `clusterProperties`: `{ name: [operator, map expression] }`,
 * where the operator is an expression name (`'+'`, `'max'`…) applied to `['accumulated']` and `['get', name]`,
 * or a whole reduce expression.
 */
function compileClusterProperties(clusterProperties: Record<string, [unknown, unknown]>, sourceId: string) {
  const names = Object.keys(clusterProperties)
  const mapExpressions = new Map<string, StyleExpression>()
  const reduceExpressions = new Map<string, StyleExpression>()
  const compile = (expression: unknown, name: string, role: string): StyleExpression => {
    const result = createExpression(expression, `sources.${sourceId}.clusterProperties.${name}`)
    if (result.result === 'error') {
      throw new Error(`GeoJsonSource: the ${role} expression of cluster property "${name}" on source "${sourceId}" does not compile (${result.value.map(error => error.message).join('; ')}).`)
    }
    return result.value
  }
  for (const name of names) {
    const entry = clusterProperties[name]
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`GeoJsonSource: cluster property "${name}" on source "${sourceId}" must be [operator, map expression], for example ['+', ['get', 'count']].`)
    }
    const [operator, map] = entry
    mapExpressions.set(name, compile(map, name, 'map'))
    reduceExpressions.set(name, compile(typeof operator === 'string' ? [operator, ['accumulated'], ['get', name]] : operator, name, 'reduce'))
  }
  const globals: { zoom: number; accumulated: unknown } = { zoom: 0, accumulated: null }
  const feature: { properties: Record<string, unknown> } = { properties: {} }
  return {
    map: (properties: Record<string, unknown>) => {
      feature.properties = properties
      const mapped: Record<string, unknown> = {}
      for (const name of names) mapped[name] = mapExpressions.get(name)!.evaluate(globals as never, feature as never)
      return mapped
    },
    reduce: (accumulated: Record<string, unknown>, properties: Readonly<Record<string, unknown>>) => {
      feature.properties = properties as Record<string, unknown>
      for (const name of names) {
        globals.accumulated = accumulated[name]
        accumulated[name] = reduceExpressions.get(name)!.evaluate(globals as never, feature as never)
      }
    },
  }
}

/** A geojson-vt or supercluster tile, shaped like a decoded vector tile with one layer. */
class GeoJsonTile implements VectorTileLike {
  readonly layers: Record<string, VectorTileLayerLike>
  constructor(entries: TileEntry[]) {
    this.layers = {
      [GEOJSON_LAYER]: {
        extent: TILE_EXTENT,
        length: entries.length,
        feature: index => toTileFeature(entries[index]!.feature, entries[index]!.id),
      },
    }
  }
}

function toTileFeature(feature: LegacyFeature, id: unknown): VectorTileFeatureLike {
  const properties = (feature.tags ?? {}) as Record<string, number | string | boolean>
  const loadGeometry = (): Point[][] =>
    feature.type === 1 ? feature.geometry.map(([x, y]) => [{ x, y }]) : feature.geometry.map(ring => ring.map(([x, y]) => ({ x, y })))
  return {
    type: feature.type,
    id: id as LegacyFeature['id'],
    properties,
    loadGeometry,
    bbox: () => {
      let [minimumX, minimumY, maximumX, maximumY] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const ring of loadGeometry()) {
        for (const { x, y } of ring) {
          minimumX = Math.min(minimumX, x)
          minimumY = Math.min(minimumY, y)
          maximumX = Math.max(maximumX, x)
          maximumY = Math.max(maximumY, y)
        }
      }
      return [minimumX, minimumY, maximumX, maximumY]
    },
    toGeoJSON: (x, y, z) => ({ geometry: tileFeatureGeometry(feature.type, loadGeometry(), TILE_EXTENT, x, y, z) }),
  }
}
