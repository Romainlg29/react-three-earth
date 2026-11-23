import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Group, Matrix4, Vector2, Vector3, type Camera, type Mesh } from 'three'
import type { MeshBasicNodeMaterial } from 'three/webgpu'

import { isOccludedByEllipsoid } from '../../core/projection.js'
import type { ViewMorph } from '../../view/ViewMorph.js'
import { longitudeToMercatorX, wrapMercatorXNear } from '../../view/webMercator.js'
import { computeCameraTilePyramid, horizonCap, tileRowToLatitude } from '../CameraTilePyramid.js'
import type { Lease } from '../RefCountedCache.js'
import type { GlyphAtlasTexture } from '../VectorTileMeshes.js'
import { SYMBOL_ALLOW_OVERLAP, SYMBOL_IGNORE_PLACEMENT, SYMBOL_KEEP_UPRIGHT, SYMBOL_LINE } from '../worker/symbols.js'
import { TILE_EXTENT, type MapStyleSummary, type ScreenLabelHit, type SymbolMesh, type TileBucket, type TileRequest } from '../worker/types.js'
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
  /** Terrain height reads left this frame, and milliseconds of reading, shared by every source. */
  elevationBudget: { remaining: number; milliseconds: number }
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
  /** The imagery layer's opacity: labels fade with it. */
  readonly opacity: number
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
  /** A label along a line: one box per glyph (padding included), which collide; null for a point label. */
  glyphBoxes: Array<[number, number, number, number]> | null
  /** A label along a line: each glyph's angle on the screen in radians (0 reads left to right); null for a point label. */
  glyphAnglesRadians: number[] | null
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
  /** Line labels: ECEF surface point and up per path point (`SymbolMesh.linePoints`), geographic too for the map. */
  pathSurface: Float64Array
  pathUp: Float64Array
  pathLongitudes: Float64Array
  pathLatitudes: Float64Array
  /** Line label glyphs this frame: screen position (CSS pixels) and angle (radians, y down), three per glyph. */
  glyphScreen: Float32Array
  /** First slot of the tile's glyphs in the glyph state texture; -1 when it has none. */
  glyphSlotBase: number
  /** Line labels, per label: 1 while turned around to read left to right (kept near vertical, so it does not flip back and forth). */
  lineFlipped: Uint8Array
  /** Per label: `projected` of the previous pass, so a road name whose layout fails keeps its glyphs only if it showed then. */
  projectedBefore: Uint8Array
  drawn: boolean
}

/** A placement candidate with the label it stands for. */
interface LabelCandidate extends PlacementCandidate {
  tile: SymbolTile
  index: number
}

const point = new Vector3()
/** A line label's path on the screen this frame, two numbers per point, projected as the walk reaches them. */
let pathScreen = new Float64Array(64)
let pathProjected = new Uint8Array(32)
const PATH_UNKNOWN = 0
const PATH_IN_FRONT = 1
const PATH_BEHIND = 2
/** The line label being laid out: what `projectPathPoint` needs. */
const lineWalk = {
  tile: null as SymbolTile | null,
  start: 0,
  count: 0,
  anchor: 0,
  heightMeters: 0,
  flat: false,
  view: null as ViewMorph | null,
  matrix: [] as number[],
  widthPixels: 0,
  heightPixels: 0,
  referenceLongitudeRadians: 0,
}
/** A road name turns to read left to right only once it runs this far (a fraction of its length) right to left. */
const UPRIGHT_SLACK = 0.1
/** A road name's glyphs as `walkGlyphs` lays them out (x, y, angle each), copied to the tile once they fit. */
let glyphScratch = new Float32Array(96)

/** Whether the glyphs in `glyphScratch` run right to left, past the slack. */
function readsBackwards(glyphCount: number): boolean {
  const last = (glyphCount - 1) * 3
  const dx = glyphScratch[last]! - glyphScratch[0]!
  const dy = glyphScratch[last + 1]! - glyphScratch[1]!
  return dx < -UPRIGHT_SLACK * Math.hypot(dx, dy)
}
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
  /** Per line label glyph: screen position and angle. */
  protected readonly glyphState = new SymbolStateTexture()
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
  /** The camera moved since the tiles were last chosen. */
  protected pyramidDue = true
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
    this.material = createSymbolMaterial(host.glyphAtlas, this.state, this.glyphState, this.viewportPixels, this.luminance, { get value() { return host.opacity } })
    this.object.name = 'MapStyleSymbols'
    this.object.matrixAutoUpdate = false
    this.object.raycast = () => {}
  }

  inspect(): ScreenSymbolsInspection {
    return { ...this.statistics }
  }

  /**
   * The labels shown on the screen whose box meets this screen box (CSS pixels: left, top, right, bottom, widened
   * by `tolerancePixels`), top style layer first, as feature query hits.
   */
  hitScreenLabels(box: readonly [number, number, number, number], tolerancePixels = 0): ScreenLabelHit[] {
    const hits: Array<ScreenLabelHit & { layerIndex: number }> = []
    for (const tile of this.tiles.values()) {
      const symbols = tile.symbols
      if (!tile.drawn || symbols === null) continue
      for (let index = 0; index < symbols.keys.length; index++) {
        const fade = tile.fades[index]
        const candidate = tile.candidates[index]!
        // Placed labels only, as MapLibre: one fading out after a collision no longer answers.
        if (fade == null || fade.opacity <= 0 || fade.target === 0 || tile.projected[index] === 0) continue
        if (!meetsBox(candidate.minimumXPixels, candidate.minimumYPixels, candidate.maximumXPixels, candidate.maximumYPixels, box, tolerancePixels)) continue
        const boxes = candidate.boxes
        if (boxes !== null) {
          let hit = false
          for (let offset = 0; offset < boxes.length && !hit; offset += 4) hit = meetsBox(boxes[offset]!, boxes[offset + 1]!, boxes[offset + 2]!, boxes[offset + 3]!, box, tolerancePixels)
          if (!hit) continue
        }
        const { sourceId, x, y, z, zoom } = tile.request
        const key = symbols.keys[index]!
        hits.push({ sourceId, x, y, z, zoom, layerId: key.slice(0, key.indexOf('\u0000')), sourceLayer: symbols.sourceLayers[index]!, featureIndex: symbols.featureIndices[index]!, layerIndex: candidate.layerIndex })
      }
    }
    hits.sort((a, b) => b.layerIndex - a.layerIndex)
    return hits.map(({ layerIndex: _, ...hit }) => hit)
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
          glyphBoxes: candidate.boxes === null ? null : Array.from({ length: candidate.boxes.length / 4 }, (_, box) => candidate.boxes!.slice(box * 4, box * 4 + 4) as [number, number, number, number]),
          glyphAnglesRadians: candidate.boxes === null ? null : Array.from({ length: symbols.glyphCounts[index]! }, (_, glyph) => tile.glyphScreen[(symbols.glyphStarts[index]! + glyph) * 3 + 2]!),
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
      this.pyramidDue = true
    }
    this.viewportPixels.value.set(frame.widthPixels, frame.heightPixels)
    this.luminance.value = view.flatMapLuminance
    this.host.glyphAtlas.upload()

    // The morph moves the ground on the GPU between two projections: labels wait for it to settle.
    const morphing = view.transitioning || (view.morph > 0 && view.morph < 1)
    // Entering or leaving the morph: hide the labels at once, or place them again at once.
    if (morphing !== this.wasMorphing) {
      this.placementDue = true
      this.lastPlacementMilliseconds = -Infinity
    }
    // While the camera moves, tiles are chosen again as often as labels are placed.
    const sincePyramid = timeMilliseconds - this.lastPyramidMilliseconds
    if (!morphing && ((this.pyramidDue && sincePyramid >= PLACEMENT_INTERVAL_MILLISECONDS) || this.tilesChanged || sincePyramid > 1000)) {
      this.requestTiles(frame, summary)
      this.lastPyramidMilliseconds = timeMilliseconds
      this.pyramidDue = false
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
      !this.pyramidDue &&
      !this.fading &&
      this.statistics.elevationsPending === 0 &&
      morphing === this.wasMorphing &&
      timeMilliseconds - this.lastPassMilliseconds < IDLE_PASS_INTERVAL_MILLISECONDS
    // A tile that arrives asks for its own frame.
    if (idle) return false
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
    this.writeState(morphing)
    return needsFrame || this.pyramidDue || this.placementDue || this.loading
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
    this.glyphState.dispose()
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
      // Raster and elevation tiles hold no labels.
      if (source.type !== undefined && source.type !== 'vector') continue
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
      pathSurface: new Float64Array(0),
      pathUp: new Float64Array(0),
      pathLongitudes: new Float64Array(0),
      pathLatitudes: new Float64Array(0),
      glyphScreen: new Float32Array(0),
      glyphSlotBase: -1,
      lineFlipped: new Uint8Array(0),
      projectedBefore: new Uint8Array(0),
      drawn: false,
    }
    this.tiles.set(key, tile)
    lease.promise.then(
      ({ bucket }) => {
        // Replaced meanwhile: by another tile, or by a refresh that finished first.
        if (this.tiles.get(key) !== tile || tile.lease !== lease) return
        this.setTileSymbols(tile, bucket.symbols ?? null)
      },
      error => {
        if (this.tiles.get(key) !== tile || tile.lease !== lease || (error as Error | undefined)?.name === 'AbortError') return
        // A failed tile shows nothing; it is asked for again once the camera leaves and comes back.
        console.warn(
          `MapStyleSource: labels of tile ${request.z}/${request.x}/${request.y} could not be processed (${(error as Error).message}). Check that the tile decodes and the style's glyphs URL answers; the tile is retried when it comes back into view.`,
        )
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
    if (tile.glyphSlotBase !== -1) this.glyphState.release(tile.glyphSlotBase, tile.symbols?.glyphOffsets.length ?? 0)
    tile.glyphSlotBase = -1
    // The same labels again (a refresh after a feature-state or paint change): they keep their height, fade and
    // place on the screen, so they neither blink nor stop answering feature queries until the next placement.
    const previous = tile.symbols
    const same = previous !== null && symbols !== null && sameLabels(previous, symbols)
    const kept = same ? { heights: tile.heights, heightReadAt: tile.heightReadAt, fades: tile.fades, projected: tile.projected, screen: tile.screen, glyphScreen: tile.glyphScreen, lineFlipped: tile.lineFlipped, projectedBefore: tile.projectedBefore, candidates: tile.candidates } : null
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
    const pathPointCount = (symbols?.linePoints.length ?? 0) / 2
    tile.pathSurface = new Float64Array(pathPointCount * 3)
    tile.pathUp = new Float64Array(pathPointCount * 3)
    tile.pathLongitudes = new Float64Array(pathPointCount)
    tile.pathLatitudes = new Float64Array(pathPointCount)
    tile.glyphScreen = new Float32Array((symbols?.glyphOffsets.length ?? 0) * 3)
    tile.lineFlipped = new Uint8Array(count)
    tile.projectedBefore = new Uint8Array(count)
    if (symbols === null || count === 0) return
    for (let pathPoint = 0; pathPoint < pathPointCount; pathPoint++) {
      const longitude = ((tile.request.x + symbols.linePoints[pathPoint * 2]! / TILE_EXTENT) / 2 ** tile.request.z) * 2 * Math.PI - Math.PI
      const latitude = tileRowToLatitude(tile.request.y + symbols.linePoints[pathPoint * 2 + 1]! / TILE_EXTENT, tile.request.z)
      tile.pathLongitudes[pathPoint] = longitude
      tile.pathLatitudes[pathPoint] = latitude
      WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, 0, point)
      tile.pathSurface.set([point.x, point.y, point.z], pathPoint * 3)
      const cosine = Math.cos(latitude)
      tile.pathUp.set([cosine * Math.cos(longitude), cosine * Math.sin(longitude), Math.sin(latitude)], pathPoint * 3)
    }
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
        boxes: (flags & SYMBOL_LINE) !== 0 ? [] : null,
        hidden: false,
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
    if (kept !== null) {
      tile.heights = kept.heights
      tile.heightReadAt = kept.heightReadAt
      tile.fades = kept.fades
      tile.projected = kept.projected
      tile.screen = kept.screen
      if (kept.glyphScreen.length === tile.glyphScreen.length) {
        tile.glyphScreen = kept.glyphScreen
        tile.lineFlipped = kept.lineFlipped
        tile.projectedBefore = kept.projectedBefore
      }
      for (let index = 0; index < count; index++) {
        const from = kept.candidates[index]!
        const to = tile.candidates[index]!
        to.xPixels = from.xPixels
        to.yPixels = from.yPixels
        to.minimumXPixels = from.minimumXPixels
        to.minimumYPixels = from.minimumYPixels
        to.maximumXPixels = from.maximumXPixels
        to.maximumYPixels = from.maximumYPixels
        if (from.boxes !== null && to.boxes !== null) to.boxes.push(...from.boxes)
        to.fade = from.fade
        to.placed = from.placed
      }
    }
    tile.slotBase = this.state.allocate(count)
    if (symbols.glyphOffsets.length > 0) tile.glyphSlotBase = this.glyphState.allocate(symbols.glyphOffsets.length)
    const mesh = createSymbolTileMesh(symbols, this.material)
    ;(mesh.userData as SymbolMeshUserData).symbolSlotBase = tile.slotBase
    ;(mesh.userData as SymbolMeshUserData).symbolGlyphSlotBase = Math.max(0, tile.glyphSlotBase)
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
    if (tile.glyphSlotBase !== -1) this.glyphState.release(tile.glyphSlotBase, tile.symbols?.glyphOffsets.length ?? 0)
    tile.glyphSlotBase = -1
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
      tile.projectedBefore.set(tile.projected)
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
            if (budget.remaining > 0 && budget.milliseconds > 0) {
              budget.remaining--
              const readStart = performance.now()
              const read = queryElevation(tile.longitudes[index]!, tile.latitudes[index]!)
              budget.milliseconds -= performance.now() - readStart
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
        const alongLine = (symbols.flags[index]! & SYMBOL_LINE) !== 0
        // Along a line: glyphs follow the projected line, or the label waits where the line turns too sharply on the
        // screen or leaves the stretch the worker kept. One shown keeps its last glyphs and fades out from there at
        // the next placement, instead of blinking off for the frames its layout fails.
        const candidate = tile.candidates[index]!
        if (alongLine) {
          const laidOut = this.layoutLineGlyphs(tile, index, scale, Number.isNaN(height) ? 0 : height, flat, view, matrix, widthPixels, heightPixels)
          candidate.hidden = !laidOut
          if (!laidOut) {
            const fade = tile.fades[index]
            if (tile.projectedBefore[index] === 0 || fade == null || fade.opacity <= 0) continue
            // Fades out where it was, following its anchor; the next placement hides it.
            this.shiftLineGlyphs(tile, index, xPixels - candidate.xPixels, yPixels - candidate.yPixels)
            if (fade.target !== 0) this.placementDue = true
          }
        }
        tile.projected[index] = 1
        tile.screen[index * 3] = xPixels
        tile.screen[index * 3 + 1] = yPixels
        tile.screen[index * 3 + 2] = scale
        const fade = tile.fades[index]
        if (fade != null) {
          fade.xPixels = xPixels
          fade.yPixels = yPixels
        }
        const padding = symbols.paddings[index]!
        candidate.xPixels = xPixels
        candidate.yPixels = yPixels
        if (alongLine) {
          candidates.push(candidate)
          continue
        }
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

  /**
   * Lays a line label's glyphs along its projected line, from its anchor: each glyph at its distance from the
   * label's middle (times `scale`), turned to the line's direction there, the label read left to right when it
   * keeps upright. Writes `glyphScreen` and the candidate's per-glyph boxes. False when a glyph falls off the kept
   * stretch, the stretch it needs reaches behind the camera, or the line turns more than `text-max-angle` over the
   * label.
   */
  protected layoutLineGlyphs(tile: SymbolTile, index: number, scale: number, heightMeters: number, flat: boolean, view: ViewMorph, matrix: number[], widthPixels: number, heightPixels: number): boolean {
    const symbols = tile.symbols!
    const count = symbols.lineLengths[index]!
    const anchor = symbols.lineAnchors[index]!
    const glyphStart = symbols.glyphStarts[index]!
    const glyphCount = symbols.glyphCounts[index]!
    if (glyphCount === 0) return false
    if (pathScreen.length < count * 2) {
      pathScreen = new Float64Array(count * 4)
      pathProjected = new Uint8Array(count * 2)
    }
    // Points are projected only as the walk reaches them: a far end behind the camera does not hide the label.
    pathProjected.fill(PATH_UNKNOWN, 0, count)
    lineWalk.tile = tile
    lineWalk.start = symbols.lineStarts[index]!
    lineWalk.count = count
    lineWalk.anchor = anchor
    lineWalk.heightMeters = heightMeters
    lineWalk.flat = flat
    lineWalk.view = view
    lineWalk.matrix = matrix
    lineWalk.widthPixels = widthPixels
    lineWalk.heightPixels = heightPixels
    lineWalk.referenceLongitudeRadians = tile.longitudes[index]!
    if (!this.projectPathPoint(anchor)) return false
    // Upright: turned around when the first glyph would come out right of the last, with some slack around
    // vertical so a label on a road running up the screen does not turn back and forth as the camera rotates.
    // Laid out in `glyphScratch`: the label's glyphs change only once it fits.
    const keepUpright = (symbols.flags[index]! & SYMBOL_KEEP_UPRIGHT) !== 0
    let flip = keepUpright && tile.lineFlipped[index] === 1
    let fits = this.walkGlyphs(tile, index, scale, flip)
    // The other way round where it reads right to left, or does not fit this way.
    if (keepUpright && (!fits || readsBackwards(glyphCount))) {
      fits = this.walkGlyphs(tile, index, scale, !flip) && !readsBackwards(glyphCount)
      flip = !flip
    }
    if (!fits) return false
    tile.lineFlipped[index] = flip ? 1 : 0
    tile.glyphScreen.set(glyphScratch.subarray(0, glyphCount * 3), glyphStart * 3)
    this.lineGlyphBoxes(tile, index, scale)
    return true
  }

  /**
   * Places every glyph of a line label along the projected path in `lineWalk`, one incremental walk each way from
   * the anchor (glyph offsets are sorted along the label). Writes `glyphScratch`; false where the label does not fit.
   */
  protected walkGlyphs(tile: SymbolTile, index: number, scale: number, flip: boolean): boolean {
    const symbols = tile.symbols!
    const glyphStart = symbols.glyphStarts[index]!
    const glyphCount = symbols.glyphCounts[index]!
    const maximumAngle = symbols.maximumAngles[index]!
    // Glyphs before the label's middle (offsets are sorted): those behind the anchor along the path, unless flipped.
    let beforeMiddle = 0
    while (beforeMiddle < glyphCount && symbols.glyphOffsets[glyphStart + beforeMiddle]! < 0) beforeMiddle++
    if (glyphScratch.length < glyphCount * 3) glyphScratch = new Float32Array(glyphCount * 6)
    for (let step = 1; step >= -1; step -= 2) {
      let from = lineWalk.anchor
      let travelled = 0
      let segmentLength = -1
      // Glyph order along this side, nearest the anchor first.
      const nearest = flip ? (step > 0 ? beforeMiddle - 1 : beforeMiddle) : step > 0 ? beforeMiddle : beforeMiddle - 1
      const direction = flip ? -step : step
      for (let glyph = nearest; glyph >= 0 && glyph < glyphCount; glyph += direction) {
        const distance = Math.abs(symbols.glyphOffsets[glyphStart + glyph]! * scale)
        for (;;) {
          if (segmentLength < 0) {
            const to = from + step
            if (to < 0 || to >= lineWalk.count || !this.projectPathPoint(to)) return false
            segmentLength = Math.hypot(pathScreen[to * 2]! - pathScreen[from * 2]!, pathScreen[to * 2 + 1]! - pathScreen[from * 2 + 1]!)
          }
          if (distance <= travelled + segmentLength) break
          travelled += segmentLength
          from += step
          segmentLength = -1
        }
        const to = from + step
        const t = segmentLength > 0 ? (distance - travelled) / segmentLength : 0
        const dx = pathScreen[to * 2]! - pathScreen[from * 2]!
        const dy = pathScreen[to * 2 + 1]! - pathScreen[from * 2 + 1]!
        glyphScratch[glyph * 3] = pathScreen[from * 2]! + dx * t
        glyphScratch[glyph * 3 + 1] = pathScreen[from * 2 + 1]! + dy * t
        // The forward direction of the path, turned around when the label reads the other way.
        glyphScratch[glyph * 3 + 2] = (step > 0 ? Math.atan2(dy, dx) : Math.atan2(-dy, -dx)) + (flip ? Math.PI : 0)
      }
    }
    // text-max-angle over the whole label (MapLibre sums the turns over about a label length).
    let turned = 0
    for (let glyph = 1; glyph < glyphCount; glyph++) {
      let turn = Math.abs(glyphScratch[glyph * 3 + 2]! - glyphScratch[(glyph - 1) * 3 + 2]!) % (2 * Math.PI)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      turned += turn
      if (turned > maximumAngle) return false
    }
    return true
  }

  /** Moves a road name's glyphs and boxes by (dx, dy) pixels as they are: it follows its anchor while it fades out. */
  protected shiftLineGlyphs(tile: SymbolTile, index: number, dx: number, dy: number): void {
    const symbols = tile.symbols!
    const glyphStart = symbols.glyphStarts[index]!
    const glyphCount = symbols.glyphCounts[index]!
    for (let glyph = glyphStart; glyph < glyphStart + glyphCount; glyph++) {
      tile.glyphScreen[glyph * 3] = tile.glyphScreen[glyph * 3]! + dx
      tile.glyphScreen[glyph * 3 + 1] = tile.glyphScreen[glyph * 3 + 1]! + dy
    }
    const candidate = tile.candidates[index]!
    const boxes = candidate.boxes!
    for (let box = 0; box < boxes.length; box += 4) {
      boxes[box] = boxes[box]! + dx
      boxes[box + 1] = boxes[box + 1]! + dy
      boxes[box + 2] = boxes[box + 2]! + dx
      boxes[box + 3] = boxes[box + 3]! + dy
    }
    candidate.minimumXPixels += dx
    candidate.minimumYPixels += dy
    candidate.maximumXPixels += dx
    candidate.maximumYPixels += dy
  }

  /** The candidate's boxes: one per glyph, its rotated advance and the text height, centred on the text row. */
  protected lineGlyphBoxes(tile: SymbolTile, index: number, scale: number): void {
    const symbols = tile.symbols!
    const glyphStart = symbols.glyphStarts[index]!
    const glyphCount = symbols.glyphCounts[index]!
    const padding = symbols.paddings[index]!
    const halfHeight = ((symbols.boxes[index * 4 + 3]! - symbols.boxes[index * 4 + 1]!) / 2) * scale
    const middleOffset = ((symbols.boxes[index * 4 + 3]! + symbols.boxes[index * 4 + 1]!) / 2) * scale
    const candidate = tile.candidates[index]!
    const boxes = candidate.boxes!
    boxes.length = 0
    let minimumX = Infinity
    let minimumY = Infinity
    let maximumX = -Infinity
    let maximumY = -Infinity
    for (let glyph = 0; glyph < glyphCount; glyph++) {
      const glyphIndex = glyphStart + glyph
      const x = tile.glyphScreen[glyphIndex * 3]!
      const y = tile.glyphScreen[glyphIndex * 3 + 1]!
      const angle = tile.glyphScreen[glyphIndex * 3 + 2]!
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const centerX = x - middleOffset * sine
      const centerY = y + middleOffset * cosine
      const halfWidth = symbols.glyphHalfWidths[glyphIndex]! * scale
      const extentX = Math.abs(halfWidth * cosine) + Math.abs(halfHeight * sine) + padding
      const extentY = Math.abs(halfWidth * sine) + Math.abs(halfHeight * cosine) + padding
      boxes.push(centerX - extentX, centerY - extentY, centerX + extentX, centerY + extentY)
      minimumX = Math.min(minimumX, centerX - extentX)
      minimumY = Math.min(minimumY, centerY - extentY)
      maximumX = Math.max(maximumX, centerX + extentX)
      maximumY = Math.max(maximumY, centerY + extentY)
    }
    candidate.minimumXPixels = minimumX
    candidate.minimumYPixels = minimumY
    candidate.maximumXPixels = maximumX
    candidate.maximumYPixels = maximumY
  }

  /** Projects point `pathPoint` of the label in `lineWalk` into `pathScreen` once; false when behind the camera. */
  protected projectPathPoint(pathPoint: number): boolean {
    const known = pathProjected[pathPoint]!
    if (known !== PATH_UNKNOWN) return known === PATH_IN_FRONT
    const { matrix } = lineWalk
    const position = this.pathPosition(lineWalk.tile!, lineWalk.start + pathPoint, lineWalk.flat, lineWalk.view!, lineWalk.heightMeters, lineWalk.referenceLongitudeRadians)
    const clipX = matrix[0]! * position.x + matrix[4]! * position.y + matrix[8]! * position.z + matrix[12]!
    const clipY = matrix[1]! * position.x + matrix[5]! * position.y + matrix[9]! * position.z + matrix[13]!
    const clipW = matrix[3]! * position.x + matrix[7]! * position.y + matrix[11]! * position.z + matrix[15]!
    if (clipW <= 0) {
      pathProjected[pathPoint] = PATH_BEHIND
      return false
    }
    pathScreen[pathPoint * 2] = ((clipX / clipW + 1) / 2) * lineWalk.widthPixels
    pathScreen[pathPoint * 2 + 1] = ((1 - clipY / clipW) / 2) * lineWalk.heightPixels
    pathProjected[pathPoint] = PATH_IN_FRONT
    return true
  }

  /**
   * A path point at `heightMeters` (the label anchor's: glyphs away from it do not follow the terrain's slope). On
   * the map, the world copy of `referenceLongitudeRadians` (the anchor's), so a label across ±180° stays whole.
   */
  protected pathPosition(tile: SymbolTile, pathPoint: number, flat: boolean, view: ViewMorph, heightMeters: number, referenceLongitudeRadians: number): Vector3 {
    if (flat) return toScenePosition(view, true, tile.pathLongitudes[pathPoint]!, tile.pathLatitudes[pathPoint]!, heightMeters, point, referenceLongitudeRadians)
    const offset = pathPoint * 3
    return point.set(
      tile.pathSurface[offset]! + tile.pathUp[offset]! * heightMeters,
      tile.pathSurface[offset + 1]! + tile.pathUp[offset + 1]! * heightMeters,
      tile.pathSurface[offset + 2]! + tile.pathUp[offset + 2]! * heightMeters,
    )
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
  protected writeState(morphing: boolean): void {
    let shown = 0
    for (const tile of this.tiles.values()) {
      if (tile.slotBase === -1) continue
      const count = tile.symbols?.keys.length ?? 0
      for (let index = 0; index < count; index++) {
        const slot = tile.slotBase + index
        const fade = tile.fades[index]
        if (morphing || !tile.drawn || tile.projected[index] === 0 || fade == null || fade.opacity <= 0) {
          this.state.hide(slot)
          continue
        }
        shown++
        this.state.write(slot, tile.screen[index * 3]!, tile.screen[index * 3 + 1]!, tile.screen[index * 3 + 2]!, fade.opacity)
        const symbols = tile.symbols!
        const glyphCount = symbols.glyphCounts[index]!
        for (let glyph = symbols.glyphStarts[index]!, end = glyph + glyphCount; glyph < end; glyph++) {
          this.glyphState.write(tile.glyphSlotBase + glyph, tile.glyphScreen[glyph * 3]!, tile.glyphScreen[glyph * 3 + 1]!, tile.glyphScreen[glyph * 3 + 2]!, 1)
        }
      }
    }
    this.statistics.labelsShown = shown
    this.state.upload()
    this.glyphState.upload()
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

function meetsBox(left: number, top: number, right: number, bottom: number, box: readonly [number, number, number, number], tolerancePixels: number): boolean {
  return right >= box[0] - tolerancePixels && left <= box[2] + tolerancePixels && bottom >= box[1] - tolerancePixels && top <= box[3] + tolerancePixels
}

/** Same labels at the same anchors, in the same order. */
function sameLabels(a: SymbolMesh, b: SymbolMesh): boolean {
  if (a.keys.length !== b.keys.length) return false
  for (let index = 0; index < a.keys.length; index++) if (a.keys[index] !== b.keys[index]) return false
  for (let index = 0; index < a.anchors.length; index++) if (a.anchors[index] !== b.anchors[index]) return false
  return true
}

function overlaps(a: SymbolTile, b: SymbolTile): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Cache key of a symbol tile in the overlay's tile cache (apart from draped tiles of the same coordinates). */
export function symbolTileKey({ sourceId, x, y, z, zoom }: TileRequest): string {
  return `s:${zoom}/${z}/${x}/${y}/${sourceId}`
}
