import type { LineString, MultiPolygon, Polygon } from 'geojson'

import { closeRing } from '../geometry.js'
import { prismMesh, wallMesh } from '../mesh.js'
import type { OverlayContent } from '../render/LiveOverlay.js'
import type { DrawFeature, DrawPointerEvent, LongitudeLatitude } from '../types.js'
import { DrawMode, hitTolerancePixels, IDLE_STATUS, type DrawModeContext, type DrawModeStatus } from './DrawMode.js'

/** The id features in progress carry in the overlay; they reach the store with a real id when finished. */
const IN_PROGRESS_ID = 'draw:in-progress'

/** Options of the point, line string and polygon modes. */
export interface PlacementModeOptions {
  /** Properties given to each feature the mode creates. Default: none. */
  properties?: Record<string, unknown>
  /**
   * Line string and polygon modes: makes each feature a mesh this many metres tall, its base on the terrain under each
   * vertex: a polygon a closed prism (its level top this high above the highest base vertex), a line a wall (its top
   * this high above its base). Change it any time on the mode (`mode.heightMeters`). Default: none, flat features.
   */
  heightMeters?: number
}

/** Places a point at each tap. */
export class PointMode extends DrawMode {
  readonly name: string = 'point'
  protected readonly properties: Record<string, unknown>

  constructor({ properties = {} }: PlacementModeOptions = {}) {
    super()
    this.properties = properties
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
    context.create([{ type: 'Feature', id: context.createId(), properties: { ...this.properties }, geometry: { type: 'Point', coordinates: [ground.longitudeDegrees, ground.latitudeDegrees] } }])
  }
}

/**
 * Shared by the line string and polygon modes: a tap places a vertex, the mouse shows the next segment, a tap on the
 * last vertex (or a double click, or `finish()`, or Enter) completes the feature, Escape drops it, Backspace and `undo()`
 * remove the last vertex. The mode stays active, ready for the next feature.
 */
export abstract class PathMode extends DrawMode {
  protected readonly properties: Record<string, unknown>
  heightMeters: number | undefined
  protected readonly vertices: LongitudeLatitude[] = []
  /** The terrain's height under each vertex, from its tap. */
  protected readonly vertexHeights: number[] = []
  /** Where the mouse is, for the segment to the next vertex. Null on touch screens and off the map. */
  protected hoverPosition: LongitudeLatitude | null = null
  /** Fewest vertices of a finished feature. */
  protected abstract readonly minimumVertices: number

  constructor({ properties = {}, heightMeters }: PlacementModeOptions = {}) {
    super()
    this.properties = properties
    this.heightMeters = heightMeters
  }

  override enter(context: DrawModeContext): void {
    super.enter(context)
    context.setCursor('crosshair')
    context.holdDoubleClickZoom()
  }

  /** The properties of a finished feature: a copy of the mode's. */
  protected featureProperties(): Record<string, unknown> {
    return { ...this.properties }
  }

  /** The geometry for these vertices: a line string, or a closed polygon. */
  protected abstract toGeometry(vertices: LongitudeLatitude[]): LineString | Polygon

  /**
   * The mesh for these vertices `heightMeters` tall, each standing on `baseHeightsMeters` (the terrain under it): a wall,
   * or a prism.
   */
  protected abstract toMesh(vertices: LongitudeLatitude[], baseHeightsMeters: number[], heightMeters: number): MultiPolygon

  /** True when a tap at `event` lands on the vertex at `index`. */
  protected hits(event: DrawPointerEvent, index: number): boolean {
    const vertex = this.vertices[index]
    if (vertex === undefined || this.context === null) return false
    const screen = this.context.project(vertex)
    return screen !== null && Math.hypot(screen.x - event.screen.xPixels, screen.y - event.screen.yPixels) <= hitTolerancePixels(event.pointerType)
  }

  /** Whether a tap at `event` completes the feature instead of placing a vertex. */
  protected completes(event: DrawPointerEvent): boolean {
    return this.vertices.length >= this.minimumVertices && this.hits(event, this.vertices.length - 1)
  }

  override click(event: DrawPointerEvent): void {
    const context = this.context
    if (context === null) return
    if (this.completes(event)) {
      this.finish()
      return
    }
    // A tap on the last vertex of a feature too short to finish places nothing (a double tap's second tap).
    if (this.vertices.length > 0 && this.hits(event, this.vertices.length - 1)) return
    const ground = event.geographic
    if (ground === null) return
    context.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    this.vertices.push([ground.longitudeDegrees, ground.latitudeDegrees])
    this.vertexHeights.push(ground.heightMeters)
    context.changed()
  }

  override doubleClick(): void {
    // The first click of the double click placed the vertex, the second finished: nothing left unless it was too short.
    if (this.vertices.length >= this.minimumVertices) this.finish()
  }

  override hover(event: DrawPointerEvent): void {
    const ground = event.geographic
    const next: LongitudeLatitude | null = ground === null ? null : [ground.longitudeDegrees, ground.latitudeDegrees]
    if (next === null && this.hoverPosition === null) return
    if (ground !== null) this.context?.heights.remember(ground.longitudeDegrees, ground.latitudeDegrees, ground.heightMeters)
    this.hoverPosition = next
    if (this.vertices.length > 0) this.context?.changed()
  }

  override keyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape' && this.vertices.length > 0) {
      this.cancel()
      return true
    }
    if (event.key === 'Enter' && this.vertices.length >= this.minimumVertices) {
      this.finish()
      return true
    }
    if (event.key === 'Backspace' && this.vertices.length > 0) {
      this.undo()
      return true
    }
    return false
  }

  override finish(): void {
    const context = this.context
    if (context === null || this.vertices.length < this.minimumVertices) return
    const height = this.heightMeters
    let geometry: LineString | Polygon | MultiPolygon
    if (height !== undefined && height > 0) {
      // The terrain under each vertex sampled now (finer tiles may have loaded since its tap), else the height remembered
      // for it (its tap's), else the tap's height kept with the vertex.
      const bases = this.vertices.map(([longitude, latitude], index) => context.heights.heightAt(longitude, latitude, this.vertexHeights[index] ?? 0, { immediate: true }))
      geometry = this.toMesh([...this.vertices], bases, height)
    } else geometry = this.toGeometry([...this.vertices])
    const feature: DrawFeature = { type: 'Feature', id: context.createId(), properties: this.featureProperties(), geometry }
    this.vertices.length = 0
    this.vertexHeights.length = 0
    context.create([feature])
    context.changed()
  }

  override cancel(): void {
    if (this.vertices.length === 0) return
    this.vertices.length = 0
    this.vertexHeights.length = 0
    this.context?.changed()
  }

  override undo(): void {
    this.vertexHeights.pop()
    if (this.vertices.pop() !== undefined) this.context?.changed()
  }

  override status(): DrawModeStatus {
    if (this.vertices.length === 0) return IDLE_STATUS
    return { drawing: true, vertexCount: this.vertices.length, canFinish: this.vertices.length >= this.minimumVertices, canUndo: true }
  }

  override overlay(content: OverlayContent): void {
    const context = this.context
    if (context === null || this.vertices.length === 0) return
    const withHover = this.hoverPosition === null ? this.vertices : [...this.vertices, this.hoverPosition]
    const feature: DrawFeature = { type: 'Feature', id: IN_PROGRESS_ID, properties: { ...this.properties }, geometry: this.inProgressGeometry(withHover) }
    const style = context.style(feature, { selected: false, drawing: true })
    content.features.push({ feature, style })
    this.vertices.forEach((position, index) => {
      const closing = this.closesOnVertex(index)
      content.handles.push({
        position,
        radiusPixels: closing ? style.vertexRadiusPixels + 2 : style.vertexRadiusPixels,
        color: closing ? style.vertexOutlineColor : style.vertexColor,
        outlineColor: closing ? style.vertexColor : style.vertexOutlineColor,
        outlineWidthPixels: style.vertexOutlineWidthPixels,
      })
    })
  }

  /** The geometry drawn while in progress, through the mouse position. */
  protected inProgressGeometry(positions: LongitudeLatitude[]): LineString | Polygon {
    return { type: 'LineString', coordinates: positions }
  }

  /** Whether tapping vertex `index` completes the feature (drawn larger). */
  protected closesOnVertex(index: number): boolean {
    return this.vertices.length >= this.minimumVertices && index === this.vertices.length - 1
  }

  override inspect(): unknown {
    return { ...this.status(), vertices: this.vertices.map(vertex => [...vertex]) }
  }
}

/**
 * Draws line strings: a tap per vertex, then a tap on the last vertex (or Enter, a double click, `finish()`). With
 * `heightMeters`, wall meshes.
 */
export class LineStringMode extends PathMode {
  readonly name: string = 'linestring'
  protected readonly minimumVertices: number = 2

  protected toGeometry(vertices: LongitudeLatitude[]): LineString {
    return { type: 'LineString', coordinates: vertices }
  }

  protected toMesh(vertices: LongitudeLatitude[], baseHeightsMeters: number[], heightMeters: number): MultiPolygon {
    return wallMesh(
      vertices.map(([longitude, latitude], index) => [longitude, latitude, baseHeightsMeters[index]!]),
      position => position[2]!,
      heightMeters,
    )
  }
}

/**
 * Draws polygons: a tap per vertex, then a tap on the first or last vertex (or Enter, a double click, `finish()`)
 * closes the ring. The fill shows from the third vertex. With `heightMeters`, prism meshes.
 */
export class PolygonMode extends PathMode {
  readonly name: string = 'polygon'
  protected readonly minimumVertices: number = 3

  protected override completes(event: DrawPointerEvent): boolean {
    return this.vertices.length >= this.minimumVertices && (this.hits(event, 0) || this.hits(event, this.vertices.length - 1))
  }

  protected override closesOnVertex(index: number): boolean {
    return this.vertices.length >= this.minimumVertices && (index === 0 || index === this.vertices.length - 1)
  }

  protected toGeometry(vertices: LongitudeLatitude[]): Polygon {
    return { type: 'Polygon', coordinates: [closeRing(vertices)] }
  }

  protected toMesh(vertices: LongitudeLatitude[], baseHeightsMeters: number[], heightMeters: number): MultiPolygon {
    return prismMesh([vertices.map(([longitude, latitude], index) => [longitude, latitude, baseHeightsMeters[index]!])], position => position[2]!, heightMeters)
  }

  protected override inProgressGeometry(positions: LongitudeLatitude[]): LineString | Polygon {
    return positions.length >= 3 ? { type: 'Polygon', coordinates: [closeRing(positions)] } : { type: 'LineString', coordinates: positions }
  }
}
