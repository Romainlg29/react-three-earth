import type { Position } from 'geojson'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, removeVertex, translateFeature, type VertexPath } from '../editing.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { isSolidFeature } from '../render/SolidFeatures.js'
import { shapeOf } from '../shapes.js'
import type { DrawFeature, DrawPointerEvent, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, NO_FEATURE_IDS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

/** Options of the select mode. */
export interface SelectModeOptions {
  /** A press on a selected feature drags it whole. Default: true. */
  moveFeatures?: boolean
  /** Selected line strings and polygons show handles: drag a vertex, tap or drag a midpoint to add one. Default: true. */
  editVertices?: boolean
  /** Edits `undo()` can take back. Default: 50. */
  undoLimit?: number
}

/** What a press on the selection is doing. */
/**
 * What a press on the selection is doing. `base` is the stored version the drag started from: if the store changes it
 * meanwhile, the drag is dropped. A `transform` drag (for subclasses: a gizmo) computes the feature from each move.
 */
export type SelectDrag =
  | { kind: 'vertex'; base: DrawFeature; feature: DrawFeature; path: VertexPath; inserted: boolean }
  | { kind: 'feature'; base: DrawFeature; feature: DrawFeature; origin: LongitudeLatitude }
  | { kind: 'transform'; base: DrawFeature; feature: DrawFeature; handle: string; update: (event: DrawPointerEvent) => DrawFeature | null }

type Drag = SelectDrag

/** One edit, as what restores it: features to put back, and ids to remove (features the edit created). */
interface UndoEntry {
  restore: DrawFeature[]
}

/** Pixels a press moves before it counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PIXELS = 4

/**
 * Selects and edits finished features. A tap selects the feature under it (points and lines before the polygons under
 * them); a tap on the empty map clears the selection. On a selected feature:
 *
 * - drag a vertex handle to move it; tap a vertex to pick it, then Delete or Backspace (or `draw.deleteSelected()`)
 *   removes it;
 * - drag or tap a midpoint handle to insert a vertex there;
 * - drag the feature itself to move it whole (shapes keep their size in metres).
 *
 * Shapes made by the shape tools (`properties.shape`: circles, rectangles, spheres…) move whole and show no vertex
 * handles, so they stay those shapes. A press anywhere else still pans the map, so one finger pans between edits. Each
 * edit fires `update` (`delete` for deletions) once, on release; `undo()` takes edits back.
 */
export class SelectMode extends DrawMode {
  readonly name: string = 'select'
  readonly moveFeatures: boolean
  readonly editVertices: boolean
  protected readonly undoLimit: number
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

  constructor({ moveFeatures = true, editVertices = true, undoLimit = 50 }: SelectModeOptions = {}) {
    super()
    this.moveFeatures = moveFeatures
    this.editVertices = editVertices
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
      this.selection = this.selection.filter(id => store.has(id))
      if (this.selectedVertex !== null && !store.has(this.selectedVertex.feature.id)) this.selectedVertex = null
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
      this.drag = null
      this.context?.changed()
    }
    return true
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
    this.commit(features, () => context.remove(features.map(feature => feature.id)))
    return true
  }

  // ---- Pointer ----

  override click(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
    const hit = this.featureAt(event)
    this.setSelection(hit === null ? [] : [hit.id])
  }

  override pointerDown(event: DrawPointerEvent): boolean {
    const context = this.context
    if (context === null || this.selection.length === 0) return false
    const handle = this.handleAt(event)
    let drag: Drag | null = null
    if (handle !== null) {
      const feature = context.store.get(handle.featureId)!
      drag =
        handle.kind === 'vertex'
          ? { kind: 'vertex', base: feature, feature, path: handle.path, inserted: false }
          : { kind: 'vertex', base: feature, feature: insertVertex(feature, handle.path, handle.position), path: handle.path, inserted: true }
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
    const ground = event.geographic
    if (ground === null) return
    context.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    const position: LongitudeLatitude = [ground.longitudeDegrees, ground.latitudeDegrees]
    const original = context.store.get(drag.feature.id)
    // Changed or removed elsewhere mid-drag: drop the drag rather than edit another version.
    if (original !== drag.base) {
      this.pointerCancel()
      return
    }
    if (drag.kind === 'vertex') {
      const base = drag.inserted ? insertVertex(original, drag.path, position) : original
      this.drag = { ...drag, feature: moveVertex(base, drag.path, position) }
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
        context.changed()
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
    const cursor = this.handleAt(event) !== null ? 'pointer' : this.moveFeatures && this.selectedFeatureAt(event) !== null ? 'move' : null
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

  /** Drops a drag in progress, then the selection. */
  override cancel(): void {
    if (this.drag !== null) {
      this.pointerCancel()
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
    return this.undoStack.length === 0 ? IDLE_STATUS : { ...IDLE_STATUS, canUndo: true }
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
      const style = context.style(feature, { selected: true, drawing: false })
      if (live.has(id)) content.features.push({ feature, style })
      else if (feature.geometry.type !== 'Point') {
        // A solid: its footprint, over the map.
        for (const ring of feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : [feature.geometry.coordinates]) {
          const atAltitude = ring.every(position => position.length > 2 && Number.isFinite(position[2]))
          content.lines.push({ positions: ring.map(position => [position[0]!, position[1]!]), heightsMeters: atAltitude ? ring.map(position => position[2]!) : undefined, color: style.vertexOutlineColor, widthPixels: 2, opacity: 1 })
        }
      }
      if (!this.showsVertexHandles(feature) || drag?.kind === 'feature' || drag?.kind === 'transform') continue
      if (feature.geometry.type !== 'Point') {
        for (const midpoint of featureMidpoints(feature)) {
          content.handles.push({ position: midpoint.position, radiusPixels: style.vertexRadiusPixels - 1, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels, faded: true })
        }
      }
      const picked = this.selectedVertex?.feature.id === id ? this.selectedVertex.path : drag?.kind === 'vertex' ? drag.path : null
      for (const vertex of featureVertices(feature)) {
        const isPicked = picked !== null && picked.ring === vertex.path.ring && picked.index === vertex.path.index
        content.handles.push({
          position: [vertex.position[0]!, vertex.position[1]!],
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
      selectedVertex: this.selectedVertex === null ? null : { featureId: this.selectedVertex.feature.id, path: this.selectedVertex.path },
      drag: this.drag === null ? null : { kind: this.drag.kind, featureId: this.drag.feature.id, dragging: this.dragging },
      undo: this.undoStack.length,
    }
  }

  // ---- Internals ----

  /** Lines and polygons drawn by hand show vertex handles; points and shapes (which stay shapes) do not. */
  protected showsVertexHandles(feature: DrawFeature): boolean {
    return this.editVertices && feature.geometry.type !== 'Point' && shapeOf(feature) === null
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
  protected handleAt(event: DrawPointerEvent): { kind: 'vertex' | 'midpoint'; featureId: string; path: VertexPath; position: LongitudeLatitude } | null {
    const context = this.context
    if (context === null) return null
    const input = this.hitInput(event)
    let best: { kind: 'vertex' | 'midpoint'; featureId: string; path: VertexPath; position: LongitudeLatitude; distance: number } | null = null
    const consider = (kind: 'vertex' | 'midpoint', featureId: string, path: VertexPath, position: LongitudeLatitude) => {
      const screen = input.project(position)
      if (screen === null) return
      // Vertices win ties over midpoints, so a short edge's vertices stay reachable.
      const distance = Math.hypot(screen.x - input.screen.x, screen.y - input.screen.y) + (kind === 'midpoint' ? 0.5 : 0)
      if (distance <= input.tolerancePixels && (best === null || distance < best.distance)) best = { kind, featureId, path, position, distance }
    }
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature === undefined || !this.showsVertexHandles(feature)) continue
      for (const vertex of featureVertices(feature)) consider('vertex', id, vertex.path, [vertex.position[0]!, vertex.position[1]!])
      for (const midpoint of featureMidpoints(feature)) consider('midpoint', id, midpoint.path, midpoint.position)
    }
    return best
  }
}
