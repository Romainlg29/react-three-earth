import { hitFeature } from '../editing.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { destination } from '../shapes.js'
import { rotateFeature, scaleFeature, setExtrusionHeight, transformFrame, type TransformFrame } from '../transform.js'
import type { DrawFeature, DrawPointerEvent, LongitudeLatitude } from '../types.js'
import { hitTolerancePixels } from './DrawMode.js'
import { SelectMode, type SelectDrag } from './SelectMode.js'

/** Options of the transform mode. */
export interface TransformModeOptions {
  /** A knob turns the selected feature. Default: true. */
  rotate?: boolean
  /** Corner handles scale the selected feature. Default: true. */
  scale?: boolean
  /**
   * A knob in the middle of a line or polygon extrudes it: drag it up to turn a flat shape into a solid (a rectangle
   * into a box, a line into a wall), down to the ground to flatten it again. Default: true.
   */
  height?: boolean
  /** Turns snap to this many degrees while Shift is held. Default: 15. */
  snapDegrees?: number
  /** Edits `undo()` can take back. Default: 50. */
  undoLimit?: number
}

/** The handles of the gizmo. */
type GizmoHandle = 'rotate' | 'scale' | 'height'

/** Smallest scale factor a drag reaches, so a feature never collapses to a point. */
const MINIMUM_SCALE_FACTOR = 0.01
/** Pixels around a drawn knob that still grab it when the press is inside the feature (where it would move it). */
const KNOB_MARGIN_PIXELS = 4
/** The height drag measures the vertical over a step about this many pixels of ground long. */
const HEIGHT_STEP_PIXELS = 100
/** A height drag ending below this many metres flattens the feature (removes its extrusion). */
const MINIMUM_EXTRUSION_METERS = 1

/**
 * Selects features like the select mode, and shows a gizmo on the selected one instead of vertex handles:
 *
 * - drag the feature to move it;
 * - drag the knob beyond its top edge to turn it (Shift snaps to 15°);
 * - drag a corner to scale it around its center;
 * - drag the knob in the middle of a flat line or polygon up to extrude it into a solid (a rectangle into a box, a
 *   circle into a cylinder, a line into a wall); on a solid it sits on top: drag it up or down to change the height,
 *   down to the ground to flatten it again.
 *
 * Shapes keep their measurements in `properties.shape`: a scaled circle is a circle with a new radius, a turned
 * rectangle has a new `rotationDegrees`. Circles and spheres show no rotation knob. Each change fires one `update`, on
 * release; `undo()` takes it back. Presses off the selection still pan the map.
 */
export class TransformMode extends SelectMode {
  override readonly name: string = 'transform'
  readonly rotate: boolean
  readonly scale: boolean
  readonly height: boolean
  readonly snapDegrees: number

  constructor({ rotate = true, scale = true, height = true, snapDegrees = 15, undoLimit }: TransformModeOptions = {}) {
    super({ editVertices: false, moveFeatures: true, undoLimit })
    this.rotate = rotate
    this.scale = scale
    this.height = height
    this.snapDegrees = snapDegrees
  }

  override pointerDown(event: DrawPointerEvent): boolean {
    const context = this.context
    if (context === null) return false
    const hit = this.gizmoHandleAt(event)
    if (hit === null) return super.pointerDown(event)
    const update = this.gizmoUpdate(hit.feature, hit.frame, hit.handle, event)
    if (update === null) return super.pointerDown(event)
    const drag: SelectDrag = { kind: 'transform', base: hit.feature, feature: hit.feature, handle: hit.handle, update }
    this.drag = drag
    this.pressStart = { x: event.screen.xPixels, y: event.screen.yPixels }
    this.dragging = false
    return true
  }

  override hover(event: DrawPointerEvent): void {
    const context = this.context
    if (context !== null && this.selection.length > 0 && this.gizmoHandleAt(event) !== null) {
      context.setCursor('grab')
      return
    }
    super.hover(event)
  }

  override overlay(content: OverlayContent): void {
    super.overlay(content)
    const context = this.context
    if (context === null) return
    for (const id of this.selectedFeatureIds()) {
      const stored = context.store.get(id)
      if (stored === undefined) continue
      const feature = this.drag !== null && this.dragging && this.drag.feature.id === id ? this.drag.feature : stored
      // Moving whole: the gizmo waits for the release.
      if (this.drag?.kind === 'feature' && this.dragging && this.drag.feature.id === id) continue
      const frame = transformFrame(feature)
      const style = context.style(feature, { selected: true, drawing: false })
      const knob = { radiusPixels: style.vertexRadiusPixels + 1, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels }
      // A feature at an altitude has its gizmo there; one on the ground, on the terrain.
      const altitude = baseAltitude(feature) ?? undefined
      const level = (count: number) => (altitude === undefined ? undefined : new Array<number>(count).fill(altitude))
      if (this.scale && frame.corners.length === 4) {
        content.lines.push({ positions: [...frame.corners, frame.corners[0]!], heightsMeters: level(5), color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
        for (const corner of frame.corners) content.handles.push({ ...knob, position: corner, heightMeters: altitude })
      }
      if (this.rotate && frame.rotationHandle !== null) {
        const topMiddle = middle(frame.corners[2]!, frame.corners[3]!)
        content.lines.push({ positions: [topMiddle, frame.rotationHandle], heightsMeters: level(2), color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
        content.handles.push({ ...knob, position: frame.rotationHandle, heightMeters: altitude, color: style.vertexOutlineColor, outlineColor: style.vertexColor })
      }
      const top = this.heightKnob(feature, frame)
      if (top !== null && top.topMeters > top.baseMeters) {
        content.lines.push({ positions: [frame.center, frame.center], heightsMeters: [top.baseMeters, top.topMeters], color: style.vertexOutlineColor, widthPixels: 1.5, opacity: 0.8 })
      }
      if (top !== null) content.handles.push({ ...knob, position: frame.center, heightMeters: top.topMeters, color: style.vertexOutlineColor, outlineColor: style.vertexColor })
    }
  }

  // ---- Internals ----

  /**
   * The height knob of a line or polygon: its base and its top above the ellipsoid (the same for a flat feature, whose
   * knob sits in its middle on the ground). Null for points.
   */
  protected heightKnob(feature: DrawFeature, frame: TransformFrame): { baseMeters: number; topMeters: number } | null {
    const context = this.context
    if (!this.height || context === null || feature.geometry.type === 'Point') return null
    const baseMeters = baseAltitude(feature) ?? context.heights.heightAt(frame.center[0], frame.center[1])
    return { baseMeters, topMeters: baseMeters + frame.extrusionHeightMeters }
  }

  /** The gizmo handle of the selected features under a press, nearest first. */
  protected gizmoHandleAt(event: DrawPointerEvent): { feature: DrawFeature; frame: TransformFrame; handle: GizmoHandle } | null {
    const context = this.context
    if (context === null) return null
    const input = this.hitInput(event)
    let best: { feature: DrawFeature; frame: TransformFrame; handle: GizmoHandle; distance: number } | null = null
    let tolerance = 0
    const consider = (feature: DrawFeature, frame: TransformFrame, handle: GizmoHandle, screen: { x: number; y: number } | null) => {
      if (screen === null) return
      const distance = Math.hypot(screen.x - event.screen.xPixels, screen.y - event.screen.yPixels)
      if (distance <= tolerance && (best === null || distance < best.distance)) best = { feature, frame, handle, distance }
    }
    const fallback = event.geographic?.heightMeters ?? 0
    for (const id of this.selection) {
      const feature = context.store.get(id)
      if (feature === undefined) continue
      // Inside the feature a press moves it, unless it lands on a knob as drawn: a finger's full reach would cover
      // small features (and the knob in the middle) and leave no way to move them.
      const knobRadius = context.style(feature, { selected: true, drawing: false }).vertexRadiusPixels + 1
      tolerance = hitFeature(feature, input) === 0 ? knobRadius + KNOB_MARGIN_PIXELS : hitTolerancePixels(event.pointerType)
      const frame = transformFrame(feature)
      const altitude = baseAltitude(feature)
      const place = (position: LongitudeLatitude) => (altitude === null ? context.project(position, fallback) : context.projectAtHeight(position, altitude))
      if (this.scale) for (const corner of frame.corners) consider(feature, frame, 'scale', place(corner))
      if (this.rotate && frame.rotationHandle !== null) consider(feature, frame, 'rotate', place(frame.rotationHandle))
      const top = this.heightKnob(feature, frame)
      if (top !== null) consider(feature, frame, 'height', context.projectAtHeight(frame.center, top.topMeters))
    }
    if (best === null) return null
    const { feature, frame, handle } = best
    return { feature, frame, handle }
  }

  /** How a drag on a gizmo handle changes the feature, from the press. Null when it cannot start here. */
  protected gizmoUpdate(feature: DrawFeature, frame: TransformFrame, handle: GizmoHandle, press: DrawPointerEvent): ((event: DrawPointerEvent) => DrawFeature | null) | null {
    const context = this.context
    if (context === null) return null
    const center = frame.center
    // Turns and scales follow the pointer around the center as drawn (at the feature's altitude), so they work the same
    // for features in the air and with the pointer over the sky.
    const altitude = baseAltitude(feature)
    const centerOnScreen = altitude === null ? context.project(center, press.geographic?.heightMeters ?? 0) : context.projectAtHeight(center, altitude)
    if (handle !== 'height' && centerOnScreen === null) return null
    const offset = (event: DrawPointerEvent) => ({ x: event.screen.xPixels - centerOnScreen!.x, y: event.screen.yPixels - centerOnScreen!.y })
    const start = offset(press)
    if (handle === 'rotate') {
      // Clockwise on the screen (y down) is clockwise from north, seen from above.
      const startAngle = Math.atan2(start.y, start.x)
      const startRotation = frame.rotationDegrees
      return event => {
        const now = offset(event)
        let angle = ((Math.atan2(now.y, now.x) - startAngle) * 180) / Math.PI
        // Shift snaps the resulting rotation (0°, 15°, 30°…), not the turn.
        if (event.originalEvent.shiftKey && this.snapDegrees > 0) angle = Math.round((startRotation + angle) / this.snapDegrees) * this.snapDegrees - startRotation
        return rotateFeature(feature, center, angle)
      }
    }
    if (handle === 'scale') {
      const startDistance = Math.hypot(start.x, start.y)
      if (startDistance < 1) return null
      return event => {
        const now = offset(event)
        return scaleFeature(feature, center, Math.max(MINIMUM_SCALE_FACTOR, Math.hypot(now.x, now.y) / startDistance))
      }
    }
    // Height: the press moves along the vertical through the center, as drawn on the screen.
    const top = this.heightKnob(feature, frame)
    if (top === null) return null
    const east = context.projectAtHeight(destination(center, 1000, 90), top.baseMeters)
    const base = context.projectAtHeight(center, top.baseMeters)
    const groundPixelsPerKilometre = east === null || base === null ? 0 : Math.hypot(east.x - base.x, east.y - base.y)
    // Measured over a step of about 100 pixels: close to a small solid, a whole kilometre up may be behind the camera.
    const stepKilometres = groundPixelsPerKilometre > 0 ? Math.min(1000, Math.max(0.001, HEIGHT_STEP_PIXELS / groundPixelsPerKilometre)) : 1
    const lower = context.projectAtHeight(center, top.topMeters)
    const upper = context.projectAtHeight(center, top.topMeters + stepKilometres * 1000)
    if (lower === null) return null
    let along = upper === null ? { x: 0, y: 0 } : { x: (upper.x - lower.x) / stepKilometres, y: (upper.y - lower.y) / stepKilometres }
    let pixelsPerKilometre = Math.hypot(along.x, along.y)
    // Seen from (nearly) straight above, as on the flat map, the vertical is short on the screen and points away from
    // its middle: then dragging up the screen raises the feature by as many metres as the ground spans under the pointer.
    if (pixelsPerKilometre < groundPixelsPerKilometre / 3 || along.y >= -0.5 * pixelsPerKilometre) {
      if (groundPixelsPerKilometre < 1e-3) return null
      pixelsPerKilometre = groundPixelsPerKilometre
      along = { x: 0, y: -pixelsPerKilometre }
    }
    const startExtrusion = frame.extrusionHeightMeters
    return event => {
      const pixels = ((event.screen.xPixels - press.screen.xPixels) * along.x + (event.screen.yPixels - press.screen.yPixels) * along.y) / pixelsPerKilometre
      const height = startExtrusion + (pixels / pixelsPerKilometre) * 1000
      // Down to the ground: flat again.
      return setExtrusionHeight(feature, height < MINIMUM_EXTRUSION_METERS ? 0 : height)
    }
  }
}

/** The altitude of a feature's first position (its third coordinate), or null for a feature on the terrain. */
function baseAltitude(feature: DrawFeature): number | null {
  const geometry = feature.geometry
  const first = geometry.type === 'Polygon' ? geometry.coordinates[0]?.[0] : geometry.type === 'LineString' ? geometry.coordinates[0] : geometry.coordinates
  return first !== undefined && first.length > 2 && Number.isFinite(first[2]) ? first[2]! : null
}

function middle(a: LongitudeLatitude, b: LongitudeLatitude): LongitudeLatitude {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
