import type { MultiPolygon, Position } from 'geojson'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, moveVertices, offsetVertices, removeVertex, translateFeature, type VertexPath } from '../editing.js'
import { distanceToSegment, hasAltitude, lowestAltitude, storedLines, storedPositions, unwrapLongitudeNear } from '../geometry.js'
import { LocalFrame, type LocalPoint } from '../localFrame.js'
import { indexMesh, isClosedMesh, isMeshGeometry, meshFromIndexed, meshSharpEdges, prismMesh, type IndexedMesh } from '../mesh.js'
import { extrudeMeshEdges, extrudeMeshFaces, meshElementFrame, PARALLEL_NORMALS_SHARE, meshFaceArea, meshFaceNormal, meshFaceTriangles, meshFaceVertices, moveMeshVertices, pushMeshFace } from '../meshEditing.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { isSolidFeature } from '../render/SolidFeatures.js'
import { altitudeRangeOf, featureAxes, featureCenter, offsetFeature, rotateFeatureAroundAxis, scaleFeature, scaleFeatureAlongAxis, WORLD_AXES } from '../transform.js'
import type { DrawFeature, DrawPointerEvent, DrawStyle, DrawStyleState, GroundHeight, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, NO_FEATURE_IDS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

/** Which handles the gizmo shows: all of them, or one tool's. */
export type GizmoTool = 'all' | 'move' | 'rotate' | 'scale'
/** The gizmo's axes: east, north and up, or the feature's own (`featureAxes`). */
export type GizmoSpace = 'world' | 'local'
export const GIZMO_TOOLS: readonly GizmoTool[] = Object.freeze(['all', 'move', 'rotate', 'scale'])
export const GIZMO_SPACES: readonly GizmoSpace[] = Object.freeze(['world', 'local'])

/**
 * A handle of the gizmo. x, y and z are east, north and up (in local space, the feature's own axes): `move-x` is the
 * east arrow, `move-xy` the square between east and north, `move-free` the center ring, `rotate-z` the arc around up
 * (the heading), `scale-x` the cube on the east axis, `scale-uniform` the outer ring (and the center ring with the scale
 * tool).
 */
export type GizmoHandle =
  | 'move-x'
  | 'move-y'
  | 'move-z'
  | 'move-xy'
  | 'move-yz'
  | 'move-xz'
  | 'move-free'
  | 'rotate-x'
  | 'rotate-y'
  | 'rotate-z'
  | 'scale-x'
  | 'scale-y'
  | 'scale-z'
  | 'scale-uniform'

/** The elements edit mode picks on the selected feature: its vertices, its edges or its faces. */
export type ElementMode = 'vertex' | 'edge' | 'face'
export const ELEMENT_MODES: readonly ElementMode[] = Object.freeze(['vertex', 'edge', 'face'])

/**
 * An element of the selected feature in edit mode, by vertex and face indices into its `FeatureElements`: those of
 * `indexMesh(geometry)` for a mesh (kept through the edits made in the mode), those of `featureVertices(feature)` (every
 * ring, in order) for a line or polygon, whose one face is 0.
 */
export type PickedElement = { kind: 'vertex'; index: number } | { kind: 'edge'; from: number; to: number } | { kind: 'face'; index: number }

/** The elements of a feature version, as edit mode picks them. */
export interface FeatureElements {
  /** Each vertex once. */
  positions: Position[]
  /** Each vertex's altitude, or null where it lies on the terrain. */
  heights: Array<number | null>
  /** Each edge once, as two vertex indices. */
  edges: Array<[number, number]>
  /** Faces as rings of vertex indices: a mesh's, a polygon's one face, none for a line. */
  faces: number[][][]
  /** A closed mesh: faces turned away from the camera, and what only they hold, cannot be picked. */
  closed: boolean
  /** The indexed mesh, for a mesh. */
  mesh: IndexedMesh | null
  /** Where each vertex of a line or polygon is in its coordinates. */
  paths: VertexPath[] | null
  /** The edges of each face, as indices into `edges`: a closed mesh shows only those of faces turned to the camera. */
  faceEdges: number[][]
  /** The stored version a drag moved these elements from, with the same faces: its screen pixels are reused. */
  origin?: { feature: DrawFeature; elements: FeatureElements }
}

/**
 * What `extrude()` does with what is picked: a line becomes a wall; a polygon's face (picked, or every edge or vertex of
 * it) a prism; a mesh's faces extrude as one region; edges (picked, or between two picked vertices) grow a face each, up.
 */
type Extrusion =
  | { kind: 'wall' }
  | { kind: 'prism' }
  | { kind: 'faces'; faces: number[] }
  | { kind: 'edges'; edges: Array<[number, number]> }

/** A transform the keyboard starts (G, R, S) or `startTransform`. */
export type TransformKind = 'move' | 'rotate' | 'scale'

/** Where a gizmo handle is drawn: screen pixels of the point a press grabs it at. */
export interface GizmoHandleOnScreen {
  handle: GizmoHandle
  x: number
  y: number
}

/** Options of the select mode. */
export interface SelectModeOptions {
  /** A press on a selected feature, away from the gizmo's handles, drags it whole on the ground. Default: true. */
  moveFeatures?: boolean
  /**
   * Edit mode: a second tap (or a double tap) on the selected line, polygon or mesh swaps its gizmo for its elements,
   * vertices, edges or faces (`elementMode`), to pick and drag; a tap on the empty map swaps back. Default: true.
   */
  editVertices?: boolean
  /** The elements edit mode starts with (`Draw.setElementMode` changes them). Default: 'vertex'. */
  elementMode?: ElementMode
  /** The gizmo's move handles: the axis arrows, the plane squares and the center ring. Default: true. */
  move?: boolean
  /** The gizmo's rotation arcs, one around each axis. Default: true. */
  rotate?: boolean
  /** The gizmo's scale handles: a cube on each axis and the outer ring. Default: true. */
  scale?: boolean
  /** Shift snaps turns to multiples of `snapDegrees`. Off unless enabled (opt-in). Default: false. */
  snapping?: boolean
  /** The snapping step of turns, in degrees. Default: 15. */
  snapDegrees?: number
  /** The length of the gizmo's arrows on the screen, in CSS pixels, at any zoom. Default: 80. */
  gizmoSizePixels?: number
  /** The handles to start with (`Draw.setGizmoTool` changes them). Default: 'all'. */
  gizmoTool?: GizmoTool
  /** The axes to start with (`Draw.setGizmoSpace` changes them). Default: 'world'. */
  gizmoSpace?: GizmoSpace
  /** Edits `undo()` can take back. Default: 50. */
  undoLimit?: number
}

/**
 * What a press on the selection is doing. `base` is the stored version the drag started from: if the store changes it
 * meanwhile, the drag is dropped. A `transform` drag (a gizmo handle) computes the feature from each move.
 */
export type SelectDrag =
  | {
      kind: 'vertex'
      base: DrawFeature
      feature: DrawFeature
      path: VertexPath
      inserted: boolean
      /** The vertex's altitude, where it moves level under the pointer; null on the terrain. */
      heightMeters: number | null
      /** Where the vertex is now. */
      position: LongitudeLatitude
    }
  | { kind: 'feature'; base: DrawFeature; feature: DrawFeature; origin: LongitudeLatitude }
  | { kind: 'transform'; base: DrawFeature; feature: DrawFeature; handle: GizmoHandle; update: (event: DrawPointerEvent) => DrawFeature | null }
  /** In edit mode: an element moved level under the pointer, or (`element` null) a face pushed along its normal by its arrow. */
  | { kind: 'element'; base: DrawFeature; feature: DrawFeature; element: PickedElement | null; update: (event: DrawPointerEvent) => DrawFeature | null }

type Drag = SelectDrag

/** A screen point, in CSS pixels. */
type Screen = { x: number; y: number }

/**
 * The gizmo of a feature version for the current camera: its center (the feature's center, at the middle of its
 * altitudes or on the terrain), its axes and how long `gizmoSizePixels` is there in metres.
 */
export interface GizmoBasis {
  feature: DrawFeature
  center: LongitudeLatitude
  /** The gizmo center's altitude. */
  heightMeters: number
  /** The feature's lowest altitude, or the terrain under its center when it has none. */
  baseMeters: number
  /** The feature has no altitude: it lies on the terrain. */
  onTerrain: boolean
  /** The east-north-up frame at the gizmo center. */
  frame: LocalFrame
  /**
   * Unit x, y and z axes in that frame: east, north and up or the feature's own, those pointing away from the camera
   * turned around (so the gizmo may be left-handed).
   */
  axes: readonly [LocalPoint, LocalPoint, LocalPoint]
  /** Metres that `gizmoSizePixels` covers at the center. */
  sizeMeters: number
  /** The terrain under the feature's positions, sampled once per feature version (for those getting altitudes). */
  ground: GroundHeight
  centerScreen: Screen
  /** Screen pixels of `sizeMeters` along each axis, from the center. */
  axisScreen: readonly [Screen, Screen, Screen]
  /**
   * In edit mode, the gizmo of the picked elements: moves only them by an offset in metres along east, north and up of
   * `frame`. Absent for the feature's own gizmo, which moves it whole.
   */
  moveElements?: (offset: LocalPoint) => DrawFeature
  /** Axes whose arrow hides: along a picked face's normal, where its push and pull arrow stands. */
  hiddenAxes?: readonly number[]
}

/** A drawn piece of the gizmo, in metres from its center along east, north and up. */
interface GizmoPart {
  handle: GizmoHandle
  /** `line`: a polyline; `dot`: a square; `knob`: a dot on a stem up the screen; `plane`: a filled quad; `ring`: a circle on the screen around the center. */
  kind: 'line' | 'dot' | 'knob' | 'plane' | 'ring'
  local: LocalPoint[]
  color: string
  /** Line width, dot half size or ring radius, in pixels. */
  sizePixels: number
  arrowhead?: boolean
  /** Where `gizmoHandles` says the handle is, in metres from the center (rings: on their right). */
  grab: LocalPoint
  /** The center ring with the scale tool: scales by the travel, not the distance from the center. */
  fromCenter?: boolean
  /** Screen pixels of `local`, projected once per view (null where hidden). */
  screens?: Array<Screen | null>
}

/** A gizmo handle under a press. */
interface GizmoHit {
  basis: GizmoBasis
  part: GizmoPart
  /** The press, and the part's point nearest to it (an arc's), in metres from the center. */
  nearest: LocalPoint
}

/** Screen pixels of a feature version's elements for one view (NaN where hidden), and which can be picked. */
interface ElementScreens {
  view: number | undefined
  x: Float64Array
  y: Float64Array
  /** 1 for a vertex of a face turned to the camera (every vertex of an open mesh, a line or a polygon). */
  visible: Uint8Array
  /** 1 for a face turned to the camera (every face of an open mesh or a polygon). */
  frontFaces: Uint8Array
  /** 1 for an edge of a face turned to the camera (every edge of an open mesh, a line or a polygon). */
  visibleEdges: Uint8Array
}

/** The push and pull arrow of a picked face, for one view. */
interface PushArrow {
  feature: DrawFeature
  face: number
  /** The frame at the face's middle, where the arrow starts. */
  frame: LocalFrame
  /** The face's outward unit normal in that frame. */
  normal: LocalPoint
  /** The arrow's length in metres (`gizmoSizePixels` on the screen). */
  lengthMeters: number
  from: Screen
  /** Screen pixels of `lengthMeters` along the normal (up the screen for a knob). */
  along: Screen
  /** The normal points at the camera (a top seen from above): a knob up the screen instead. */
  knob: boolean
}

/** One edit, as what restores it: features to put back, and ids to remove (features the edit created). */
interface UndoEntry {
  restore: DrawFeature[]
}

/** A move, turn or scale started from the keyboard (G, R, S): it follows the pointer, no press needed. */
interface KeyboardTransform {
  kind: TransformKind
  /** The axis it is locked to (X, Y, Z), or none. */
  axis: 0 | 1 | 2 | null
  base: DrawFeature
  feature: DrawFeature
  basis: GizmoBasis
  /** The pointer when it started. */
  start: Screen
  /** Pixels from the pointer to the gizmo center when it started: a free move keeps them. */
  grabOffset: Screen
  /** The view its feature was computed for (`viewVersion`), to follow the camera. */
  view: number | undefined
  /** The pointer now, and Shift. */
  pointer: Screen
  shiftKey: boolean
}

/** Pixels a press moves before it counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PIXELS = 4
/** Smallest scale factor a drag reaches, so a feature never collapses. */
const MINIMUM_SCALE_FACTOR = 0.01
/** The style state of selected features. */
const SELECTED_STATE: DrawStyleState = Object.freeze({ selected: true, drawing: false })
/** A feature on the terrain stays there (unchanged) unless a move raises it at least this many metres. */
const MINIMUM_LIFT_METERS = 1
/** Two taps this close in time (and within reach of each other) are a double tap. */
const DOUBLE_TAP_MILLISECONDS = 400
/** The shortest prism a polygon's face arrow pulls up, in metres: less leaves the polygon flat. */
const MINIMUM_PRISM_METERS = 0.5
/** `extrude()` without a distance goes this share of the push and pull arrow's length. */
const EXTRUDE_ARROW_SHARE = 0.5

/** A gizmo axis this near a picked face's normal (the cosine of the angle between them) leaves it to the push and pull arrow. */
const PARALLEL_AXIS_COSINE = 0.9

/** Colours of the x (east), y (north) and z (up) axes, of the rings and of the handle under the pointer. */
const AXIS_COLORS = ['#ef4444', '#22c55e', '#3b82f6'] as const
const RING_COLOR = '#ffffff'
const ACTIVE_COLOR = '#facc15'
const OUTLINE_COLOR = '#111827'

/** Proportions of the gizmo, in arrow lengths: arrows start out of the center ring and end at 1. */
const ARROW_START = 0.15
const PLANE_NEAR = 0.22
const PLANE_FAR = 0.4
const ARC_RADIUS = 0.72
const CUBE_DISTANCE = 1.16
const OUTER_RING_RADIUS = 1.3
/** Pixel sizes of the gizmo's pieces. */
const CENTER_RING_PIXELS = 9
const ARROW_WIDTH_PIXELS = 3
const ARROWHEAD_PIXELS = 14
const ARC_WIDTH_PIXELS = 2.5
const CUBE_PIXELS = 5
/** An axis shorter than this share of the arrow length on the screen points at the camera: its arrow and cube hide. */
const MINIMUM_AXIS_SHARE = 0.2
/** A plane square smaller on the screen than this share of its full size is seen edge on: it hides. */
const MINIMUM_PLANE_SHARE = 0.15
/** A rotation arc seen more face on than this (its circle's screen area, in squared arrow lengths) turns with the pointer around the center. */
const FACE_ON_SHARE = 0.25
/**
 * A rotation arc seen more edge on than this hides: it would lie on the arrows of its plane (the arc around east, seen
 * looking north), out of reach. Turn the camera a little to tilt that way, or use R then X.
 */
const EDGE_ON_SHARE = 0.1
/** Samples of the arc around z (a full circle) and of the arcs around x and y (half circles). */
const FULL_ARC_SAMPLES = 48
const HALF_ARC_SAMPLES = 24


/**
 * Selects and edits finished features. A tap selects the feature under it (points and lines before the polygons under
 * them); a tap on the empty map clears the selection. A selected line, polygon or mesh shows a gizmo at its center, the
 * same size on the screen at any zoom (`gizmoSizePixels`):
 *
 * - drag an axis arrow (x east in red, y north in green, z up in blue) to move along that axis only; up gives every
 *   position an altitude, as `liftFeature` does;
 * - drag a square between two axes to move in that plane (the one between east and north moves on the ground);
 * - drag the white center ring to move freely on the ground, the center following the pointer;
 * - drag an arc to turn around that axis through the center: around up is the heading; around east or north tilts the
 *   feature (`rotateFeatureAroundAxis`); with `snapping`, Shift snaps the turn to `snapDegrees`;
 * - drag a cube on an axis to scale along it (`scaleFeatureAlongAxis`), and the outer ring (or the center ring with the
 *   scale tool) to scale uniformly.
 *
 * `setGizmoTool` shows all the handles or one tool's, `setGizmoSpace` turns the axes to the feature's own. A press on
 * the feature away from every handle still moves it on the ground. With the `Draw`'s `keyboard` option, G, R and S move,
 * turn and scale under the pointer (X, Y, Z lock an axis; a click or Enter confirms; Escape or a right click cancels).
 *
 * Tap the selected line, polygon or mesh again (or double tap a feature) for edit mode, as Blender's: its vertices,
 * edges or faces (`setElementMode`) show instead of the gizmo. Tap one to pick it, drag one to move it level under the
 * pointer (a mesh's vertex moves in every face that shares it). A picked face shows an arrow along its normal: drag it
 * to push or pull the face (a box grows that way), or `extrude()` it first; on a polygon the arrow pulls up a prism. A
 * double tap on a mesh goes straight to its faces, the one under the pointer picked. On lines and polygons in vertex
 * mode, drag a vertex handle to move it; tap a vertex to pick it, then Delete or Backspace (or `draw.deleteSelected()`)
 * removes it; drag or tap a midpoint handle to insert a vertex there. A tap on the empty map (or Escape, or Tab) goes
 * back to the gizmo; selecting another feature starts with the gizmo again. Points have no gizmo: they move whole.
 *
 * Every edit writes new positions: nothing else describes a shape. A press anywhere else still pans the map,
 * so one finger pans between edits. Each edit fires `update` (`delete` for deletions) once, on release; `undo()` takes
 * edits back.
 */
export class SelectMode extends DrawMode {
  readonly name: string = 'select'
  readonly moveFeatures: boolean
  readonly editVertices: boolean
  readonly move: boolean
  readonly rotate: boolean
  readonly scale: boolean
  readonly snapping: boolean
  readonly snapDegrees: number
  readonly gizmoSizePixels: number
  protected tool: GizmoTool
  protected space: GizmoSpace
  protected readonly undoLimit: number
  /** Edit mode: the selected feature shows its elements rather than the gizmo. */
  protected vertexEditing = false
  /** The elements edit mode picks. */
  protected element: ElementMode
  /**
   * The picked elements of the selected feature in edit mode, on the stored version they were picked on, of the
   * current element mode, the last picked last (a line's or polygon's vertices: by their index in `featureVertices`).
   */
  protected picked: { feature: DrawFeature; elements: readonly PickedElement[] } | null = null
  /** The element under the mouse in edit mode, drawn highlighted, and whether it is over the push and pull arrow. */
  protected hoveredElement: PickedElement | null = null
  protected hoveredArrow = false
  /** The last tap, to tell a double tap. */
  protected lastTap: { x: number; y: number; time: number } | null = null
  /** The elements of feature versions (null: none to edit), and their screen pixels for the last view. */
  protected readonly elementsCache = new WeakMap<DrawFeature, FeatureElements | null>()
  protected readonly elementScreens = new WeakMap<DrawFeature, ElementScreens>()
  /** The push and pull arrow of each feature version, for a view and a face. */
  protected readonly arrowCache = new WeakMap<DrawFeature, { view: number; face: number; arrow: PushArrow | null }>()
  /** The triangles of the faces of feature versions, to fill a picked face. */
  protected readonly faceTriangles = new WeakMap<DrawFeature, Map<number, Array<[number, number, number]>>>()
  /** Local axes of feature versions (features are replaced, never changed, so a version's axes stay right). */
  protected readonly localAxes = new WeakMap<DrawFeature, [LocalPoint, LocalPoint, LocalPoint]>()
  protected selection: readonly string[] = NO_FEATURE_IDS
  /** Stops listening to the store. */
  protected unsubscribeStore: (() => void) | null = null
  /** True while the mode changes the store itself. */
  protected committing = false
  protected drag: Drag | null = null
  /** Where the press started, in pixels, and whether it moved past the threshold. */
  protected pressStart: { x: number; y: number } | null = null
  protected dragging = false
  protected readonly undoStack: UndoEntry[] = []
  /** The gizmo handle under the mouse, drawn highlighted. */
  protected hoveredHandle: GizmoHandle | null = null
  /** Where the mouse last was over the map, for keyboard transforms. */
  protected lastPointer: Screen | null = null
  protected keyboardTransform: KeyboardTransform | null = null
  /** The ground's height under the last pointer event: where the terrain is not known yet, gizmos stand at it. */
  protected groundFallbackMeters = 0
  /** Centers, altitudes and terrain samplers of feature versions. */
  protected readonly featureGeometry = new WeakMap<DrawFeature, { center: LongitudeLatitude; range: { minimumMeters: number; maximumMeters: number } | null; ground: GroundHeight | null }>()
  /** The last gizmo of each feature version, valid while the view (`viewVersion`), the space and its height stay. */
  protected readonly gizmoCache = new WeakMap<DrawFeature, { view: number; space: GizmoSpace; heightMeters: number; basis: GizmoBasis }>()
  /** The last gizmo of the picked elements of each feature version, valid while the view, the space and what is picked stay. */
  protected readonly elementGizmoCache = new WeakMap<DrawFeature, { view: number; space: GizmoSpace; picked: readonly PickedElement[]; heightMeters: number; basis: GizmoBasis }>()
  /** What `extrude()` would do with each pick, on the feature version it was computed for. */
  protected readonly extrusionCache = new WeakMap<readonly PickedElement[], { feature: DrawFeature; extrusion: Extrusion | null }>()
  /** The pieces of each gizmo, for a tool. */
  protected readonly partsCache = new WeakMap<GizmoBasis, { tool: GizmoTool; parts: GizmoPart[] }>()

  constructor({
    moveFeatures = true,
    editVertices = true,
    elementMode = 'vertex',
    move = true,
    rotate = true,
    scale = true,
    snapping = false,
    snapDegrees = 15,
    gizmoSizePixels = 80,
    gizmoTool = 'all',
    gizmoSpace = 'world',
    undoLimit = 50,
  }: SelectModeOptions = {}) {
    super()
    this.moveFeatures = moveFeatures
    this.editVertices = editVertices
    this.element = elementMode
    this.move = move
    this.rotate = rotate
    this.scale = scale
    this.snapping = snapping
    this.snapDegrees = snapDegrees
    this.gizmoSizePixels = gizmoSizePixels
    this.tool = gizmoTool
    this.space = gizmoSpace
    this.undoLimit = undoLimit
  }

  override enter(context: DrawModeContext): void {
    super.enter(context)
    context.setCursor(null)
    // Changes made elsewhere (addFeatures, clear, another tool) end what was picked and what undo would restore.
    this.unsubscribeStore = context.store.subscribe(() => {
      if (this.committing) return
      this.undoStack.length = 0
      if (this.picked !== null && context.store.get(this.picked.feature.id) !== this.picked.feature) this.picked = null
      // The feature may have fewer vertices now: what was under the mouse is found again on the next move.
      this.hoveredElement = null
      this.hoveredArrow = false
      if (this.keyboardTransform !== null && context.store.get(this.keyboardTransform.base.id) !== this.keyboardTransform.base) this.keyboardTransform = null
    })
  }

  override exit(): void {
    this.drag = null
    this.pressStart = null
    this.keyboardTransform = null
    this.hoveredHandle = null
    this.hoveredElement = null
    this.hoveredArrow = false
    this.setSelection([])
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    this.undoStack.length = 0
    super.exit()
  }

  // ---- Gizmo settings ----

  /** Which handles the gizmo shows. */
  get gizmoTool(): GizmoTool {
    return this.tool
  }

  /** The gizmo's axes. */
  get gizmoSpace(): GizmoSpace {
    return this.space
  }

  /** Shows all the gizmo's handles (`'all'`) or only one tool's. `Draw.setGizmoTool` calls it. */
  setGizmoTool(tool: GizmoTool): void {
    if (!GIZMO_TOOLS.includes(tool)) throw new Error(`SelectMode.setGizmoTool: "${String(tool)}" is no gizmo tool; pick one of ${GIZMO_TOOLS.join(', ')}.`)
    if (tool === this.tool) return
    this.tool = tool
    this.hoveredHandle = null
    this.context?.changed()
  }

  /** Puts the gizmo's axes along east, north and up (`'world'`) or the feature's own (`'local'`). `Draw.setGizmoSpace` calls it. */
  setGizmoSpace(space: GizmoSpace): void {
    if (!GIZMO_SPACES.includes(space)) throw new Error(`SelectMode.setGizmoSpace: "${String(space)}" is no gizmo space; pick 'world' or 'local'.`)
    if (space === this.space) return
    this.space = space
    this.context?.changed()
  }

  /** The elements edit mode picks. */
  get elementMode(): ElementMode {
    return this.element
  }

  /** Picks vertices, edges or faces in edit mode (what was picked is dropped). `Draw.setElementMode` calls it. */
  setElementMode(mode: ElementMode): void {
    if (!ELEMENT_MODES.includes(mode)) throw new Error(`SelectMode.setElementMode: "${String(mode)}" is no element mode; pick 'vertex', 'edge' or 'face'.`)
    if (mode === this.element) return
    this.element = mode
    this.picked = null
    this.hoveredElement = null
    this.hoveredArrow = false
    // A drag in progress picked its element in the old mode: dropped, its release does nothing.
    this.drag = null
    this.pressStart = null
    this.context?.changed()
  }

  // ---- Selection ----

  override selectedFeatureIds(): readonly string[] {
    // Features removed elsewhere leave the selection.
    const store = this.context?.store
    if (store !== undefined && this.selection.some(id => !store.has(id))) {
      const remaining = this.selection.filter(id => store.has(id))
      this.selection = remaining.length === 0 ? NO_FEATURE_IDS : remaining
      if (this.picked !== null && !store.has(this.picked.feature.id)) this.picked = null
      this.hoveredElement = null
      this.hoveredArrow = false
      if (remaining.length === 0) this.vertexEditing = false
    }
    return this.selection
  }

  override setSelection(ids: readonly string[]): boolean {
    const store = this.context?.store
    const next = store === undefined ? [...ids] : ids.filter(id => store.has(id))
    const same = next.length === this.selection.length && next.every((id, index) => id === this.selection[index])
    // While something is selected, a double tap enters edit mode rather than zooming, even on presses nobody takes
    // (`moveFeatures: false`). The first tap selects, so the hold is in place before the second press.
    if (next.length > 0) this.context?.holdDoubleClickZoom()
    else this.context?.releaseDoubleClickZoom()
    if (!same) {
      this.selection = next.length === 0 ? NO_FEATURE_IDS : next
      this.picked = null
      this.vertexEditing = false
      this.drag = null
      this.keyboardTransform = null
      this.hoveredHandle = null
      this.hoveredElement = null
      this.hoveredArrow = false
      this.context?.changed()
    } else if (next.length === 0 && this.vertexEditing) {
      this.vertexEditing = false
      this.context?.changed()
    }
    return true
  }

  /** True in edit mode, while the selected feature shows its elements; false while it shows the gizmo. */
  get editingVertices(): boolean {
    return this.vertexEditing
  }

  /**
   * Edit mode: shows the selected feature's elements (true) or its gizmo (false), as a second tap on it and a tap on the
   * empty map do. Stays false with `editVertices: false`. Selecting another feature goes back to the gizmo.
   */
  setEditingVertices(editing: boolean): void {
    const next = editing && this.editVertices
    if (next === this.vertexEditing) return
    this.vertexEditing = next
    this.picked = null
    this.hoveredElement = null
    this.hoveredArrow = false
    this.drag = null
    this.keyboardTransform = null
    this.pressStart = null
    this.context?.changed()
  }

  override deleteSelection(): boolean {
    const context = this.context
    if (context === null) return false
    // Edit mode deletes the picked vertices of a line or polygon, never the feature (nor a mesh's elements).
    if (this.vertexEditing) return this.deletePickedVertices()
    const features = this.selectedFeatureIds()
      .map(id => context.store.get(id))
      .filter((feature): feature is DrawFeature => feature !== undefined)
    if (features.length === 0) return false
    this.selection = NO_FEATURE_IDS
    this.vertexEditing = false
    this.keyboardTransform = null
    this.commit(features, () => context.remove(features.map(feature => feature.id)))
    return true
  }

  // ---- Pointer ----

  /** Remembers where the pointer is, and the ground's height under it. */
  protected notePointer(event: DrawPointerEvent): void {
    this.lastPointer = { x: event.screen.xPixels, y: event.screen.yPixels }
    if (event.geographic !== null && Number.isFinite(event.geographic.heightMeters)) this.groundFallbackMeters = event.geographic.heightMeters
  }

  override click(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
    this.notePointer(event)
    // A keyboard transform is confirmed by its press (see `pointerUp`); a click without one confirms it too.
    if (this.keyboardTransform !== null) {
      this.confirmKeyboardTransform()
      return
    }
    const double = this.isDoubleTap(event)
    const hit = this.featureAt(event)
    if (hit === null) {
      // Off every feature: out of edit mode first, then the selection.
      if (this.vertexEditing && this.selection.length > 0) this.setEditingVertices(false)
      else this.setSelection([])
      return
    }
    // A tap on the selected feature (or a double tap on any) enters edit mode, picking the element under it.
    const selected = this.selection.length === 1 && this.selection[0] === hit.id
    if (!this.canEditVertices(hit) || (!selected && !double)) {
      this.setSelection([hit.id])
      return
    }
    this.editAt(event, hit, double)
  }

  /** A double click or double tap that reached the map (not taken by a press): edit mode, as a double tap. */
  override doubleClick(event: DrawPointerEvent): void {
    if (this.context === null || this.keyboardTransform !== null) return
    const hit = this.featureAt(event)
    if (hit !== null && this.canEditVertices(hit)) this.editAt(event, hit, true)
  }

  /** Selects a feature in edit mode and picks the element under a tap; a double tap on a mesh picks its face. */
  protected editAt(event: DrawPointerEvent, feature: DrawFeature, double: boolean): void {
    this.setSelection([feature.id])
    this.setEditingVertices(true)
    if (double && this.elementsOf(feature)?.mesh != null) this.setElementMode('face')
    const element = this.showsVertexHandles(feature) ? this.vertexHandleAt(event, feature) : this.elementAt(event, feature)
    if (element !== null) this.pickElement(feature, element, isAdditive(event))
    else if (!isAdditive(event)) this.picked = null
    this.context?.changed()
  }

  /** Whether a tap is the second of a double tap (a third starts again). */
  protected isDoubleTap(event: DrawPointerEvent): boolean {
    // When the tap happened, not when it is handled: a slow frame between two taps must not split them.
    const stamp = event.originalEvent?.timeStamp
    const time = typeof stamp === 'number' && stamp > 0 ? stamp : typeof performance === 'undefined' ? Date.now() : performance.now()
    const x = event.screen.xPixels
    const y = event.screen.yPixels
    const last = this.lastTap
    const double = last !== null && time - last.time < DOUBLE_TAP_MILLISECONDS && Math.hypot(x - last.x, y - last.y) <= hitTolerancePixels(event.pointerType)
    this.lastTap = double ? null : { x, y, time }
    return double
  }

  override pointerDown(event: DrawPointerEvent): boolean {
    const context = this.context
    if (context === null || this.selection.length === 0) return false
    this.notePointer(event)
    // A keyboard transform: the press confirms it on release, and never pans.
    if (this.keyboardTransform !== null) {
      this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
      this.dragging = false
      return true
    }
    // Shift in edit mode adds to what is picked (or takes away): the press goes to the element, past the gizmo. A
    // picked face's push and pull arrow, and a vertex, edge or handle not picked, win over the gizmo's handles on them.
    const additive = this.vertexEditing && isAdditive(event)
    const gizmo = additive || this.gizmoCovered(event) ? null : this.gizmoHandleAt(event)
    const update = gizmo === null ? null : this.gizmoUpdate(gizmo, event)
    if (gizmo !== null && update !== null) {
      this.drag = { kind: 'transform', base: gizmo.basis.feature, feature: gizmo.basis.feature, handle: gizmo.part.handle, update }
      this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
      this.dragging = false
      return true
    }
    const elementDrag = this.elementDragAt(event)
    if (elementDrag !== null) {
      this.drag = elementDrag
      this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
      this.dragging = false
      return true
    }
    const handle = this.handleAt(event)
    let drag: Drag | null = null
    const group = handle?.kind === 'vertex' && !additive ? this.pickedGroupDrag(context.store.get(handle.featureId)!, handle.path, event) : null
    if (group !== null) drag = group
    else if (handle !== null) {
      const feature = context.store.get(handle.featureId)!
      const inserted = handle.kind === 'midpoint'
      drag = { kind: 'vertex', base: feature, feature: inserted ? insertVertex(feature, handle.path, handle.position) : feature, path: handle.path, inserted, heightMeters: handle.heightMeters, position: handle.position }
    } else if (this.moveFeatures && event.geographic !== null) {
      const feature = this.selectedFeatureAt(event)
      if (feature !== null) drag = { kind: 'feature', base: feature, feature, origin: [event.geographic.longitudeDegrees, event.geographic.latitudeDegrees] }
    }
    if (drag === null) return false
    this.drag = drag
    this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
    this.dragging = false
    if (drag.kind === 'vertex' && drag.inserted) context.changed()
    return true
  }

  override pointerMove(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
    this.notePointer(event)
    if (this.keyboardTransform !== null) {
      this.updateKeyboardTransform(event)
      return
    }
    const drag = this.drag
    const start = this.pressStart
    if (drag === null || start === null) return
    if (!this.dragging && Math.hypot(event.screen.xPixels - start.x, event.screen.yPixels - start.y) < DRAG_THRESHOLD_PIXELS) return
    this.dragging = true
    if (drag.kind === 'transform' || drag.kind === 'element') {
      if (context.store.get(drag.feature.id) !== drag.base) {
        this.pointerCancel()
        return
      }
      const feature = drag.update(event)
      if (feature !== null) this.drag = { ...drag, feature }
      context.changed()
      return
    }
    const original = context.store.get(drag.feature.id)
    // Changed or removed elsewhere mid-drag: drop the drag rather than edit another version.
    if (original !== drag.base) {
      this.pointerCancel()
      return
    }
    // A vertex at an altitude moves level, under the pointer as drawn; the rest follow the ground.
    if (drag.kind === 'vertex' && drag.heightMeters !== null) {
      const position = this.positionUnderPointer(event.screen.xPixels, event.screen.yPixels, drag.heightMeters, drag.position)
      if (position === null) return
      const base = drag.inserted ? insertVertex(original, drag.path, position) : original
      this.drag = { ...drag, position, feature: moveVertex(base, drag.path, position) }
      context.changed()
      return
    }
    const ground = event.geographic
    if (ground === null) return
    context.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    const position: LongitudeLatitude = [ground.longitudeDegrees, ground.latitudeDegrees]
    if (drag.kind === 'vertex') {
      const base = drag.inserted ? insertVertex(original, drag.path, position) : original
      this.drag = { ...drag, position, feature: moveVertex(base, drag.path, position) }
    } else {
      this.drag = { ...drag, feature: translateFeature(original, drag.origin, position) }
    }
    context.changed()
  }

  override pointerUp(event: DrawPointerEvent): void {
    const context = this.context
    if (this.keyboardTransform !== null) {
      this.pressStart = null
      this.updateKeyboardTransform(event)
      this.confirmKeyboardTransform()
      return
    }
    const drag = this.drag
    this.drag = null
    this.pressStart = null
    if (context === null || drag === null) return
    const original = context.store.get(drag.feature.id)
    if (original !== drag.base) {
      context.changed()
      return
    }
    if (drag.kind === 'element') {
      // A tap picks the element; a drag moves it (or pushes the face), which stays picked.
      if (!this.dragging) {
        if (drag.element !== null) this.pickElement(original, drag.element, isAdditive(event))
        context.changed()
        return
      }
      // What moved stays picked: the picked elements when the dragged one was among them, else the dragged one.
      const picked = this.picked?.feature === original ? this.picked.elements : []
      const moved = drag.element === null ? picked : picked.some(each => sameElement(each, drag.element)) ? picked : [drag.element]
      this.commitEdit(original, drag.feature)
      const edited = context.store.get(drag.feature.id)
      if (moved.length > 0 && edited !== undefined && edited !== original) {
        this.picked = { feature: edited, elements: moved }
        context.changed()
      }
      return
    }
    if (drag.kind === 'vertex') {
      // A tap on a vertex picks it; a tap on a midpoint inserts a vertex there; a drag moves it.
      if (!this.dragging && !drag.inserted) {
        const index = this.vertexIndex(original, drag.path)
        if (index >= 0) this.pickElement(original, { kind: 'vertex', index }, isAdditive(event))
        context.changed()
        return
      }
    } else if (drag.kind === 'transform') {
      if (!this.dragging) {
        // A tap on a handle over the feature is a tap on the feature (a second tap edits its vertices); elsewhere, and
        // on the gizmo of picked elements (which a tap must not drop), nothing.
        if (drag.base === this.picked?.feature || this.featureAt(event) === null) context.changed()
        else this.click(event)
        return
      }
    } else if (!this.dragging) {
      // A tap on the selected feature selects what is under it, as on the map: a point or line inside a polygon.
      this.click(event)
      return
    }
    this.commitEdit(original, drag.feature)
    const edited = context.store.get(drag.feature.id)
    if (drag.kind === 'vertex' && edited !== undefined && edited !== original) {
      const index = this.vertexIndex(edited, drag.path)
      this.picked = index < 0 ? null : { feature: edited, elements: [{ kind: 'vertex', index }] }
    } else this.carryPicked(original)
  }

  override pointerCancel(): void {
    if (this.drag === null) return
    this.drag = null
    this.pressStart = null
    this.context?.changed()
  }

  override hover(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
    this.notePointer(event)
    if (this.keyboardTransform !== null) {
      this.updateKeyboardTransform(event)
      return
    }
    if (this.selection.length === 0) {
      context.setCursor(null)
      return
    }
    const gizmo = this.gizmoCovered(event) ? null : this.gizmoHandleAt(event)
    const hovered = gizmo?.part.handle ?? null
    if (hovered !== this.hoveredHandle) {
      this.hoveredHandle = hovered
      context.changed()
    }
    // Edit mode: the arrow, else the element under the mouse, highlighted.
    const edited = this.elementEditedFeature()
    const arrow = edited !== null && this.arrowAt(event) !== null
    const element = edited === null || arrow || gizmo !== null || this.showsVertexHandles(edited) ? null : this.elementAt(event, edited)
    if (arrow !== this.hoveredArrow || !sameElement(element, this.hoveredElement)) {
      this.hoveredArrow = arrow
      this.hoveredElement = element
      context.changed()
    }
    const cursor = gizmo !== null || arrow ? 'grab' : element !== null || this.handleAt(event) !== null ? 'pointer' : this.moveFeatures && this.selectedFeatureAt(event) !== null ? 'move' : null
    context.setCursor(cursor)
  }

  override keyDown(event: KeyboardEvent): boolean {
    // Edit mode, as in Blender: A picks every element, Alt+A none (on a Mac, Option+A types å: the key's code tells).
    if (this.vertexEditing && this.keyboardTransform === null && event.ctrlKey !== true && event.metaKey !== true) {
      // The key's code only where Alt typed no letter (Option+A on a Mac): Alt+Q on an AZERTY keyboard is not Alt+A.
      if (event.altKey === true && (event.key.toLowerCase() === 'a' || (!/^[a-z]$/i.test(event.key) && event.code === 'KeyA'))) {
        this.clearElementSelection()
        return true
      }
      if (event.altKey !== true && event.key.toLowerCase() === 'a') return this.selectAllElements()
    }
    // Shortcuts of the browser and the system (Ctrl+R, Cmd+S…) are theirs.
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return false
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const transform = this.keyboardTransform
    if (transform !== null) {
      if (key === 'Escape') this.cancelKeyboardTransform()
      else if (key === 'Enter') this.confirmKeyboardTransform()
      else if (key === 'x' || key === 'y' || key === 'z') {
        const axis = key === 'x' ? 0 : key === 'y' ? 1 : 2
        // An axis pointing at the camera cannot follow the pointer along it: a move or scale keeps its lock.
        const basis = this.gizmoFor(transform.base) ?? transform.basis
        if (transform.axis !== axis && transform.kind !== 'rotate' && this.axisScreen(basis, axis) === null) return true
        // The same key again unlocks.
        this.keyboardTransform = { ...transform, axis: transform.axis === axis ? null : axis }
        this.refreshKeyboardTransform()
      } else if (key === 'g' || key === 'r' || key === 's') {
        // Picked elements only move.
        if (transform.basis.moveElements !== undefined) return true
        this.keyboardTransform = { ...transform, kind: key === 'g' ? 'move' : key === 'r' ? 'rotate' : 'scale' }
        this.refreshKeyboardTransform()
      } else return false
      return true
    }
    if (event.key === 'Escape' && this.selection.length > 0) {
      this.cancel()
      return true
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selection.length > 0) return this.deleteSelection()
    // Edit mode, as in Blender: Tab in and out, 1, 2 and 3 for vertices, edges and faces, E to extrude the picked face.
    if (key === 'Tab' && this.selection.length > 0) {
      const feature = this.context?.store.get(this.selection[0]!)
      if (feature === undefined || !this.canEditVertices(feature)) return false
      this.setEditingVertices(!this.vertexEditing)
      return true
    }
    if (this.vertexEditing && (key === '1' || key === '2' || key === '3')) {
      this.setElementMode(ELEMENT_MODES[Number(key) - 1]!)
      return true
    }
    if (this.vertexEditing && key === 'e') return this.extrude()
    if ((key === 'g' || key === 'r' || key === 's') && !event.ctrlKey && !event.metaKey && !event.altKey) return this.startTransform(key === 'g' ? 'move' : key === 'r' ? 'rotate' : 'scale')
    return false
  }

  override focusLost(): void {
    this.cancelKeyboardTransform()
  }

  override secondaryPress(): boolean {
    if (this.keyboardTransform === null) return false
    this.cancelKeyboardTransform()
    return true
  }

  /** Drops a transform or drag in progress, then edit mode (back to the gizmo), then the selection. */
  override cancel(): void {
    if (this.keyboardTransform !== null) {
      this.cancelKeyboardTransform()
      return
    }
    if (this.drag !== null) {
      this.pointerCancel()
      return
    }
    if (this.vertexEditing && this.selection.length > 0) {
      this.setEditingVertices(false)
      return
    }
    this.setSelection([])
  }

  /** Takes back the last edit. */
  override undo(): void {
    const context = this.context
    if (context === null) return
    const entry = this.undoStack.pop()
    if (entry === undefined) return
    const existing = entry.restore.filter(feature => context.store.has(feature.id))
    const removed = entry.restore.filter(feature => !context.store.has(feature.id))
    this.picked = null
    this.hoveredElement = null
    this.hoveredArrow = false
    this.keyboardTransform = null
    this.committing = true
    try {
      if (existing.length > 0) context.update(existing)
      if (removed.length > 0) context.create(removed)
    } finally {
      this.committing = false
    }
    context.changed()
  }

  override status(): DrawModeStatus {
    // Features removed elsewhere leave the selection, and with the last one edit mode ends.
    this.selectedFeatureIds()
    return { ...IDLE_STATUS, canUndo: this.undoStack.length > 0, editingVertices: this.vertexEditing, elementMode: this.element, canExtrude: this.canExtrude, pickedElementCount: this.pickedElementCount }
  }

  override liveFeatureIds(): readonly string[] {
    const context = this.context
    if (context === null) return NO_FEATURE_IDS
    // Draped features show live while selected; a solid only while it changes (then as a preview solid).
    const live = this.selectedFeatureIds().filter(id => {
      const feature = context.store.get(id)
      return feature !== undefined && (!isSolidFeature(feature) || this.editedFeature(id) !== null)
    })
    return live.length === 0 ? NO_FEATURE_IDS : live
  }

  override overlay(content: OverlayContent): void {
    const context = this.context
    if (context === null) return
    // The camera moved (a wheel zoom) during a keyboard transform: the feature follows the pointer on the new view.
    const transform = this.keyboardTransform
    const view = context.viewVersion?.()
    if (transform !== null && view !== undefined && view !== transform.view) {
      this.keyboardTransform = { ...transform, view, feature: this.keyboardFeature(transform) ?? transform.feature }
    }
    const live = new Set(this.liveFeatureIds())
    for (const id of this.selectedFeatureIds()) {
      const stored = context.store.get(id)
      if (stored === undefined) continue
      const drag = this.drag !== null && this.drag.feature.id === id && (this.dragging || this.drag.kind === 'vertex') ? this.drag : null
      const feature = this.editedFeature(id) ?? stored
      const style = context.style(feature, SELECTED_STATE)
      if (live.has(id)) content.features.push({ feature, style })
      else if (this.editsElements(feature)) {
        // In edit mode, `elementsOverlay` draws a mesh's edges.
        if (feature.geometry.type !== 'MultiPolygon') this.ringsOverlay(feature, content, style.vertexOutlineColor)
      } else if (isMeshGeometry(feature.geometry)) {
        // A mesh: its sharp edges, over the map.
        const { vertices, edges } = this.outlineOf(feature)
        for (const [a, b] of edges) {
          const from = vertices[a]!
          const to = vertices[b]!
          content.lines.push({ positions: [[from[0]!, from[1]!], [to[0]!, to[1]!]], heightsMeters: [from[2]!, to[2]!], color: style.vertexOutlineColor, widthPixels: 2, opacity: 1 })
        }
      } else if (feature.geometry.type !== 'Point') this.ringsOverlay(feature, content, style.vertexOutlineColor)
      // Moving whole: the handles wait for the release.
      if (drag?.kind === 'feature') continue
      if (this.keyboardTransform?.base.id === id) {
        this.keyboardOverlay(this.keyboardTransform, content)
        continue
      }
      const active = drag?.kind === 'transform' ? drag.handle : this.hoveredHandle
      if (this.showsGizmo(feature)) {
        this.gizmoOverlay(this.gizmoBasis(feature), content, active)
        continue
      }
      if (this.editsElements(feature) && !this.showsVertexHandles(feature)) this.elementsOverlay(feature, content, style, drag?.kind === 'element' ? drag : null)
      else if (this.showsVertexHandles(feature)) this.vertexHandlesOverlay(feature, content, style, drag)
      // The picked elements' move gizmo, over them.
      this.gizmoOverlay(this.elementGizmoBasis(feature), content, active)
    }
  }

  /** A line's or polygon's vertex and midpoint handles in edit mode, the picked vertices (or the dragged one) highlighted. */
  protected vertexHandlesOverlay(feature: DrawFeature, content: OverlayContent, style: DrawStyle, drag: SelectDrag | null): void {
    for (const midpoint of featureMidpoints(feature)) {
      content.handles.push({ position: midpoint.position, heightMeters: midpoint.heightMeters, radiusPixels: style.vertexRadiusPixels - 1, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels, faded: true })
    }
    const dragged = drag?.kind === 'vertex' ? drag.path : null
    const picked = new Set(dragged !== null || this.picked?.feature.id !== feature.id ? [] : this.picked.elements.flatMap(each => (each.kind === 'vertex' ? [each.index] : [])))
    for (const [index, vertex] of featureVertices(feature).entries()) {
      const isPicked = dragged !== null ? dragged.ring === vertex.path.ring && dragged.index === vertex.path.index : picked.has(index)
      content.handles.push({
        position: [vertex.position[0]!, vertex.position[1]!],
        // At its altitude; without one, on the terrain.
        heightMeters: vertex.position.length > 2 && Number.isFinite(vertex.position[2]) ? vertex.position[2] : undefined,
        radiusPixels: isPicked ? style.vertexRadiusPixels + 2 : style.vertexRadiusPixels,
        color: isPicked ? style.vertexOutlineColor : style.vertexColor,
        outlineColor: isPicked ? style.vertexColor : style.vertexOutlineColor,
        outlineWidthPixels: style.vertexOutlineWidthPixels,
      })
    }
  }

  override inspect(): unknown {
    const transform = this.keyboardTransform
    return {
      ...this.status(),
      selection: [...this.selection],
      editingVertices: this.vertexEditing,
      elementMode: this.element,
      picked: this.picked === null ? null : { featureId: this.picked.feature.id, ...this.picked.elements[this.picked.elements.length - 1]! },
      pickedElements: this.picked === null ? [] : this.picked.elements.map(element => ({ ...element })),
      gizmoTool: this.tool,
      gizmoSpace: this.space,
      drag: this.drag === null ? null : { kind: this.drag.kind, featureId: this.drag.feature.id, dragging: this.dragging, handle: this.drag.kind === 'transform' ? this.drag.handle : null },
      keyboardTransform: transform === null ? null : { kind: transform.kind, axis: transform.axis === null ? null : 'xyz'[transform.axis], featureId: transform.base.id, start: transform.start, pointer: transform.pointer, changed: transform.feature !== transform.base },
      undo: this.undoStack.length,
    }
  }

  // ---- Keyboard transforms ----

  /** The keyboard transform in progress (G, R, S), or null. */
  get transforming(): TransformKind | null {
    return this.keyboardTransform?.kind ?? null
  }

  /**
   * Starts moving, turning or scaling the selected feature under the pointer, as G, R and S do with the `keyboard`
   * option: it follows the mouse with no press; a click or Enter confirms, Escape or a right click cancels, X, Y and Z
   * lock it to an axis of the gizmo (east, north, up in world space). Without an axis a move stays on the ground, a turn
   * goes around up and a scale is uniform, all from the pointer's distance to the center. In edit mode, a move takes
   * only the picked elements (turns and scales do not start there). Returns false when nothing can start (no selected
   * line, polygon or mesh, nothing picked in edit mode, a drag in progress).
   */
  startTransform(kind: TransformKind): boolean {
    const context = this.context
    if (context === null || this.drag !== null || (this.vertexEditing && kind !== 'move')) return false
    const feature = this.vertexEditing ? this.elementEditedFeature() : this.selection.map(id => context.store.get(id)).find(each => each !== undefined && this.showsGizmo(each))
    if (feature === undefined || feature === null) return false
    const basis = this.gizmoFor(feature)
    if (basis === null) return false
    // Without a mouse over the map yet, from a gizmo's length to the right of the center.
    const start = this.lastPointer ?? { x: basis.centerScreen.x + this.gizmoSizePixels, y: basis.centerScreen.y }
    const grabOffset = { x: basis.centerScreen.x - start.x, y: basis.centerScreen.y - start.y }
    this.keyboardTransform = { kind, axis: null, base: feature, feature, basis, start, grabOffset, view: context.viewVersion?.(), pointer: start, shiftKey: false }
    context.changed()
    return true
  }

  protected updateKeyboardTransform(event: DrawPointerEvent): void {
    const transform = this.keyboardTransform
    if (transform === null) return
    this.notePointer(event)
    this.keyboardTransform = { ...transform, pointer: { x: event.screen.xPixels, y: event.screen.yPixels }, shiftKey: event.originalEvent?.shiftKey === true }
    this.refreshKeyboardTransform()
  }

  /** Recomputes the keyboard transform's feature from the pointer, its kind and its axis. */
  protected refreshKeyboardTransform(): void {
    const transform = this.keyboardTransform
    const context = this.context
    if (transform === null || context === null) return
    if (context.store.get(transform.base.id) !== transform.base) {
      this.cancelKeyboardTransform()
      return
    }
    const feature = this.keyboardFeature(transform)
    // A locked move or scale that cannot be computed (over the horizon) shows and commits the feature unchanged.
    this.keyboardTransform = { ...transform, view: context.viewVersion?.(), feature: feature ?? (transform.axis === null ? transform.feature : transform.base) }
    context.changed()
  }

  /** The keyboard transform's feature for the pointer, on the current view; null when it cannot be computed. */
  protected keyboardFeature(transform: KeyboardTransform): DrawFeature | null {
    const { start, pointer, axis } = transform
    // On the current view: the camera may have zoomed since it started.
    const basis = this.gizmoFor(transform.base) ?? transform.basis
    const center = basis.centerScreen
    const deltaX = pointer.x - start.x
    const deltaY = pointer.y - start.y
    if (transform.kind === 'move') {
      if (axis === null) return this.freeMove(basis, pointer.x + transform.grabOffset.x, pointer.y + transform.grabOffset.y)
      const along = this.axisScreen(basis, axis)
      return along === null ? null : this.moveAlong(basis, axis, ((deltaX * along.x + deltaY * along.y) / (along.x * along.x + along.y * along.y)) * basis.sizeMeters)
    }
    if (transform.kind === 'rotate') {
      const rotationAxis = axis ?? 2
      const turn = angleBetween(start.x - center.x, start.y - center.y, pointer.x - center.x, pointer.y - center.y)
      return this.turn(basis, rotationAxis, (this.screenTurnSign(basis, rotationAxis) * turn * 180) / Math.PI, transform.shiftKey)
    }
    const factor = Math.max(MINIMUM_SCALE_FACTOR, Math.hypot(pointer.x - center.x, pointer.y - center.y) / Math.max(10, Math.hypot(start.x - center.x, start.y - center.y)))
    return axis === null ? this.scaleUniformly(basis, factor) : this.scaleAlong(basis, axis, factor)
  }

  protected confirmKeyboardTransform(): void {
    const transform = this.keyboardTransform
    const context = this.context
    this.keyboardTransform = null
    if (transform === null || context === null) return
    const original = context.store.get(transform.base.id)
    if (original !== transform.base) {
      context.changed()
      return
    }
    this.commitEdit(original, transform.feature)
    this.carryPicked(original)
  }

  protected cancelKeyboardTransform(): void {
    if (this.keyboardTransform === null) return
    this.keyboardTransform = null
    this.context?.changed()
  }

  /** While a keyboard transform runs: the axis it is locked to, as a long line through the center. */
  protected keyboardOverlay(transform: KeyboardTransform, content: OverlayContent): void {
    if (transform.axis === null) return
    const { basis } = transform
    const reach = basis.sizeMeters * 12
    const axis = basis.axes[transform.axis]
    const from = basis.frame.toGeographic(-axis[0] * reach, -axis[1] * reach, -axis[2] * reach)
    const to = basis.frame.toGeographic(axis[0] * reach, axis[1] * reach, axis[2] * reach)
    content.lines.push({ positions: [[from[0], from[1]], [basis.center[0], basis.center[1]], [to[0], to[1]]], heightsMeters: [from[2], basis.heightMeters, to[2]], color: AXIS_COLORS[transform.axis], widthPixels: 1.5, opacity: 0.9 })
  }

  // ---- Internals ----

  /** The feature as it is being changed (dragged, transformed), or null when it is not. */
  protected editedFeature(id: string): DrawFeature | null {
    if (this.keyboardTransform?.base.id === id) return this.keyboardTransform.feature
    const drag = this.drag
    if (drag !== null && drag.feature.id === id && (this.dragging || drag.kind === 'vertex')) return drag.feature
    return null
  }

  /** Stores an edit as one `update` and one undo step, unless it changes nothing. */
  protected commitEdit(original: DrawFeature, edited: DrawFeature): void {
    const context = this.context!
    // A drag that ends where it started (a handle dragged and brought back) changes nothing: no update, no undo step.
    if (edited === original || (JSON.stringify(edited.geometry) === JSON.stringify(original.geometry) && JSON.stringify(edited.properties) === JSON.stringify(original.properties))) {
      context.changed()
      return
    }
    this.commit([original], () => context.update([edited]))
  }

  /** Whether a feature has edit mode: lines, polygons and meshes (not points, nor flat multipolygons). */
  protected canEditVertices(feature: DrawFeature): boolean {
    if (!this.editVertices) return false
    const type = feature.geometry.type
    return type === 'LineString' || type === 'Polygon' || (type === 'MultiPolygon' && this.elementsOf(feature) !== null)
  }

  /** A selected feature in edit mode shows its elements. */
  protected editsElements(feature: DrawFeature): boolean {
    return this.vertexEditing && this.canEditVertices(feature)
  }

  /** Outlines of mesh versions: their vertices and sharp edges, computed once. */
  protected readonly outlines = new WeakMap<DrawFeature, { vertices: Position[]; edges: Array<[number, number]> }>()

  /** The vertices and sharp edges of a mesh feature version (see `meshSharpEdges`). */
  protected outlineOf(feature: DrawFeature): { vertices: Position[]; edges: Array<[number, number]> } {
    let outline = this.outlines.get(feature)
    if (outline === undefined) {
      const mesh = feature.geometry.type === 'MultiPolygon' ? indexMesh(feature.geometry) : { vertices: [], faces: [] }
      outline = { vertices: mesh.vertices, edges: meshSharpEdges(mesh) }
      this.outlines.set(feature, outline)
    }
    return outline
  }

  /** A selected line or polygon in edit mode picking vertices shows vertex and midpoint handles. */
  protected showsVertexHandles(feature: DrawFeature): boolean {
    return this.element === 'vertex' && feature.geometry.type !== 'MultiPolygon' && this.editsElements(feature)
  }

  /** A selected line, polygon or mesh shows the gizmo, unless it is in edit mode. Points move whole. */
  protected showsGizmo(feature: DrawFeature): boolean {
    if (this.editsElements(feature)) return false
    return feature.geometry.type !== 'Point'
  }

  /** A line's or flat polygon's rings over the map, where they are drawn (positions without an altitude at the lowest, as `isSolidFeature` says). */
  protected ringsOverlay(feature: DrawFeature, content: OverlayContent, color: string): void {
    const lowest = lowestAltitude(feature.geometry)
    for (const ring of storedLines(feature.geometry)) {
      const heightsMeters = lowest === null ? undefined : ring.map(position => (hasAltitude(position) ? position[2]! : lowest))
      content.lines.push({ positions: ring.map(position => [position[0]!, position[1]!]), heightsMeters, color, widthPixels: 2, opacity: 1 })
    }
  }

  // ---- Edit mode ----

  /** Whether `extrude()` can act: in edit mode, with faces, edges or a line's elements picked on its stored version. */
  get canExtrude(): boolean {
    const picked = this.picked
    if (!this.vertexEditing || picked === null || this.context?.store.get(picked.feature.id) !== picked.feature) return false
    return this.extrusionOf(picked.feature, picked.elements) !== null
  }

  /** What `extrude()` would do with the picked elements of a feature version (kept per pick), or null for nothing. */
  protected extrusionOf(feature: DrawFeature, picked: readonly PickedElement[]): Extrusion | null {
    const cached = this.extrusionCache.get(picked)
    if (cached !== undefined && cached.feature === feature) return cached.extrusion
    const extrusion = this.findExtrusion(feature, picked)
    this.extrusionCache.set(picked, { feature, extrusion })
    return extrusion
  }

  protected findExtrusion(feature: DrawFeature, picked: readonly PickedElement[]): Extrusion | null {
    const elements = this.elementsOf(feature)
    if (elements === null || picked.length === 0 || !picked.every(element => elementFits(elements, element))) return null
    // A line has no face to keep its other segments: the whole of it becomes a wall.
    if (feature.geometry.type === 'LineString') return elements.edges.some(([a, b]) => !samePlace(elements.positions[a]!, elements.positions[b]!)) ? { kind: 'wall' } : null
    // The picked edges, as indices into `edges`: picked ones, and those between two picked vertices.
    const pickedVertices = new Set(picked.flatMap(element => (element.kind === 'vertex' ? [element.index] : [])))
    const edgeKeys = new Set(picked.flatMap(element => (element.kind === 'edge' ? [edgeKey(element.from, element.to)] : [])))
    const edgeIndices = elements.edges.flatMap(([a, b], index) => (edgeKeys.has(edgeKey(a, b)) || (pickedVertices.has(a) && pickedVertices.has(b)) ? [index] : []))
    const pickedEdges = new Set(edgeIndices)
    // As in Blender, a face whose every edge is picked is picked too.
    const faces = new Set(picked.flatMap(element => (element.kind === 'face' ? [element.index] : [])))
    elements.faceEdges.forEach((edges, faceIndex) => {
      if (edges.length > 0 && edges.every(edge => pickedEdges.has(edge))) faces.add(faceIndex)
    })
    // Faces win: picked edges outside them (a stray edge) stay as they are.
    if (faces.size > 0) {
      if (elements.mesh === null) return { kind: 'prism' }
      const region = [...faces]
      // Faces pointing every way (a whole box) have no direction to go together.
      if (region.length > 1) {
        const frame = meshElementFrame(elements.mesh, this.pickedVertices(elements, region.map(index => ({ kind: 'face', index }))))
        const sum = [0, 0, 0]
        for (const faceIndex of region) {
          const normal = meshFaceNormal(elements.mesh, faceIndex, frame)
          const area = meshFaceArea(elements.mesh, faceIndex)
          for (let axis = 0; axis < 3; axis++) sum[axis]! += normal[axis]! * area
        }
        const area = region.reduce((total, faceIndex) => total + meshFaceArea(elements.mesh!, faceIndex), 0)
        if (!(Math.hypot(sum[0]!, sum[1]!, sum[2]!) > area * PARALLEL_NORMALS_SHARE)) return null
      }
      return { kind: 'faces', faces: region }
    }
    // An edge of no length (a vertex placed twice) would make a face of no area.
    const edges = edgeIndices.map(index => elements.edges[index]!).filter(([a, b]) => !samePlace(elements.positions[a]!, elements.positions[b]!))
    return edges.length > 0 ? { kind: 'edges', edges } : null
  }

  /** How many elements are picked in edit mode (`selectAllElements` picks them all). */
  get pickedElementCount(): number {
    return this.vertexEditing ? (this.picked?.elements.length ?? 0) : 0
  }

  /**
   * Picks every element of the selected feature in edit mode, of the element mode (every vertex, edge or face, those
   * turned away from the camera too), as A does with the `keyboard` option. Returns false outside edit mode, or when
   * the feature has none of them (a line's faces).
   */
  selectAllElements(): boolean {
    const context = this.context
    const feature = this.elementEditedFeature()
    const elements = feature === null ? null : this.elementsOf(feature)
    if (context === null || feature === null || elements === null || this.drag !== null || this.keyboardTransform !== null) return false
    const all: PickedElement[] =
      this.element === 'vertex'
        ? elements.positions.map((_, index) => ({ kind: 'vertex', index }))
        : this.element === 'edge'
          ? elements.edges.map(([from, to]) => ({ kind: 'edge', from, to }))
          : elements.faces.map((_, index) => ({ kind: 'face', index }))
    if (all.length === 0) return false
    this.picked = { feature, elements: all }
    context.changed()
    return true
  }

  /** Drops what is picked in edit mode, as Alt+A does with the `keyboard` option. Returns false when nothing was picked. */
  clearElementSelection(): boolean {
    if (this.picked === null || this.drag !== null || this.keyboardTransform !== null) return false
    this.picked = null
    this.context?.changed()
    return true
  }

  /** Picks an element, or with `additive` (Shift) adds it to what is picked on that version, or takes it away when already picked. */
  protected pickElement(feature: DrawFeature, element: PickedElement, additive: boolean): void {
    const current = additive && this.picked?.feature === feature ? this.picked.elements : []
    const without = current.filter(each => !sameElement(each, element))
    const elements = without.length < current.length ? without : [...without, element]
    this.picked = elements.length === 0 ? null : { feature, elements }
  }

  /** After an edit of the feature the elements were picked on, they stay picked on its new version (same indices). */
  protected carryPicked(original: DrawFeature): void {
    const picked = this.picked
    const edited = this.context?.store.get(original.id)
    if (picked === null || picked.feature !== original || edited === undefined || edited === original) return
    this.picked = { feature: edited, elements: picked.elements }
    this.context?.changed()
  }

  /** The index of a line's or polygon's vertex among its elements (`featureVertices` order), or -1. */
  protected vertexIndex(feature: DrawFeature, path: VertexPath): number {
    return this.elementsOf(feature)?.paths?.findIndex(each => each.ring === path.ring && each.index === path.index) ?? -1
  }

  /** The vertex handle under a press, as a picked vertex, or null. */
  protected vertexHandleAt(event: DrawPointerEvent, feature: DrawFeature): PickedElement | null {
    const handle = this.handleAt(event)
    if (handle === null || handle.kind !== 'vertex' || handle.featureId !== feature.id) return null
    const index = this.vertexIndex(feature, handle.path)
    return index < 0 ? null : { kind: 'vertex', index }
  }

  /** A press on a picked vertex handle while several elements are picked: a drag moving them all, level under the pointer. */
  protected pickedGroupDrag(feature: DrawFeature, path: VertexPath, press: DrawPointerEvent): SelectDrag | null {
    const picked = this.picked
    if (picked === null || picked.feature !== feature || picked.elements.length < 2) return null
    const index = this.vertexIndex(feature, path)
    const element: PickedElement = { kind: 'vertex', index }
    if (index < 0 || !picked.elements.some(each => sameElement(each, element))) return null
    const update = this.elementMoveUpdate(feature, picked.elements, press)
    return update === null ? null : { kind: 'element', base: feature, feature, element, update }
  }

  /** Removes the picked vertices of the selected line or polygon in edit mode (each ring keeps its fewest). */
  protected deletePickedVertices(): boolean {
    const context = this.context
    const picked = this.picked
    if (context === null || picked === null) return false
    const feature = context.store.get(picked.feature.id)
    // Picked on another version of the feature: the indices may name other vertices now.
    const paths = feature !== picked.feature ? null : this.elementsOf(feature)?.paths
    if (feature === undefined || paths == null) return false
    // From the last, so the indices of those still to remove hold.
    const targets = picked.elements
      .flatMap(each => (each.kind === 'vertex' && paths[each.index] !== undefined ? [paths[each.index]!] : []))
      .sort((a, b) => b.ring - a.ring || b.index - a.index)
    let edited = feature
    for (const path of targets) edited = removeVertex(edited, path) ?? edited
    if (edited === feature) return false
    this.picked = null
    this.commit([feature], () => context.update([edited]))
    return true
  }

  /**
   * Extrudes what is picked, as E does with the `keyboard` option, as Blender's extrude:
   *
   * - faces of a mesh go out along their mean outward normal as one region (`extrudeMeshFaces`), new walls joining
   *   their outline to where it was; a polygon's face becomes a prism (`prismMesh`) that tall;
   * - edges of a mesh or polygon (or those between two picked vertices) each grow a face straight up
   *   (`extrudeMeshEdges`); a line, whatever is picked of it, becomes a wall (one face per segment) that tall;
   * - as in Blender, every edge (or vertex) of a face picked picks the face.
   *
   * What it made stays picked (the moved faces, the new top edges or vertices), with the move gizmo over it to carry
   * it further. Without `distanceMeters`, half the arrow's length (about 40 px on the screen). One `update`, one undo
   * step. Returns false when nothing can be extruded (`canExtrude`), and for a negative distance on a line or a
   * polygon's face (walls and prisms only grow up; a mesh's faces extrude inwards, its edges down).
   */
  extrude(distanceMeters?: number): boolean {
    const context = this.context
    if (distanceMeters !== undefined && (!Number.isFinite(distanceMeters) || distanceMeters === 0)) {
      throw new Error(`SelectMode.extrude: distanceMeters is ${distanceMeters}; give a finite number of metres other than 0, or leave it out for half the arrow's length.`)
    }
    if (context === null || !this.canExtrude || this.drag !== null) return false
    const { feature, elements: picked } = this.picked!
    const extrusion = this.extrusionOf(feature, picked)
    const elements = this.elementsOf(feature)
    if (extrusion === null || elements === null) return false
    const distance = distanceMeters ?? this.defaultExtrusionMeters(feature, picked)
    let edited: DrawFeature
    let made: { vertices: number[]; edges: Array<[number, number]>; faces: number[] }
    if (extrusion.kind === 'wall' || extrusion.kind === 'prism') {
      if (distance < 0) return false
      if (extrusion.kind === 'wall') {
        const wall = this.wallOf(feature, distance)
        if (wall === null) return false
        edited = this.withMesh(feature, wall.mesh)
        made = { vertices: [...new Set(wall.top.flat())], edges: wall.top, faces: [] }
      } else {
        edited = this.prismOf(feature, distance)
        // A prism has its top first.
        made = this.faceElementsOf(edited, [0])
      }
    } else if (extrusion.kind === 'faces') {
      edited = this.withMesh(feature, extrudeMeshFaces(elements.mesh!, extrusion.faces, distance))
      made = this.faceElementsOf(edited, extrusion.faces)
    } else {
      const mesh = elements.mesh ?? this.meshOfPolygon(feature, elements)
      const extruded = extrudeMeshEdges(mesh, extrusion.edges, [0, 0, distance])
      edited = this.withMesh(feature, extruded.mesh)
      made = { vertices: [...new Set(extruded.edges.flat())], edges: extruded.edges, faces: [] }
    }
    this.commit([feature], () => context.update([edited]))
    const kept = this.element === 'vertex' ? made.vertices.map(index => ({ kind: 'vertex', index }) as const) : this.element === 'edge' ? made.edges.map(([from, to]) => ({ kind: 'edge', from: Math.min(from, to), to: Math.max(from, to) }) as const) : made.faces.map(index => ({ kind: 'face', index }) as const)
    this.picked = kept.length === 0 ? null : { feature: edited, elements: kept }
    context.changed()
    return true
  }

  /** The vertices, edges and faces of some faces of a feature version, to pick them after an edit. */
  protected faceElementsOf(feature: DrawFeature, faces: readonly number[]): { vertices: number[]; edges: Array<[number, number]>; faces: number[] } {
    const elements = this.elementsOf(feature)
    if (elements === null) return { vertices: [], edges: [], faces: [] }
    const edges = [...new Set(faces.flatMap(face => elements.faceEdges[face] ?? []))].map(index => elements.edges[index]!)
    return { vertices: this.pickedVertices(elements, faces.map(index => ({ kind: 'face', index }))), edges, faces: [...faces] }
  }

  /**
   * A line as a wall `heightMeters` tall (one face per segment, as `wallMesh`), standing at its altitudes or on the
   * terrain under it, with its vertices first in their order then their copies on top; and the wall's top edges.
   */
  protected wallOf(feature: DrawFeature, heightMeters: number): { mesh: IndexedMesh; top: Array<[number, number]> } | null {
    const elements = this.elementsOf(feature)
    if (elements === null || feature.geometry.type !== 'LineString') return null
    // As a prism stands: at a vertex's altitude, or on the terrain under it.
    const ground = this.groundOf(feature, lowestAltitude(feature.geometry) ?? this.groundFallbackMeters)
    // A vertex placed again where one already is (a line closing on its start) is that vertex: the wall stays joined.
    const bottom: Position[] = []
    const indexOf = new Map<string, number>()
    const line = elements.positions.map((position, index) => {
      const base: Position = [position[0]!, position[1]!, elements.heights[index] ?? ground(position[0]!, position[1]!)]
      const key = base.join()
      let at = indexOf.get(key)
      if (at === undefined) indexOf.set(key, (at = bottom.push(base) - 1))
      return at
    })
    const count = bottom.length
    const vertices = [...bottom, ...bottom.map((position): Position => [position[0]!, position[1]!, position[2]! + heightMeters])]
    const faces: number[][][] = []
    const top: Array<[number, number]> = []
    for (let index = 0; index + 1 < line.length; index++) {
      const a = line[index]!
      const b = line[index + 1]!
      // A segment of no length (a vertex placed twice in a row) makes no face.
      if (a === b) continue
      faces.push([[a, b, count + b, count + a]])
      top.push([count + a, count + b])
    }
    return faces.length === 0 ? null : { mesh: { vertices, faces }, top }
  }

  /** A polygon as a mesh of its one face, at its altitudes or on the terrain, its vertices in `featureVertices` order. */
  protected meshOfPolygon(feature: DrawFeature, elements: FeatureElements): IndexedMesh {
    const ground = this.groundOf(feature, lowestAltitude(feature.geometry) ?? this.groundFallbackMeters)
    return { vertices: elements.positions.map((position, index): Position => [position[0]!, position[1]!, elements.heights[index] ?? ground(position[0]!, position[1]!)]), faces: elements.faces }
  }

  /** `extrude()`'s distance: a picked face's half arrow, else half the move gizmo's arrow over what is picked. */
  protected defaultExtrusionMeters(feature: DrawFeature, picked: readonly PickedElement[]): number {
    if (picked.length === 1 && picked[0]!.kind === 'face') return this.defaultExtrudeMeters(feature, picked[0]!.index)
    const basis = this.elementGizmoBasis(feature)
    if (basis !== null) return basis.sizeMeters * EXTRUDE_ARROW_SHARE
    const { center, range } = this.geometryOf(feature)
    const height = range?.minimumMeters ?? this.context!.heights.heightAt(center[0], center[1], this.groundFallbackMeters)
    return (this.basisAt(feature, center, height, height, range === null)?.sizeMeters ?? 2) * EXTRUDE_ARROW_SHARE
  }

  /** Half the arrow's length at a face, or a quarter of the face's side when it cannot be measured on the screen. */
  protected defaultExtrudeMeters(feature: DrawFeature, face: number): number {
    const arrow = this.arrowOf(feature)
    if (arrow !== null) return arrow.lengthMeters * EXTRUDE_ARROW_SHARE
    const elements = this.elementsOf(feature)
    const mesh = elements === null ? null : (elements.mesh ?? { vertices: elements.positions, faces: elements.faces })
    const area = mesh === null || mesh.faces[face] === undefined ? 0 : meshFaceArea(mesh, face)
    return area > 0 ? Math.sqrt(area) / 4 : 1
  }

  /**
   * Where a press grabs the picked face's push and pull arrow on the screen (for tests and tutorials), or null without
   * a picked face showing one.
   */
  pushPullHandle(): { x: number; y: number } | null {
    const feature = this.elementEditedFeature()
    const arrow = feature === null ? null : this.arrowOf(feature)
    if (arrow === null) return null
    const share = arrow.knob ? 0.85 : 0.6
    return { x: arrow.from.x + arrow.along.x * share, y: arrow.from.y + arrow.along.y * share }
  }

  /** The selected feature in edit mode (its stored version), or null. */
  protected elementEditedFeature(): DrawFeature | null {
    const context = this.context
    if (context === null || !this.vertexEditing) return null
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature !== undefined && this.editsElements(feature)) return feature
    }
    return null
  }

  /** The elements of a feature version (computed once), or null when it has none to edit (a point, flat polygons). */
  protected elementsOf(feature: DrawFeature): FeatureElements | null {
    const cached = this.elementsCache.get(feature)
    if (cached !== undefined) return cached
    let elements: FeatureElements | null = null
    const geometry = feature.geometry
    if (geometry.type === 'MultiPolygon') {
      if (isMeshGeometry(geometry)) elements = elementsOfMesh(indexMesh(geometry))
    } else if (geometry.type === 'LineString' || geometry.type === 'Polygon') {
      const vertices = featureVertices(feature)
      const rings: number[][] = []
      vertices.forEach((vertex, index) => (rings[vertex.path.ring] ??= []).push(index))
      const edges: Array<[number, number]> = []
      for (const ring of rings) {
        const count = geometry.type === 'Polygon' ? ring.length : ring.length - 1
        for (let index = 0; index < count; index++) edges.push([ring[index]!, ring[(index + 1) % ring.length]!])
      }
      elements = {
        positions: vertices.map(vertex => vertex.position),
        heights: vertices.map(vertex => (vertex.position.length > 2 && Number.isFinite(vertex.position[2]) ? vertex.position[2]! : null)),
        edges,
        faces: geometry.type === 'Polygon' ? [rings] : [],
        closed: false,
        mesh: null,
        paths: vertices.map(vertex => vertex.path),
        faceEdges: geometry.type === 'Polygon' ? [edges.map((_, index) => index)] : [],
      }
    }
    this.elementsCache.set(feature, elements)
    return elements
  }

  /** A feature version with a new mesh, its elements known (so indices picked on the mesh hold). */
  protected withMesh(feature: DrawFeature, mesh: IndexedMesh): DrawFeature {
    const base = this.elementsOf(feature)
    const sameFaces = base?.mesh != null && base.mesh.faces === mesh.faces && feature.geometry.type === 'MultiPolygon'
    let geometry: MultiPolygon
    if (sameFaces) {
      // A move: faces whose vertices all stayed keep their coordinates (features are never changed in place).
      const baseVertices = base.mesh!.vertices
      const baseCoordinates = (feature.geometry as MultiPolygon).coordinates
      geometry = {
        type: 'MultiPolygon',
        coordinates: mesh.faces.map((face, faceIndex) =>
          face.every(ring => ring.every(index => mesh.vertices[index] === baseVertices[index])) ? baseCoordinates[faceIndex]! : face.map(ring => closeIndexedRing(mesh.vertices, ring)),
        ),
      }
    } else geometry = meshFromIndexed(mesh)
    const edited: DrawFeature = { ...feature, geometry }
    const elements = elementsOfMesh(mesh, sameFaces ? base : null)
    if (sameFaces) elements.origin = { feature, elements: base }
    this.elementsCache.set(edited, elements)
    return edited
  }

  /** A polygon as a prism `heightMeters` tall, standing at its altitudes or on the terrain under it. */
  protected prismOf(feature: DrawFeature, heightMeters: number): DrawFeature {
    if (feature.geometry.type !== 'Polygon') return feature
    const ground = this.groundOf(feature, lowestAltitude(feature.geometry) ?? this.groundFallbackMeters)
    return { ...feature, geometry: prismMesh(feature.geometry.coordinates, position => (hasAltitude(position) ? position[2]! : ground(position[0]!, position[1]!)), heightMeters) }
  }

  /** Screen pixels of a feature version's elements for the current view (kept while it stays), and what can be picked. */
  protected screensOf(feature: DrawFeature, elements: FeatureElements): ElementScreens {
    const context = this.context!
    const view = context.viewVersion?.()
    const cached = this.elementScreens.get(feature)
    if (cached !== undefined && view !== undefined && cached.view === view) return cached
    const count = elements.positions.length
    // A drag's step: the stored version's pixels for this view, only the moved vertices projected again.
    const origin = elements.origin
    const originScreens = origin === undefined ? undefined : this.elementScreens.get(origin.feature)
    const reuse = originScreens !== undefined && origin!.elements.positions.length === count && view !== undefined && originScreens.view === view
    const x = reuse ? originScreens.x.slice() : new Float64Array(count)
    const y = reuse ? originScreens.y.slice() : new Float64Array(count)
    for (let index = 0; index < count; index++) {
      const position = elements.positions[index]!
      if (reuse && position === origin!.elements.positions[index]) continue
      const height = elements.heights[index]!
      const screen = height === null ? context.project([position[0]!, position[1]!], this.groundFallbackMeters) : context.projectAtHeight([position[0]!, position[1]!], height)
      x[index] = screen?.x ?? Number.NaN
      y[index] = screen?.y ?? Number.NaN
    }
    const frontFaces = new Uint8Array(elements.faces.length)
    const visible = new Uint8Array(count)
    const visibleEdges = new Uint8Array(elements.edges.length)
    elements.faces.forEach((face, faceIndex) => {
      // Counter-clockwise seen from outside is clockwise on the screen (y down): a negative area.
      const ring = face[0] ?? []
      let area = 0
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!
        const b = ring[(index + 1) % ring.length]!
        area += x[a]! * y[b]! - x[b]! * y[a]!
      }
      if (!elements.closed || area < 0) {
        frontFaces[faceIndex] = 1
        if (elements.closed) {
          for (const each of face) for (const index of each) visible[index] = 1
          for (const edge of elements.faceEdges[faceIndex] ?? []) visibleEdges[edge] = 1
        }
      }
    })
    if (!elements.closed) {
      visible.fill(1)
      visibleEdges.fill(1)
    }
    const screens: ElementScreens = { view, x, y, visible, frontFaces, visibleEdges }
    if (view !== undefined) this.elementScreens.set(feature, screens)
    return screens
  }

  /**
   * The element of a feature in edit mode under a press, of the current element mode: the nearest vertex or edge within
   * reach (10 px with a mouse, 22 with a finger), or the face under it nearest the camera. Only those turned to the
   * camera on a closed mesh.
   */
  protected elementAt(event: DrawPointerEvent, feature: DrawFeature): PickedElement | null {
    const elements = this.elementsOf(feature)
    if (elements === null) return null
    const { x, y, visible, frontFaces, visibleEdges } = this.screensOf(feature, elements)
    const pointerX = event.screen.xPixels
    const pointerY = event.screen.yPixels
    const reach = hitTolerancePixels(event.pointerType)
    if (this.element === 'vertex') {
      let best = -1
      let bestDistance = reach
      for (let index = 0; index < x.length; index++) {
        if (visible[index] !== 1) continue
        const distance = Math.hypot(x[index]! - pointerX, y[index]! - pointerY)
        if (distance <= bestDistance) {
          best = index
          bestDistance = distance
        }
      }
      return best < 0 ? null : { kind: 'vertex', index: best }
    }
    if (this.element === 'edge') {
      let best: [number, number] | null = null
      let bestDistance = reach
      for (let edgeIndex = 0; edgeIndex < elements.edges.length; edgeIndex++) {
        if (visibleEdges[edgeIndex] !== 1) continue
        const edge = elements.edges[edgeIndex]!
        const [a, b] = edge
        const distance = distanceToSegment(pointerX, pointerY, x[a]!, y[a]!, x[b]!, y[b]!)
        if (distance <= bestDistance) {
          best = edge
          bestDistance = distance
        }
      }
      return best === null ? null : { kind: 'edge', from: best[0], to: best[1] }
    }
    // Faces in front of each other (a hollow shape): the one whose middle is nearest the camera wins.
    let best = -1
    let bestDepth = Infinity
    const depthAtHeight = this.context!.depthAtHeight
    elements.faces.forEach((face, faceIndex) => {
      if (frontFaces[faceIndex] !== 1 || !insideScreenFace(face, x, y, pointerX, pointerY)) return
      let depth = 0
      if (depthAtHeight !== undefined) {
        const indices = face[0]!
        let longitude = 0
        let latitude = 0
        let height = 0
        for (const index of indices) {
          const position = elements.positions[index]!
          longitude += position[0]! / indices.length
          latitude += position[1]! / indices.length
          height += (elements.heights[index] ?? this.groundFallbackMeters) / indices.length
        }
        depth = depthAtHeight([longitude, latitude], height) ?? 0
      }
      if (best < 0 || depth < bestDepth) {
        best = faceIndex
        bestDepth = depth
      }
    })
    return best < 0 ? null : { kind: 'face', index: best }
  }

  /** The vertex indices of some elements, each once (none for elements the version does not have). */
  protected pickedVertices(elements: FeatureElements, picked: readonly PickedElement[]): number[] {
    return [...new Set(picked.flatMap(element => (elementFits(elements, element) ? this.elementVertices(elements, element) : [])))]
  }

  /** The vertex indices of an element. */
  protected elementVertices(elements: FeatureElements, element: PickedElement): number[] {
    if (element.kind === 'vertex') return [element.index]
    if (element.kind === 'edge') return [element.from, element.to]
    return [...new Set((elements.faces[element.index] ?? []).flat())]
  }

  /**
   * Whether, in edit mode, something under a press wins over the gizmo's handles there: a picked face's push and pull
   * arrow, or a vertex, edge or handle (a midpoint too) that is not picked, so the gizmo of one vertex never hides its
   * neighbours. What is picked never does: pressing it moves it, as the gizmo's ring.
   */
  protected gizmoCovered(event: DrawPointerEvent): boolean {
    const feature = this.elementEditedFeature()
    if (feature === null || this.picked?.feature !== feature) return false
    if (this.arrowAt(event) !== null) return true
    const picked = this.picked.elements
    if (this.showsVertexHandles(feature)) {
      const handle = this.handleAt(event)
      if (handle === null) return false
      if (handle.kind === 'midpoint') return true
      const index = this.vertexIndex(feature, handle.path)
      return !picked.some(element => element.kind === 'vertex' && element.index === index)
    }
    if (this.element === 'face') return false
    const element = this.elementAt(event, feature)
    return element !== null && !picked.some(each => sameElement(each, element))
  }

  /** In edit mode, the drag a press starts: the picked face's arrow, else an element (not a line's or polygon's vertex handles). */
  protected elementDragAt(event: DrawPointerEvent): SelectDrag | null {
    const feature = this.elementEditedFeature()
    if (feature === null) return null
    const arrow = this.arrowAt(event)
    if (arrow !== null) {
      const update = this.arrowUpdate(arrow, event)
      return update === null ? null : { kind: 'element', base: feature, feature, element: null, update }
    }
    if (this.showsVertexHandles(feature)) return null
    const element = this.elementAt(event, feature)
    if (element === null) return null
    // A picked element moves with every other picked one.
    const picked = this.picked?.feature === feature ? this.picked.elements : []
    const moved = picked.some(each => sameElement(each, element)) ? picked : [element]
    return { kind: 'element', base: feature, feature, element, update: this.elementMoveUpdate(feature, moved, event) ?? (() => null) }
  }

  /**
   * How a drag moves an element level under the pointer, at its altitude (a mesh's vertices in every face sharing them),
   * or on the terrain for a draped line or polygon. Null when the press is not over the map.
   */
  protected elementMoveUpdate(feature: DrawFeature, moved: readonly PickedElement[], press: DrawPointerEvent): ((event: DrawPointerEvent) => DrawFeature | null) | null {
    const context = this.context!
    const elements = this.elementsOf(feature)
    if (elements === null) return null
    const indices = this.pickedVertices(elements, moved)
    if (indices.length === 0) return null
    let level: number | null = 0
    for (const index of indices) {
      const height = elements.heights[index]!
      level = level === null || height === null ? null : level + height / indices.length
    }
    const first = elements.positions[indices[0]!]!
    const start = level === null ? (press.geographic === null ? null : ([press.geographic.longitudeDegrees, press.geographic.latitudeDegrees] as LongitudeLatitude)) : this.positionUnderPointer(press.screen.xPixels, press.screen.yPixels, level, [first[0]!, first[1]!])
    if (start === null) return null
    const target = (event: DrawPointerEvent): LongitudeLatitude | null => {
      if (level !== null) return this.positionUnderPointer(event.screen.xPixels, event.screen.yPixels, level, start)
      const ground = event.geographic
      if (ground === null) return null
      context.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
      return [ground.longitudeDegrees, ground.latitudeDegrees]
    }
    const mesh = elements.mesh
    if (mesh !== null) {
      const frame = new LocalFrame(start[0], start[1], level ?? 0)
      return event => {
        const to = target(event)
        if (to === null) return null
        // A rigid step from where it was grabbed to where it is under the pointer, at the same altitude.
        return this.withMesh(feature, moveMeshVertices(mesh, indices, frame.toLocal(to[0], to[1], level ?? 0), frame))
      }
    }
    const paths = indices.map(index => elements.paths![index]!)
    return event => {
      const to = target(event)
      return to === null ? null : moveVertices(feature, paths, start, to)
    }
  }

  /**
   * The push and pull arrow of a feature version's picked face for the current view: from the face's middle along its
   * outward normal (up, for a polygon), `gizmoSizePixels` long, or a knob up the screen when the normal points at the
   * camera. Null without a picked face, or with the face turned away from the camera along the line of sight.
   */
  protected arrowOf(feature: DrawFeature): PushArrow | null {
    const context = this.context
    const picked = this.picked
    const element = picked?.elements.length === 1 ? picked.elements[0]! : null
    if (context === null || !this.vertexEditing || picked === null || element?.kind !== 'face' || picked.feature.id !== feature.id) return null
    const face = element.index
    const view = context.viewVersion?.()
    const cached = this.arrowCache.get(feature)
    if (cached !== undefined && view !== undefined && cached.view === view && cached.face === face) return cached.arrow
    const arrow = this.buildArrow(feature, face)
    if (view !== undefined) this.arrowCache.set(feature, { view, face, arrow })
    return arrow
  }

  protected buildArrow(feature: DrawFeature, face: number): PushArrow | null {
    const context = this.context!
    const elements = this.elementsOf(feature)
    if (elements === null || elements.faces[face] === undefined) return null
    let frame: LocalFrame
    let normal: LocalPoint
    if (elements.mesh !== null) {
      frame = meshElementFrame(elements.mesh, meshFaceVertices(elements.mesh, face))
      normal = meshFaceNormal(elements.mesh, face, frame)
      if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null
    } else {
      const { center, range } = this.geometryOf(feature)
      frame = new LocalFrame(center[0], center[1], range?.minimumMeters ?? context.heights.heightAt(center[0], center[1], this.groundFallbackMeters))
      normal = [0, 0, 1]
    }
    const from = this.gizmoScreenOf(frame, [0, 0, 0])
    if (from === null) return null
    let squares = 0
    for (const axis of WORLD_AXES) {
      const offset = this.screenOffset(frame, axis[0], axis[1], axis[2], from)
      if (offset === null) return null
      squares += offset.x * offset.x + offset.y * offset.y
    }
    const pixelsPerMetre = Math.sqrt(squares / 2)
    if (!(pixelsPerMetre > 0) || !Number.isFinite(pixelsPerMetre)) return null
    const lengthMeters = this.gizmoSizePixels / pixelsPerMetre
    const along = this.screenOffset(frame, normal[0] * lengthMeters, normal[1] * lengthMeters, normal[2] * lengthMeters, from)
    if (along === null) return null
    if (Math.hypot(along.x, along.y) >= this.gizmoSizePixels * MINIMUM_AXIS_SHARE) return { feature, face, frame, normal, lengthMeters, from, along, knob: false }
    // Along the line of sight: a face seen squarely (a top from above, a wall from in front) pulls up the screen, as the
    // gizmo's up knob, when it faces the camera; a face turned away shows none.
    const depthAtHeight = this.context!.depthAtHeight
    let facesCamera = normal[2] > 0
    if (depthAtHeight !== undefined) {
      const center = frame.toGeographic(0, 0, 0)
      const tip = frame.toGeographic(normal[0] * lengthMeters, normal[1] * lengthMeters, normal[2] * lengthMeters)
      const centerDepth = depthAtHeight([center[0], center[1]], center[2])
      const tipDepth = depthAtHeight([tip[0], tip[1]], tip[2])
      if (centerDepth !== null && tipDepth !== null) facesCamera = tipDepth < centerDepth
    }
    if (!facesCamera) return null
    return { feature, face, frame, normal, lengthMeters, from, along: { x: 0, y: -this.gizmoSizePixels }, knob: true }
  }

  /** Screen pixels of a point of a frame, or null when hidden. */
  protected gizmoScreenOf(frame: LocalFrame, local: LocalPoint): Screen | null {
    const [longitude, latitude, height] = frame.toGeographic(local[0], local[1], local[2])
    return this.context!.projectAtHeight([longitude, latitude], height)
  }

  /** The selected feature's push and pull arrow under a press (within reach of its shaft or knob), or null. */
  protected arrowAt(event: DrawPointerEvent): PushArrow | null {
    const feature = this.elementEditedFeature()
    const arrow = feature === null ? null : this.arrowOf(feature)
    if (arrow === null) return null
    const x = event.screen.xPixels
    const y = event.screen.yPixels
    const reach = Math.max(hitTolerancePixels(event.pointerType), ARROWHEAD_PIXELS / 2)
    const distance = arrow.knob
      ? Math.hypot(x - arrow.from.x, y - (arrow.from.y + arrow.along.y * 0.85))
      : distanceToSegment(x, y, arrow.from.x + arrow.along.x * ARROW_START, arrow.from.y + arrow.along.y * ARROW_START, arrow.from.x + arrow.along.x, arrow.from.y + arrow.along.y)
    return distance <= reach ? arrow : null
  }

  /** How a drag on the arrow pushes or pulls its face: by the pointer's travel along the arrow on the screen. */
  protected arrowUpdate(arrow: PushArrow, press: DrawPointerEvent): ((event: DrawPointerEvent) => DrawFeature | null) | null {
    const { along } = arrow
    const lengthSquared = along.x * along.x + along.y * along.y
    if (lengthSquared < 1) return null
    const elements = this.elementsOf(arrow.feature)
    if (elements === null) return null
    const pressX = press.screen.xPixels
    const pressY = press.screen.yPixels
    return event => {
      const meters = (((event.screen.xPixels - pressX) * along.x + (event.screen.yPixels - pressY) * along.y) / lengthSquared) * arrow.lengthMeters
      if (elements.mesh !== null) return meters === 0 ? arrow.feature : this.withMesh(arrow.feature, pushMeshFace(elements.mesh, arrow.face, meters))
      // A polygon pulled up becomes a prism; pushed down, it stays flat.
      return meters < MINIMUM_PRISM_METERS ? arrow.feature : this.prismOf(arrow.feature, meters)
    }
  }

  /** Edit mode over the map: a mesh's edges, the elements to pick, what is hovered and picked, and the picked face's arrow. */
  protected elementsOverlay(feature: DrawFeature, content: OverlayContent, style: DrawStyle, drag: Extract<SelectDrag, { kind: 'element' }> | null): void {
    const elements = this.elementsOf(feature)
    if (elements === null) return
    const { visible, visibleEdges } = this.screensOf(feature, elements)
    const { positions } = elements
    const heightOf = (index: number) => elements.heights[index] ?? this.context!.heights.heightAt(positions[index]![0]!, positions[index]![1]!, this.groundFallbackMeters)
    const line = (indices: readonly number[], color: string, widthPixels: number, opacity: number) =>
      content.lines.push({ positions: indices.map(index => [positions[index]![0]!, positions[index]![1]!]), heightsMeters: indices.map(heightOf), color, widthPixels, opacity })
    if (elements.mesh !== null) elements.edges.forEach(([a, b], edgeIndex) => visibleEdges[edgeIndex] === 1 && line([a, b], style.vertexOutlineColor, 1.5, 0.9))
    // Elements of another version (the feature changed since) may name vertices or faces it no longer has: skipped.
    const fits = (element: PickedElement | null): PickedElement | null => (element !== null && elementFits(elements, element) ? element : null)
    // Dragging an element not picked shows it picked alone; a picked one moves them all.
    const stored = this.picked?.feature.id === feature.id ? this.picked.elements : []
    const dragged = drag?.element ?? null
    const picked = (dragged !== null && !stored.some(each => sameElement(each, dragged)) ? [dragged] : stored).filter(each => fits(each) !== null)
    const pickedVertices = new Set(picked.flatMap(each => (each.kind === 'vertex' ? [each.index] : [])))
    const hovered = drag === null ? fits(this.hoveredElement) : null
    if (this.element === 'vertex') {
      positions.forEach((position, index) => {
        if (visible[index] !== 1) return
        const isPicked = pickedVertices.has(index)
        const isHovered = hovered?.kind === 'vertex' && hovered.index === index
        content.handles.push({
          position: [position[0]!, position[1]!],
          heightMeters: heightOf(index),
          radiusPixels: isPicked ? style.vertexRadiusPixels + 2 : style.vertexRadiusPixels - 1,
          color: isPicked || isHovered ? ACTIVE_COLOR : style.vertexColor,
          outlineColor: style.vertexOutlineColor,
          outlineWidthPixels: style.vertexOutlineWidthPixels,
        })
      })
    }
    for (const [element, opacity] of [[hovered, 0.6] as const, ...picked.map(each => [each, 1] as const)]) {
      if (element === null || element.kind === 'vertex') continue
      if (element.kind === 'edge') {
        line([element.from, element.to], ACTIVE_COLOR, 4, opacity)
        continue
      }
      const face = elements.faces[element.index]
      if (face === undefined) continue
      for (const ring of face) line([...ring, ring[0]!], ACTIVE_COLOR, opacity === 1 ? 3 : 2, opacity)
      if (opacity !== 1) continue
      // The picked face filled, a triangle at a time (it may be concave).
      for (const triangle of this.trianglesOf(feature, elements, element.index)) {
        ;(content.polygons ??= []).push({ positions: triangle.map(index => [positions[index]![0]!, positions[index]![1]!]), heightsMeters: triangle.map(heightOf), color: ACTIVE_COLOR, opacity: 0.3 })
      }
    }
    const arrow = this.arrowOf(feature)
    if (arrow === null) return
    const color = this.hoveredArrow || (drag !== null && drag.element === null) ? ACTIVE_COLOR : AXIS_COLORS[2]
    const center = arrow.frame.toGeographic(0, 0, 0)
    if (arrow.knob) {
      content.handles.push({ position: [center[0], center[1]], heightMeters: center[2], radiusPixels: 6, color, outlineColor: color, outlineWidthPixels: 0, offsetYPixels: -this.gizmoSizePixels * 0.85, stemWidthPixels: ARROW_WIDTH_PIXELS })
      return
    }
    const { normal, lengthMeters } = arrow
    const points = [ARROW_START, 1].map(share => arrow.frame.toGeographic(normal[0] * lengthMeters * share, normal[1] * lengthMeters * share, normal[2] * lengthMeters * share))
    content.lines.push({ positions: points.map(point => [point[0], point[1]]), heightsMeters: points.map(point => point[2]), color, widthPixels: ARROW_WIDTH_PIXELS, opacity: 1, arrowheadPixels: ARROWHEAD_PIXELS })
  }

  /** The triangles of a face of a feature version, computed once. */
  protected trianglesOf(feature: DrawFeature, elements: FeatureElements, face: number): Array<[number, number, number]> {
    let faces = this.faceTriangles.get(feature)
    if (faces === undefined) this.faceTriangles.set(feature, (faces = new Map()))
    let triangles = faces.get(face)
    if (triangles === undefined) {
      const mesh = elements.mesh ?? { vertices: elements.positions.map(position => [position[0]!, position[1]!, position[2] ?? 0]), faces: elements.faces }
      triangles = meshFaceTriangles(mesh, face)
      faces.set(face, triangles)
    }
    return triangles
  }

  /** Records what restores an edit, then makes it. */
  protected commit(restore: DrawFeature[], edit: () => void): void {
    this.committing = true
    try {
      edit()
    } finally {
      this.committing = false
    }
    this.undoStack.push({ restore })
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift()
    this.context?.changed()
  }

  protected hitInput(event: DrawPointerEvent) {
    const context = this.context!
    const ground = event.geographic
    const fallbackHeight = ground?.heightMeters ?? 0
    return {
      ground: ground === null ? ([Number.NaN, Number.NaN] as LongitudeLatitude) : ([ground.longitudeDegrees, ground.latitudeDegrees] as LongitudeLatitude),
      screen: { x: event.screen.xPixels, y: event.screen.yPixels },
      tolerancePixels: hitTolerancePixels(event.pointerType),
      project: (position: Position, aboveMeters = 0) => {
        const longitudeLatitude: LongitudeLatitude = [position[0]!, position[1]!]
        if (position.length > 2 && Number.isFinite(position[2])) return context.projectAtHeight(longitudeLatitude, position[2]! + aboveMeters)
        if (aboveMeters === 0) return context.project(longitudeLatitude, fallbackHeight)
        return context.projectAtHeight(longitudeLatitude, context.heights.heightAt(position[0]!, position[1]!, fallbackHeight) + aboveMeters)
      },
    }
  }

  /**
   * The feature a tap selects: the nearest point or line within reach, else a polygon: one containing the tap before
   * one whose outline is only near it, and the last drawn (on top) among equals.
   */
  protected featureAt(event: DrawPointerEvent): DrawFeature | null {
    const context = this.context
    if (context === null) return null
    const input = this.hitInput(event)
    let best: { feature: DrawFeature; rank: number; distance: number } | null = null
    for (const feature of context.store.values()) {
      const distance = hitFeature(feature, input)
      if (distance === null) continue
      // 0: points and lines, 1: polygons and meshes containing the tap, 2: those whose outline is near it.
      const rank = feature.geometry.type === 'Point' || feature.geometry.type === 'LineString' ? 0 : distance === 0 ? 1 : 2
      const better = best === null || rank < best.rank || (rank === best.rank && (rank === 1 ? true : distance <= best.distance))
      if (better) best = { feature, rank, distance }
    }
    return best?.feature ?? null
  }

  /** The selected feature under a press (as dragged so far), or null. */
  protected selectedFeatureAt(event: DrawPointerEvent): DrawFeature | null {
    const context = this.context
    if (context === null) return null
    const input = this.hitInput(event)
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature !== undefined && hitFeature(feature, input) !== null) return feature
    }
    return null
  }

  /** The vertex or midpoint handle of a selected feature under a press, nearest first. */
  protected handleAt(event: DrawPointerEvent): { kind: 'vertex' | 'midpoint'; featureId: string; path: VertexPath; position: LongitudeLatitude; heightMeters: number | null } | null {
    const context = this.context
    if (context === null) return null
    const input = this.hitInput(event)
    let best: { kind: 'vertex' | 'midpoint'; featureId: string; path: VertexPath; position: LongitudeLatitude; heightMeters: number | null; distance: number } | null = null
    const consider = (kind: 'vertex' | 'midpoint', featureId: string, path: VertexPath, longitude: number, latitude: number, heightMeters: number | null) => {
      // Where it is drawn: at its altitude, or on the terrain.
      const screen = heightMeters === null ? input.project([longitude, latitude]) : context.projectAtHeight([longitude, latitude], heightMeters)
      if (screen === null) return
      // Vertices win ties over midpoints, so a short edge's vertices stay reachable.
      const distance = Math.hypot(screen.x - input.screen.x, screen.y - input.screen.y) + (kind === 'midpoint' ? 0.5 : 0)
      if (distance <= input.tolerancePixels && (best === null || distance < best.distance)) best = { kind, featureId, path, position: [longitude, latitude], heightMeters, distance }
    }
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature === undefined || !this.showsVertexHandles(feature)) continue
      for (const { path, position } of featureVertices(feature)) consider('vertex', id, path, position[0]!, position[1]!, position.length > 2 && Number.isFinite(position[2]) ? position[2]! : null)
      for (const midpoint of featureMidpoints(feature)) consider('midpoint', id, midpoint.path, midpoint.position[0], midpoint.position[1], midpoint.heightMeters ?? null)
    }
    return best
  }

  /**
   * The position at `heightMeters` whose projection is at screen pixels `targetX`, `targetY`, found by Newton steps on
   * the screen from `start`. Null when it is hidden or cannot be found (the pointer over the horizon).
   */
  protected positionUnderPointer(targetX: number, targetY: number, heightMeters: number, start: LongitudeLatitude): LongitudeLatitude | null {
    const context = this.context
    if (context === null) return null
    const step = 1e-6
    let longitude = start[0]
    let latitude = start[1]
    for (let iteration = 0; iteration < 6; iteration++) {
      const here = context.projectAtHeight([longitude, latitude], heightMeters)
      if (here === null) return null
      const errorX = targetX - here.x
      const errorY = targetY - here.y
      if (Math.abs(errorX) + Math.abs(errorY) < 0.05) break
      const east = context.projectAtHeight([longitude + step, latitude], heightMeters)
      const north = context.projectAtHeight([longitude, latitude + step], heightMeters)
      if (east === null || north === null) return null
      // Pixels per degree of longitude and of latitude.
      const xLongitude = (east.x - here.x) / step
      const yLongitude = (east.y - here.y) / step
      const xLatitude = (north.x - here.x) / step
      const yLatitude = (north.y - here.y) / step
      const determinant = xLongitude * yLatitude - xLatitude * yLongitude
      if (!(Math.abs(determinant) > 1e-12)) return null
      // A step at most 10° long: far beyond that the linear guess means nothing.
      const deltaLongitude = Math.max(-10, Math.min(10, (yLatitude * errorX - xLatitude * errorY) / determinant))
      const deltaLatitude = Math.max(-10, Math.min(10, (xLongitude * errorY - yLongitude * errorX) / determinant))
      longitude += deltaLongitude
      latitude = Math.max(-89.999, Math.min(89.999, latitude + deltaLatitude))
    }
    const reached = context.projectAtHeight([longitude, latitude], heightMeters)
    return reached !== null && Math.hypot(reached.x - targetX, reached.y - targetY) < 2 ? [longitude, latitude] : null
  }

  // ---- Gizmo ----

  /** The axes of the gizmo on a feature version: east, north and up, or its own (computed once per version). */
  protected axesOf(feature: DrawFeature): readonly [LocalPoint, LocalPoint, LocalPoint] {
    if (this.space === 'world') return WORLD_AXES
    let axes = this.localAxes.get(feature)
    if (axes === undefined) {
      axes = featureAxes(feature)
      this.localAxes.set(feature, axes)
    }
    return axes
  }

  /** The center, altitudes and terrain sampler of a feature version, computed once. */
  protected geometryOf(feature: DrawFeature): { center: LongitudeLatitude; range: { minimumMeters: number; maximumMeters: number } | null; ground: GroundHeight | null } {
    let geometry = this.featureGeometry.get(feature)
    if (geometry === undefined) {
      geometry = { center: featureCenter(feature), range: altitudeRangeOf(feature), ground: null }
      this.featureGeometry.set(feature, geometry)
    }
    return geometry
  }

  /**
   * The terrain under a feature version's positions that have no altitude, sampled once (at the first drag that needs
   * it, as loaded then) and reused for every move of every drag: positions not sampled stand at `fallbackMeters`.
   */
  protected groundOf(feature: DrawFeature, fallbackMeters: number): GroundHeight {
    const geometry = this.geometryOf(feature)
    if (geometry.ground !== null) return geometry.ground
    const heights = this.context!.heights
    let sampled: Map<number, Map<number, number>> | null = null
    const ground: GroundHeight = (longitude, latitude) => {
      if (sampled === null) {
        sampled = new Map()
        for (const position of storedPositions(feature.geometry)) {
          if (hasAltitude(position)) continue
          let row = sampled.get(position[0]!)
          if (row === undefined) sampled.set(position[0]!, (row = new Map()))
          if (!row.has(position[1]!)) row.set(position[1]!, heights.heightAt(position[0]!, position[1]!, fallbackMeters, { immediate: true }))
        }
      }
      return sampled.get(longitude)?.get(latitude) ?? fallbackMeters
    }
    geometry.ground = ground
    return ground
  }

  /**
   * The gizmo of a feature for the current camera, or null when its center is hidden. Its size in metres comes from the
   * screen: the pixels one metre spans at the center along east, north and up (their squares add up to twice the
   * squared scale, whatever the view), so the gizmo keeps its size on the screen at any zoom. A feature on the terrain
   * has it at the terrain's height under its center (`groundFallbackMeters` where not known yet). Kept per feature version
   * while the view (`viewVersion`) stays.
   */
  protected gizmoBasis(feature: DrawFeature): GizmoBasis | null {
    const context = this.context
    if (context === null) return null
    const { center, range } = this.geometryOf(feature)
    const groundMeters = range === null ? context.heights.heightAt(center[0], center[1], this.groundFallbackMeters) : 0
    const heightMeters = range === null ? groundMeters : (range.minimumMeters + range.maximumMeters) / 2
    const view = context.viewVersion?.()
    const cached = this.gizmoCache.get(feature)
    if (view !== undefined && cached !== undefined && cached.view === view && cached.space === this.space && cached.heightMeters === heightMeters) return cached.basis
    const basis = this.basisAt(feature, center, heightMeters, range?.minimumMeters ?? groundMeters, range === null)
    if (basis !== null && view !== undefined) this.gizmoCache.set(feature, { view, space: this.space, heightMeters, basis })
    return basis
  }

  /**
   * The gizmo of the picked elements of the selected feature in edit mode, for the current camera: move handles only,
   * at the middle of their vertices, moving only them. Null outside edit mode, with nothing picked, or with `move: false`.
   */
  protected elementGizmoBasis(feature: DrawFeature): GizmoBasis | null {
    const context = this.context
    const picked = this.picked
    if (context === null || !this.move || picked === null || picked.feature.id !== feature.id || !this.editsElements(feature)) return null
    const elements = this.elementsOf(feature)
    if (elements === null) return null
    const indices = this.pickedVertices(elements, picked.elements)
    if (indices.length === 0) return null
    // A line or polygon on the terrain has its gizmo on it; one with altitudes stands its vertices without one at the lowest.
    const lowest = elements.mesh === null ? lowestAltitude(feature.geometry) : null
    const onTerrain = elements.mesh === null && lowest === null
    const first = elements.positions[indices[0]!]!
    let longitude = 0
    let latitude = 0
    let height = 0
    for (const index of indices) {
      const position = elements.positions[index]!
      longitude += unwrapLongitudeNear(position[0]!, first[0]!) / indices.length
      latitude += position[1]! / indices.length
      height += (elements.heights[index] ?? lowest ?? 0) / indices.length
    }
    const center: LongitudeLatitude = [longitude, latitude]
    // On the terrain, the height under it as known now: the gizmo follows it as finer tiles load.
    const heightMeters = onTerrain ? context.heights.heightAt(longitude, latitude, this.groundFallbackMeters) : height
    const view = context.viewVersion?.()
    const cached = this.elementGizmoCache.get(feature)
    if (view !== undefined && cached !== undefined && cached.view === view && cached.space === this.space && cached.picked === picked.elements && cached.heightMeters === heightMeters) return cached.basis
    const basis = this.basisAt(feature, center, heightMeters, heightMeters, onTerrain)
    if (basis === null) return null
    const { frame } = basis
    const mesh = elements.mesh
    const paths = elements.paths
    basis.moveElements =
      mesh !== null
        ? offset => this.withMesh(feature, moveMeshVertices(mesh, indices, offset, frame))
        : offset => offsetVertices(feature, indices.map(index => paths![index]!), offset, frame, basis.ground)
    // One picked face: its push and pull arrow stands for the axis along its normal.
    const arrow = this.arrowOf(feature)
    if (arrow !== null) basis.hiddenAxes = [0, 1, 2].filter(index => Math.abs(dot(basis.axes[index]!, arrow.normal)) > PARALLEL_AXIS_COSINE)
    if (view !== undefined) this.elementGizmoCache.set(feature, { view, space: this.space, picked: picked.elements, heightMeters, basis })
    return basis
  }

  /** The gizmo a selected feature shows: its own, or in edit mode its picked elements' (null for none). */
  protected gizmoFor(feature: DrawFeature): GizmoBasis | null {
    return this.showsGizmo(feature) ? this.gizmoBasis(feature) : this.elementGizmoBasis(feature)
  }

  /** A gizmo at a center and altitude, for the current camera, or null when its center is hidden. */
  protected basisAt(feature: DrawFeature, center: LongitudeLatitude, heightMeters: number, baseMeters: number, onTerrain: boolean): GizmoBasis | null {
    const context = this.context!
    const frame = new LocalFrame(center[0], center[1], heightMeters)
    const centerScreen = context.projectAtHeight(center, heightMeters)
    if (centerScreen === null) return null
    let squares = 0
    for (const axis of WORLD_AXES) {
      const offset = this.screenOffset(frame, axis[0], axis[1], axis[2], centerScreen)
      if (offset === null) return null
      squares += offset.x * offset.x + offset.y * offset.y
    }
    const pixelsPerMetre = Math.sqrt(squares / 2)
    if (!(pixelsPerMetre > 0) || !Number.isFinite(pixelsPerMetre)) return null
    const sizeMeters = this.gizmoSizePixels / pixelsPerMetre
    const centerDepth = context.depthAtHeight?.(center, heightMeters) ?? null
    const axes: LocalPoint[] = []
    const axisScreen: Screen[] = []
    this.axesOf(feature).forEach((axis, index) => {
      const offset = this.screenOffset(frame, axis[0] * sizeMeters, axis[1] * sizeMeters, axis[2] * sizeMeters, centerScreen)
      // An x or y axis pointing away from the camera is drawn the other way, towards it (as Blender's gizmo flips), so
      // no two arrows lie on each other (north and up, seen looking north). z never turns: it would point into the feature.
      let away = false
      if (index < 2 && centerDepth !== null) {
        const [longitude, latitude, height] = frame.toGeographic(axis[0] * sizeMeters, axis[1] * sizeMeters, axis[2] * sizeMeters)
        const depth = context.depthAtHeight!([longitude, latitude], height)
        away = depth !== null && depth > centerDepth
      }
      axes.push(away ? [-axis[0], -axis[1], -axis[2]] : axis)
      axisScreen.push(offset === null ? { x: 0, y: 0 } : away ? { x: -offset.x, y: -offset.y } : offset)
    })
    return {
      feature,
      center,
      heightMeters,
      baseMeters,
      onTerrain,
      frame,
      axes: axes as [LocalPoint, LocalPoint, LocalPoint],
      sizeMeters,
      ground: this.groundOf(feature, baseMeters),
      centerScreen,
      axisScreen: axisScreen as [Screen, Screen, Screen],
    }
  }

  /** Screen pixels from the gizmo center to a point of its frame, or null when it is hidden. */
  protected screenOffset(frame: LocalFrame, east: number, north: number, up: number, centerScreen: Screen): Screen | null {
    const [longitude, latitude, height] = frame.toGeographic(east, north, up)
    const screen = this.context!.projectAtHeight([longitude, latitude], height)
    return screen === null ? null : { x: screen.x - centerScreen.x, y: screen.y - centerScreen.y }
  }

  /** Whether an axis is (nearly) straight up. */
  protected isVertical(axis: LocalPoint): boolean {
    return axis[2] > 0.999
  }

  /** Whether an axis's arrow shows: long enough on the screen not to point at the camera. */
  protected axisShows(basis: GizmoBasis, index: number): boolean {
    const screen = basis.axisScreen[index]!
    return Math.hypot(screen.x, screen.y) >= this.gizmoSizePixels * MINIMUM_AXIS_SHARE
  }

  /**
   * Screen pixels of `sizeMeters` along an axis, for dragging along it; null when it points at the camera. Up seen from
   * (nearly) straight above, as on the flat map, goes up the screen instead, a gizmo length per arrow length.
   */
  protected axisScreen(basis: GizmoBasis, index: number): Screen | null {
    if (this.axisShows(basis, index)) return basis.axisScreen[index]!
    return this.isVertical(basis.axes[index]!) ? { x: 0, y: -this.gizmoSizePixels } : null
  }

  /** The tool a gizmo shows: the gizmo tool, or move for picked elements. */
  protected toolOf(basis: GizmoBasis): GizmoTool {
    return basis.moveElements !== undefined ? 'move' : this.tool
  }

  /** The pieces of a gizmo for the current camera and tool (kept per gizmo and tool). */
  protected gizmoParts(basis: GizmoBasis): GizmoPart[] {
    const cached = this.partsCache.get(basis)
    if (cached !== undefined && cached.tool === this.toolOf(basis)) return cached.parts
    const parts = this.buildGizmoParts(basis)
    this.partsCache.set(basis, { tool: this.toolOf(basis), parts })
    return parts
  }

  /** The screen pixels of a part's points, projected once per gizmo. */
  protected partScreens(basis: GizmoBasis, part: GizmoPart): Array<Screen | null> {
    part.screens ??= part.local.map(local => this.gizmoScreen(basis, local))
    return part.screens
  }

  protected buildGizmoParts(basis: GizmoBasis): GizmoPart[] {
    const parts: GizmoPart[] = []
    const { axes, sizeMeters } = basis
    const tool = this.toolOf(basis)
    const moves = this.move && (tool === 'all' || tool === 'move')
    const rotates = this.rotate && (tool === 'all' || tool === 'rotate')
    const scales = this.scale && (tool === 'all' || tool === 'scale')
    const at = (index: number, distance: number): LocalPoint => {
      const axis = axes[index]!
      return [axis[0] * distance * sizeMeters, axis[1] * distance * sizeMeters, axis[2] * distance * sizeMeters]
    }
    const combine = (first: number, a: number, second: number, b: number): LocalPoint => {
      const one = axes[first]!
      const two = axes[second]!
      return [(one[0] * a + two[0] * b) * sizeMeters, (one[1] * a + two[1] * b) * sizeMeters, (one[2] * a + two[2] * b) * sizeMeters]
    }
    const names = ['x', 'y', 'z'] as const
    if (rotates) {
      // Around z a full circle; around x and y the half above the plane of x and y, so they stand out of the ground.
      for (const index of [2, 0, 1] as const) {
        const [first, second] = index === 2 ? [0, 1] : index === 0 ? [1, 2] : [0, 2]
        const a = basis.axisScreen[first]!
        const b = basis.axisScreen[second]!
        if (Math.abs(a.x * b.y - a.y * b.x) < EDGE_ON_SHARE * this.gizmoSizePixels * this.gizmoSizePixels) continue
        const full = index === 2
        const samples = full ? FULL_ARC_SAMPLES : HALF_ARC_SAMPLES
        const local: LocalPoint[] = []
        for (let sample = 0; sample <= samples; sample++) {
          const angle = ((full ? 2 : 1) * Math.PI * sample) / samples
          local.push(combine(first, Math.cos(angle) * ARC_RADIUS, second, Math.sin(angle) * ARC_RADIUS))
        }
        const grab = combine(first, Math.SQRT1_2 * ARC_RADIUS, second, Math.SQRT1_2 * ARC_RADIUS)
        parts.push({ handle: `rotate-${names[index]}`, kind: 'line', local, color: AXIS_COLORS[index], sizePixels: ARC_WIDTH_PIXELS, grab })
      }
    }
    for (const index of [0, 1, 2] as const) {
      const shows = this.axisShows(basis, index)
      if (basis.hiddenAxes?.includes(index) === true) {
        // Left to the push and pull arrow.
      } else if (moves && shows) {
        parts.push({ handle: `move-${names[index]}`, kind: 'line', local: [at(index, ARROW_START), at(index, 1)], color: AXIS_COLORS[index], sizePixels: ARROW_WIDTH_PIXELS, arrowhead: true, grab: at(index, 0.6) })
      } else if (moves && this.isVertical(axes[index]!)) {
        // Up seen from above: a knob on a stem up the screen.
        parts.push({ handle: `move-${names[index]}`, kind: 'knob', local: [[0, 0, 0]], color: AXIS_COLORS[index], sizePixels: 6, grab: [0, 0, 0] })
      }
      if (scales && shows) {
        const distance = tool === 'scale' ? 1 : CUBE_DISTANCE
        if (tool === 'scale') parts.push({ handle: `scale-${names[index]}`, kind: 'line', local: [at(index, ARROW_START), at(index, distance)], color: AXIS_COLORS[index], sizePixels: 2, grab: at(index, 0.6) })
        parts.push({ handle: `scale-${names[index]}`, kind: 'dot', local: [at(index, distance)], color: AXIS_COLORS[index], sizePixels: CUBE_PIXELS, grab: at(index, distance) })
      }
    }
    if (moves) {
      const full = (PLANE_FAR - PLANE_NEAR) * this.gizmoSizePixels
      for (const [first, second, normal] of [[0, 1, 2], [1, 2, 0], [0, 2, 1]] as const) {
        const a = basis.axisScreen[first]!
        const b = basis.axisScreen[second]!
        // The square's area on the screen against its full size: edge on, it hides.
        const share = (Math.abs(a.x * b.y - a.y * b.x) * (PLANE_FAR - PLANE_NEAR) ** 2) / (full * full)
        if (share < MINIMUM_PLANE_SHARE) continue
        const handle = `move-${names[first]}${names[second]}` as GizmoHandle
        const middle = (PLANE_NEAR + PLANE_FAR) / 2
        parts.push({
          handle,
          kind: 'plane',
          local: [combine(first, PLANE_NEAR, second, PLANE_NEAR), combine(first, PLANE_FAR, second, PLANE_NEAR), combine(first, PLANE_FAR, second, PLANE_FAR), combine(first, PLANE_NEAR, second, PLANE_FAR)],
          color: AXIS_COLORS[normal],
          sizePixels: 0,
          grab: combine(first, middle, second, middle),
        })
      }
    }
    if (moves) parts.push({ handle: 'move-free', kind: 'ring', local: [[0, 0, 0]], color: RING_COLOR, sizePixels: CENTER_RING_PIXELS, grab: [0, 0, 0] })
    else if (scales && tool === 'scale') parts.push({ handle: 'scale-uniform', kind: 'ring', local: [[0, 0, 0]], color: RING_COLOR, sizePixels: CENTER_RING_PIXELS, grab: [0, 0, 0], fromCenter: true })
    if (scales) parts.push({ handle: 'scale-uniform', kind: 'ring', local: [[0, 0, 0]], color: RING_COLOR, sizePixels: OUTER_RING_RADIUS * this.gizmoSizePixels, grab: [0, 0, 0] })
    return parts
  }

  /** Screen pixels of a point of the gizmo's frame, or null when hidden. */
  protected gizmoScreen(basis: GizmoBasis, local: LocalPoint): Screen | null {
    const offset = this.screenOffset(basis.frame, local[0], local[1], local[2], basis.centerScreen)
    return offset === null ? null : { x: basis.centerScreen.x + offset.x, y: basis.centerScreen.y + offset.y }
  }

  /** Where a part is grabbed on the screen (`gizmoHandles`). */
  protected grabScreen(basis: GizmoBasis, part: GizmoPart): Screen | null {
    const center = basis.centerScreen
    if (part.kind === 'ring') return part.fromCenter === true || part.handle === 'move-free' ? { x: center.x, y: center.y } : { x: center.x + part.sizePixels, y: center.y }
    if (part.kind === 'knob') return { x: center.x, y: center.y - this.gizmoSizePixels * 0.85 }
    if (part.handle.startsWith('rotate-')) {
      // An arc: its point farthest from the arrows' lines on the screen, clear of them.
      let best: Screen | null = null
      let bestClearance = -1
      for (const local of part.local) {
        const screen = this.gizmoScreen(basis, local)
        if (screen === null) continue
        let clearance = Infinity
        for (const axis of basis.axisScreen) {
          const length = Math.hypot(axis.x, axis.y)
          if (length > 1) clearance = Math.min(clearance, Math.abs((screen.x - center.x) * axis.y - (screen.y - center.y) * axis.x) / length)
        }
        if (clearance > bestClearance) {
          bestClearance = clearance
          best = screen
        }
      }
      return best
    }
    return this.gizmoScreen(basis, part.grab)
  }

  /**
   * Screen positions of the selected feature's gizmo handles, where a press grabs them (for tests and tutorials): one
   * entry per drawn piece, so `scale-uniform` comes twice with the scale tool (the center ring, then the outer ring).
   * Empty without a selected line, polygon or mesh showing its gizmo.
   */
  gizmoHandles(): GizmoHandleOnScreen[] {
    const context = this.context
    if (context === null) return []
    for (const id of this.selection) {
      const feature = context.store.get(id)
      const basis = feature === undefined ? null : this.gizmoFor(feature)
      if (basis === null) continue
      const handles: GizmoHandleOnScreen[] = []
      for (const part of this.gizmoParts(basis)) {
        const screen = this.grabScreen(basis, part)
        if (screen !== null) handles.push({ handle: part.handle, x: screen.x, y: screen.y })
      }
      return handles
    }
    return []
  }

  /** Adds a gizmo of a selected feature (as changed so far) to the overlay, `active` highlighted. */
  protected gizmoOverlay(basis: GizmoBasis | null, content: OverlayContent, active: GizmoHandle | null): void {
    if (basis === null) return
    const geographic = (local: LocalPoint) => basis.frame.toGeographic(local[0], local[1], local[2])
    const centerPosition: LongitudeLatitude = [basis.center[0], basis.center[1]]
    for (const part of this.gizmoParts(basis)) {
      const color = part.handle === active ? ACTIVE_COLOR : part.color
      if (part.kind === 'line') {
        const points = part.local.map(geographic)
        content.lines.push({
          positions: points.map(point => [point[0], point[1]]),
          heightsMeters: points.map(point => point[2]),
          color,
          widthPixels: part.sizePixels,
          opacity: 1,
          arrowheadPixels: part.arrowhead === true ? ARROWHEAD_PIXELS : undefined,
        })
      } else if (part.kind === 'plane') {
        const points = part.local.map(geographic)
        ;(content.polygons ??= []).push({ positions: points.map(point => [point[0], point[1]]), heightsMeters: points.map(point => point[2]), color, opacity: part.handle === active ? 0.95 : 0.75 })
      } else if (part.kind === 'dot') {
        const [longitude, latitude, height] = geographic(part.local[0]!)
        content.handles.push({ position: [longitude, latitude], heightMeters: height, shape: 'square', radiusPixels: part.sizePixels, color, outlineColor: OUTLINE_COLOR, outlineWidthPixels: 1 })
      } else if (part.kind === 'knob') {
        content.handles.push({ position: centerPosition, heightMeters: basis.heightMeters, radiusPixels: part.sizePixels, color, outlineColor: color, outlineWidthPixels: 0, offsetYPixels: -this.gizmoSizePixels * 0.85, stemWidthPixels: ARROW_WIDTH_PIXELS })
      } else {
        const outer = part.handle === 'scale-uniform' && part.fromCenter !== true
        content.handles.push({ position: centerPosition, heightMeters: basis.heightMeters, shape: 'ring', radiusPixels: part.sizePixels, color, outlineColor: OUTLINE_COLOR, outlineWidthPixels: outer ? 1.5 : 2.5, faded: outer && part.handle !== active })
      }
    }
  }

  /**
   * The gizmo handle of the selected features under a press, nearest first: a handle takes a press within reach
   * (`hitTolerancePixels`: 10 px with a mouse, 22 with a finger), on the feature or off it; the body takes the presses
   * no handle reaches.
   */
  protected gizmoHandleAt(event: DrawPointerEvent): GizmoHit | null {
    const context = this.context
    if (context === null || this.selection.length === 0) return null
    const pointerX = event.screen.xPixels
    const pointerY = event.screen.yPixels
    const reach = hitTolerancePixels(event.pointerType)
    let best: GizmoHit | null = null
    let bestRank = Infinity
    for (const id of this.selection) {
      const feature = context.store.get(id)
      const basis = feature === undefined ? null : this.gizmoFor(feature)
      if (basis === null) continue
      const center = basis.centerScreen
      for (const part of this.gizmoParts(basis)) {
        let distance = Infinity
        let drawn = 0
        let nearest: LocalPoint = part.grab
        if (part.kind === 'ring') {
          const fromCenter = Math.hypot(pointerX - center.x, pointerY - center.y)
          const centerRing = part.handle === 'move-free' || part.fromCenter === true
          // The center ring takes its inside too; the outer ring only its circle.
          distance = centerRing ? Math.max(0, fromCenter - part.sizePixels) : Math.abs(fromCenter - part.sizePixels)
          drawn = 2
        } else if (part.kind === 'knob') {
          distance = Math.hypot(pointerX - center.x, pointerY - (center.y - this.gizmoSizePixels * 0.85))
          drawn = part.sizePixels
        } else if (part.kind === 'dot') {
          const screen = this.partScreens(basis, part)[0]!
          if (screen !== null) distance = Math.max(Math.abs(pointerX - screen.x), Math.abs(pointerY - screen.y))
          drawn = part.sizePixels + 1
        } else if (part.kind === 'plane') {
          const corners = this.partScreens(basis, part)
          if (corners.every(corner => corner !== null)) {
            const ring = corners as Screen[]
            distance = insideConvex(pointerX, pointerY, ring) ? 0 : Math.min(...ring.map((corner, index) => distanceToSegment(pointerX, pointerY, corner.x, corner.y, ring[(index + 1) % ring.length]!.x, ring[(index + 1) % ring.length]!.y)))
          }
        } else {
          let previous: Screen | null = null
          const screens = this.partScreens(basis, part)
          part.local.forEach((local, index) => {
            const screen = screens[index]!
            if (screen !== null && previous !== null) {
              const segment = distanceToSegment(pointerX, pointerY, previous.x, previous.y, screen.x, screen.y)
              if (segment < distance) {
                distance = segment
                // The nearer end of the nearest piece: where an arc is grabbed.
                nearest = Math.hypot(pointerX - screen.x, pointerY - screen.y) < Math.hypot(pointerX - previous.x, pointerY - previous.y) ? local : part.local[index - 1]!
              }
            }
            previous = screen
          })
          drawn = part.sizePixels / 2 + (part.arrowhead === true ? 1 : 0)
        }
        const tolerance = Math.max(drawn, reach)
        if (distance > tolerance) continue
        // Small pieces win ties over the lines they sit on (a cube on its shaft, a plane square across an arc).
        // Arrows win over the arcs that cross them.
        const rank = distance - (part.kind === 'dot' || part.kind === 'knob' ? 3 : part.kind === 'plane' || part.kind === 'ring' || part.arrowhead === true ? 1 : 0)
        if (rank < bestRank) {
          bestRank = rank
          best = { basis, part, nearest }
        }
      }
    }
    return best
  }

  /** The feature moved on the ground (level, at its altitude) so that its center is under screen pixels `x`, `y`. */
  protected freeMove(basis: GizmoBasis, x: number, y: number): DrawFeature | null {
    const target = this.positionUnderPointer(x, y, basis.heightMeters, basis.center)
    if (target === null) return null
    if (basis.moveElements === undefined) return translateFeature(basis.feature, basis.center, target)
    const [east, north] = basis.frame.toLocal(target[0], target[1], basis.heightMeters)
    return this.moveBy(basis, [east, north, 0])
  }

  /** The feature moved `meters` along a gizmo axis; one on the terrain stays there unless raised a metre. */
  protected moveAlong(basis: GizmoBasis, index: number, meters: number): DrawFeature {
    const axis = basis.axes[index]!
    return this.moveBy(basis, [axis[0] * meters, axis[1] * meters, axis[2] * meters])
  }

  protected moveBy(basis: GizmoBasis, offset: LocalPoint): DrawFeature {
    const up = basis.onTerrain && Math.abs(offset[2]) < MINIMUM_LIFT_METERS ? 0 : offset[2]
    if (offset[0] === 0 && offset[1] === 0 && up === 0) return basis.feature
    if (basis.moveElements !== undefined) return basis.moveElements([offset[0], offset[1], up])
    return offsetFeature(basis.feature, [offset[0], offset[1], up], basis.ground)
  }

  /** The feature turned `angleDegrees` (right-handed) around a gizmo axis through its center, snapped with Shift. */
  protected turn(basis: GizmoBasis, index: number, angleDegrees: number, shiftKey: boolean): DrawFeature {
    const angle = this.snapping && shiftKey && this.snapDegrees > 0 ? Math.round(angleDegrees / this.snapDegrees) * this.snapDegrees : angleDegrees
    return rotateFeatureAroundAxis(basis.feature, [basis.center[0], basis.center[1], basis.heightMeters], basis.axes[index]!, angle, basis.ground)
  }

  /**
   * The feature scaled along a gizmo axis through its center. Along up it scales from its base, so it stays standing
   * where it is; a feature on the terrain has no height to scale.
   */
  protected scaleAlong(basis: GizmoBasis, index: number, factor: number): DrawFeature {
    const axis = basis.axes[index]!
    const vertical = this.isVertical(axis)
    if (basis.onTerrain && Math.abs(axis[2]) > 1e-9) return basis.feature
    const pivotHeight = vertical ? basis.baseMeters : basis.heightMeters
    return scaleFeatureAlongAxis(basis.feature, [basis.center[0], basis.center[1], pivotHeight], axis, factor, basis.ground)
  }

  /** The feature scaled uniformly around its center (a mesh from its base, `scaleFeature`). */
  protected scaleUniformly(basis: GizmoBasis, factor: number): DrawFeature {
    return scaleFeature(basis.feature, basis.center, factor)
  }

  /**
   * The sign that turns a turn of the pointer around the gizmo's center on the screen (clockwise positive, y down) into
   * a right-handed turn around an axis: negative when the axis points at the camera.
   */
  protected screenTurnSign(basis: GizmoBasis, index: number): number {
    const [first, second] = index === 0 ? [1, 2] : index === 1 ? [2, 0] : [0, 1]
    const a = basis.axisScreen[first]!
    const b = basis.axisScreen[second]!
    const cross = a.x * b.y - a.y * b.x
    // An axis turned towards the camera makes the gizmo left-handed: the other two then cross to minus this one.
    const [x, y, z] = basis.axes
    const handedness = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]) < 0 ? -1 : 1
    // Edge on, either way: the up axis seen level turns as from above.
    return (cross > 0 ? 1 : -1) * handedness
  }

  /** How a drag on a gizmo handle changes the feature, from the press. Null when it cannot start here. */
  protected gizmoUpdate(hit: GizmoHit, press: DrawPointerEvent): ((event: DrawPointerEvent) => DrawFeature | null) | null {
    const { basis, part } = hit
    const handle = part.handle
    const pressX = press.screen.xPixels
    const pressY = press.screen.yPixels
    const center = basis.centerScreen
    const index = (name: string) => (name === 'x' ? 0 : name === 'y' ? 1 : 2)
    if (handle === 'move-free') {
      const offsetX = center.x - pressX
      const offsetY = center.y - pressY
      return event => this.freeMove(basis, event.screen.xPixels + offsetX, event.screen.yPixels + offsetY)
    }
    if (handle === 'move-x' || handle === 'move-y' || handle === 'move-z') {
      const axis = index(handle[5]!)
      const along = this.axisScreen(basis, axis)
      if (along === null) return null
      const lengthSquared = along.x * along.x + along.y * along.y
      return event => this.moveAlong(basis, axis, (((event.screen.xPixels - pressX) * along.x + (event.screen.yPixels - pressY) * along.y) / lengthSquared) * basis.sizeMeters)
    }
    if (handle === 'move-xy' || handle === 'move-yz' || handle === 'move-xz') {
      const first = index(handle[5]!)
      const second = index(handle[6]!)
      const one = basis.axes[first]!
      const two = basis.axes[second]!
      // Level: on the ground, the center under the pointer.
      if (Math.abs(one[2]) < 1e-9 && Math.abs(two[2]) < 1e-9) {
        const offsetX = center.x - pressX
        const offsetY = center.y - pressY
        return event => this.freeMove(basis, event.screen.xPixels + offsetX, event.screen.yPixels + offsetY)
      }
      // Else across the plane as it lies on the screen.
      const a = basis.axisScreen[first]!
      const b = basis.axisScreen[second]!
      const determinant = a.x * b.y - a.y * b.x
      if (Math.abs(determinant) < 1e-6) return null
      return event => {
        const deltaX = event.screen.xPixels - pressX
        const deltaY = event.screen.yPixels - pressY
        const alongOne = ((deltaX * b.y - deltaY * b.x) / determinant) * basis.sizeMeters
        const alongTwo = ((a.x * deltaY - a.y * deltaX) / determinant) * basis.sizeMeters
        return this.moveBy(basis, [one[0] * alongOne + two[0] * alongTwo, one[1] * alongOne + two[1] * alongTwo, one[2] * alongOne + two[2] * alongTwo])
      }
    }
    if (handle === 'rotate-x' || handle === 'rotate-y' || handle === 'rotate-z') {
      const axis = index(handle[7]!)
      const [first, second] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1]
      const a = basis.axisScreen[first]!
      const b = basis.axisScreen[second]!
      const faceOn = Math.abs(a.x * b.y - a.y * b.x) / (this.gizmoSizePixels * this.gizmoSizePixels)
      const startX = pressX - center.x
      const startY = pressY - center.y
      if (faceOn > FACE_ON_SHARE && Math.hypot(startX, startY) > 4) {
        // Seen face on: the pointer turns around the center (whole turns too).
        const sign = this.screenTurnSign(basis, axis)
        let previousX = startX
        let previousY = startY
        let total = 0
        return event => {
          const x = event.screen.xPixels - center.x
          const y = event.screen.yPixels - center.y
          if (Math.hypot(x, y) > 1) {
            total += angleBetween(previousX, previousY, x, y)
            previousX = x
            previousY = y
          }
          return this.turn(basis, axis, (sign * total * 180) / Math.PI, event.originalEvent?.shiftKey === true)
        }
      }
      // Seen edge on: dragging along the arc where it was grabbed, as it lies on the screen.
      const rotationAxis = basis.axes[axis]!
      const grabbed = hit.nearest
      const tangent: LocalPoint = [
        rotationAxis[1] * grabbed[2] - rotationAxis[2] * grabbed[1],
        rotationAxis[2] * grabbed[0] - rotationAxis[0] * grabbed[2],
        rotationAxis[0] * grabbed[1] - rotationAxis[1] * grabbed[0],
      ]
      const step = 0.01
      const from = this.gizmoScreen(basis, grabbed)
      const to = this.gizmoScreen(basis, [grabbed[0] + tangent[0] * step, grabbed[1] + tangent[1] * step, grabbed[2] + tangent[2] * step])
      if (from === null || to === null) return null
      const perRadianX = (to.x - from.x) / step
      const perRadianY = (to.y - from.y) / step
      const lengthSquared = perRadianX * perRadianX + perRadianY * perRadianY
      if (lengthSquared < 1) return null
      return event => {
        const radians = ((event.screen.xPixels - pressX) * perRadianX + (event.screen.yPixels - pressY) * perRadianY) / lengthSquared
        return this.turn(basis, axis, (radians * 180) / Math.PI, event.originalEvent?.shiftKey === true)
      }
    }
    if (handle === 'scale-x' || handle === 'scale-y' || handle === 'scale-z') {
      const axis = index(handle[6]!)
      const along = this.axisScreen(basis, axis)
      if (along === null) return null
      const lengthSquared = along.x * along.x + along.y * along.y
      // Metres from the center to where it was grabbed: the cube (or its shaft) moves by the pointer's travel.
      const reach = (part.kind === 'dot' ? (this.tool === 'scale' ? 1 : CUBE_DISTANCE) : 0.6) * basis.sizeMeters
      return event => {
        const travel = (((event.screen.xPixels - pressX) * along.x + (event.screen.yPixels - pressY) * along.y) / lengthSquared) * basis.sizeMeters
        return this.scaleAlong(basis, axis, Math.max(MINIMUM_SCALE_FACTOR, (reach + travel) / reach))
      }
    }
    // Uniform: the outer ring by the pointer's distance from the center; the center ring by its travel right and up.
    if (part.fromCenter === true) {
      return event => this.scaleUniformly(basis, Math.max(MINIMUM_SCALE_FACTOR, 1 + (event.screen.xPixels - pressX - (event.screen.yPixels - pressY)) / 2 / this.gizmoSizePixels))
    }
    const startDistance = Math.hypot(pressX - center.x, pressY - center.y)
    if (startDistance < 1) return null
    return event => this.scaleUniformly(basis, Math.max(MINIMUM_SCALE_FACTOR, Math.hypot(event.screen.xPixels - center.x, event.screen.yPixels - center.y) / startDistance))
  }
}

/** The signed angle in radians from one screen vector to another, between -π and π (clockwise positive, y down). */
function angleBetween(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(fromX * toY - fromY * toX, fromX * toX + fromY * toY)
}

/** One key for an edge either way round. */
function samePlace(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1] && (a[2] ?? null) === (b[2] ?? null)
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

/** Whether a press adds to what is picked (Shift), as in Blender. */
function isAdditive(event: DrawPointerEvent): boolean {
  return event.originalEvent?.shiftKey === true
}

function dot(a: LocalPoint, b: LocalPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Whether a screen point lies inside a convex quad, whichever its winding. */
function insideConvex(x: number, y: number, ring: readonly Screen[]): boolean {
  let sign = 0
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    if (cross === 0) continue
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return true
}

/** The elements of an indexed mesh; its edges and whether it is closed taken from `sameFaces`, elements with the same faces. */
function elementsOfMesh(mesh: IndexedMesh, sameFaces: FeatureElements | null = null): FeatureElements {
  const heights = mesh.vertices.map(position => position[2] ?? 0)
  if (sameFaces !== null) return { positions: mesh.vertices, heights, edges: sameFaces.edges, faces: mesh.faces, closed: sameFaces.closed, mesh, paths: null, faceEdges: sameFaces.faceEdges }
  // Each edge once (the smaller vertex first), and the edges of each face.
  const edges: Array<[number, number]> = []
  const edgeIndices = new Map<number, number>()
  const count = mesh.vertices.length
  const faceEdges = mesh.faces.map(face => {
    const list: number[] = []
    for (const ring of face) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!
        const b = ring[(index + 1) % ring.length]!
        if (a === b) continue
        const key = a < b ? a * count + b : b * count + a
        let edge = edgeIndices.get(key)
        if (edge === undefined) {
          edge = edges.push(a < b ? [a, b] : [b, a]) - 1
          edgeIndices.set(key, edge)
        }
        list.push(edge)
      }
    }
    return list
  })
  return { positions: mesh.vertices, heights, edges, faces: mesh.faces, closed: isClosedMesh(mesh), mesh, paths: null, faceEdges }
}

/** Whether an element's vertices or face exist in some elements. */
function elementFits(elements: FeatureElements, element: PickedElement): boolean {
  if (element.kind === 'face') return element.index < elements.faces.length
  const count = elements.positions.length
  return element.kind === 'vertex' ? element.index < count : element.from < count && element.to < count
}

/** A ring of an indexed mesh as positions, closed, each its own array. */
function closeIndexedRing(vertices: readonly Position[], ring: readonly number[]): Position[] {
  const positions = ring.map(index => [...vertices[index]!])
  if (positions.length > 0) positions.push([...positions[0]!])
  return positions
}

/** Whether two elements are the same (both null too). */
function sameElement(a: PickedElement | null, b: PickedElement | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'edge' && b.kind === 'edge') return a.from === b.from && a.to === b.to
  return a.kind === b.kind && (a as { index: number }).index === (b as { index: number }).index
}

/** Whether a screen point lies inside a face drawn at screen pixels `x`, `y` (even-odd: inside its exterior, outside its holes). */
function insideScreenFace(face: readonly number[][], x: Float64Array, y: Float64Array, pointX: number, pointY: number): boolean {
  let inside = false
  for (const ring of face) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const ax = x[ring[index]!]!
      const ay = y[ring[index]!]!
      const bx = x[ring[previous]!]!
      const by = y[ring[previous]!]!
      if (Number.isNaN(ax) || Number.isNaN(bx)) return false
      if (ay > pointY !== by > pointY && pointX < ((bx - ax) * (pointY - ay)) / (by - ay) + ax) inside = !inside
    }
  }
  return inside
}
