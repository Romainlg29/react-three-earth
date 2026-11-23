import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Group, Matrix4, Vector2, Vector3, type Camera, type Mesh } from 'three'
import type { MeshBasicNodeMaterial } from 'three/webgpu'

import { isOccludedByEllipsoid } from '../../core/projection.js'
import type { ViewMorph } from '../../view/ViewMorph.js'
import { longitudeToMercatorX, wrapMercatorXNear } from '../../view/webMercator.js'
import { computeCameraTilePyramid, horizonCap, tileRowToLatitude } from '../CameraTilePyramid.js'
import type { Lease } from '../RefCountedCache.js'
import type { GlyphAtlasTexture } from '../VectorTileMeshes.js'
import { SYMBOL_ALLOW_OVERLAP, SYMBOL_IGNORE_PLACEMENT } from '../worker/symbols.js'
import { TILE_EXTENT, type MapStyleSummary, type SymbolMesh, type TileBucket, type TileRequest } from '../worker/types.js'
import { SymbolPlacement, type PlacementCandidate, type SymbolFade } from './SymbolPlacement.js'
import { createSymbolMaterial, createSymbolTileMesh, SymbolStateTexture, type SymbolMeshUserData } from './symbolMaterial.js'

/** What labels facing the viewer need from the earth in a frame. `Earth.update` builds it once for every source. */
export interface SymbolFrame {
  camera: Camera
  widthPixels: number
  heightPixels: number
  /** The camera's continuous zoom at the screen centre (`earth.camera`), for `text-size` between zooms. */
  zoom: number
  /** Distance from the camera to the screen centre, in scene metres: labels further away shrink a little (MapLibre). */
  centerDistanceMeters: number
  view: ViewMorph
  /** Height of the terrain as drawn (radians in), or null where no tile is loaded. Null without terrain. */
  sampleTerrainElevation: ((longitudeRadians: number, latitudeRadians: number) => number | null) | null
  /** Terrain height reads left this frame, shared by every source. */
  elevationBudget: { remaining: number; deadlineMilliseconds: number }
  timeMilliseconds: number
  deltaSeconds: number
  /** Asks for another frame (a tile arrived between frames). */
  requestFrame: () => void
}

/** What `ScreenSymbols` needs from its map style overlay. */
export interface ScreenSymbolsHost {
  readonly summary: MapStyleSummary | null
  readonly glyphAtlas: GlyphAtlasTexture
  /** Deepest zoom labels are laid out at (the overlay's `maximumZoom`). */
  readonly maximumZoom: number
  /** Locks a processed symbol tile in the overlay's tile cache. */
  acquireSymbolTile(request: TileRequest): Lease<{ bucket: TileBucket }>
}

export interface ScreenSymbolsInspection {
  /** Symbol tiles the camera asks for, and those drawn (loaded ones, plus older ones standing in for tiles still loading). */
  tilesRequested: number
  tilesDrawn: number
  /** Labels in drawn tiles, labels on the screen (fading in or shown), and labels hidden by collisions. */
  labels: number
  labelsShown: number
  labelsCollided: number
  /** Main-thread time of the last placement (projection, collision), in milliseconds. */
  placementMilliseconds: number
  /** Terrain height reads waiting for a frame's budget. */
  elevationsPending: number
}

/** A label on the screen, from `getScreenLabels`. */
export interface ScreenLabelInspection {
  layerIndex: number
  text: string
  xPixels: number
  yPixels: number
  /** Collision box, padding included: left, top, right, bottom. */
  box: [number, number, number, number]
  opacity: number
  ignorePlacement: boolean
  allowOverlap: boolean
}

/** Between two placements while the camera moves; positions follow every frame. */
const PLACEMENT_INTERVAL_MILLISECONDS = 100
/** While idle, labels are still re-projected this often, to follow terrain that loaded finer. */
const IDLE_PASS_INTERVAL_MILLISECONDS = 1000
/** Terrain heights under labels are read again this often, as finer terrain loads. */
const ELEVATION_REFRESH_MILLISECONDS = 3000
/** A label whose terrain had no tile loaded is tried again after this long. */
const ELEVATION_RETRY_MILLISECONDS = 500
/**
 * Lowest height a label stands at. Coarse terrain tiles sag kilometres below the ellipsoid between their vertices
 * (a chord of the curved Earth); the lowest dry land is 430 m below sea level.
 */
const MINIMUM_LABEL_HEIGHT_METERS = -500
/** Labels whose anchor is this far outside the screen still project (their text may reach in). */
const SCREEN_MARGIN_PIXELS = 256

/** One symbol tile: its labels, GPU mesh and per-frame screen state. */
interface SymbolTile {
  key: string
  request: TileRequest
  /** Normalised Web Mercator range of the data tile (x east, y south, 0 to 1), for overlap tests. */
  left: number
  top: number
  right: number
  bottom: number
  lease: Lease<{ bucket: TileBucket }>
  /** A fresher copy being processed after a style or data change; replaces this one when it arrives. */
  refresh: Lease<{ bucket: TileBucket }> | null
  loaded: boolean
  symbols: SymbolMesh | null
  mesh: Mesh | null
  longitudes: Float64Array
  latitudes: Float64Array
  /** Surface point and up direction per label, ECEF. */
  surface: Float64Array
  up: Float64Array
  /** Terrain height per label (NaN until read), and when it was read. */
  heights: Float64Array
  heightReadAt: Float64Array
  /** The label's fade state from the last placement (null: not placed, duplicate, or not seen yet). */
  fades: Array<SymbolFade | null>
  candidates: LabelCandidate[]
  /** This frame: projected (1) or culled (0), and where. */
  projected: Uint8Array
  screen: Float32Array
  slotBase: number
  drawn: boolean
}

/** A placement candidate with the label it stands for. */
interface LabelCandidate extends PlacementCandidate {
  tile: SymbolTile
  index: number
}

const point = new Vector3()
const cartographic = { lat: 0, lon: 0, height: 0 }
const viewProjection = new Matrix4()

/**
 * The labels of one map style source that face the viewer (MapLibre's symbols), drawn over the terrain at constant
 * size. Tiles come from a camera-driven pyramid (`computeCameraTilePyramid`), so labels do not repeat or vanish at
 * terrain level seams. Each frame, anchors are lifted onto the terrain, projected, culled behind the horizon, and
 * placed a few times a second in one collision grid for the whole screen (`SymbolPlacement`), then fade in and out.
 * One draw per tile; the vertex shader moves glyphs to their label's screen position from a state texture.
 *
 * Hidden while the view morphs between the globe and the flat map; shown on both.
 */
export class ScreenSymbols {
  /** Add it to the scene: holds one mesh per drawn tile. `Terrain` adds it under the earth. */
  readonly object = new Group()
  protected readonly host: ScreenSymbolsHost
  protected readonly tiles = new Map<string, SymbolTile>()
  protected readonly placement: SymbolPlacement
  protected readonly state = new SymbolStateTexture()
  protected readonly viewportPixels = { value: new Vector2(1, 1) }
  protected readonly luminance = { value: 1 }
  protected readonly material: MeshBasicNodeMaterial
  protected requestedKeys = new Set<string>()
  protected lastPyramidMilliseconds = -Infinity
  protected lastPlacementMilliseconds = -Infinity
  /** Something changed since the last placement: tiles, heights, the camera. */
  protected placementDue = true
  /** Whether an opacity was still changing after the last frame. */
  protected fading = false
  protected wasMorphing = false
  protected lastPassMilliseconds = -Infinity
  protected tilesChanged = true
  protected statistics: ScreenSymbolsInspection = { tilesRequested: 0, tilesDrawn: 0, labels: 0, labelsShown: 0, labelsCollided: 0, placementMilliseconds: 0, elevationsPending: 0 }
  protected disposed = false
  protected readonly lastCameraMatrix = new Matrix4()
  protected readonly lastProjectionMatrix = new Matrix4()
  /** The last frame's `requestFrame`: a tile that arrives between frames asks for one. */
  protected requestFrame: (() => void) | null = null

  constructor(host: ScreenSymbolsHost, { fadeDurationSeconds = 0.3 }: { fadeDurationSeconds?: number } = {}) {
    this.host = host
    this.placement = new SymbolPlacement({ fadeDurationSeconds })
    this.material = createSymbolMaterial(host.glyphAtlas, this.state, this.viewportPixels, this.luminance)
    this.object.name = 'MapStyleSymbols'
    this.object.matrixAutoUpdate = false
    this.object.raycast = () => {}
  }

  inspect(): ScreenSymbolsInspection {
    return { ...this.statistics }
  }

  /**
   * The labels on the screen as of the last frame (fading in or shown): text (`key` without its layer), anchor and
   * collision box in CSS pixels, opacity. For tests and devtools.
   */
  getScreenLabels(): ScreenLabelInspection[] {
    const labels: ScreenLabelInspection[] = []
    for (const tile of this.tiles.values()) {
      const symbols = tile.symbols
      if (!tile.drawn || symbols === null) continue
      for (let index = 0; index < symbols.keys.length; index++) {
        const fade = tile.fades[index]
        if (fade == null || fade.opacity <= 0 || tile.projected[index] === 0) continue
        const candidate = tile.candidates[index]!
        const key = symbols.keys[index]!
        labels.push({
          layerIndex: candidate.layerIndex,
          text: key.slice(key.indexOf('\u0000') + 1),
          xPixels: candidate.xPixels,
          yPixels: candidate.yPixels,
          box: [candidate.minimumXPixels, candidate.minimumYPixels, candidate.maximumXPixels, candidate.maximumYPixels],
          opacity: fade.opacity,
          ignorePlacement: candidate.ignorePlacement,
          allowOverlap: candidate.allowOverlap,
        })
      }
    }
    return labels
  }

  /** True while symbol tiles the camera asks for are still being processed. */
  get loading(): boolean {
    for (const key of this.requestedKeys) if (this.tiles.get(key)?.loaded !== true) return true
    return false
  }

  /**
   * Picks the tiles for the camera, places the labels and moves them for this frame. Returns true while another
   * frame is needed (fading, tiles loading, a placement or terrain reads waiting).
   */
  update(frame: SymbolFrame): boolean {
    this.requestFrame = frame.requestFrame
    const summary = this.host.summary
    if (this.disposed || summary === null) return false
    const { camera, view, timeMilliseconds } = frame
    camera.updateMatrixWorld()
    const cameraMoved =
      !this.lastCameraMatrix.equals(camera.matrixWorld) ||
      !this.lastProjectionMatrix.equals(camera.projectionMatrix) ||
      this.viewportPixels.value.x !== frame.widthPixels ||
      this.viewportPixels.value.y !== frame.heightPixels
    if (cameraMoved) {
      this.lastCameraMatrix.copy(camera.matrixWorld)
      this.lastProjectionMatrix.copy(camera.projectionMatrix)
      this.placementDue = true
    }
    this.viewportPixels.value.set(frame.widthPixels, frame.heightPixels)
    this.luminance.value = view.flatMapLuminance
    this.host.glyphAtlas.upload()

    // The morph moves the ground on the GPU between two projections: labels wait for it to settle.
    const morphing = view.transitioning || (view.morph > 0 && view.morph < 1)
    if (!morphing && (cameraMoved || this.tilesChanged || timeMilliseconds - this.lastPyramidMilliseconds > 1000)) {
      this.requestTiles(frame, summary)
      this.lastPyramidMilliseconds = timeMilliseconds
    }
    const tilesChanged = this.tilesChanged
    this.tilesChanged = false
    this.chooseDrawnTiles()

    // Nothing moved, nothing fades, nothing waits: the state texture already holds this frame. A pass still runs
    // now and then to pick up terrain heights refined since.
    const idle =
      !cameraMoved &&
      !tilesChanged &&
      !this.placementDue &&
      !this.fading &&
      this.statistics.elevationsPending === 0 &&
      morphing === this.wasMorphing &&
      timeMilliseconds - this.lastPassMilliseconds < IDLE_PASS_INTERVAL_MILLISECONDS
    if (idle) return this.loading
    this.wasMorphing = morphing
    this.lastPassMilliseconds = timeMilliseconds

    let needsFrame = false
    const candidates: LabelCandidate[] = []
    if (!morphing) needsFrame = this.projectLabels(frame, candidates) || needsFrame
    const placementWaits = this.placementDue && timeMilliseconds - this.lastPlacementMilliseconds < PLACEMENT_INTERVAL_MILLISECONDS
    if (this.placementDue && !placementWaits) {
      const start = performance.now()
      this.placement.place(morphing ? [] : candidates, frame.widthPixels, frame.heightPixels)
      // Labels left out of this placement (culled, waiting for their height) have no fade state until the next.
      for (const tile of this.tiles.values()) tile.fades.fill(null)
      for (const candidate of candidates) candidate.tile.fades[candidate.index] = candidate.fade
      this.statistics.placementMilliseconds = performance.now() - start
      this.statistics.labelsCollided = candidates.reduce((count, candidate) => count + (candidate.fade !== null && !candidate.placed ? 1 : 0), 0)
      this.lastPlacementMilliseconds = timeMilliseconds
      this.placementDue = false
    }
    this.fading = this.placement.fade(frame.deltaSeconds)
    needsFrame = this.fading || needsFrame
    this.writeState()
    return needsFrame || this.placementDue || this.loading
  }

  /** The style loaded or its sources changed: asks for a frame, which picks tiles again. */
  summaryChanged(): void {
    this.tilesChanged = true
    this.requestFrame?.()
  }

  /**
   * Processes again the held tiles `matches` selects (their style, data or feature-state changed). Each keeps showing
   * its labels until the new ones arrive.
   */
  refresh(matches: (request: TileRequest) => boolean): void {
    for (const tile of this.tiles.values()) {
      if (!matches(tile.request)) continue
      tile.refresh?.release()
      const refresh = this.host.acquireSymbolTile(tile.request)
      tile.refresh = refresh
      refresh.promise.then(
        ({ bucket }) => {
          if (tile.refresh !== refresh || this.tiles.get(tile.key) !== tile) return
          tile.lease.release()
          tile.lease = refresh
          tile.refresh = null
          this.setTileSymbols(tile, bucket.symbols ?? null)
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
    this.material.dispose()
    this.state.dispose()
    this.object.removeFromParent()
  }

  /** Asks for the pyramid's tiles of every source, keeping tiles already held. */
  protected requestTiles(frame: SymbolFrame, summary: MapStyleSummary): void {
    const { view, camera } = frame
    const flat = view.morph === 1
    camera.updateMatrixWorld()
    const cameraPosition = point.setFromMatrixPosition(camera.matrixWorld).clone()
    const pyramid = computeCameraTilePyramid({
      camera,
      widthPixels: frame.widthPixels,
      heightPixels: frame.heightPixels,
      toScenePosition: (longitude, latitude, target, centerLongitude) => toScenePosition(view, flat, longitude, latitude, 0, target, centerLongitude),
      visibleCap: flat ? null : horizonCap(cameraPosition),
      cameraHeightMeters: cameraHeightAboveSurface(view, flat, cameraPosition),
      maximumZoom: this.host.maximumZoom,
    })
    const requested = new Set<string>()
    for (const source of summary.sources) {
      for (const tile of pyramid) {
        if (tile.z < source.minimumZoom) continue
        const z = Math.min(tile.z, source.maximumZoom)
        const shift = tile.z - z
        const request: TileRequest = { sourceId: source.id, x: tile.x >> shift, y: tile.y >> shift, z, zoom: tile.z, symbols: true }
        const key = symbolTileKey(request)
        if (requested.has(key)) continue
        requested.add(key)
        if (!this.tiles.has(key)) this.addTile(key, request)
      }
    }
    this.requestedKeys = requested
    this.statistics.tilesRequested = requested.size
  }

  protected addTile(key: string, request: TileRequest): void {
    const count = 2 ** request.z
    const lease = this.host.acquireSymbolTile(request)
    const tile: SymbolTile = {
      key,
      request,
      left: request.x / count,
      top: request.y / count,
      right: (request.x + 1) / count,
      bottom: (request.y + 1) / count,
      lease,
      refresh: null,
      loaded: false,
      symbols: null,
      mesh: null,
      longitudes: new Float64Array(0),
      latitudes: new Float64Array(0),
      surface: new Float64Array(0),
      up: new Float64Array(0),
      heights: new Float64Array(0),
      heightReadAt: new Float64Array(0),
      fades: [],
      candidates: [],
      projected: new Uint8Array(0),
      screen: new Float32Array(0),
      slotBase: -1,
      drawn: false,
    }
    this.tiles.set(key, tile)
    lease.promise.then(
      ({ bucket }) => {
        if (this.tiles.get(key) !== tile) return
        this.setTileSymbols(tile, bucket.symbols ?? null)
      },
      error => {
        if (this.tiles.get(key) !== tile) return
        // A failed tile shows nothing; it is asked for again once the camera leaves and comes back.
        if ((error as Error | undefined)?.name !== 'AbortError') console.warn(`MapStyleSource: labels of tile ${request.z}/${request.x}/${request.y} could not be processed. ${(error as Error).message}`)
        this.setTileSymbols(tile, null)
      },
    )
  }

  /** Puts a tile's (new) labels in place: geographic anchors, GPU mesh, state slots. */
  protected setTileSymbols(tile: SymbolTile, symbols: SymbolMesh | null): void {
    if (tile.mesh !== null) {
      this.object.remove(tile.mesh)
      tile.mesh.geometry.dispose()
      tile.mesh = null
    }
    if (tile.slotBase !== -1) this.state.release(tile.slotBase, tile.symbols?.keys.length ?? 0)
    tile.slotBase = -1
    tile.symbols = symbols
    tile.loaded = true
    this.tilesChanged = true
    this.placementDue = true
    this.requestFrame?.()
    const count = symbols?.keys.length ?? 0
    tile.longitudes = new Float64Array(count)
    tile.latitudes = new Float64Array(count)
    tile.surface = new Float64Array(count * 3)
    tile.up = new Float64Array(count * 3)
    tile.heights = new Float64Array(count).fill(Number.NaN)
    tile.heightReadAt = new Float64Array(count).fill(-Infinity)
    tile.fades = new Array<SymbolFade | null>(count).fill(null)
    tile.projected = new Uint8Array(count)
    tile.screen = new Float32Array(count * 3)
    tile.candidates = []
    if (symbols === null || count === 0) return
    const { x, y, z } = tile.request
    const tilesAcross = 2 ** z
    const order = (tile.request.zoom * 2 ** 22 + ((y * tilesAcross + x) % 2 ** 20)) * 2 ** 10
    for (let index = 0; index < count; index++) {
      const longitude = ((x + symbols.anchors[index * 2]! / TILE_EXTENT) / tilesAcross) * 2 * Math.PI - Math.PI
      const latitude = tileRowToLatitude(y + symbols.anchors[index * 2 + 1]! / TILE_EXTENT, z)
      tile.longitudes[index] = longitude
      tile.latitudes[index] = latitude
      WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, 0, point)
      tile.surface.set([point.x, point.y, point.z], index * 3)
      const cosine = Math.cos(latitude)
      tile.up.set([cosine * Math.cos(longitude), cosine * Math.sin(longitude), Math.sin(latitude)], index * 3)
      const flags = symbols.flags[index]!
      tile.candidates.push({
        key: symbols.keys[index]!,
        xPixels: 0,
        yPixels: 0,
        minimumXPixels: 0,
        minimumYPixels: 0,
        maximumXPixels: 0,
        maximumYPixels: 0,
        layerIndex: symbols.layerIndices[index]!,
        sortKey: symbols.sortKeys[index]!,
        allowOverlap: (flags & SYMBOL_ALLOW_OVERLAP) !== 0,
        ignorePlacement: (flags & SYMBOL_IGNORE_PLACEMENT) !== 0,
        // Deeper tiles first among equals: their positions are the most precise.
        order: -order + index,
        fade: null,
        placed: false,
        match: null,
        tile,
        index,
      })
    }
    tile.slotBase = this.state.allocate(count)
    const mesh = createSymbolTileMesh(symbols, this.material)
    ;(mesh.userData as SymbolMeshUserData).symbolSlotBase = tile.slotBase
    mesh.visible = tile.drawn
    tile.mesh = mesh
    this.object.add(mesh)
  }

  /**
   * Draws the requested tiles that loaded, and keeps drawing older tiles that overlap a requested tile still
   * loading (its parent or children), so labels do not blink while zooming. Releases the rest.
   */
  protected chooseDrawnTiles(): void {
    const waiting: SymbolTile[] = []
    for (const key of this.requestedKeys) {
      const tile = this.tiles.get(key)
      if (tile !== undefined && !tile.loaded) waiting.push(tile)
    }
    let drawnCount = 0
    for (const [key, tile] of this.tiles) {
      const requested = this.requestedKeys.has(key)
      let drawn = requested && tile.loaded
      if (!requested) {
        drawn = tile.loaded && tile.drawn && waiting.some(other => other.request.sourceId === tile.request.sourceId && overlaps(tile, other))
        if (!drawn) {
          this.releaseTile(tile)
          this.tiles.delete(key)
          this.tilesChanged = true
          continue
        }
      }
      if (drawn !== tile.drawn) this.placementDue = true
      tile.drawn = drawn
      if (tile.mesh !== null) tile.mesh.visible = drawn
      if (drawn) drawnCount++
    }
    this.statistics.tilesDrawn = drawnCount
  }

  protected releaseTile(tile: SymbolTile): void {
    tile.lease.release()
    tile.refresh?.release()
    tile.refresh = null
    if (tile.mesh !== null) {
      this.object.remove(tile.mesh)
      tile.mesh.geometry.dispose()
      tile.mesh = null
    }
    if (tile.slotBase !== -1) this.state.release(tile.slotBase, tile.symbols?.keys.length ?? 0)
    tile.slotBase = -1
  }

  /**
   * Lifts each label of the drawn tiles onto the terrain, projects it, and fills `candidates` with those in front of
   * the camera, above the horizon and near the screen. Returns true when terrain reads had to wait.
   */
  protected projectLabels(frame: SymbolFrame, candidates: LabelCandidate[]): boolean {
    const { camera, view, widthPixels, heightPixels, timeMilliseconds } = frame
    const flat = view.morph === 1
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const matrix = viewProjection.elements
    const cameraPosition = new Vector3().setFromMatrixPosition(camera.matrixWorld)
    const queryElevation = frame.sampleTerrainElevation
    const budget = frame.elevationBudget
    let elevationsPending = 0
    let labels = 0
    for (const tile of this.tiles.values()) {
      const symbols = tile.symbols
      tile.projected.fill(0)
      if (!tile.drawn || symbols === null) continue
      const count = symbols.keys.length
      labels += count
      const sizeFraction = Math.min(1, Math.max(0, frame.zoom - tile.request.zoom))
      for (let index = 0; index < count; index++) {
        let height = tile.heights[index]!
        const known = !Number.isNaN(height)
        if (queryElevation === null) {
          if (!known) tile.heights[index] = height = 0
        }
        const groundHeight = known ? height : 0
        // Behind the globe (tested on the ellipsoid or above: coarse terrain sags below it between its vertices).
        if (!flat && isOccludedByEllipsoid(cameraPosition, this.labelPosition(tile, index, flat, view, Math.max(0, groundHeight)))) continue
        const scenePoint = this.labelPosition(tile, index, flat, view, groundHeight)
        let clipX = matrix[0]! * scenePoint.x + matrix[4]! * scenePoint.y + matrix[8]! * scenePoint.z + matrix[12]!
        let clipY = matrix[1]! * scenePoint.x + matrix[5]! * scenePoint.y + matrix[9]! * scenePoint.z + matrix[13]!
        let clipW = matrix[3]! * scenePoint.x + matrix[7]! * scenePoint.y + matrix[11]! * scenePoint.z + matrix[15]!
        if (clipW <= 0) continue
        let xPixels = ((clipX / clipW + 1) / 2) * widthPixels
        let yPixels = ((1 - clipY / clipW) / 2) * heightPixels
        if (xPixels < -SCREEN_MARGIN_PIXELS || xPixels > widthPixels + SCREEN_MARGIN_PIXELS || yPixels < -SCREEN_MARGIN_PIXELS || yPixels > heightPixels + SCREEN_MARGIN_PIXELS) continue
        if (queryElevation !== null) {
          const stale = known && timeMilliseconds - tile.heightReadAt[index]! > ELEVATION_REFRESH_MILLISECONDS
          if (!known || stale) {
            if (budget.remaining > 0 && performance.now() < budget.deadlineMilliseconds) {
              budget.remaining--
              const read = queryElevation(tile.longitudes[index]!, tile.latitudes[index]!)
              // No terrain tile there yet: stand on the ellipsoid for now and try again soon.
              const next = read === null ? (known ? height : 0) : Math.max(MINIMUM_LABEL_HEIGHT_METERS, read)
              tile.heightReadAt[index] = read === null ? timeMilliseconds - ELEVATION_REFRESH_MILLISECONDS + ELEVATION_RETRY_MILLISECONDS : timeMilliseconds
              if (next !== height || !known) {
                if (Math.abs(next - (known ? height : 0)) > 1) this.placementDue = true
                tile.heights[index] = height = next
              }
            } else {
              elevationsPending++
              // Not placed before its first height: it would jump once read.
              if (!known) continue
            }
            const lifted = this.labelPosition(tile, index, flat, view, height)
            clipX = matrix[0]! * lifted.x + matrix[4]! * lifted.y + matrix[8]! * lifted.z + matrix[12]!
            clipY = matrix[1]! * lifted.x + matrix[5]! * lifted.y + matrix[9]! * lifted.z + matrix[13]!
            clipW = matrix[3]! * lifted.x + matrix[7]! * lifted.y + matrix[11]! * lifted.z + matrix[15]!
            if (clipW <= 0) continue
            xPixels = ((clipX / clipW + 1) / 2) * widthPixels
            yPixels = ((1 - clipY / clipW) / 2) * heightPixels
          }
        }
        // Further than the centre: a little smaller; nearer: a little larger (MapLibre's perspective ratio).
        const perspectiveRatio = Math.min(4, Math.max(0, 0.5 + (0.5 * frame.centerDistanceMeters) / clipW))
        const sizePixels = symbols.sizes[index * 2]! + (symbols.sizes[index * 2 + 1]! - symbols.sizes[index * 2]!) * sizeFraction
        const scale = (sizePixels / 24) * perspectiveRatio
        tile.projected[index] = 1
        tile.screen[index * 3] = xPixels
        tile.screen[index * 3 + 1] = yPixels
        tile.screen[index * 3 + 2] = scale
        const fade = tile.fades[index]
        if (fade != null) {
          fade.xPixels = xPixels
          fade.yPixels = yPixels
        }
        const candidate = tile.candidates[index]!
        const padding = symbols.paddings[index]!
        candidate.xPixels = xPixels
        candidate.yPixels = yPixels
        candidate.minimumXPixels = xPixels + symbols.boxes[index * 4]! * scale - padding
        candidate.minimumYPixels = yPixels + symbols.boxes[index * 4 + 1]! * scale - padding
        candidate.maximumXPixels = xPixels + symbols.boxes[index * 4 + 2]! * scale + padding
        candidate.maximumYPixels = yPixels + symbols.boxes[index * 4 + 3]! * scale + padding
        candidates.push(candidate)
      }
    }
    this.statistics.labels = labels
    this.statistics.elevationsPending = elevationsPending
    return elevationsPending > 0
  }

  protected labelPosition(tile: SymbolTile, index: number, flat: boolean, view: ViewMorph, heightMeters: number): Vector3 {
    if (flat) return toScenePosition(view, true, tile.longitudes[index]!, tile.latitudes[index]!, heightMeters, point)
    const offset = index * 3
    return point.set(
      tile.surface[offset]! + tile.up[offset]! * heightMeters,
      tile.surface[offset + 1]! + tile.up[offset + 1]! * heightMeters,
      tile.surface[offset + 2]! + tile.up[offset + 2]! * heightMeters,
    )
  }

  /** Writes every slot's screen position, scale and opacity, and uploads the state. */
  protected writeState(): void {
    let shown = 0
    for (const tile of this.tiles.values()) {
      if (tile.slotBase === -1) continue
      const count = tile.symbols?.keys.length ?? 0
      for (let index = 0; index < count; index++) {
        const slot = tile.slotBase + index
        const fade = tile.fades[index]
        if (!tile.drawn || tile.projected[index] === 0 || fade == null || fade.opacity <= 0) {
          this.state.hide(slot)
          continue
        }
        shown++
        this.state.write(slot, tile.screen[index * 3]!, tile.screen[index * 3 + 1]!, tile.screen[index * 3 + 2]!, fade.opacity)
      }
    }
    this.statistics.labelsShown = shown
    this.state.upload()
  }
}

/**
 * Scene position of a geographic point: on the globe, or on the flat map's world copy nearest the camera (the copy of
 * `referenceLongitudeRadians`, when given, so points of one tile stay together).
 */
function toScenePosition(view: ViewMorph, flat: boolean, longitudeRadians: number, latitudeRadians: number, heightMeters: number, target: Vector3, referenceLongitudeRadians = longitudeRadians): Vector3 {
  if (!flat) return WGS84_ELLIPSOID.getCartographicToPosition(latitudeRadians, longitudeRadians, heightMeters, target) as Vector3
  const flatPoint = view.geodeticToFlat(longitudeRadians, latitudeRadians, heightMeters, target)
  const referenceX = longitudeToMercatorX(referenceLongitudeRadians)
  flatPoint.x += wrapMercatorXNear(referenceX, view.worldCopyReferenceXMeters) - referenceX
  return flatPoint.applyMatrix4(view.flatToEarth)
}

/** The camera's height above the ellipsoid (the map's plane on the flat map), in scene metres. */
function cameraHeightAboveSurface(view: ViewMorph, flat: boolean, cameraPosition: Vector3): number {
  if (flat) return point.copy(cameraPosition).applyMatrix4(view.earthToFlat).z * view.scale
  WGS84_ELLIPSOID.getPositionToCartographic(cameraPosition, cartographic)
  return cartographic.height
}

function overlaps(a: SymbolTile, b: SymbolTile): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Cache key of a symbol tile in the overlay's tile cache (apart from draped tiles of the same coordinates). */
export function symbolTileKey({ sourceId, x, y, z, zoom }: TileRequest): string {
  return `s:${zoom}/${z}/${x}/${y}/${sourceId}`
}
