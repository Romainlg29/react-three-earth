// Types for a plugin's worker module (the geometry tier of custom style layer types). A worker module imports
// only types from here (`import type { WorkerLayerTypeFactory } from 'react-three-earth/plugin-worker'`): the
// library hands it what it needs through `host`, so the module never bundles a second copy of the library.

/** A point in tile units: 0 to `host.TILE_EXTENT`, y down from the tile's north edge. */
export interface WorkerPoint {
  x: number
  y: number
}

/** A feature as a worker module sees it. `geometry` is passed beside it to `addFeature`. */
export interface WorkerFeature {
  /** 1: point, 2: line, 3: polygon. */
  type: 1 | 2 | 3
  properties: Record<string, unknown>
  id?: string | number
  /** Its feature-state, read by `layer.evaluate` (paint properties that use `['feature-state', …]`). */
  state: Record<string, unknown>
}

/** RGBA, straight alpha, 0 to 255, sRGB. */
export type WorkerRgba = [number, number, number, number]

/** The style layer being tessellated, with its properties compiled by the library. */
export interface WorkerStyleLayer {
  readonly id: string
  readonly type: string
  /** A paint or layout property for a feature (its state included), or for no feature (zoom only). */
  evaluate<T = unknown>(kind: 'paint' | 'layout', name: string, zoom: number, feature?: WorkerFeature): T
  /** A colour paint property times an opacity, as straight-alpha sRGB bytes. */
  evaluateColor(name: string, zoom: number, feature?: WorkerFeature, opacity?: number): WorkerRgba
  /** Whether the style sets the property, as opposed to relying on its default. */
  has(kind: 'paint' | 'layout', name: string): boolean
}

/** What the library lends a worker module. */
export interface WorkerLayerTypeHost {
  /** Tile coordinates run from 0 to this. */
  readonly TILE_EXTENT: number
  /** Polygon rings to polygons (outer ring, then its holes), as MapLibre does. */
  classifyRings(rings: WorkerPoint[][]): WorkerPoint[][][]
  /** Triangulates a polygon (flat x, y pairs, hole start indices): mapbox's earcut. */
  earcut(vertices: ArrayLike<number>, holeIndices?: ArrayLike<number>, dimensions?: number): number[]
  /** Clamps a reach in pixels to the type's `maximumReachPixels`. */
  clampReach(pixels: number): number
  /**
   * Whether a point lies inside the tile proper, not in the buffer around it. Additive layers count only
   * these features, or neighbouring tiles would count buffered features twice.
   */
  isInsideTile(point: WorkerPoint): boolean
}

export interface WorkerTileBuilderOptions {
  layer: WorkerStyleLayer
  /** The zoom the style is evaluated at. */
  zoom: number
  /** Tile units per map pixel at that zoom: multiply a width in pixels by it. */
  unitsPerPixel: number
  tile: { x: number; y: number; z: number }
}

/** A vertex attribute of the layer's mesh. */
export interface WorkerAttribute {
  array: Float32Array | Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
  itemSize: 1 | 2 | 3 | 4
  /** Integers read as 0 to 1 (or -1 to 1). Default: false. */
  normalized?: boolean
}

/**
 * The mesh of one layer in one tile. `position` is required (2 floats per vertex, tile units). Name other
 * attributes as shader identifiers (`segmentStart`); an attribute named after a paint property (`my-glow-color`)
 * is what `paint.color('my-glow-color')` reads in the material.
 */
export interface WorkerLayerGeometry {
  attributes: Record<string, WorkerAttribute>
  indices: Uint32Array | Uint16Array
}

/** Collects one layer's features in one tile, then builds its mesh. */
export interface WorkerTileBuilder {
  addFeature(feature: WorkerFeature, geometry: WorkerPoint[][]): void
  /** The mesh, or null when nothing is drawn. Its arrays are transferred to the main thread. */
  finish(): WorkerLayerGeometry | null
}

export interface WorkerLayerType {
  createTileBuilder(options: WorkerTileBuilderOptions): WorkerTileBuilder
}

/** What a worker module exports, under the definition's `exportName`. */
export type WorkerLayerTypeFactory = (host: WorkerLayerTypeHost) => WorkerLayerType
