import type { Feature, GeoJSON, Point } from 'geojson'

import type { MapStyle } from './MapStyle.js'
import { applyGeoJsonDiff, toFeatures, type GeoJsonSourceDiff } from './worker/geoJsonData.js'
import type { GeoJsonSourceSpecification } from './worker/geoJsonSource.js'

/**
 * A GeoJSON source, in MapLibre's terms with full names and units. Every option but `data` matches a `geojson` style
 * source property (`clusterRadiusPixels` is `clusterRadius`, and so on).
 */
export interface GeoJsonSourceOptions {
  /** The style source id that layers read (`source` on a layer). An existing source of this id is replaced. */
  id: string
  /** GeoJSON (a FeatureCollection, a Feature or a geometry), or a URL answering GeoJSON (the app's URL). */
  data: GeoJSON | string
  /** Deepest zoom tiles are cut at; deeper zooms draw from it. Default: 18. */
  maximumZoom?: number
  /** Credit shown in the attribution. */
  attribution?: string
  /** How far a tile's data reaches past its edges, in pixels; raise it for wide lines or large circles. Default: 128. */
  bufferPixels?: number
  /** Simplification tolerance, in pixels; higher is simpler and faster. Default: 0.375. */
  tolerancePixels?: number
  /** Groups nearby points into clusters, with `point_count` and `cluster_id` properties. Default: false. */
  cluster?: boolean
  /** Radius of each cluster, in pixels. Default: 50. */
  clusterRadiusPixels?: number
  /** Deepest zoom points are clustered at. Default: one less than `maximumZoom`. */
  clusterMaximumZoom?: number
  /** Fewest points a cluster gathers. Default: 2. */
  clusterMinimumPoints?: number
  /**
   * Properties computed over each cluster's points, as in MapLibre: `{ name: [operator, map expression] }`.
   * @example { totalSeats: ['+', ['get', 'seats']] }
   */
  clusterProperties?: Record<string, [unknown, unknown]>
  /** Tracks progress along lines, for `line-gradient`. Default: false. */
  lineMetrics?: boolean
  /** Gives features without an id one (their index), for feature-state. Default: false. */
  generateId?: boolean
  /** A property to use as the feature id (feature-state, `updateData`). */
  promoteId?: string
  /** A MapLibre filter expression: only matching features are tiled. */
  filter?: unknown
}

/** What a `GeoJsonSource` is added to: a `MapStyleSource`. */
export interface GeoJsonSourceHost {
  getMapStyle(): MapStyle
}

/** Options whose change replaces the source (tiles are cut again); `data` alone is sent with `setData`. */
const OPTION_NAMES = [
  'maximumZoom',
  'attribution',
  'bufferPixels',
  'tolerancePixels',
  'cluster',
  'clusterRadiusPixels',
  'clusterMaximumZoom',
  'clusterMinimumPoints',
  'clusterProperties',
  'lineMetrics',
  'generateId',
  'promoteId',
  'filter',
] as const satisfies ReadonlyArray<keyof GeoJsonSourceOptions>

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * GeoJSON data the app owns, drawn by a `MapStyleSource`'s style: routes, points, user data. Tiled in the vector tile
 * worker (geojson-vt), with points optionally clustered (supercluster), as in MapLibre. Layers read it by its `id`.
 *
 * `setData` replaces the data, `updateData` changes features by id; either redraws only the regions where the data
 * changed. Cluster queries (`getClusterExpansionZoom`, `getClusterChildren`, `getClusterLeaves`) answer from the
 * worker. The source survives `setStyle`. `<GeoJsonSource>` in React wraps it.
 *
 * @example
 * const points = new GeoJsonSource({ id: 'stations', data: '/stations.geojson', cluster: true })
 * mapStyleSource.addGeoJsonSource(points)
 * mapStyleSource.addLayer({ id: 'clusters', type: 'circle', source: 'stations', filter: ['has', 'point_count'], paint: { 'circle-radius': 18 } })
 */
export class GeoJsonSource {
  readonly id: string
  /** The options, with `data` as it is now (`updateData` changes applied). */
  protected options: GeoJsonSourceOptions
  /** The `data` the app last passed (constructor, `update`, `setData`): `update` compares the next one with it. */
  protected suppliedData: GeoJSON | string
  protected style: MapStyle | null = null

  constructor(options: GeoJsonSourceOptions) {
    this.id = options.id
    this.options = { ...options }
    this.suppliedData = options.data
  }

  /** The data as it is now, with `updateData` changes applied (a URL stays a URL). */
  get data(): GeoJSON | string {
    return this.options.data
  }

  /** The MapLibre `geojson` source object. */
  toSpecification(): GeoJsonSourceSpecification {
    const { maximumZoom, attribution, bufferPixels, tolerancePixels, cluster, clusterRadiusPixels, clusterMaximumZoom, clusterMinimumPoints, clusterProperties, lineMetrics, generateId, promoteId, filter } = this.options
    const optional = {
      maxzoom: maximumZoom,
      attribution,
      buffer: bufferPixels,
      tolerance: tolerancePixels,
      cluster,
      clusterRadius: clusterRadiusPixels,
      clusterMaxZoom: clusterMaximumZoom,
      clusterMinPoints: clusterMinimumPoints,
      clusterProperties,
      lineMetrics,
      generateId,
      promoteId,
      filter,
    }
    return { type: 'geojson', data: this.data, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) }
  }

  /** Adds the source to a `MapStyleSource`'s style, replacing a source of the same id (its layers keep reading it). */
  addTo(host: GeoJsonSourceHost): this {
    if (this.style !== null) throw new Error(`GeoJsonSource "${this.id}" is already added; remove() it first.`)
    const style = host.getMapStyle()
    style.setSource(this.id, this.toSpecification())
    style.manageSource(this)
    this.style = style
    return this
  }

  /**
   * Removes the source from its style once no layer reads it: layers removed in the same task (React children
   * unmounting) are waited for. A source still read by the style's own layers stays, with its last data.
   */
  remove(): void {
    const style = this.style
    if (style === null) return
    this.style = null
    style.unmanageSource(this)
    const removeIfUnread = (): void => {
      // Added again meanwhile (React StrictMode), or replaced by another GeoJsonSource of the same id
      if (this.style !== null || style.isSourceManaged(this.id)) return
      // Still loading (or a setStyle pending): the queued setSource applies first, so check again then.
      if (!style.isSettled) {
        void style.whenSettled().then(removeIfUnread)
        return
      }
      if (style.hasSource(this.id) && style.getLayerIdsReadingSource(this.id).length === 0) style.removeSource(this.id)
    }
    queueMicrotask(removeIfUnread)
  }

  /**
   * Applies new options: a new `data` object (compared by identity) is sent with `setData`; any other change cuts
   * the tiles again. The id cannot change: make another source.
   */
  update(next: GeoJsonSourceOptions): void {
    if (next.id !== this.id) throw new Error(`GeoJsonSource.update: the id cannot change ("${this.id}" to "${next.id}"); create another GeoJsonSource.`)
    const previous = this.options
    const optionsChanged = OPTION_NAMES.some(name => !same(previous[name], next[name]))
    const dataChanged = this.suppliedData !== next.data
    if (!optionsChanged && !dataChanged) return
    // Same data object: keep the `updateData` changes applied since.
    this.options = dataChanged ? { ...next } : { ...next, data: previous.data }
    this.suppliedData = next.data
    if (this.style === null) return
    if (optionsChanged) this.style.setSource(this.id, this.toSpecification())
    else this.style.setGeoJsonSourceData(this.id, next.data)
  }

  /**
   * Replaces the data: GeoJSON or a URL. Keep the object unchanged afterwards (pass a new one for the next change).
   * Only the regions where the old or the new data lie are redrawn.
   */
  setData(data: GeoJSON | string): void {
    this.options = { ...this.options, data }
    this.suppliedData = data
    this.style?.setGeoJsonSourceData(this.id, data)
  }

  /**
   * Changes features by id without sending the whole data again (MapLibre's `updateData`): cheap enough for moving
   * vehicles. Every feature needs an id (`id`, or the `promoteId` property). Needs the data as an object, not a URL.
   * @example source.updateData({ update: [{ id: 'bus-12', newGeometry: { type: 'Point', coordinates: [2.35, 48.86] } }] })
   */
  updateData(diff: GeoJsonSourceDiff): void {
    const { data, promoteId } = this.options
    if (typeof data === 'string') {
      throw new Error(`GeoJsonSource.updateData: source "${this.id}" loads its data from a URL; fetch it in the app and pass the object with setData, then update it by id.`)
    }
    // Applied here first, so a diff naming no feature throws to the caller and changes nothing.
    const { features } = applyGeoJsonDiff(toFeatures(data), diff, promoteId, this.id)
    this.options = { ...this.options, data: { type: 'FeatureCollection', features } }
    this.style?.updateGeoJsonSourceData(this.id, diff)
  }

  /** The zoom at which a cluster splits into several features: zoom there on a cluster click. */
  async getClusterExpansionZoom(clusterId: number): Promise<number> {
    return (await this.requireStyle('getClusterExpansionZoom').querySource(this.id, { kind: 'clusterExpansionZoom', clusterId })) as number
  }

  /** The children of a cluster one zoom deeper: clusters and points. */
  async getClusterChildren(clusterId: number): Promise<Array<Feature<Point>>> {
    return (await this.requireStyle('getClusterChildren').querySource(this.id, { kind: 'clusterChildren', clusterId })) as Array<Feature<Point>>
  }

  /** The points of a cluster, `limit` of them (default 10; `Infinity` for all) from `offset`. */
  async getClusterLeaves(clusterId: number, limit = 10, offset = 0): Promise<Array<Feature<Point>>> {
    return (await this.requireStyle('getClusterLeaves').querySource(this.id, { kind: 'clusterLeaves', clusterId, limit, offset })) as Array<Feature<Point>>
  }

  protected requireStyle(method: string): MapStyle {
    if (this.style === null) throw new Error(`GeoJsonSource.${method}: source "${this.id}" is not added to a MapStyleSource; call addTo(mapStyleSource) first.`)
    return this.style
  }
}
