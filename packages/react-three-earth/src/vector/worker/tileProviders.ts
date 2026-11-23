import { classifyRings } from '@maplibre/maplibre-gl-style-spec'
import { VectorTile } from '@mapbox/vector-tile'
import type { Geometry } from 'geojson'
import Pbf from 'pbf'

import type { Point } from './ShapeBuilder.js'
import { createVectorTileFetcher, type FetcherContext, type VectorSourceSpecification } from './tileSources.js'

/** A feature as the style processor reads it: `@mapbox/vector-tile`'s shape, which GeoJSON tiles imitate. */
export interface VectorTileFeatureLike {
  /** 1 point, 2 line, 3 polygon (0: unknown, skipped by every layer type). */
  type: 0 | 1 | 2 | 3
  id?: number | string | undefined
  properties: Record<string, number | string | boolean>
  /** Rings (or lines, or one ring per point) in the layer's `extent` units, y down. */
  loadGeometry(): Point[][]
  /** The box around the geometry, in the layer's `extent` units: minimum x, minimum y, maximum x, maximum y. */
  bbox(): number[]
  /** The feature in longitude-latitude, clipped to the tile (with its buffer), as `@mapbox/vector-tile` answers it. */
  toGeoJSON(x: number, y: number, z: number): { geometry: Geometry }
}

export interface VectorTileLayerLike {
  extent: number
  length: number
  feature(index: number): VectorTileFeatureLike
}

/** A decoded tile: its layers by name. */
export interface VectorTileLike {
  layers: Record<string, VectorTileLayerLike>
}

/**
 * The tiles of one style source, decoded: vector tiles fetched from a server, or GeoJSON tiled in the worker.
 * The style processor reads every source through this interface, so a new source type only adds a provider.
 */
export interface VectorTileProvider {
  /** The source's credit, from the style or the source's own metadata. */
  attribution?: string
  readonly minimumZoom: number
  /** The deepest data level: deeper zooms are drawn from it (overzoomed). */
  readonly maximumZoom: number
  /**
   * The one layer every style layer of the source reads, whatever its `source-layer` (GeoJSON has a single layer).
   * Undefined for sources whose style layers name their `source-layer`.
   */
  readonly singleLayer?: string
  /** Null for a tile with no data. `revalidate`: the data may have changed on the server (see `invalidate`). */
  loadTile(x: number, y: number, z: number, signal?: AbortSignal, revalidate?: boolean): Promise<VectorTileLike | null>
  /** Forgets what the provider caches itself, after the data changed on the server. */
  invalidate?(): void
}

/** The parts of a style source every provider reads. */
export interface TileSourceSpecification {
  type: string
  attribution?: string
  [key: string]: unknown
}

/** Creates the provider of a style source; throws an error that states the fix when the source cannot load. */
export type VectorTileProviderFactory = (source: TileSourceSpecification, context: FetcherContext, sourceId: string) => Promise<VectorTileProvider>

/** Vector tiles (XYZ, TileJSON or PMTiles), fetched and decoded. */
export const createVectorTileProvider: VectorTileProviderFactory = async (source, context) => {
  const fetcher = await createVectorTileFetcher(source as unknown as VectorSourceSpecification, context)
  const provider: VectorTileProvider = {
    get attribution() {
      return fetcher.attribution
    },
    minimumZoom: fetcher.minimumZoom,
    maximumZoom: fetcher.maximumZoom,
    loadTile: async (x, y, z, signal, revalidate) => {
      const bytes = await fetcher.fetchTile(x, y, z, signal, revalidate)
      return bytes === null ? null : (new VectorTile(new Pbf(bytes)) as unknown as VectorTileLike)
    },
    invalidate: () => fetcher.invalidate?.(),
  }
  return provider
}

/**
 * A feature's geometry in longitude-latitude, from its tile geometry: `@mapbox/vector-tile`'s `toGeoJSON`, for
 * features that are not decoded vector tile features (GeoJSON tiles).
 */
export function tileFeatureGeometry(type: number, rings: Point[][], extent: number, x: number, y: number, z: number): Geometry {
  const size = extent * 2 ** z
  const toLongitudeLatitude = ({ x: column, y: row }: Point): [number, number] => {
    const longitude = ((column + extent * x) * 360) / size - 180
    const mercatorY = 180 - ((row + extent * y) * 360) / size
    return [longitude, (360 / Math.PI) * Math.atan(Math.exp((mercatorY * Math.PI) / 180)) - 90]
  }
  if (type === 1) {
    const points = rings.map(ring => toLongitudeLatitude(ring[0]!))
    return points.length === 1 ? { type: 'Point', coordinates: points[0]! } : { type: 'MultiPoint', coordinates: points }
  }
  if (type === 2) {
    const lines = rings.map(line => line.map(toLongitudeLatitude))
    return lines.length === 1 ? { type: 'LineString', coordinates: lines[0]! } : { type: 'MultiLineString', coordinates: lines }
  }
  const polygons = classifyRings(rings as never, 0) as unknown as Point[][][]
  const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(toLongitudeLatitude)))
  return coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0]! } : { type: 'MultiPolygon', coordinates }
}
