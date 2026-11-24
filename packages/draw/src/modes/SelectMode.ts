import type { Position } from 'geojson'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, removeVertex, translateFeature, type VertexPath } from '../editing.js'
import { distanceToSegment, hasAltitude, lowestAltitude, storedLines, storedPositions } from '../geometry.js'
import { LocalFrame, type LocalPoint } from '../localFrame.js'
import { indexMesh, isMeshGeometry, meshSharpEdges } from '../mesh.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { isSolidFeature } from '../render/SolidFeatures.js'
import { altitudeRangeOf, featureAxes, featureCenter, offsetFeature, rotateFeatureAroundAxis, scaleFeature, scaleFeatureAlongAxis, WORLD_AXES } from '../transform.js'
import type { DrawFeature, DrawPointerEvent, DrawStyleState, GroundHeight, LongitudeLatitude } from '../types.js'
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
   * A second tap on the selected line or polygon swaps its gizmo for vertex handles (drag a vertex, tap or drag a
   * midpoint to add one); another tap swaps back. Meshes keep their gizmo. Default: true.
   */
  editVertices?: boolean
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

const STATUS_UNDO: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, canUndo: true })
const STATUS_VERTICES: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, editingVertices: true })
const STATUS_VERTICES_UNDO: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, canUndo: true, editingVertices: true })

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
 * Tap the selected line or polygon again to edit its vertices instead: drag a vertex handle to move it; tap a vertex to
 * pick it, then Delete or Backspace (or `draw.deleteSelected()`) removes it; drag or tap a midpoint handle to insert a
 * vertex there. Another tap (or Escape) goes back to the gizmo; selecting another feature starts with the gizmo again.
 * Points have no gizmo: they move whole.
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
  /** The selected feature shows vertex handles rather than the gizmo. */
  protected vertexEditing = false
  /** Local axes of feature versions (features are replaced, never changed, so a version's axes stay right). */
  protected readonly localAxes = new WeakMap<DrawFeature, [LocalPoint, LocalPoint, LocalPoint]>()
  protected selection: readonly string[] = NO_FEATURE_IDS
  /** The picked vertex of the selected feature, which Delete removes, on the stored version it was picked on. */
  protected selectedVertex: { feature: DrawFeature; path: VertexPath } | null = null
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
  /** The pieces of each gizmo, for a tool. */
  protected readonly partsCache = new WeakMap<GizmoBasis, { tool: GizmoTool; parts: GizmoPart[] }>()

  constructor({
    moveFeatures = true,
    editVertices = true,
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
      if (this.selectedVertex !== null && context.store.get(this.selectedVertex.feature.id) !== this.selectedVertex.feature) this.selectedVertex = null
      if (this.keyboardTransform !== null && context.store.get(this.keyboardTransform.base.id) !== this.keyboardTransform.base) this.keyboardTransform = null
    })
  }

  override exit(): void {
    this.drag = null
    this.pressStart = null
    this.keyboardTransform = null
    this.hoveredHandle = null
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

  // ---- Selection ----

  override selectedFeatureIds(): readonly string[] {
    // Features removed elsewhere leave the selection.
    const store = this.context?.store
    if (store !== undefined && this.selection.some(id => !store.has(id))) {
      const remaining = this.selection.filter(id => store.has(id))
      this.selection = remaining.length === 0 ? NO_FEATURE_IDS : remaining
      if (this.selectedVertex !== null && !store.has(this.selectedVertex.feature.id)) this.selectedVertex = null
      if (remaining.length === 0) this.vertexEditing = false
    }
    return this.selection
  }

  override setSelection(ids: readonly string[]): boolean {
    const store = this.context?.store
    const next = store === undefined ? [...ids] : ids.filter(id => store.has(id))
    const same = next.length === this.selection.length && next.every((id, index) => id === this.selection[index])
    if (!same) {
      this.selection = next.length === 0 ? NO_FEATURE_IDS : next
      this.selectedVertex = null
      this.vertexEditing = false
      this.drag = null
      this.keyboardTransform = null
      this.hoveredHandle = null
      this.context?.changed()
    } else if (next.length === 0 && this.vertexEditing) {
      this.vertexEditing = false
      this.context?.changed()
    }
    return true
  }

  /** True while the selected feature shows vertex handles; false while it shows the gizmo. */
  get editingVertices(): boolean {
    return this.vertexEditing
  }

  /**
   * Shows the selected feature's vertex handles (true) or its gizmo (false), as a second tap on it does. Stays false
   * with `editVertices: false`. Selecting another feature goes back to the gizmo.
   */
  setEditingVertices(editing: boolean): void {
    const next = editing && this.editVertices
    if (next === this.vertexEditing) return
    this.vertexEditing = next
    this.selectedVertex = null
    this.drag = null
    this.keyboardTransform = null
    this.pressStart = null
    this.context?.changed()
  }

  override deleteSelection(): boolean {
    const context = this.context
    if (context === null) return false
    const vertex = this.selectedVertex
    if (vertex !== null) {
      const feature = context.store.get(vertex.feature.id)
      // Picked on another version of the feature: the index may name another vertex now.
      const edited = feature !== vertex.feature ? null : removeVertex(feature, vertex.path)
      if (feature === undefined || edited === null) return false
      this.selectedVertex = null
      this.commit([feature], () => context.update([edited]))
      return true
    }
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
    const hit = this.featureAt(event)
    // A tap on the selected line or polygon swaps its gizmo and its vertex handles.
    if (hit !== null && this.selection.length === 1 && this.selection[0] === hit.id && this.canEditVertices(hit)) {
      this.setEditingVertices(!this.vertexEditing)
      return
    }
    this.setSelection(hit === null ? [] : [hit.id])
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
    const gizmo = this.gizmoHandleAt(event)
    const update = gizmo === null ? null : this.gizmoUpdate(gizmo, event)
    if (gizmo !== null && update !== null) {
      this.drag = { kind: 'transform', base: gizmo.basis.feature, feature: gizmo.basis.feature, handle: gizmo.part.handle, update }
      this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
      this.dragging = false
      return true
    }
    const handle = this.handleAt(event)
    let drag: Drag | null = null
    if (handle !== null) {
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
    if (drag.kind === 'transform') {
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
    if (drag.kind === 'vertex') {
      // A tap on a vertex picks it; a tap on a midpoint inserts a vertex there; a drag moves it.
      if (!this.dragging && !drag.inserted) {
        this.selectedVertex = { feature: original, path: drag.path }
        context.changed()
        return
      }
    } else if (drag.kind === 'transform') {
      if (!this.dragging) {
        // A tap on a handle over the feature is a tap on the feature (a second tap edits its vertices); elsewhere, nothing.
        if (this.featureAt(event) !== null) this.click(event)
        else context.changed()
        return
      }
    } else if (!this.dragging) {
      // A tap on the selected feature selects what is under it, as on the map: a point or line inside a polygon.
      this.click(event)
      return
    }
    this.commitEdit(original, drag.feature)
    const edited = context.store.get(drag.feature.id)
    if (drag.kind === 'vertex' && edited !== undefined && edited !== original) this.selectedVertex = { feature: edited, path: drag.path }
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
    const gizmo = this.gizmoHandleAt(event)
    const hovered = gizmo?.part.handle ?? null
    if (hovered !== this.hoveredHandle) {
      this.hoveredHandle = hovered
      context.changed()
    }
    const cursor = gizmo !== null ? 'grab' : this.handleAt(event) !== null ? 'pointer' : this.moveFeatures && this.selectedFeatureAt(event) !== null ? 'move' : null
    context.setCursor(cursor)
  }

  override keyDown(event: KeyboardEvent): boolean {
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
        const basis = this.gizmoBasis(transform.base) ?? transform.basis
        if (transform.axis !== axis && transform.kind !== 'rotate' && this.axisScreen(basis, axis) === null) return true
        // The same key again unlocks.
        this.keyboardTransform = { ...transform, axis: transform.axis === axis ? null : axis }
        this.refreshKeyboardTransform()
      } else if (key === 'g' || key === 'r' || key === 's') {
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

  /** Drops a transform or drag in progress, then the vertex editing (back to the gizmo), then the selection. */
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
    this.selectedVertex = null
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
    const canUndo = this.undoStack.length > 0
    // Features removed elsewhere leave the selection, and with the last one the vertex editing ends.
    this.selectedFeatureIds()
    if (this.vertexEditing) return canUndo ? STATUS_VERTICES_UNDO : STATUS_VERTICES
    return canUndo ? STATUS_UNDO : IDLE_STATUS
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
      else if (isMeshGeometry(feature.geometry)) {
        // A mesh: its sharp edges, over the map.
        const { vertices, edges } = this.outlineOf(feature)
        for (const [a, b] of edges) {
          const from = vertices[a]!
          const to = vertices[b]!
          content.lines.push({ positions: [[from[0]!, from[1]!], [to[0]!, to[1]!]], heightsMeters: [from[2]!, to[2]!], color: style.vertexOutlineColor, widthPixels: 2, opacity: 1 })
        }
      } else if (feature.geometry.type !== 'Point') {
        // Lines and flat polygons at their altitudes: their rings, over the map, where they are drawn (positions without
        // an altitude at the lowest, as `isSolidFeature` says).
        const lowest = lowestAltitude(feature.geometry)
        for (const ring of storedLines(feature.geometry)) {
          const heightsMeters = lowest === null ? undefined : ring.map(position => (hasAltitude(position) ? position[2]! : lowest))
          content.lines.push({ positions: ring.map(position => [position[0]!, position[1]!]), heightsMeters, color: style.vertexOutlineColor, widthPixels: 2, opacity: 1 })
        }
      }
      // Moving whole: the handles wait for the release.
      if (drag?.kind === 'feature') continue
      if (this.keyboardTransform?.base.id === id) {
        this.keyboardOverlay(this.keyboardTransform, content)
        continue
      }
      if (this.showsGizmo(feature)) {
        this.gizmoOverlay(feature, content, drag?.kind === 'transform' ? drag.handle : this.hoveredHandle)
        continue
      }
      if (!this.showsVertexHandles(feature) || drag?.kind === 'transform') continue
      if (feature.geometry.type !== 'Point') {
        for (const midpoint of featureMidpoints(feature)) {
          content.handles.push({ position: midpoint.position, heightMeters: midpoint.heightMeters, radiusPixels: style.vertexRadiusPixels - 1, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels, faded: true })
        }
      }
      const picked = this.selectedVertex?.feature.id === id ? this.selectedVertex.path : drag?.kind === 'vertex' ? drag.path : null
      for (const vertex of featureVertices(feature)) {
        const isPicked = picked !== null && picked.ring === vertex.path.ring && picked.index === vertex.path.index
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
  }

  override inspect(): unknown {
    const transform = this.keyboardTransform
    return {
      ...this.status(),
      selection: [...this.selection],
      editingVertices: this.vertexEditing,
      gizmoTool: this.tool,
      gizmoSpace: this.space,
      selectedVertex: this.selectedVertex === null ? null : { featureId: this.selectedVertex.feature.id, path: this.selectedVertex.path },
      drag: this.drag === null ? null : { kind: this.drag.kind, featureId: this.drag.feature.id, dragging: this.dragging, handle: this.drag.kind === 'transform' ? this.drag.handle : null },
      keyboardTransform: transform === null ? null : { kind: transform.kind, axis: transform.axis === null ? null : 'xyz'[transform.axis], featureId: transform.base.id },
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
   * goes around up and a scale is uniform, all from the pointer's distance to the center. Returns false when nothing
   * can start (no selected line, polygon or mesh, vertex editing, a drag in progress).
   */
  startTransform(kind: TransformKind): boolean {
    const context = this.context
    if (context === null || this.drag !== null || this.vertexEditing) return false
    const feature = this.selection.map(id => context.store.get(id)).find(each => each !== undefined && this.showsGizmo(each))
    if (feature === undefined) return false
    const basis = this.gizmoBasis(feature)
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
    const basis = this.gizmoBasis(transform.base) ?? transform.basis
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

  /** Whether a feature can show vertex handles: lines and polygons (not points, nor meshes, whose faces share vertices). */
  protected canEditVertices(feature: DrawFeature): boolean {
    return this.editVertices && (feature.geometry.type === 'LineString' || feature.geometry.type === 'Polygon')
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

  /** A selected line or polygon shows vertex handles while the vertex editing is on. */
  protected showsVertexHandles(feature: DrawFeature): boolean {
    return this.vertexEditing && this.canEditVertices(feature)
  }

  /** A selected line, polygon or mesh shows the gizmo, unless it shows vertex handles. Points move whole. */
  protected showsGizmo(feature: DrawFeature): boolean {
    if (this.showsVertexHandles(feature)) return false
    return feature.geometry.type !== 'Point'
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
    const basis: GizmoBasis = {
      feature,
      center,
      heightMeters,
      baseMeters: range?.minimumMeters ?? groundMeters,
      onTerrain: range === null,
      frame,
      axes: axes as [LocalPoint, LocalPoint, LocalPoint],
      sizeMeters,
      ground: this.groundOf(feature, range?.minimumMeters ?? groundMeters),
      centerScreen,
      axisScreen: axisScreen as [Screen, Screen, Screen],
    }
    if (view !== undefined) this.gizmoCache.set(feature, { view, space: this.space, heightMeters, basis })
    return basis
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

  /** The pieces of a gizmo for the current camera and tool (kept per gizmo and tool). */
  protected gizmoParts(basis: GizmoBasis): GizmoPart[] {
    const cached = this.partsCache.get(basis)
    if (cached !== undefined && cached.tool === this.tool) return cached.parts
    const parts = this.buildGizmoParts(basis)
    this.partsCache.set(basis, { tool: this.tool, parts })
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
    const tool = this.tool
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
      if (moves && shows) {
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
      if (feature === undefined || !this.showsGizmo(feature)) continue
      const basis = this.gizmoBasis(feature)
      if (basis === null) return []
      const handles: GizmoHandleOnScreen[] = []
      for (const part of this.gizmoParts(basis)) {
        const screen = this.grabScreen(basis, part)
        if (screen !== null) handles.push({ handle: part.handle, x: screen.x, y: screen.y })
      }
      return handles
    }
    return []
  }

  /** Adds the gizmo of a selected feature (as changed so far) to the overlay, `active` highlighted. */
  protected gizmoOverlay(feature: DrawFeature, content: OverlayContent, active: GizmoHandle | null): void {
    const basis = this.gizmoBasis(feature)
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
      if (feature === undefined || !this.showsGizmo(feature)) continue
      const basis = this.gizmoBasis(feature)
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
    return target === null ? null : translateFeature(basis.feature, basis.center, target)
  }

  /** The feature moved `meters` along a gizmo axis; one on the terrain stays there unless raised a metre. */
  protected moveAlong(basis: GizmoBasis, index: number, meters: number): DrawFeature {
    const axis = basis.axes[index]!
    return this.moveBy(basis, [axis[0] * meters, axis[1] * meters, axis[2] * meters])
  }

  protected moveBy(basis: GizmoBasis, offset: LocalPoint): DrawFeature {
    const up = basis.onTerrain && Math.abs(offset[2]) < MINIMUM_LIFT_METERS ? 0 : offset[2]
    if (offset[0] === 0 && offset[1] === 0 && up === 0) return basis.feature
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
