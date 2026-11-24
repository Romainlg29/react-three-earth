import { distanceMeters, unwrapLongitudeNear } from '../geometry.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { createCircle, createRectangle, createSphere, type ShapeFeature, type ShapeOptions } from '../shapes.js'
import type { DrawFeature, DrawPointerEvent, GroundHeight, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

const IN_PROGRESS_ID = 'draw:in-progress'

/** Options of the circle, rectangle and sphere modes. */
export interface ShapeModeOptions {
  /** Properties given to each shape the mode creates. Default: none. */
  properties?: Record<string, unknown>
  /**
   * Circle and rectangle modes: makes each shape a closed prism mesh this many metres tall (a circle a cylinder, a
   * rectangle a box), its bottom on the terrain under each vertex, its level top this high above the highest. Change it
   * any time on the mode (`mode.heightMeters`). Default: none, flat shapes draped on the terrain.
   */
  heightMeters?: number
}

/**
 * Shared by the shape modes: a first tap places an anchor point (a center or a corner), the mouse shows the shape, a
 * second tap sets its size and creates it. Escape, Backspace, `cancel()` and `undo()` drop the first point. The mode
 * stays active, ready for the next shape.
 */
export abstract class TwoTapShapeMode extends DrawMode {
  protected readonly properties: Record<string, unknown>
  heightMeters: number | undefined
  /** The first tap, or null before it. */
  protected start: LongitudeLatitude | null = null
  /** The terrain's height under the first tap. */
  protected startHeightMeters = 0
  /** Where the mouse is (null on touch screens and off the map). */
  protected hoverPosition: LongitudeLatitude | null = null

  constructor({ properties = {}, heightMeters }: ShapeModeOptions = {}) {
    super()
    this.properties = properties
    this.heightMeters = heightMeters
  }

  /**
   * The shape spanning the first tap and `end`, or null when it would be empty. `ground` gives the terrain's height
   * under a position (for the base of a solid).
   */
  protected abstract build(start: LongitudeLatitude, end: LongitudeLatitude, ground: GroundHeight): ShapeFeature | null

  /** The shape drawn while the size is being picked (a sphere previews as its footprint). */
  protected preview(start: LongitudeLatitude, end: LongitudeLatitude, ground: GroundHeight): ShapeFeature | null {
    return this.build(start, end, ground)
  }

  /**
   * The terrain's height under positions, the tap's height where it is not known yet. `immediate`: sampled now (when
   * creating), else within the overlay's per-frame budget (while previewing).
   */
  protected ground(immediate: boolean): GroundHeight {
    const heights = this.context?.heights
    const fallback = this.startHeightMeters
    if (heights === undefined) return () => fallback
    return (longitude, latitude) => heights.heightAt(longitude, latitude, fallback, { immediate })
  }

  override enter(context: DrawModeContext): void {
    super.enter(context)
    context.setCursor('crosshair')
    context.holdDoubleClickZoom()
  }

  override click(event: DrawPointerEvent): void {
    const context = this.context
    const ground = event.geographic
    if (context === null || ground === null) return
    context.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    const position: LongitudeLatitude = [ground.longitudeDegrees, ground.latitudeDegrees]
    if (this.start === null) {
      this.start = position
      this.startHeightMeters = ground.heightMeters
      context.changed()
      return
    }
    // A second tap on the first point (a double tap) makes nothing: wait for a real size.
    const startScreen = context.project(this.start)
    if (startScreen !== null && Math.hypot(startScreen.x - event.screen.xPixels, startScreen.y - event.screen.yPixels) <= hitTolerancePixels(event.pointerType)) return
    const shape = this.build(this.start, position, this.ground(true))
    if (shape === null) return
    this.start = null
    context.create([{ ...shape, id: shape.id ?? context.createId() } as DrawFeature])
    context.changed()
  }

  override hover(event: DrawPointerEvent): void {
    const ground = event.geographic
    if (ground !== null) this.context?.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    this.hoverPosition = ground === null ? null : [ground.longitudeDegrees, ground.latitudeDegrees]
    if (this.start !== null) this.context?.changed()
  }

  override keyDown(event: KeyboardEvent): boolean {
    if ((event.key === 'Escape' || event.key === 'Backspace') && this.start !== null) {
      this.cancel()
      return true
    }
    return false
  }

  override cancel(): void {
    if (this.start === null) return
    this.start = null
    this.context?.changed()
  }

  override undo(): void {
    this.cancel()
  }

  override status(): DrawModeStatus {
    return this.start === null ? IDLE_STATUS : { drawing: true, vertexCount: 1, canFinish: false, canUndo: true }
  }

  override overlay(content: OverlayContent): void {
    const context = this.context
    const start = this.start
    if (context === null || start === null) return
    const shape = this.hoverPosition === null ? null : this.preview(start, this.hoverPosition, this.ground(false))
    const style = context.style({ type: 'Feature', id: IN_PROGRESS_ID, properties: this.properties, geometry: { type: 'Point', coordinates: start } }, { selected: false, drawing: true })
    if (shape !== null) {
      const feature = { ...shape, id: IN_PROGRESS_ID } as DrawFeature
      content.features.push({ feature, style: context.style(feature, { selected: false, drawing: true }) })
    }
    content.handles.push({ position: start, radiusPixels: style.vertexRadiusPixels, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels })
  }

  /** The options of the shape builders: the mode's properties and, with a height, the base on the terrain. */
  protected shapeOptions(ground: GroundHeight): ShapeOptions {
    const height = this.heightMeters
    return height !== undefined && height > 0 ? { properties: { ...this.properties }, heightMeters: height, baseHeightMeters: ground } : { properties: { ...this.properties } }
  }

  override inspect(): unknown {
    return { ...this.status(), start: this.start === null ? null : [...this.start], heightMeters: this.heightMeters ?? null }
  }
}

/** Draws circles: a tap on the center, a tap on the edge. With `heightMeters`, cylinder meshes. */
export class CircleMode extends TwoTapShapeMode {
  readonly name: string = 'circle'

  protected build(center: LongitudeLatitude, edge: LongitudeLatitude, ground: GroundHeight): ShapeFeature | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createCircle(center, radius, this.shapeOptions(ground)) : null
  }
}

/**
 * Draws rectangles facing north: a tap on a corner, a tap on the opposite corner. With `heightMeters`, box meshes. Turn
 * them afterwards with the select mode's gizmo (or `rotateFeature`).
 */
export class RectangleMode extends TwoTapShapeMode {
  readonly name: string = 'rectangle'

  protected build(corner: LongitudeLatitude, tapped: LongitudeLatitude, ground: GroundHeight): ShapeFeature | null {
    // Taps come wrapped to ±180°: across the antimeridian, the opposite corner is the one near the first.
    const opposite: LongitudeLatitude = [unwrapLongitudeNear(tapped[0], corner[0]), tapped[1]]
    const middleLatitude = (corner[1] + opposite[1]) / 2
    const width = distanceMeters([corner[0], middleLatitude], [opposite[0], middleLatitude])
    const length = distanceMeters([corner[0], corner[1]], [corner[0], opposite[1]])
    if (width === 0 || length === 0) return null
    return createRectangle([(corner[0] + opposite[0]) / 2, middleLatitude], width, length, this.shapeOptions(ground))
  }
}

/**
 * Places spheres resting on the terrain under their center: a tap on the center, a tap at the radius. Each is a closed
 * sphere mesh (`createSphere`). `heightMeters` is not used.
 */
export class SphereMode extends TwoTapShapeMode {
  readonly name: string = 'sphere'

  protected build(center: LongitudeLatitude, edge: LongitudeLatitude, ground: GroundHeight): ShapeFeature | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createSphere(center, radius, { properties: { ...this.properties }, baseHeightMeters: ground }) : null
  }

  protected override preview(center: LongitudeLatitude, edge: LongitudeLatitude): ShapeFeature | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createCircle(center, radius, { properties: { ...this.properties } }) : null
  }
}
