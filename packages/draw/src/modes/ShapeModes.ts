import type { Point, Polygon } from 'geojson'

import { distanceMeters, unwrapLongitudeNear } from '../geometry.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import { createCircle, createRectangle, createSphere, type ShapeFeature } from '../shapes.js'
import type { DrawFeature, DrawPointerEvent, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

const IN_PROGRESS_ID = 'draw:in-progress'

/** Options of the circle, rectangle and sphere modes. */
export interface ShapeModeOptions {
  /** Properties given to each shape the mode creates. Default: none. */
  properties?: Record<string, unknown>
  /**
   * Extrudes each shape into a solid this many metres tall (circles into cylinders, rectangles into boxes). Change it
   * any time on the mode (`mode.extrusionHeightMeters`). Default: none, flat shapes draped on the terrain.
   */
  extrusionHeightMeters?: number
}

/**
 * Shared by the shape modes: a first tap places an anchor point (a center or a corner), the mouse shows the shape, a
 * second tap sets its size and creates it. Escape, Backspace, `cancel()` and `undo()` drop the first point. The mode
 * stays active, ready for the next shape.
 */
export abstract class TwoTapShapeMode extends DrawMode {
  protected readonly properties: Record<string, unknown>
  extrusionHeightMeters: number | undefined
  /** The first tap, or null before it. */
  protected start: LongitudeLatitude | null = null
  /** Where the mouse is (null on touch screens and off the map). */
  protected hoverPosition: LongitudeLatitude | null = null

  constructor({ properties = {}, extrusionHeightMeters }: ShapeModeOptions = {}) {
    super()
    this.properties = properties
    this.extrusionHeightMeters = extrusionHeightMeters
  }

  /** The shape spanning the first tap and `end`, or null when it would be empty. */
  protected abstract build(start: LongitudeLatitude, end: LongitudeLatitude): ShapeFeature<Polygon | Point> | null

  /** The outline drawn while the size is being picked (a sphere previews as its footprint). */
  protected preview(start: LongitudeLatitude, end: LongitudeLatitude): ShapeFeature<Polygon | Point> | null {
    return this.build(start, end)
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
      context.changed()
      return
    }
    // A second tap on the first point (a double tap) makes nothing: wait for a real size.
    const startScreen = context.project(this.start)
    if (startScreen !== null && Math.hypot(startScreen.x - event.screen.xPixels, startScreen.y - event.screen.yPixels) <= hitTolerancePixels(event.pointerType)) return
    const shape = this.build(this.start, position)
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
    const shape = this.hoverPosition === null ? null : this.preview(start, this.hoverPosition)
    const style = context.style({ type: 'Feature', id: IN_PROGRESS_ID, properties: this.properties, geometry: { type: 'Point', coordinates: start } }, { selected: false, drawing: true })
    if (shape !== null) {
      const feature = { ...shape, id: IN_PROGRESS_ID } as DrawFeature
      content.features.push({ feature, style: context.style(feature, { selected: false, drawing: true }) })
    }
    content.handles.push({ position: start, radiusPixels: style.vertexRadiusPixels, color: style.vertexColor, outlineColor: style.vertexOutlineColor, outlineWidthPixels: style.vertexOutlineWidthPixels })
  }

  protected shapeOptions(): { properties: Record<string, unknown>; extrusionHeightMeters?: number } {
    const extrusion = this.extrusionHeightMeters
    return extrusion !== undefined && extrusion > 0 ? { properties: { ...this.properties }, extrusionHeightMeters: extrusion } : { properties: { ...this.properties } }
  }

  override inspect(): unknown {
    return { ...this.status(), start: this.start === null ? null : [...this.start], extrusionHeightMeters: this.extrusionHeightMeters ?? null }
  }
}

/** Draws circles: a tap on the center, a tap on the edge. With `extrusionHeightMeters`, cylinders. */
export class CircleMode extends TwoTapShapeMode {
  readonly name: string = 'circle'

  protected build(center: LongitudeLatitude, edge: LongitudeLatitude): ShapeFeature | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createCircle(center, radius, this.shapeOptions()) : null
  }
}

/**
 * Draws rectangles facing north: a tap on a corner, a tap on the opposite corner. With `extrusionHeightMeters`, boxes.
 * Turn them afterwards with `createRectangle`'s `rotationDegrees` (the shape is kept in `properties.shape`).
 */
export class RectangleMode extends TwoTapShapeMode {
  readonly name: string = 'rectangle'

  protected build(corner: LongitudeLatitude, tapped: LongitudeLatitude): ShapeFeature | null {
    // Taps come wrapped to ±180°: across the antimeridian, the opposite corner is the one near the first.
    const opposite: LongitudeLatitude = [unwrapLongitudeNear(tapped[0], corner[0]), tapped[1]]
    const middleLatitude = (corner[1] + opposite[1]) / 2
    const width = distanceMeters([corner[0], middleLatitude], [opposite[0], middleLatitude])
    const length = distanceMeters([corner[0], corner[1]], [corner[0], opposite[1]])
    if (width === 0 || length === 0) return null
    return createRectangle([(corner[0] + opposite[0]) / 2, middleLatitude], width, length, this.shapeOptions())
  }
}

/** Places spheres resting on the terrain: a tap on the center, a tap at the radius. */
export class SphereMode extends TwoTapShapeMode {
  readonly name: string = 'sphere'

  protected build(center: LongitudeLatitude, edge: LongitudeLatitude): ShapeFeature<Point> | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createSphere(center, radius, { properties: { ...this.properties } }) : null
  }

  protected override preview(center: LongitudeLatitude, edge: LongitudeLatitude): ShapeFeature | null {
    const radius = distanceMeters(center, edge)
    return radius > 0 ? createCircle(center, radius, { properties: { ...this.properties } }) : null
  }
}
