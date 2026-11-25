import type { Tile } from '3d-tiles-renderer'
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, type Object3D } from 'three'

import type { DemUnpackFactors } from '../vector/raster/rasterTiles.js'
import { WEB_MERCATOR_MAX_LATITUDE_RADIANS } from '../view/webMercator.js'
import { DemMeshBuilder } from './dem/DemMeshBuilder.js'
import { TERRAIN_ELEVATION_ATTRIBUTE } from './terrainSurface.js'
import { demTileGeometricError, webMercatorTileBounds, type TerrainSurface } from './dem/demSurface.js'
import type { DemImageDecoder, DemTask } from './dem/demTasks.js'
import { readTileJson, type TileJsonInfo } from './imagery/XYZImageryOverlay.js'

/** Grid cells along each side of a terrain tile: as many samples as a Cesium heightmap tile (65). */
export const DEM_TILE_SEGMENTS = 64
/** Rings and columns of the polar caps. */
const CAP_RINGS = 8
const CAP_SEGMENTS = 128
/** Heights a tile is assumed to span before its data loads: the deepest ocean trench (Terrarium has bathymetry) to Everest. */
const INITIAL_MINIMUM_HEIGHT_METERS = -11_000
const INITIAL_MAXIMUM_HEIGHT_METERS = 9_000
/** Encoded elevation tiles kept at the data's deepest zoom, for the tiles drawn deeper than the data. */
const RETAINED_RASTER_COUNT = 64
/** Skirt along the edge of Web Mercator, where tiles meet the polar caps (which follow the coarse zoom 0 row). */
const POLAR_EDGE_SKIRT_LENGTH_METERS = 3000
/** Statuses of a tile the server does not have (past its last zoom, outside its bounds): its parent stands in. */
const MISSING_TILE_STATUSES = new Set([204, 404])

const DEM_TILE = Symbol('DEM_TILE')
const CHILDREN_EXPANDED = Symbol('DEM_CHILDREN_EXPANDED')

/** What the plugin knows of a tile it made. */
interface DemTileInfo {
  x: number
  y: number
  z: number
  /** The tile whose raster this one reads: itself, its ancestor at the data's deepest zoom, or the nearest ancestor the server has. */
  sourceX: number
  sourceY: number
  sourceZ: number
  /** A polar cap, built from the zoom 0 raster. */
  cap: 'north' | 'south' | null
}

interface DemTile {
  refine: 'REPLACE'
  geometricError: number
  boundingVolume: { region: number[] }
  content: { uri: string } | null
  children: DemTile[]
  [DEM_TILE]?: DemTileInfo
  [CHILDREN_EXPANDED]?: true
}

/** The parts of `TilesRenderer` the plugin uses. */
interface TilesRendererLike {
  errorTarget: number
  rootURL: string
  fetchOptions: RequestInit
  ellipsoid: unknown
  invokeOnePlugin<T>(callback: (plugin: { fetchData?: (url: string, options: RequestInit) => unknown }) => T): T
  preprocessTileset(json: object, url: string, parent?: unknown): void
}

export interface RasterDemTerrainPluginOptions {
  /** URL template with `{z}`, `{x}` and `{y}` (or `{-y}`). Pass this or `tileJsonUrl`. */
  url?: string
  /** A TileJSON document giving the template, `maxzoom`, `scheme` and `attribution`. */
  tileJsonUrl?: string
  /** The deepest zoom the server has; deeper tiles reuse its rasters. Default: the TileJSON's `maxzoom`, or 15. */
  maximumZoom?: number
  /** How elevation is packed into the tiles' colours. */
  factors: DemUnpackFactors
  /** Starts the terrain worker; null builds meshes on the main thread. Default: the worker shipped with the library. */
  createWorker?: (() => Worker) | null
  /** Image decoder for the main-thread path (tests). Default: the browser's. */
  decodeImage?: DemImageDecoder
  /** Called once a TileJSON is read, before tiles load (for its attribution). */
  onTileJson?: (info: TileJsonInfo) => void
  /** Ground below this height, metres, is drawn at it (a flat sea over bathymetry). Default: none. */
  floorHeightMeters?: number | null
}

/**
 * A 3DTilesRenderer plugin building terrain from raster-dem tiles (Terrarium, Mapbox Terrain-RGB): an implicit
 * Web Mercator quadtree whose tiles carry region bounding volumes and geometric errors like quantized-mesh terrain,
 * so tile selection, fades, imagery and the flat map work unchanged.
 *
 * - Each tile is a 65 × 65 grid with skirts, decoded and built in a worker (`DemMeshBuilder`).
 * - Tiles deeper than the data (`maximumZoom`) read a part of their ancestor's raster, until a grid cell spans a
 *   pixel; the ancestor's encoded bytes are kept for them, so they need no new request.
 * - Web Mercator stops at about ±85.05°: two caps, built from the zoom 0 raster, close the globe at the poles.
 */
export class RasterDemTerrainPlugin {
  readonly name = 'RASTER_DEM_TERRAIN_PLUGIN'
  /** Before other plugins that parse content. */
  readonly priority = -1000
  protected tiles: TilesRendererLike | null = null
  protected template: string
  protected maximumZoom: number
  protected readonly builder: DemMeshBuilder
  /** Encoded rasters at the data's deepest zoom, by URL, least recently used first. */
  protected readonly retainedRasters = new Map<string, ArrayBuffer>()
  /** Levels drawn past the data's deepest zoom, known once a raster's size is: until a grid cell spans a pixel. */
  protected extraLevels: number | null = null
  /** Tiles that read their own URL, by URL: the ones whose parent can stand in when the server lacks them. */
  protected readonly tileCoordinates = new Map<string, { x: number; y: number; z: number }>()
  /** URLs the server lacks, and the ancestor whose raster stands in for each. */
  protected readonly substitutes = new Map<string, { x: number; y: number; z: number }>()
  /** Zooms already warned about missing tiles. */
  protected readonly warnedMissingZooms = new Set<number>()

  constructor(protected readonly options: RasterDemTerrainPluginOptions) {
    this.template = options.url ?? ''
    this.maximumZoom = options.maximumZoom ?? 15
    this.builder = new DemMeshBuilder(options.factors, options.createWorker, options.decodeImage)
  }

  init(tiles: TilesRendererLike): void {
    this.tiles = tiles
    // The error target quantized-mesh terrain uses: both make tiles of the same width and sample count.
    tiles.errorTarget = 2
  }

  async loadRootTileset(): Promise<object> {
    const tiles = this.tiles!
    const { tileJsonUrl } = this.options
    if (tileJsonUrl !== undefined) {
      const absoluteUrl = absolute(tileJsonUrl, pageUrl())
      const response = (await tiles.invokeOnePlugin(plugin => plugin.fetchData?.(absoluteUrl, tiles.fetchOptions))) as Response
      if (!response.ok) throw new Error(`RasterDemSource: the TileJSON at ${absoluteUrl} answered ${response.status}; check the URL.`)
      const info = readTileJson(await response.json(), absoluteUrl, 'RasterDemSource')
      this.template = info.url
      if (this.options.maximumZoom === undefined && info.levels !== undefined) this.maximumZoom = info.levels - 1
      this.options.onTileJson?.(info)
    } else {
      this.template = absolute(this.template, pageUrl())
    }

    const level0 = this.createTile(0, 0, 0, null, INITIAL_MINIMUM_HEIGHT_METERS, INITIAL_MAXIMUM_HEIGHT_METERS)
    const tileset = {
      asset: { version: '1.0' },
      geometricError: Infinity,
      root: {
        refine: 'REPLACE',
        geometricError: Infinity,
        boundingVolume: { region: [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2, INITIAL_MINIMUM_HEIGHT_METERS, INITIAL_MAXIMUM_HEIGHT_METERS] },
        children: [level0, this.createCap('north'), this.createCap('south')],
      },
    }
    tiles.preprocessTileset(tileset, tiles.rootURL)
    return tileset
  }

  /**
   * Serves the rasters kept for tiles deeper than the data, instead of a new request. A tile the server lacks (404, 204:
   * past its last zoom or outside its bounds) is served its nearest ancestor's raster, so the terrain stays whole.
   */
  fetchData(url: string, options?: RequestInit): ArrayBuffer | Promise<Response | ArrayBuffer> | undefined {
    const retained = this.takeRetained(url)
    if (retained !== undefined) return retained
    const substitute = this.substitutes.get(url)
    if (substitute !== undefined) return this.fetchAncestor(url, substitute.x, substitute.y, substitute.z + 1, options)
    const coordinates = this.tileCoordinates.get(url)
    if (coordinates === undefined || coordinates.z === 0) return undefined
    return fetch(url, options).then(response => {
      if (!MISSING_TILE_STATUSES.has(response.status)) return response
      this.warnMissing(coordinates.z)
      return this.fetchAncestor(url, coordinates.x, coordinates.y, coordinates.z, options, response)
    })
  }

  parseToMesh(buffer: ArrayBuffer, tile: Tile & DemTile, _extension: string, url: string, abortSignal: AbortSignal): Promise<Object3D | null> | undefined {
    const info = tile[DEM_TILE]
    // Not a promise: other plugins get the tiles this one did not make.
    if (info === undefined) return undefined
    return this.parseDemTile(buffer, tile, info, url, abortSignal)
  }

  protected async parseDemTile(buffer: ArrayBuffer, tile: Tile & DemTile, info: DemTileInfo, url: string, abortSignal: AbortSignal): Promise<Object3D | null> {
    const substitute = this.substitutes.get(url)
    if (substitute !== undefined && info.sourceZ === info.z) {
      info.sourceX = substitute.x
      info.sourceY = substitute.y
      info.sourceZ = substitute.z
    }
    // Keep the raster when descendants will read it: at the data's deepest zoom, or standing in for a missing tile.
    if (info.cap === null && (info.z >= this.maximumZoom || info.sourceZ < info.z)) this.retainRaster(this.tileUrl(info.sourceX, info.sourceY, info.sourceZ), buffer)

    let surface: TerrainSurface
    let rasterWidth: number
    try {
      // Transferred to the worker: the tile renderer does not read the buffer again, and `retainRaster` kept a copy.
      ;({ surface, rasterWidth } = await this.builder.build(buffer, this.taskFor(tile, info)))
    } catch (error) {
      if ((error as Error).name === 'AbortError' || abortSignal.aborted) return null
      throw new Error(`RasterDemSource: the elevation tile ${url} could not be decoded (${(error as Error).message}); check that the URL serves PNG or WebP tiles in the source's encoding.`)
    }
    if (abortSignal.aborted) return null

    this.extraLevels ??= Math.max(0, Math.round(Math.log2(rasterWidth / DEM_TILE_SEGMENTS)))
    const region = tile.boundingVolume.region
    region[4] = surface.minimumHeightMeters
    region[5] = surface.maximumHeightMeters
    ;((tile as unknown as { engineData: unknown }).engineData as { boundingVolume: { setRegionData(ellipsoid: unknown, ...region: number[]): void } }).boundingVolume.setRegionData(this.tiles!.ellipsoid, ...region)
    if (info.cap === null) this.expandChildren(tile, info, surface)
    return createMesh(surface)
  }

  dispose(): void {
    this.builder.dispose()
    this.retainedRasters.clear()
  }

  protected taskFor(tile: DemTile, info: DemTileInfo): DemTask {
    const floorHeightMeters = this.options.floorHeightMeters ?? null
    if (info.cap !== null) return { kind: 'cap', north: info.cap === 'north', rings: CAP_RINGS, segments: CAP_SEGMENTS, skirtLengthMeters: capSkirtLengthMeters(), floorHeightMeters }
    const scale = 2 ** (info.z - info.sourceZ)
    const west = (info.x - info.sourceX * scale) / scale
    const top = (info.y - info.sourceY * scale) / scale
    return {
      kind: 'tile',
      x: info.x,
      y: info.y,
      z: info.z,
      subview: [west, top, west + 1 / scale, top + 1 / scale],
      segments: DEM_TILE_SEGMENTS,
      skirtLengthMeters: info.y === 0 || info.y === 2 ** info.z - 1 ? Math.max(tile.geometricError, POLAR_EDGE_SKIRT_LENGTH_METERS) : tile.geometricError,
      floorHeightMeters,
    }
  }

  protected takeRetained(url: string): ArrayBuffer | undefined {
    const retained = this.retainedRasters.get(url)
    if (retained === undefined) return undefined
    this.retainedRasters.delete(url)
    this.retainedRasters.set(url, retained)
    return retained.slice(0)
  }

  /** The raster of the nearest ancestor (above zoom `z`) the server has, kept or fetched; `fallback` when none answers. */
  protected async fetchAncestor(url: string, x: number, y: number, z: number, options: RequestInit | undefined, fallback?: Response): Promise<Response | ArrayBuffer> {
    let response = fallback
    for (let level = z - 1, ancestorX = x >> 1, ancestorY = y >> 1; level >= 0; level--, ancestorX >>= 1, ancestorY >>= 1) {
      const ancestorUrl = this.tileUrl(ancestorX, ancestorY, level)
      const retained = this.takeRetained(ancestorUrl)
      if (retained === undefined) {
        response = await fetch(ancestorUrl, options)
        if (MISSING_TILE_STATUSES.has(response.status)) continue
        if (!response.ok) return response
      }
      this.substitutes.set(url, { x: ancestorX, y: ancestorY, z: level })
      return retained ?? response!.arrayBuffer()
    }
    return response ?? fetch(url, options)
  }

  protected warnMissing(z: number): void {
    if (this.warnedMissingZooms.has(z)) return
    this.warnedMissingZooms.add(z)
    console.warn(
      `RasterDemSource: the server has no elevation tiles at zoom ${z} here (404); their parents' rasters stand in. ` +
        `If the server stops at zoom ${z - 1}, set maximumZoom to ${z - 1} to skip these requests.`,
    )
  }

  protected retainRaster(url: string, buffer: ArrayBuffer): void {
    this.retainedRasters.delete(url)
    this.retainedRasters.set(url, buffer.slice(0))
    while (this.retainedRasters.size > RETAINED_RASTER_COUNT) this.retainedRasters.delete(this.retainedRasters.keys().next().value!)
  }

  /** Adds a loaded tile's four children, once: kept when the tile unloads, like a static tile set's. */
  protected expandChildren(tile: DemTile, info: DemTileInfo, surface: TerrainSurface): void {
    if (tile[CHILDREN_EXPANDED] === true) return
    tile[CHILDREN_EXPANDED] = true
    // Past the data (its deepest zoom, or an ancestor standing in for a missing tile), children read the same raster
    // until a cell spans a pixel.
    const pastData = info.z >= this.maximumZoom || info.sourceZ < info.z
    if (pastData && info.z >= info.sourceZ + (this.extraLevels ?? 0)) return
    const source = pastData ? info : null
    // Children start from this tile's heights, widened: their finer grids reach peaks and pits this one smooths over.
    const margin = Math.max(100, 0.25 * (surface.maximumHeightMeters - surface.minimumHeightMeters))
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        tile.children.push(this.createTile(2 * info.x + dx, 2 * info.y + dy, info.z + 1, source, surface.minimumHeightMeters - margin, surface.maximumHeightMeters + margin))
      }
    }
  }

  protected createTile(x: number, y: number, z: number, source: DemTileInfo | null, minimumHeightMeters: number, maximumHeightMeters: number): DemTile {
    const { west, south, east, north } = webMercatorTileBounds(x, y, z)
    const sourceX = source?.sourceX ?? x
    const sourceY = source?.sourceY ?? y
    const sourceZ = source?.sourceZ ?? z
    if (source === null) this.tileCoordinates.set(this.tileUrl(x, y, z), { x, y, z })
    return {
      refine: 'REPLACE',
      geometricError: demTileGeometricError(x, y, z, DEM_TILE_SEGMENTS),
      boundingVolume: { region: [west, south, east, north, minimumHeightMeters, maximumHeightMeters] },
      content: { uri: this.tileUrl(sourceX, sourceY, sourceZ) },
      children: [],
      [DEM_TILE]: { x, y, z, sourceX, sourceY, sourceZ, cap: null },
    }
  }

  protected createCap(cap: 'north' | 'south'): DemTile {
    const region = cap === 'north' ? [-Math.PI, WEB_MERCATOR_MAX_LATITUDE_RADIANS, Math.PI, Math.PI / 2] : [-Math.PI, -Math.PI / 2, Math.PI, -WEB_MERCATOR_MAX_LATITUDE_RADIANS]
    return {
      refine: 'REPLACE',
      geometricError: 0,
      boundingVolume: { region: [...region, INITIAL_MINIMUM_HEIGHT_METERS, INITIAL_MAXIMUM_HEIGHT_METERS] },
      // The cap reads the zoom 0 raster's edge row.
      content: { uri: this.tileUrl(0, 0, 0) },
      children: [],
      [DEM_TILE]: { x: 0, y: 0, z: 0, sourceX: 0, sourceY: 0, sourceZ: 0, cap },
    }
  }

  protected tileUrl(x: number, y: number, z: number): string {
    return this.template
      .replace(/{z}/g, String(z))
      .replace(/{x}/g, String(x))
      .replace(/{y}/g, String(y))
      .replace(/{-y}/g, String(2 ** z - 1 - y))
  }
}

/** The cap's skirt reaches below the Web Mercator tiles' edges, which are finer than the zoom 0 row it follows. */
function capSkirtLengthMeters(): number {
  return 3000
}

function createMesh({ positions, normals, uvs, indices, center, elevations }: TerrainSurface): Mesh {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  // The true heights where the floor lifted the ground: `FlatMapPlugin` writes them into `terrainSurface`.
  if (elevations !== undefined) geometry.setAttribute(TERRAIN_ELEVATION_ATTRIBUTE, new BufferAttribute(elevations, 1))
  geometry.setIndex(new BufferAttribute(indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  // Replaced by the terrain's material (TileMaterialReplacementPlugin).
  const mesh = new Mesh(geometry, new MeshBasicMaterial())
  mesh.position.set(...center)
  return mesh
}

function pageUrl(): string {
  return typeof location === 'undefined' ? 'http://localhost/' : location.href
}

/** Resolves a URL or template against a base, keeping `{z}`-style placeholders (`new URL` would percent-encode them). */
function absolute(url: string, base: string): string {
  return new URL(url.replace(/{/g, '__open__').replace(/}/g, '__close__'), base).href.replace(/__open__/g, '{').replace(/__close__/g, '}')
}
