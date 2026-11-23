import { createExpression, featureFilter, type FeatureFilter, type StyleExpression } from '@maplibre/maplibre-gl-style-spec'
import type { Feature, GeoJSON } from 'geojson'
import GeoJSONVT, { type LegacyFeature } from 'geojson-vt'
import Supercluster from 'supercluster'

import { applyGeoJsonDiff, boundsRectangles, featureRectangles, geoJsonBounds, toFeatures, type GeoJsonSourceDiff } from './geoJsonData.js'
import type { MercatorRectangle } from './rectangles.js'
import type { Point } from './ShapeBuilder.js'
import type { TileSourceSpecification, VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike, VectorTileProvider, VectorTileProviderFactory } from './tileProviders.js'
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
  protected index: TileIndex | null = null
  protected clusters: Supercluster | null = null
  protected readonly filter: FeatureFilter | null

  protected constructor(
    protected readonly sourceId: string,
    source: GeoJsonSourceSpecification,
    protected readonly context: FetcherContext,
  ) {
    this.options = resolveOptions(source)
    this.maximumZoom = this.options.maximumZoom
    if (typeof source.attribution === 'string') this.attribution = source.attribution
    this.filter = source.filter === undefined ? null : compileFilter(source.filter, sourceId)
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
      const before = this.drawnFeatures(this.features)
      const applied = applyGeoJsonDiff(this.features, diff, this.options.promoteId, this.sourceId)
      this.buildIndex(applied.features)
      const rectangles = this.options.cluster
        ? [...boxOf(before), ...boxOf(this.drawnFeatures(this.features))]
        : featureRectangles([...this.drawnFeatures(applied.before), ...this.drawnFeatures(applied.after)])
      return { rectangles, marginTiles: this.marginTiles }
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
    const tile = this.index?.getTile(z, x, y) ?? null
    return tile === null || tile.features.length === 0 ? null : new GeoJsonTile(tile.features)
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

  /** Keeps every feature and tiles those the filter keeps. */
  protected buildIndex(features: Feature[]): void {
    this.features = features
    const drawn = this.drawnFeatures(features)
    const options = this.options
    if (options.cluster) {
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
      this.index = clusters as unknown as TileIndex
      return
    }
    this.clusters = null
    this.index = new GeoJSONVT(
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
  constructor(features: LegacyFeature[]) {
    this.layers = {
      [GEOJSON_LAYER]: {
        extent: TILE_EXTENT,
        length: features.length,
        feature: index => toTileFeature(features[index]!),
      },
    }
  }
}

function toTileFeature(feature: LegacyFeature): VectorTileFeatureLike {
  const properties = (feature.tags ?? {}) as Record<string, number | string | boolean>
  return {
    type: feature.type,
    id: feature.id,
    properties,
    loadGeometry: (): Point[][] =>
      feature.type === 1 ? feature.geometry.map(([x, y]) => [{ x, y }]) : feature.geometry.map(ring => ring.map(([x, y]) => ({ x, y }))),
  }
}
