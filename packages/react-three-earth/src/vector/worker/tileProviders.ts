import { VectorTile } from '@mapbox/vector-tile'
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
