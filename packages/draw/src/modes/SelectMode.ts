import type { Position } from 'geojson'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, removeVertex, translateFeature, type VertexPath } from '../editing.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { isSolidFeature } from '../render/SolidFeatures.js'
import { destination, shapeOf } from '../shapes.js'
import {
  baseAltitudeOf,
  firstAltitudeOf,
  liftFeature,
  rotateFeature,
  scaleFeature,
  setExtrusionHeight,
  stretchFeature,
  transformFrame,
  type TransformFrame,
  type TransformSideHandle,
} from '../transform.js'
import type { DrawFeature, DrawPointerEvent, DrawStyle, DrawStyleState, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, NO_FEATURE_IDS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

/** Options of the select mode. */
export interface SelectModeOptions {
  /** A press on a selected feature drags it whole. Default: true. */
  moveFeatures?: boolean
  /**
   * A second tap on the selected line or polygon swaps its gizmo for vertex handles (drag a vertex, tap or drag a
   * midpoint to add one); another tap swaps back. Default: true.
   */
  editVertices?: boolean
  /** A knob beyond the gizmo's top edge turns the selected feature. Default: true. */
  rotate?: boolean
  /** The gizmo's corners scale the selected feature around its center. Default: true. */
  scale?: boolean
  /** Handles in the middle of the gizmo's edges stretch the selected feature along one axis, the opposite edge fixed. Default: true. */
  stretch?: boolean
  /**
   * A knob in the middle of a line or polygon extrudes it: drag it up to turn a flat shape into a solid (a rectangle
   * into a box, a line into a wall), down to the ground to flatten it again. Default: true.
   */
  height?: boolean
  /**
   * A knob under the feature's base, on a short stem, moves it up and down: its positions get altitudes (the GeoJSON
   * third coordinate), those on the terrain starting from its height under each. Default: true.
   */
  lift?: boolean
  /** Turns snap to this many degrees while Shift is held. Default: 15. */
  snapDegrees?: number
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
  | { kind: 'transform'; base: DrawFeature; feature: DrawFeature; handle: string; update: (event: DrawPointerEvent) => DrawFeature | null }

type Drag = SelectDrag

/** The handles of the gizmo. */
export type GizmoHandle = 'rotate' | 'scale' | 'stretch' | 'height' | 'lift'

/** A gizmo handle under a press. */
interface GizmoHit {
  feature: DrawFeature
  frame: TransformFrame
  handle: GizmoHandle
  /** The stretch handle's side. */
  side: TransformSideHandle | null
}

/** One edit, as what restores it: features to put back, and ids to remove (features the edit created). */
interface UndoEntry {
  restore: DrawFeature[]
}

/** Pixels a press moves before it counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PIXELS = 4
/** Smallest scale or stretch factor a drag reaches, so a feature never collapses. */
const MINIMUM_SCALE_FACTOR = 0.01
/**
 * A gizmo smaller on the screen than this many knob diameters (across or along) hides its side handles and middle knob,
 * which would cover it: a press inside then always moves it.
 */
const SMALL_GIZMO_KNOB_DIAMETERS = 3
/** The style state of selected features. */
const SELECTED_STATE: DrawStyleState = Object.freeze({ selected: true, drawing: false })
/** The vertical drags measure the vertical over a step about this many pixels of ground long. */
const HEIGHT_STEP_PIXELS = 100
/** A height drag ending below this many metres flattens the feature (removes its extrusion). */
const MINIMUM_EXTRUSION_METERS = 1
/** The lift knob is drawn this many pixels below the feature's base, on a stem, so it never covers the height knob. */
const LIFT_OFFSET_PIXELS = 24
/** A feature on the terrain stays there (unchanged) unless a lift raises it at least this many metres. */
const MINIMUM_LIFT_METERS = 1

const STATUS_UNDO: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, canUndo: true })
const STATUS_VERTICES: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, editingVertices: true })
const STATUS_VERTICES_UNDO: DrawModeStatus = Object.freeze({ ...IDLE_STATUS, canUndo: true, editingVertices: true })

/**
 * Selects and edits finished features. A tap selects the feature under it (points and lines before the polygons under
 * them); a tap on the empty map clears the selection. A selected line, polygon or sphere shows a gizmo:
 *
 * - drag the feature to move it (shapes keep their size in metres);
 * - drag a corner of the box around it to scale it around its center;
 * - drag the middle of an edge to stretch it along that axis, the opposite edge fixed (a circle becomes an ellipse);
 * - drag the knob beyond its top edge to turn it (Shift snaps to 15°);
 * - drag the knob in the middle of a flat line or polygon up to extrude it into a solid (a rectangle into a box, a
 *   circle into a cylinder, a line into a wall); on a solid it sits on top: drag it up or down to change the height,
 *   down to the ground to flatten it again;
 * - drag the knob on a stem under its base up or down to move it vertically: its positions get altitudes (those on the
 *   terrain start from its height under each, so the shape keeps the relief's offsets).
 *
 * Tap the selected line or polygon again to edit its vertices instead: drag a vertex handle to move it; tap a vertex to
 * pick it, then Delete or Backspace (or `draw.deleteSelected()`) removes it; drag or tap a midpoint handle to insert a
 * vertex there. Another tap (or Escape) goes back to the gizmo; selecting another feature starts with the gizmo again.
 * Points have no gizmo: they move whole.
 *
 * Shapes keep their measurements in `properties.shape`: a scaled circle is a circle with a new radius, a turned
 * rectangle has a new `rotationDegrees`; an edited outline is a plain polygon. A press anywhere else still pans the map,
 * so one finger pans between edits. Each edit fires `update` (`delete` for deletions) once, on release; `undo()` takes
 * edits back.
 */
export class SelectMode extends DrawMode {
  readonly name: string = 'select'
  readonly moveFeatures: boolean
  readonly editVertices: boolean
  readonly rotate: boolean
  readonly scale: boolean
  readonly stretch: boolean
  readonly height: boolean
  readonly lift: boolean
  readonly snapDegrees: number
  protected readonly undoLimit: number
  /** The selected feature shows vertex handles rather than the gizmo. */
  protected vertexEditing = false
  /** Gizmo frames of feature versions (features are replaced, never changed, so a version's frame stays right). */
  protected readonly frames = new WeakMap<DrawFeature, TransformFrame>()
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

  constructor({ moveFeatures = true, editVertices = true, rotate = true, scale = true, stretch = true, height = true, lift = true, snapDegrees = 15, undoLimit = 50 }: SelectModeOptions = {}) {
    super()
    this.moveFeatures = moveFeatures
    this.editVertices = editVertices
    this.rotate = rotate
    this.scale = scale
    this.stretch = stretch
    this.height = height
    this.lift = lift
    this.snapDegrees = snapDegrees
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
    })
  }

  override exit(): void {
    this.drag = null
    this.pressStart = null
    this.setSelection([])
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    this.undoStack.length = 0
    super.exit()
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
    this.commit(features, () => context.remove(features.map(feature => feature.id)))
    return true
  }

  // ---- Pointer ----

  override click(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
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
    const gizmo = this.gizmoHandleAt(event)
    const update = gizmo === null ? null : this.gizmoUpdate(gizmo, event)
    if (gizmo !== null && update !== null) {
      this.drag = { kind: 'transform', base: gizmo.feature, feature: gizmo.feature, handle: gizmo.handle, update }
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
    const drag = this.drag
    const start = this.pressStart
    if (context === null || drag === null || start === null) return
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
      const position = this.positionUnderPointer(event, drag.heightMeters, drag.position)
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
        // A tap on a knob in the middle (on a flat shape, over the feature) is a tap on what is there; on the others, nothing.
        if ((drag.handle === 'height' || drag.handle === 'lift') && this.featureAt(event) !== null) this.click(event)
        else context.changed()
        return
      }
    } else if (!this.dragging) {
      // A tap on the selected feature selects what is under it, as on the map: a point or line inside a polygon.
      this.click(event)
      return
    }
    // A drag that ends where it started (a knob dragged and brought back) changes nothing: no update, no undo step.
    if (drag.feature === original || (JSON.stringify(drag.feature.geometry) === JSON.stringify(original.geometry) && JSON.stringify(drag.feature.properties) === JSON.stringify(original.properties))) {
      context.changed()
      return
    }
    this.commit([original], () => context.update([drag.feature]))
    const edited = context.store.get(drag.feature.id)
    if (drag.kind === 'vertex' && edited !== undefined) this.selectedVertex = { feature: edited, path: drag.path }
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
    if (this.selection.length === 0) {
      context.setCursor(null)
      return
    }
    const cursor = this.gizmoHandleAt(event) !== null ? 'grab' : this.handleAt(event) !== null ? 'pointer' : this.moveFeatures && this.selectedFeatureAt(event) !== null ? 'move' : null
    context.setCursor(cursor)
  }

  override keyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape' && this.selection.length > 0) {
      this.cancel()
      return true
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selection.length > 0) return this.deleteSelection()
    return false
  }

  /** Drops a drag in progress, then the vertex editing (back to the gizmo), then the selection. */
  override cancel(): void {
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
    // Draped features show live while selected; a solid only while it is dragged (then as a preview solid).
    const live = this.selectedFeatureIds().filter(id => {
      const feature = context.store.get(id)
      return feature !== undefined && (!isSolidFeature(feature) || (this.drag !== null && this.dragging && this.drag.feature.id === id))
    })
    return live.length === 0 ? NO_FEATURE_IDS : live
  }

  override overlay(content: OverlayContent): void {
    const context = this.context
    if (context === null) return
    const live = new Set(this.liveFeatureIds())
    for (const id of this.selectedFeatureIds()) {
      const stored = context.store.get(id)
      if (stored === undefined) continue
      const drag = this.drag !== null && this.drag.feature.id === id && (this.dragging || this.drag.kind === 'vertex') ? this.drag : null
      const feature = drag?.feature ?? stored
      const style = context.style(feature, SELECTED_STATE)
      if (live.has(id)) content.features.push({ feature, style })
      else if (feature.geometry.type !== 'Point') {
        // A solid: its footprint, over the map.
        for (const ring of feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : [feature.geometry.coordinates]) {
          const atAltitude = ring.every(position => position.length > 2 && Number.isFinite(position[2]))
          content.lines.push({ positions: ring.map(position => [position[0]!, position[1]!]), heightsMeters: atAltitude ? ring.map(position => position[2]!) : undefined, color: style.vertexOutlineColor, widthPixels: 2, opacity: 1 })
        }
      }
      // Moving whole: the handles wait for the release.
      if (drag?.kind === 'feature') continue
      if (this.showsGizmo(feature)) {
        this.gizmoOverlay(feature, style, content)
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
    return {
      ...this.status(),
      selection: [...this.selection],
      editingVertices: this.vertexEditing,
      selectedVertex: this.selectedVertex === null ? null : { featureId: this.selectedVertex.feature.id, path: this.selectedVertex.path },
      drag: this.drag === null ? null : { kind: this.drag.kind, featureId: this.drag.feature.id, dragging: this.dragging },
      undo: this.undoStack.length,
    }
  }

  // ---- Internals ----

  /** Whether a feature can show vertex handles: lines and polygons, shapes too (an edited one is a plain polygon). */
  protected canEditVertices(feature: DrawFeature): boolean {
    return this.editVertices && feature.geometry.type !== 'Point'
  }

  /** A selected line or polygon shows vertex handles while the vertex editing is on. */
  protected showsVertexHandles(feature: DrawFeature): boolean {
    return this.vertexEditing && this.canEditVertices(feature)
  }

  /** A selected line, polygon or sphere shows the gizmo, unless it shows vertex handles. Points move whole. */
  protected showsGizmo(feature: DrawFeature): boolean {
    if (this.showsVertexHandles(feature)) return false
    return feature.geometry.type !== 'Point' || shapeOf(feature)?.type === 'sphere'
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
      // 0: points and lines, 1: polygons containing the tap, 2: polygons whose outline is near it.
      const rank = feature.geometry.type !== 'Polygon' ? 0 : distance === 0 ? 1 : 2
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
   * The position at `heightMeters` whose projection is under the pointer, found by Newton steps on the screen from
   * `start` (where the vertex was). Null when it is hidden or cannot be found (the pointer over the horizon).
   */
  protected positionUnderPointer(event: DrawPointerEvent, heightMeters: number, start: LongitudeLatitude): LongitudeLatitude | null {
    const context = this.context
    if (context === null) return null
    const targetX = event.screen.xPixels
    const targetY = event.screen.yPixels
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

  /** The gizmo frame of a feature version, computed once. */
  protected frameOf(feature: DrawFeature): TransformFrame {
    let frame = this.frames.get(feature)
    if (frame === undefined) {
      frame = transformFrame(feature)
      this.frames.set(feature, frame)
    }
    return frame
  }

  /** Pixels a knob covers: its radius and its outline. */
  protected knobRadiusPixels(style: DrawStyle): number {
    return style.vertexRadiusPixels + 1 + style.vertexOutlineWidthPixels
  }

  /**
   * Whether the gizmo is too small on the screen for its side handles and middle knob: its box is under a few knob
   * diameters across or along (or the feature has no extent at all). They are hidden then, so a press inside always
   * moves the feature.
   */
  protected gizmoIsSmall(feature: DrawFeature, frame: TransformFrame, style: DrawStyle, fallbackHeightMeters: number): boolean {
    if (frame.corners.length !== 4) return false
    const origin = this.gizmoOnScreen(feature, frame.corners[0]!, fallbackHeightMeters)
    const across = this.gizmoOnScreen(feature, frame.corners[1]!, fallbackHeightMeters)
    const along = this.gizmoOnScreen(feature, frame.corners[3]!, fallbackHeightMeters)
    if (origin === null || across === null || along === null) return false
    const minimum = SMALL_GIZMO_KNOB_DIAMETERS * 2 * this.knobRadiusPixels(style)
    // An axis without side handles (across a straight line) does not count: the line is as small as it is long.
    let hasWidth = false
    let hasLength = false
    for (const side of frame.sideHandles) {
      if (side.axis === 'across') hasWidth = true
      else hasLength = true
    }
    if (!hasWidth && !hasLength) return true
    return (hasWidth && Math.hypot(across.x - origin.x, across.y - origin.y) < minimum) || (hasLength && Math.hypot(along.x - origin.x, along.y - origin.y) < minimum)
  }

  /** Adds the gizmo of a selected feature (as dragged so far) to the overlay. */
  protected gizmoOverlay(feature: DrawFeature, style: DrawStyle, content: OverlayContent): void {
    const context = this.context
    if (context === null) return
    const frame = this.frameOf(feature)
    const small = this.gizmoIsSmall(feature, frame, style, 0)
    const knob = { radiusPixels: style.vertexRadiusPixels + 1, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels }
    const inverted = { ...knob, color: style.vertexOutlineColor, outlineColor: style.vertexColor }
    // A feature at an altitude has its gizmo there; one on the ground, on the terrain.
    const altitude = firstAltitudeOf(feature) ?? undefined
    if ((this.scale || this.stretch) && frame.corners.length === 4) {
      const corners = frame.corners
      content.lines.push({ positions: [corners[0]!, corners[1]!, corners[2]!, corners[3]!, corners[0]!], heightsMeters: altitude === undefined ? undefined : [altitude, altitude, altitude, altitude, altitude], color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
    }
    if (this.scale) for (const corner of frame.corners) content.handles.push({ ...knob, position: corner, heightMeters: altitude })
    if (this.stretch && !small) {
      for (const side of frame.sideHandles) content.handles.push({ ...knob, radiusPixels: style.vertexRadiusPixels - 1, position: side.position, heightMeters: altitude })
    }
    if (this.rotate && frame.rotationHandle !== null) {
      const topMiddle = middle(frame.corners[2]!, frame.corners[3]!)
      content.lines.push({ positions: [topMiddle, frame.rotationHandle], heightsMeters: altitude === undefined ? undefined : [altitude, altitude], color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
      content.handles.push({ ...inverted, position: frame.rotationHandle, heightMeters: altitude })
    }
    const top = small ? null : this.heightKnob(feature, frame, 0)
    if (top !== null && top.topMeters > top.baseMeters) {
      content.lines.push({ positions: [frame.center, frame.center], heightsMeters: [top.baseMeters, top.topMeters], color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
    }
    if (top !== null) content.handles.push({ ...inverted, position: frame.center, heightMeters: top.topMeters })
    const lift = this.liftKnob(feature, frame, 0)
    if (lift !== null) {
      content.handles.push({ ...knob, position: frame.center, heightMeters: lift.baseMeters, offsetYPixels: LIFT_OFFSET_PIXELS, stemWidthPixels: 2 })
    }
  }

  /**
   * The height knob of a line or polygon: its base and its top above the ellipsoid (the same for a flat feature, whose
   * knob sits in its middle on the ground). Null for points and spheres.
   */
  protected heightKnob(feature: DrawFeature, frame: TransformFrame, fallbackHeightMeters: number): { baseMeters: number; topMeters: number } | null {
    const context = this.context
    if (!this.height || context === null || feature.geometry.type === 'Point') return null
    const baseMeters = baseAltitudeOf(feature) ?? context.heights.heightAt(frame.center[0], frame.center[1], fallbackHeightMeters)
    return { baseMeters, topMeters: baseMeters + frame.extrusionHeightMeters }
  }

  /**
   * The lift knob of a line, polygon or sphere: the terrain's height under its center and the altitude of its base (a
   * sphere's bottom), where the knob's stem starts. Null for points.
   */
  protected liftKnob(feature: DrawFeature, frame: TransformFrame, fallbackHeightMeters: number): { groundMeters: number; baseMeters: number } | null {
    const context = this.context
    if (!this.lift || context === null || (feature.geometry.type === 'Point' && shapeOf(feature)?.type !== 'sphere')) return null
    const groundMeters = context.heights.heightAt(frame.center[0], frame.center[1], fallbackHeightMeters)
    return { groundMeters, baseMeters: baseAltitudeOf(feature) ?? groundMeters }
  }

  /** Screen pixels of a gizmo position: at the feature's altitude, or on the terrain. */
  protected gizmoOnScreen(feature: DrawFeature, position: LongitudeLatitude, fallbackHeightMeters: number): { x: number; y: number } | null {
    const context = this.context!
    const altitude = firstAltitudeOf(feature)
    return altitude === null ? context.project(position, fallbackHeightMeters) : context.projectAtHeight(position, altitude)
  }

  /** The gizmo handle of the selected features under a press, nearest first. */
  protected gizmoHandleAt(event: DrawPointerEvent): GizmoHit | null {
    const context = this.context
    if (context === null || this.selection.length === 0) return null
    const input = this.hitInput(event)
    const fallback = event.geographic?.heightMeters ?? 0
    const pointerX = event.screen.xPixels
    const pointerY = event.screen.yPixels
    const outside = hitTolerancePixels(event.pointerType)
    let best: GizmoHit | null = null
    let bestDistance = Infinity
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature === undefined || !this.showsGizmo(feature)) continue
      const style = context.style(feature, SELECTED_STATE)
      const frame = this.frameOf(feature)
      // Inside the feature a press moves it, unless it lands on a knob as drawn: a finger's full reach would cover
      // small features (and the knob in the middle) and leave no way to move them.
      const inside = hitFeature(feature, input) === 0
      const knobTolerance = inside ? this.knobRadiusPixels(style) : outside
      const sideTolerance = inside ? this.knobRadiusPixels(style) - 2 : outside
      const small = this.gizmoIsSmall(feature, frame, style, fallback)
      const consider = (handle: GizmoHandle, screen: { x: number; y: number } | null, tolerance: number, side: TransformSideHandle | null = null, offsetYPixels = 0) => {
        if (screen === null) return
        const distance = Math.hypot(screen.x - pointerX, screen.y + offsetYPixels - pointerY)
        if (distance > tolerance) return
        // Side handles win ties (half a pixel) over the corners they meet on a straight line.
        const ranked = handle === 'stretch' ? distance - 0.5 : distance
        if (ranked < bestDistance) {
          bestDistance = ranked
          best = { feature, frame, handle, side }
        }
      }
      if (this.stretch && !small) for (const side of frame.sideHandles) consider('stretch', this.gizmoOnScreen(feature, side.position, fallback), sideTolerance, side)
      if (this.scale) for (const corner of frame.corners) consider('scale', this.gizmoOnScreen(feature, corner, fallback), knobTolerance)
      if (this.rotate && frame.rotationHandle !== null) consider('rotate', this.gizmoOnScreen(feature, frame.rotationHandle, fallback), knobTolerance)
      const top = small ? null : this.heightKnob(feature, frame, fallback)
      if (top !== null) consider('height', context.projectAtHeight(frame.center, top.topMeters), knobTolerance)
      const lift = this.liftKnob(feature, frame, fallback)
      if (lift !== null) consider('lift', context.projectAtHeight(frame.center, lift.baseMeters), knobTolerance, null, LIFT_OFFSET_PIXELS)
    }
    return best
  }

  /** How a drag on a gizmo handle changes the feature, from the press. Null when it cannot start here. */
  protected gizmoUpdate(hit: GizmoHit, press: DrawPointerEvent): ((event: DrawPointerEvent) => DrawFeature | null) | null {
    const context = this.context
    if (context === null) return null
    const { feature, frame, handle } = hit
    const center = frame.center
    const fallback = press.geographic?.heightMeters ?? 0
    if (handle === 'rotate' || handle === 'scale') {
      // Turns and scales follow the pointer around the center as drawn (at the feature's altitude), so they work the
      // same for features in the air and with the pointer over the sky.
      const centerOnScreen = this.gizmoOnScreen(feature, center, fallback)
      if (centerOnScreen === null) return null
      const startX = press.screen.xPixels - centerOnScreen.x
      const startY = press.screen.yPixels - centerOnScreen.y
      if (handle === 'rotate') {
        // Clockwise on the screen (y down) is clockwise from north, seen from above.
        const startAngle = Math.atan2(startY, startX)
        const startRotation = frame.rotationDegrees
        return event => {
          let angle = ((Math.atan2(event.screen.yPixels - centerOnScreen.y, event.screen.xPixels - centerOnScreen.x) - startAngle) * 180) / Math.PI
          // Shift snaps the resulting rotation (0°, 15°, 30°…), not the turn.
          if (event.originalEvent.shiftKey && this.snapDegrees > 0) angle = Math.round((startRotation + angle) / this.snapDegrees) * this.snapDegrees - startRotation
          return rotateFeature(feature, center, angle)
        }
      }
      const startDistance = Math.hypot(startX, startY)
      if (startDistance < 1) return null
      return event => {
        const distance = Math.hypot(event.screen.xPixels - centerOnScreen.x, event.screen.yPixels - centerOnScreen.y)
        return scaleFeature(feature, center, Math.max(MINIMUM_SCALE_FACTOR, distance / startDistance))
      }
    }
    if (handle === 'stretch') {
      // The pointer's travel along the side's axis as drawn: the side's distance from the opposite one on the screen
      // stands for its distance in metres.
      const side = hit.side
      if (side === null) return null
      const fixed = this.gizmoOnScreen(feature, side.oppositePosition, fallback)
      const moving = this.gizmoOnScreen(feature, side.position, fallback)
      if (fixed === null || moving === null) return null
      const axisX = moving.x - fixed.x
      const axisY = moving.y - fixed.y
      const lengthSquared = axisX * axisX + axisY * axisY
      if (lengthSquared < 1) return null
      return event => {
        const travel = ((event.screen.xPixels - press.screen.xPixels) * axisX + (event.screen.yPixels - press.screen.yPixels) * axisY) / lengthSquared
        return stretchFeature(feature, frame, side.axis, side.fixedMeters, Math.max(MINIMUM_SCALE_FACTOR, 1 + travel))
      }
    }
    if (handle === 'height') {
      const top = this.heightKnob(feature, frame, fallback)
      if (top === null) return null
      const rise = this.verticalDrag(center, top.baseMeters, top.topMeters, press)
      if (rise === null) return null
      const startExtrusion = frame.extrusionHeightMeters
      return event => {
        const height = startExtrusion + rise(event)
        // Down to the ground: flat again.
        return setExtrusionHeight(feature, height < MINIMUM_EXTRUSION_METERS ? 0 : height)
      }
    }
    const lift = this.liftKnob(feature, frame, fallback)
    if (lift === null) return null
    const rise = this.verticalDrag(center, lift.groundMeters, lift.baseMeters, press)
    if (rise === null) return null
    // Every position at an altitude, once: those on the terrain at its height under them (or under the press, where
    // it is not known yet), so the shape keeps the relief's offsets as it rises.
    const heights = context.heights
    const start = liftFeature(feature, 0, (longitude, latitude) => heights.heightAt(longitude, latitude, fallback))
    const onTerrain = baseAltitudeOf(feature) === null
    return event => {
      const delta = rise(event)
      // A feature that stood on the terrain stays there until it is lifted a metre; one in the air keeps its altitudes.
      if (onTerrain && delta < MINIMUM_LIFT_METERS) return feature
      return liftFeature(start, delta)
    }
  }

  /**
   * How far up a drag from `press` goes, in metres, along the vertical through `center` at `atMeters` as drawn on the
   * screen (the ground's scale measured at `groundMeters`). Seen from (nearly) straight above, as on the flat map, the
   * vertical is short on the screen: then dragging up the screen goes up by as many metres as the ground spans under
   * the pointer. Null when neither can be measured.
   */
  protected verticalDrag(center: LongitudeLatitude, groundMeters: number, atMeters: number, press: DrawPointerEvent): ((event: DrawPointerEvent) => number) | null {
    const context = this.context
    if (context === null) return null
    const east = context.projectAtHeight(destination(center, 1000, 90), groundMeters)
    const base = context.projectAtHeight(center, groundMeters)
    const groundPixelsPerKilometre = east === null || base === null ? 0 : Math.hypot(east.x - base.x, east.y - base.y)
    // Measured over a step of about 100 pixels: close to a small solid, a whole kilometre up may be behind the camera.
    const stepKilometres = groundPixelsPerKilometre > 0 ? Math.min(1000, Math.max(0.001, HEIGHT_STEP_PIXELS / groundPixelsPerKilometre)) : 1
    const lower = context.projectAtHeight(center, atMeters)
    const upper = context.projectAtHeight(center, atMeters + stepKilometres * 1000)
    if (lower === null) return null
    let alongX = upper === null ? 0 : (upper.x - lower.x) / stepKilometres
    let alongY = upper === null ? 0 : (upper.y - lower.y) / stepKilometres
    let pixelsPerKilometre = Math.hypot(alongX, alongY)
    // From above the vertical is short and points away from the middle of the screen: use up the screen instead.
    if (pixelsPerKilometre < groundPixelsPerKilometre / 3 || alongY >= -0.5 * pixelsPerKilometre) {
      if (groundPixelsPerKilometre < 1e-3) return null
      pixelsPerKilometre = groundPixelsPerKilometre
      alongX = 0
      alongY = -pixelsPerKilometre
    }
    const metresPerSquarePixel = 1000 / (pixelsPerKilometre * pixelsPerKilometre)
    const pressX = press.screen.xPixels
    const pressY = press.screen.yPixels
    return event => ((event.screen.xPixels - pressX) * alongX + (event.screen.yPixels - pressY) * alongY) * metresPerSquarePixel
  }
}

function middle(a: LongitudeLatitude, b: LongitudeLatitude): LongitudeLatitude {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
