import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Group, Matrix4, Vector3, type Mesh } from 'three'

import { enableFlatMorph, type FlatMorphHost } from '../../tiles/FlatMapPlugin.js'
import type { ViewMorph } from '../../view/ViewMorph.js'
import { computeViewTilePyramid, tileRowToLatitude } from '../CameraTilePyramid.js'
import type { Lease } from '../RefCountedCache.js'
import type { SymbolFrame } from '../symbols/ScreenSymbols.js'
import { screenClipPlane, setScreenClipMask } from '../../core/screenClip.js'
import { TILE_EXTENT, type ExtrusionMesh, type MapStyleSummary, type TileBucket, type TileRequest } from '../worker/types.js'
import { createExtrusionAttributes, createExtrusionGeometry, createExtrusionMaterials, createExtrusionMesh, type ExtrusionAttributes, type ExtrusionMaterials, type ExtrusionMeshUserData } from './extrusionMaterial.js'

const UNCLIPPED_PLANE = screenClipPlane(null)

/** What 3D extrusions need from the earth in a frame: the same as labels facing the viewer. */
export interface ExtrusionFrame extends SymbolFrame {
  /** Changes whenever the terrain's drawn tiles change (`Terrain.visibleTilesVersion`): the ground is read again then. */
  terrainVersion: number
}

/** What `Extrusions` needs from its map style overlay. */
export interface ExtrusionsHost {
  readonly summary: MapStyleSummary | null
  /** Deepest zoom tiles are built at (the overlay's `maximumZoom`). */
  readonly maximumZoom: number
  /** The imagery layer's opacity: buildings fade with it. */
  readonly opacity: number
  /** The part of the canvas the imagery layer keeps (`Imagery.screenClip`): buildings are clipped with it. Default: all of it. */
  readonly screenClipPlane?: Vector3
  /** Locks a processed building tile in the overlay's tile cache. */
  acquireExtrusionTile(request: TileRequest): Lease<{ bucket: TileBucket }>
}

export interface ExtrusionsInspection {
  /** Building tiles the camera asks for, and those drawn (ready ones, plus older ones standing in for tiles still loading). */
  tilesRequested: number
  tilesDrawn: number
  /** Buildings in drawn tiles. */
  buildings: number
  /** Terrain height reads still to do: for buildings not yet shown, and for buildings re-reading the ground since the terrain changed (finer tiles, exaggeration). */
  elevationsPending: number
  /** Main-thread time of the last frame's update (choosing tiles, reading terrain, heights), in milliseconds. */
  updateMilliseconds: number
}

/** One building tile: its meshes and the terrain under it. */
interface ExtrusionTile {
  key: string
  request: TileRequest
  /** Normalised Web Mercator range of the data tile, for overlap tests. */
  left: number
  top: number
  right: number
  bottom: number
  lease: Lease<{ bucket: TileBucket }>
  /** A fresher copy being processed after a style, data or feature-state change; replaces this one when it arrives. */
  refresh: Lease<{ bucket: TileBucket }> | null
  loaded: boolean
  extrusions: ExtrusionMesh | null
  /** Holds the layers' meshes, placed in the tile centre's east-north-up frame. */
  group: Group | null
  attributes: ExtrusionAttributes | null
  /** Per style layer: its colour mesh, the depth mesh drawn before it when translucent, and its opacities. */
  layers: Array<{ color: Mesh; depth: Mesh; opacity: number; nextZoomOpacity: number }>
  /** Terrain heights on a grid over the tile, row by row from the north-west, NaN until read; `gridCells` + 1 per side. */
  grid: Float64Array
  gridCells: number
  /** Next grid point to read, and when the grid was last read through. */
  gridCursor: number
  gridReadAt: number
  /** When the last full pass (not a retry of unknown points) finished: finer terrain is read again from it. */
  gridRefreshedAt: number
  /** The terrain's version when the last full pass started, and when the one under way started. */
  gridTerrainVersion: number
  gridPassTerrainVersion: number
  /** The pass under way reads only the points still unknown (a retry), not the whole grid (a refresh). */
  gridRetry: boolean
  /** Grid points still unknown after the last pass. */
  gridUnknown: number
  /** True once every building stands on terrain read at least once. */
  ready: boolean
  drawn: boolean
}

/** Between two choices of tiles while the camera moves. */
const PYRAMID_INTERVAL_MILLISECONDS = 100
/** The terrain under buildings is read again at most this often, once its drawn tiles have changed (finer terrain). */
const ELEVATION_REFRESH_MILLISECONDS = 1000
/** A grid with points where no terrain was loaded is read again this soon. */
const ELEVATION_RETRY_MILLISECONDS = 500
/** As labels: coarse terrain tiles sag below the ellipsoid between their vertices. */
const MINIMUM_ELEVATION_METERS = -500
/** Grid spacing on the ground the terrain under buildings is read at, and the limits on the cells per side. */
const GRID_SPACING_METERS = 40
const MINIMUM_GRID_CELLS = 4
const MAXIMUM_GRID_CELLS = 32
/** An elevation change smaller than this is not uploaded again. */
const ELEVATION_TOLERANCE_METERS = 0.05
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6_378_137

const east = new Vector3()
const north = new Vector3()
const up = new Vector3()
const origin = new Vector3()
const frameMatrix = new Matrix4()

/**
 * `fill-extrusion` layers as real 3D buildings (MapLibre's 3D buildings), for a map style source. Building tiles come
 * from the camera (`computeViewTilePyramid`, as labels facing the viewer): one zoom per area of the screen, deeper
 * near the camera, never overlapping, so no building is drawn twice. The worker builds walls and roofs at elevation 0
 * in each tile centre's east-north-up frame; here each building is lifted onto the terrain as drawn (the lowest
 * ground under its footprint, read on a grid over the tile), heights follow the camera's zoom between the tile's
 * zoom and the next, and the meshes morph to the flat map with the terrain. Lit by the scene's lights (the
 * atmosphere's sun) and hazed by aerial perspective like the ground; translucent layers draw a depth pass first, so
 * only the front-most surface blends, as MapLibre.
 */
export class Extrusions implements FlatMorphHost {
  /** Add it to the scene under the earth: holds one group per drawn tile. `Terrain` adds it. */
  readonly object = new Group()
  protected readonly host: ExtrusionsHost
  protected readonly tiles = new Map<string, ExtrusionTile>()
  protected readonly materials: ExtrusionMaterials
  protected requestedKeys = new Set<string>()
  protected lastPyramidMilliseconds = -Infinity
  protected pyramidDue = true
  /** Some standing buildings wait to read the ground again since the terrain changed: frames are asked for until they do. */
  protected refreshPending = false
  protected tilesChanged = true
  protected statistics: ExtrusionsInspection = { tilesRequested: 0, tilesDrawn: 0, buildings: 0, elevationsPending: 0, updateMilliseconds: 0 }
  protected disposed = false
  protected readonly lastCameraMatrix = new Matrix4()
  protected readonly lastProjectionMatrix = new Matrix4()
  protected requestFrame: (() => void) | null = null
  /** The morph the meshes follow (`FlatMorphHost`), from the last frame. */
  view: ViewMorph | null = null

  constructor(host: ExtrusionsHost) {
    this.host = host
    this.materials = createExtrusionMaterials({ get value() { return host.screenClipPlane ?? UNCLIPPED_PLANE } })
    this.object.name = 'MapStyleExtrusions'
    this.object.matrixAutoUpdate = false
  }

  /** The object placing ECEF in the scene (`FlatMorphHost`): the extrusions' own group, under the earth. */
  get frame(): Group {
    return this.object
  }

  inspect(): ExtrusionsInspection {
    return { ...this.statistics }
  }

  /** True while building tiles the camera asks for are still being processed, or wait for the terrain under them (first read or a re-read after the terrain changed). */
  get loading(): boolean {
    // Buildings reading the ground again since the terrain changed are still settling.
    if (this.refreshPending) return true
    for (const key of this.requestedKeys) {
      const tile = this.tiles.get(key)
      if (tile === undefined || !tile.loaded || (tile.extrusions !== null && !tile.ready)) return true
    }
    return false
  }

  /** Picks the tiles for the camera, reads the terrain under them and sets this frame's heights. Returns true while another frame is needed. */
  update(frame: ExtrusionFrame): boolean {
    this.requestFrame = frame.requestFrame
    this.view = frame.view
    const summary = this.host.summary
    if (this.disposed || summary === null) return false
    const start = performance.now()
    const { camera, view, timeMilliseconds } = frame
    camera.updateMatrixWorld()
    if (!this.lastCameraMatrix.equals(camera.matrixWorld) || !this.lastProjectionMatrix.equals(camera.projectionMatrix)) {
      this.lastCameraMatrix.copy(camera.matrixWorld)
      this.lastProjectionMatrix.copy(camera.projectionMatrix)
      this.pyramidDue = true
    }
    // The morph moves the ground between two projections: the tiles of either end stay until it settles.
    const morphing = view.transitioning || (view.morph > 0 && view.morph < 1)
    const sincePyramid = timeMilliseconds - this.lastPyramidMilliseconds
    if (!morphing && ((this.pyramidDue && sincePyramid >= PYRAMID_INTERVAL_MILLISECONDS) || this.tilesChanged || sincePyramid > 1000)) {
      this.requestTiles(frame, summary)
      this.lastPyramidMilliseconds = timeMilliseconds
      this.pyramidDue = false
    }
    this.tilesChanged = false
    this.readElevations(frame)
    this.chooseDrawnTiles()
    this.setDrawState(frame.zoom)
    const plane = this.host.screenClipPlane ?? UNCLIPPED_PLANE
    for (const material of [this.materials.opaque, this.materials.translucent, this.materials.depth]) setScreenClipMask(material, plane)
    this.statistics.updateMilliseconds = performance.now() - start
    // Buildings waiting for their first ground, or to read it again since the terrain changed (both `loading`), ask for
    // frames; retries of points with no terrain under them ride on frames drawn anyway.
    return this.pyramidDue || this.loading
  }

  /** The style loaded or its sources changed: asks for a frame, which picks tiles again. */
  summaryChanged(): void {
    this.tilesChanged = true
    this.requestFrame?.()
  }

  /** Processes again the held tiles `matches` selects (their style, data or feature-state changed). Each keeps drawing until the new one arrives. */
  refresh(matches: (request: TileRequest) => boolean): void {
    for (const tile of this.tiles.values()) {
      if (!matches(tile.request)) continue
      tile.refresh?.release()
      const refresh = this.host.acquireExtrusionTile(tile.request)
      tile.refresh = refresh
      refresh.promise.then(
        ({ bucket }) => {
          if (tile.refresh !== refresh || this.tiles.get(tile.key) !== tile) return
          tile.lease.release()
          tile.lease = refresh
          tile.refresh = null
          this.setTileExtrusions(tile, bucket.extrusions ?? null)
        },
        () => {
          if (tile.refresh === refresh) tile.refresh = null
          refresh.release()
        },
      )
    }
  }

  dispose(): void {
    this.disposed = true
    for (const tile of this.tiles.values()) this.releaseTile(tile)
    this.tiles.clear()
    this.materials.opaque.dispose()
    this.materials.translucent.dispose()
    this.materials.depth.dispose()
    this.object.removeFromParent()
  }

  /**
   * Asks for the building tiles of the camera's pyramid, keeping tiles already held. Past a source's maximum zoom
   * several pyramid tiles share one data tile: it is asked for once, at the deepest of their zooms.
   */
  protected requestTiles(frame: ExtrusionFrame, summary: MapStyleSummary): void {
    const layers = summary.extrusionLayers ?? []
    const requested = new Set<string>()
    if (layers.length > 0) {
      const pyramid = computeViewTilePyramid(frame.camera, frame.widthPixels, frame.heightPixels, frame.view, this.host.maximumZoom, frame.centerHeightMeters)
      for (const source of summary.sources) {
        const sourceLayers = layers.filter(layer => layer.source === source.id)
        if (sourceLayers.length === 0 || (source.type !== undefined && source.type !== 'vector')) continue
        const dataTiles = new Map<string, TileRequest>()
        for (const tile of pyramid) {
          if (tile.z < source.minimumZoom) continue
          // No layer draws at this zoom (MapLibre: minzoom inclusive, maxzoom exclusive).
          if (!sourceLayers.some(layer => tile.z >= layer.minimumZoom && tile.z < layer.maximumZoom)) continue
          const z = Math.min(tile.z, source.maximumZoom)
          const shift = tile.z - z
          const x = tile.x >> shift
          const y = tile.y >> shift
          const dataKey = `${z}/${x}/${y}`
          const known = dataTiles.get(dataKey)
          if (known === undefined || known.zoom < tile.z) dataTiles.set(dataKey, { sourceId: source.id, x, y, z, zoom: tile.z, extrusions: true })
        }
        for (const request of dataTiles.values()) {
          const key = extrusionTileKey(request)
          requested.add(key)
          if (!this.tiles.has(key)) this.addTile(key, request)
        }
      }
    }
    this.requestedKeys = requested
    this.statistics.tilesRequested = requested.size
  }

  protected addTile(key: string, request: TileRequest): void {
    const count = 2 ** request.z
    const lease = this.host.acquireExtrusionTile(request)
    const tile: ExtrusionTile = {
      key,
      request,
      left: request.x / count,
      top: request.y / count,
      right: (request.x + 1) / count,
      bottom: (request.y + 1) / count,
      lease,
      refresh: null,
      loaded: false,
      extrusions: null,
      group: null,
      attributes: null,
      layers: [],
      grid: new Float64Array(0),
      gridCells: 0,
      gridCursor: 0,
      gridReadAt: -Infinity,
      gridRefreshedAt: -Infinity,
      gridTerrainVersion: -1,
      gridPassTerrainVersion: -1,
      gridRetry: false,
      gridUnknown: 0,
      ready: false,
      drawn: false,
    }
    this.tiles.set(key, tile)
    lease.promise.then(
      ({ bucket }) => {
        if (this.tiles.get(key) !== tile || tile.lease !== lease) return
        this.setTileExtrusions(tile, bucket.extrusions ?? null)
      },
      error => {
        if (this.tiles.get(key) !== tile || tile.lease !== lease || (error as Error | undefined)?.name === 'AbortError') return
        console.warn(
          `MapStyleSource: buildings of tile ${request.z}/${request.x}/${request.y} could not be processed (${(error as Error).message}). Check that the tile decodes; it is retried when it comes back into view.`,
        )
        this.setTileExtrusions(tile, null)
      },
    )
  }

  /** Puts a tile's (new) buildings in place. A refresh keeps the terrain grid already read: the ground has not moved. */
  protected setTileExtrusions(tile: ExtrusionTile, extrusions: ExtrusionMesh | null): void {
    this.disposeMeshes(tile)
    tile.extrusions = extrusions
    tile.loaded = true
    this.tilesChanged = true
    this.requestFrame?.()
    if (extrusions === null) return
    if (tile.gridCells === 0) {
      const latitude = tileRowToLatitude(tile.request.y + 0.5, tile.request.z)
      const sizeMeters = (EARTH_CIRCUMFERENCE_METERS * Math.cos(latitude)) / 2 ** tile.request.z
      tile.gridCells = Math.min(MAXIMUM_GRID_CELLS, Math.max(MINIMUM_GRID_CELLS, Math.ceil(sizeMeters / GRID_SPACING_METERS)))
      tile.grid = new Float64Array((tile.gridCells + 1) ** 2).fill(Number.NaN)
    }
    const group = new Group()
    group.name = `MapStyleExtrusionTile ${tile.request.z}/${tile.request.x}/${tile.request.y}`
    group.matrixAutoUpdate = false
    WGS84_ELLIPSOID.getCartographicToPosition(extrusions.originLatitudeRadians, extrusions.originLongitudeRadians, 0, origin)
    WGS84_ELLIPSOID.getEastNorthUpAxes(extrusions.originLatitudeRadians, extrusions.originLongitudeRadians, east, north, up)
    group.matrix.copy(frameMatrix.makeBasis(east, north, up).setPosition(origin))
    group.visible = false
    const attributes = createExtrusionAttributes(extrusions)
    tile.attributes = attributes
    const center = [extrusions.originMercatorXMeters, extrusions.originMercatorYMeters, 0] as const
    for (const layer of extrusions.layers) {
      const geometry = createExtrusionGeometry(attributes, extrusions.indices.subarray(layer.start, layer.start + layer.count))
      const name = `${layer.layerId} ${tile.request.z}/${tile.request.x}/${tile.request.y}`
      const depth = createExtrusionMesh(geometry, this.materials.depth, `MapStyleExtrusionDepth ${name}`)
      const color = createExtrusionMesh(geometry, this.materials.opaque, `MapStyleExtrusion ${name}`)
      for (const mesh of [depth, color]) {
        ;(mesh.userData as ExtrusionMeshUserData).extrusionCenterMercatorYMeters = extrusions.originMercatorYMeters
        enableFlatMorph(mesh, center, this)
        group.add(mesh)
      }
      // Style order among translucent layers: each one's depth pass, then its colour.
      depth.renderOrder = layer.layerIndex * 2
      color.renderOrder = layer.layerIndex * 2 + 1
      tile.layers.push({ color, depth, opacity: layer.opacity, nextZoomOpacity: layer.nextZoomOpacity })
    }
    tile.group = group
    this.object.add(group)
    // New buildings at the same place (a refresh): lift them as the old ones were, at once.
    if (tile.ready) this.writeElevations(tile, true)
  }

  /**
   * Reads the terrain under the tiles waiting for it, within the frame's budget: tiles never read first, then full
   * passes, then retries; requested tiles before others, passes under way before new ones.
   */
  protected readElevations(frame: ExtrusionFrame): void {
    const sample = frame.sampleTerrainElevation
    const budget = frame.elevationBudget
    const start = performance.now()
    let pending = 0
    this.refreshPending = false
    const due: ExtrusionTile[] = []
    for (const tile of this.tiles.values()) {
      // Tiles kept only until their replacement is ready are not read again.
      if (tile.extrusions === null || (tile.ready && !this.requestedKeys.has(tile.key))) continue
      if (tile.gridCursor > 0 || !Number.isFinite(tile.gridReadAt)) {
        if (tile.ready) this.refreshPending = true
        due.push(tile)
        continue
      }
      // Retries of unknown points (every 500 ms) never put off the full refresh, once the terrain has changed.
      const terrainChanged = tile.gridTerrainVersion !== frame.terrainVersion
      if (terrainChanged) this.refreshPending = true
      if (terrainChanged && frame.timeMilliseconds - tile.gridRefreshedAt >= ELEVATION_REFRESH_MILLISECONDS) tile.gridRetry = false
      else if (frame.timeMilliseconds - tile.gridReadAt >= ELEVATION_RETRY_MILLISECONDS && tile.gridUnknown > 0) tile.gridRetry = true
      else continue
      due.push(tile)
    }
    // Buildings not shown yet first, then full passes over the ground (it changed) before retries of points with no
    // terrain under them (off the screen, often: they must not starve the rest).
    due.sort(
      (a, b) =>
        Number(a.ready) - Number(b.ready) ||
        Number(a.gridRetry) - Number(b.gridRetry) ||
        Number(this.requestedKeys.has(b.key)) - Number(this.requestedKeys.has(a.key)) ||
        b.gridCursor - a.gridCursor ||
        b.request.z - a.request.z,
    )
    for (const tile of due) {
      const side = tile.gridCells + 1
      const total = side * side
      if (sample === null) {
        tile.grid.fill(0)
        tile.gridCursor = total
      }
      if (tile.gridCursor === 0 && !tile.gridRetry) tile.gridPassTerrainVersion = frame.terrainVersion
      while (tile.gridCursor < total) {
        if (budget.remaining <= 0 || performance.now() - start > budget.milliseconds) break
        const index = tile.gridCursor++
        if (tile.gridRetry && !Number.isNaN(tile.grid[index]!)) continue
        const column = index % side
        const row = Math.floor(index / side)
        const count = 2 ** tile.request.z
        const longitude = ((tile.request.x + column / tile.gridCells) / count) * 2 * Math.PI - Math.PI
        const latitude = tileRowToLatitude(tile.request.y + row / tile.gridCells, tile.request.z)
        const height = sample!(longitude, latitude)
        budget.remaining--
        tile.grid[index] = height === null ? Number.NaN : Math.max(MINIMUM_ELEVATION_METERS, height)
      }
      if (tile.gridCursor < total) {
        if (!tile.ready || !tile.gridRetry) pending += total - tile.gridCursor
        continue
      }
      tile.gridCursor = 0
      tile.gridReadAt = frame.timeMilliseconds
      if (!tile.gridRetry) {
        tile.gridRefreshedAt = frame.timeMilliseconds
        tile.gridTerrainVersion = tile.gridPassTerrainVersion
      }
      tile.gridUnknown = 0
      for (const height of tile.grid) if (Number.isNaN(height)) tile.gridUnknown++
      // Points still unknown (no terrain tile drawn there yet, or off the screen) take their nearest known neighbour,
      // or 0 when none is known; they are read again soon.
      this.writeElevations(tile, false)
      if (!tile.ready) {
        tile.ready = true
        this.tilesChanged = true
      }
    }
    this.statistics.elevationsPending = pending
  }

  /** Writes each building's elevation from the grid; `force` uploads them even when none changed. */
  protected writeElevations(tile: ExtrusionTile, force: boolean): void {
    const extrusions = tile.extrusions
    const attributes = tile.attributes
    if (extrusions === null || attributes === null) return
    const grid = fillUnknownGridPoints(tile.grid, tile.gridCells) ?? new Float64Array(tile.grid.length)
    const elevations = buildingElevations(grid, tile.gridCells, extrusions.buildingBounds)
    const array = attributes.elevation.array as Float32Array
    const starts = extrusions.buildingVertexStarts
    let changed = force
    for (let building = 0; building < elevations.length; building++) {
      const elevation = elevations[building]!
      const first = starts[building]!
      if (!changed && Math.abs(array[first]! - elevation) < ELEVATION_TOLERANCE_METERS) continue
      changed = true
      array.fill(elevation, first, starts[building + 1]!)
    }
    if (changed) {
      attributes.elevation.needsUpdate = true
      this.requestFrame?.()
    }
  }

  /**
   * Draws the requested tiles that are ready, and keeps drawing older tiles that overlap a requested tile not ready
   * yet (its parent, children, or itself at another zoom); a ready tile under one of those waits with it, so the two
   * never draw the same building twice. Releases the rest.
   */
  protected chooseDrawnTiles(): void {
    const waiting: ExtrusionTile[] = []
    for (const key of this.requestedKeys) {
      const tile = this.tiles.get(key)
      if (tile !== undefined && !isReady(tile)) waiting.push(tile)
    }
    const kept: ExtrusionTile[] = []
    for (const [key, tile] of this.tiles) {
      if (this.requestedKeys.has(key)) continue
      const keep = isReady(tile) && tile.drawn && waiting.some(other => other.request.sourceId === tile.request.sourceId && overlaps(tile, other))
      if (keep) {
        kept.push(tile)
        continue
      }
      this.releaseTile(tile)
      this.tiles.delete(key)
    }
    let drawnCount = 0
    let buildings = 0
    for (const [key, tile] of this.tiles) {
      const drawn = this.requestedKeys.has(key) ? isReady(tile) && !kept.some(other => other.request.sourceId === tile.request.sourceId && overlaps(tile, other)) : true
      tile.drawn = drawn
      if (tile.group !== null) tile.group.visible = drawn && tile.extrusions !== null
      if (drawn) {
        drawnCount++
        buildings += (tile.extrusions?.buildingVertexStarts.length ?? 1) - 1
      }
    }
    this.statistics.tilesDrawn = drawnCount
    this.statistics.buildings = buildings
  }

  /** Heights between zooms and opacities for the camera's zoom. */
  protected setDrawState(cameraZoom: number): void {
    const layerOpacity = this.host.opacity
    for (const tile of this.tiles.values()) {
      if (!tile.drawn || tile.group === null) continue
      const factor = Math.min(1, Math.max(0, cameraZoom - tile.request.zoom))
      for (const layer of tile.layers) {
        const opacity = (layer.opacity + (layer.nextZoomOpacity - layer.opacity) * factor) * layerOpacity
        const translucent = opacity < 1
        layer.color.material = translucent ? this.materials.translucent : this.materials.opaque
        layer.color.visible = opacity > 0
        layer.depth.visible = translucent && opacity > 0
        for (const mesh of [layer.color, layer.depth]) {
          const userData = mesh.userData as ExtrusionMeshUserData
          userData.extrusionZoomFactor = factor
          userData.extrusionOpacity = opacity
        }
      }
    }
  }

  protected disposeMeshes(tile: ExtrusionTile): void {
    if (tile.group !== null) {
      this.object.remove(tile.group)
      // Each mesh draws its own instanced copy of the layer's geometry (world copies on the flat map).
      for (const layer of tile.layers) {
        layer.color.geometry.dispose()
        layer.depth.geometry.dispose()
      }
    }
    tile.group = null
    tile.layers = []
    tile.attributes = null
  }

  protected releaseTile(tile: ExtrusionTile): void {
    tile.lease.release()
    tile.refresh?.release()
    tile.refresh = null
    this.disposeMeshes(tile)
  }
}

function isReady(tile: ExtrusionTile): boolean {
  return tile.loaded && (tile.extrusions === null || tile.ready)
}

function overlaps(a: ExtrusionTile, b: ExtrusionTile): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

export function extrusionTileKey({ sourceId, x, y, z, zoom }: TileRequest): string {
  return `e:${zoom}/${z}/${x}/${y}/${sourceId}`
}

/**
 * The grid with its unknown points (NaN) set to their nearest known point, row by row from the north-west, or null
 * when none is known. A copy: the grid keeps NaN where the terrain is still to be read.
 */
export function fillUnknownGridPoints(grid: Float64Array, cells: number): Float64Array | null {
  const side = cells + 1
  const known: number[] = []
  for (let index = 0; index < grid.length; index++) if (!Number.isNaN(grid[index]!)) known.push(index)
  if (known.length === 0) return null
  if (known.length === grid.length) return grid
  const filled = new Float64Array(grid)
  for (let index = 0; index < grid.length; index++) {
    if (!Number.isNaN(grid[index]!)) continue
    let best = known[0]!
    let bestDistance = Infinity
    for (const other of known) {
      const distance = (other % side - (index % side)) ** 2 + (Math.floor(other / side) - Math.floor(index / side)) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        best = other
      }
    }
    filled[index] = grid[best]!
  }
  return filled
}

/**
 * Each building's elevation: the lowest ground under its footprint, read bilinearly from the grid at the corners and
 * centre of its bounds (tile units). The lowest, so a building on a slope sinks into it on the uphill side rather
 * than float on the downhill side, as in MapLibre.
 */
export function buildingElevations(grid: Float64Array, cells: number, bounds: Float32Array): Float32Array {
  const side = cells + 1
  const at = (x: number, y: number): number => {
    const gridX = Math.min(cells, Math.max(0, (x / TILE_EXTENT) * cells))
    const gridY = Math.min(cells, Math.max(0, (y / TILE_EXTENT) * cells))
    const column = Math.min(cells - 1, Math.floor(gridX))
    const row = Math.min(cells - 1, Math.floor(gridY))
    const fx = gridX - column
    const fy = gridY - row
    const index = row * side + column
    const top = grid[index]! + (grid[index + 1]! - grid[index]!) * fx
    const bottom = grid[index + side]! + (grid[index + side + 1]! - grid[index + side]!) * fx
    return top + (bottom - top) * fy
  }
  const count = bounds.length / 4
  const elevations = new Float32Array(count)
  for (let building = 0; building < count; building++) {
    const minimumX = bounds[building * 4]!
    const minimumY = bounds[building * 4 + 1]!
    const maximumX = bounds[building * 4 + 2]!
    const maximumY = bounds[building * 4 + 3]!
    elevations[building] = Math.min(
      at(minimumX, minimumY),
      at(maximumX, minimumY),
      at(minimumX, maximumY),
      at(maximumX, maximumY),
      at((minimumX + maximumX) / 2, (minimumY + maximumY) / 2),
    )
  }
  return elevations
}
