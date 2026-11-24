import { isOccludedByEllipsoid, type Earth } from 'react-three-earth'
import { Group, Vector3, type Camera } from 'three'

import { distanceMeters, geometryLines, geometryPolygons, unwrapLongitudeNear, triangulatePolygon, fromMercator } from '../geometry.js'
import { linearColor } from '../style.js'
import type { DrawFeature, DrawStyle, LongitudeLatitude } from '../types.js'
import { ShapeBatch } from './ShapeBatch.js'

/** A handle drawn over the map: a vertex, a midpoint, a gizmo knob. */
export interface OverlayHandle {
  position: LongitudeLatitude
  /** Pixels; default: the style's `vertexRadiusPixels`. */
  radiusPixels?: number
  color: string
  outlineColor: string
  outlineWidthPixels: number
  /** Drawn semi-transparent (a midpoint, an inactive knob). */
  faded?: boolean
  /** Height above the WGS84 ellipsoid, in metres. Default: on the terrain. */
  heightMeters?: number
  /** Drawn this many pixels below where its position is on the screen (above when negative). Default: 0. */
  offsetYPixels?: number
  /** With an offset, a line this many pixels wide joins the handle to its position, in `outlineColor`. Default: none. */
  stemWidthPixels?: number
  /**
   * `'circle'` (the default) and `'square'` are filled in `color` with an `outlineColor` ring; `'ring'` is hollow: a
   * circle `outlineWidthPixels` wide in `color`, edged in `outlineColor`.
   */
  shape?: 'circle' | 'square' | 'ring'
}

/** A line drawn over the map in screen pixels: a guide, a gizmo ring. */
export interface OverlayLine {
  positions: LongitudeLatitude[]
  /** Height of each position above the WGS84 ellipsoid, in metres. Default: on the terrain. */
  heightsMeters?: number[]
  color: string
  widthPixels: number
  opacity: number
  /** An arrowhead this many pixels long at the line's last position, pointing along its last piece. Default: none. */
  arrowheadPixels?: number
}

/** A filled convex polygon drawn over the map: a gizmo's plane handle. */
export interface OverlayPolygon {
  positions: LongitudeLatitude[]
  /** Height of each position above the WGS84 ellipsoid, in metres. */
  heightsMeters: number[]
  color: string
  opacity: number
}

/** What the overlay draws this frame. */
export interface OverlayContent {
  features: Array<{ feature: DrawFeature; style: DrawStyle }>
  lines: OverlayLine[]
  handles: OverlayHandle[]
  /** Filled polygons, drawn over the lines and under the handles. Default: none. */
  polygons?: OverlayPolygon[]
}

/** Longest piece a line is cut into on the globe, so it follows the curve of the Earth. */
const SUBDIVISION_METERS = 50_000
const MAXIMUM_SUBDIVISIONS = 64
/** New terrain heights sampled per frame (each is a raycast); the rest wait for the next frames. */
const HEIGHT_SAMPLES_PER_FRAME = 24

/** Pieces of a ring handle's circle. */
const RING_SEGMENTS = 32

const scenePoint = new Vector3()
const ringPoints = new Float64Array((RING_SEGMENTS + 1) * 2)
const viewPoint = new Vector3()
const cameraPosition = new Vector3()

/**
 * Terrain heights of positions, for drawing over the map where the ground is: raycasts are cached by position and
 * limited per frame.
 */
export class HeightSampler {
  protected readonly heights = new Map<string, number>()
  protected samplesLeft = HEIGHT_SAMPLES_PER_FRAME
  /** True when a height was left unsampled this frame: draw again next frame. */
  pending = false

  constructor(protected readonly earth: Earth) {}

  protected key(longitude: number, latitude: number): string {
    return `${longitude.toFixed(7)},${latitude.toFixed(7)}`
  }

  /** Records a height known from elsewhere (the ground under a tap). */
  remember(longitude: number, latitude: number, heightMeters: number): void {
    if (this.heights.size > 4096) this.heights.clear()
    this.heights.set(this.key(longitude, latitude), heightMeters)
  }

  /**
   * The terrain height at a position: the remembered one (sampled before, or a tap's), else sampled now within the
   * per-frame budget, else `fallback` (and `pending` turns true, so the overlay draws again). With `immediate` (for
   * one-off uses, such as the base of a solid being created), it samples the terrain now, as loaded now, whatever the
   * budget and whatever was remembered (a tap's height may come from coarser tiles), falling back to the remembered
   * height, then to `fallback`.
   */
  heightAt(longitude: number, latitude: number, fallback = 0, { immediate = false }: { immediate?: boolean } = {}): number {
    const key = this.key(longitude, latitude)
    const known = this.heights.get(key)
    if (immediate) {
      const height = this.earth.queryTerrainElevation({ longitudeDegrees: longitude, latitudeDegrees: latitude })
      if (height === null) return known ?? fallback
      this.remember(longitude, latitude, height)
      return height
    }
    if (known !== undefined) return known
    if (this.samplesLeft <= 0) {
      this.pending = true
      return fallback
    }
    this.samplesLeft--
    const height = this.earth.queryTerrainElevation({ longitudeDegrees: longitude, latitudeDegrees: latitude })
    // Not loaded yet: try again later rather than remembering sea level.
    if (height === null) {
      this.pending = true
      return fallback
    }
    this.remember(longitude, latitude, height)
    return height
  }

  /** Call once per frame, before sampling. */
  startFrame(): void {
    this.samplesLeft = HEIGHT_SAMPLES_PER_FRAME
    this.pending = false
  }

  /** Forgets every height: the terrain changed. */
  clear(): void {
    this.heights.clear()
  }
}

/**
 * The live layer: what is being drawn or dragged, and handles, drawn over the map in screen pixels every frame the
 * camera or the content changes. Features under the pointer move here without redrawing any draped region; once they
 * settle they go back to `DrapedFeatures`.
 *
 * Positions follow the ground (sampled terrain heights) and the globe-to-map morph (`earth.camera.toScenePosition`);
 * whatever is behind the camera or the globe's horizon is left out.
 */
export class LiveOverlay {
  readonly object = new Group()
  readonly heights: HeightSampler
  protected readonly batch = new ShapeBatch({ flipY: true })
  protected camera: Camera | null = null
  protected widthPixels = 0
  protected heightPixels = 0
  protected onGlobe = true

  constructor(protected readonly earth: Earth) {
    this.heights = new HeightSampler(earth)
    this.object.name = 'DrawOverlay'
    this.object.add(this.batch.mesh)
  }

  /**
   * Redraws `content` for the camera. Returns true when heights are still being sampled (draw again next frame).
   */
  draw(camera: Camera, content: OverlayContent): boolean {
    const batch = this.batch
    batch.clear()
    if (!this.prepare(camera)) {
      batch.upload()
      return false
    }
    this.heights.startFrame()
    for (const { feature, style } of content.features) this.drawFeature(feature, style)
    for (const line of content.lines) {
      const color = linearColor(line.color)
      this.drawLine(line.positions, line.widthPixels, color, line.opacity, line.heightsMeters)
      if (line.arrowheadPixels !== undefined && line.arrowheadPixels > 0) this.drawArrowhead(line, color)
    }
    if (content.polygons !== undefined) for (const polygon of content.polygons) this.drawPolygon(polygon)
    for (const handle of content.handles) this.drawHandle(handle)
    batch.sizePixels.value.set(this.widthPixels, this.heightPixels)
    batch.upload()
    return this.heights.pending
  }

  /**
   * Takes the camera and the viewport for `project`, before `draw`: modes then measure the screen (a gizmo's size) with
   * this frame's camera. Returns false while nothing can be drawn (no viewport, the camera not ready).
   */
  prepare(camera: Camera): boolean {
    const earth = this.earth
    this.widthPixels = earth.camera.viewportWidthPixels
    this.heightPixels = earth.camera.viewportHeightPixels
    if (this.widthPixels <= 0 || this.heightPixels <= 0 || !earth.camera.ready) return false
    camera.updateMatrixWorld()
    this.camera = camera
    this.onGlobe = earth.view.morph < 0.5
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    return true
  }

  /** Screen pixels of a position (written to `target`), or null behind the camera or the horizon. */
  project(longitude: number, latitude: number, heightMeters: number, target: { x: number; y: number }): { x: number; y: number } | null {
    const camera = this.camera
    if (camera === null) return null
    this.earth.camera.toScenePosition({ longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters }, scenePoint)
    if (this.onGlobe && isOccludedByEllipsoid(cameraPosition, scenePoint)) return null
    viewPoint.copy(scenePoint).applyMatrix4(camera.matrixWorldInverse)
    if (viewPoint.z >= 0) return null
    viewPoint.applyMatrix4(camera.projectionMatrix)
    target.x = ((viewPoint.x + 1) / 2) * this.widthPixels
    target.y = ((1 - viewPoint.y) / 2) * this.heightPixels
    return target
  }

  /** How far in front of the camera a position is (its view-space depth, in scene units), or null without a camera. */
  depth(longitude: number, latitude: number, heightMeters: number): number | null {
    const camera = this.camera
    if (camera === null) return null
    this.earth.camera.toScenePosition({ longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters }, scenePoint)
    viewPoint.copy(scenePoint).applyMatrix4(camera.matrixWorldInverse)
    return -viewPoint.z
  }

  protected drawFeature(feature: DrawFeature, style: DrawStyle): void {
    const geometry = feature.geometry
    if (geometry.type === 'Point') {
      const [longitude, latitude] = geometry.coordinates as [number, number]
      const point = this.project(longitude, latitude, this.heights.heightAt(longitude, latitude), { x: 0, y: 0 })
      if (point === null) return
      this.batch.circle(point.x, point.y, style.pointRadiusPixels + style.pointOutlineWidthPixels, linearColor(style.pointOutlineColor), 1)
      this.batch.circle(point.x, point.y, style.pointRadiusPixels, linearColor(style.pointColor), 1)
      return
    }
    const lines = geometryLines(geometry)
    if (style.fillOpacity > 0) for (const rings of geometryPolygons(geometry)) if (rings.length > 0 && rings[0]!.length >= 3) this.drawFill(rings, style)
    if (style.lineOpacity <= 0 || style.lineWidthPixels <= 0) return
    for (const line of lines) this.drawLine(line, style.lineWidthPixels, linearColor(style.lineColor), style.lineOpacity)
  }

  protected drawFill(rings: LongitudeLatitude[][], style: DrawStyle): void {
    const { vertices, indices } = triangulatePolygon(rings)
    const color = linearColor(style.fillColor)
    const reference = rings[0]![0]![0]
    const fallback = this.heights.heightAt(rings[0]![0]![0], rings[0]![0]![1])
    const screen: Array<{ x: number; y: number } | null> = []
    for (let index = 0; index < vertices.length; index += 2) {
      const [longitude, latitude] = fromMercator({ x: vertices[index]!, y: vertices[index + 1]! })
      const unwrapped = unwrapLongitudeNear(longitude, reference)
      screen.push(this.project(unwrapped, latitude, this.heights.heightAt(unwrapped, latitude, fallback), { x: 0, y: 0 }))
    }
    for (let index = 0; index < indices.length; index += 3) {
      const a = screen[indices[index]!]
      const b = screen[indices[index + 1]!]
      const c = screen[indices[index + 2]!]
      if (a == null || b == null || c == null) continue
      this.batch.triangle(a.x, a.y, b.x, b.y, c.x, c.y, color, style.fillOpacity)
    }
  }

  /** A line through positions, cut into pieces that follow the globe; pieces behind the camera or horizon are skipped. */
  protected drawLine(positions: readonly LongitudeLatitude[], widthPixels: number, color: readonly [number, number, number], alpha: number, heightsMeters?: readonly number[]): void {
    if (positions.length < 2 || widthPixels <= 0 || alpha <= 0) return
    const run: number[] = []
    const flush = () => {
      if (run.length >= 4) this.batch.polyline(run, widthPixels, color, alpha)
      run.length = 0
    }
    const point = { x: 0, y: 0 }
    let previousHeight = heightsMeters?.[0] ?? this.heights.heightAt(positions[0]![0], positions[0]![1])
    for (let index = 0; index + 1 < positions.length; index++) {
      const from = positions[index]!
      const to: LongitudeLatitude = [unwrapLongitudeNear(positions[index + 1]![0], from[0]), positions[index + 1]![1]]
      const fromHeight = previousHeight
      const toHeight = heightsMeters?.[index + 1] ?? this.heights.heightAt(to[0], to[1], fromHeight)
      previousHeight = toHeight
      const pieces = this.onGlobe ? Math.min(MAXIMUM_SUBDIVISIONS, Math.max(1, Math.ceil(distanceMeters(from, to) / SUBDIVISION_METERS))) : 1
      for (let piece = index === 0 ? 0 : 1; piece <= pieces; piece++) {
        const t = piece / pieces
        // Straight on the map (Web Mercator), as the draped line is drawn.
        const longitude = from[0] + (to[0] - from[0]) * t
        const latitude = pieces === 1 ? (t === 0 ? from[1] : to[1]) : mercatorLatitudeLerp(from[1], to[1], t)
        const projected = this.project(longitude, latitude, fromHeight + (toHeight - fromHeight) * t, point)
        if (projected === null) {
          flush()
          continue
        }
        run.push(projected.x, projected.y)
      }
    }
    flush()
  }

  /** A triangle at the line's last position, pointing along its last piece on the screen. */
  protected drawArrowhead(line: OverlayLine, color: readonly [number, number, number]): void {
    const count = line.positions.length
    if (count < 2) return
    const tipPosition = line.positions[count - 1]!
    const backPosition = line.positions[count - 2]!
    const tip = this.project(tipPosition[0], tipPosition[1], line.heightsMeters?.[count - 1] ?? this.heights.heightAt(tipPosition[0], tipPosition[1]), { x: 0, y: 0 })
    const back = this.project(backPosition[0], backPosition[1], line.heightsMeters?.[count - 2] ?? this.heights.heightAt(backPosition[0], backPosition[1]), { x: 0, y: 0 })
    if (tip === null || back === null) return
    const dx = tip.x - back.x
    const dy = tip.y - back.y
    const length = Math.hypot(dx, dy)
    if (length < 1) return
    const along = line.arrowheadPixels! / length
    const half = 0.45 * along
    const baseX = tip.x - dx * along
    const baseY = tip.y - dy * along
    this.batch.triangle(tip.x, tip.y, baseX - dy * half, baseY + dx * half, baseX + dy * half, baseY - dx * half, color, line.opacity)
  }

  /** A convex polygon, filled as a fan on the screen; left out when a corner is hidden. */
  protected drawPolygon(polygon: OverlayPolygon): void {
    const { positions, heightsMeters } = polygon
    if (positions.length < 3 || polygon.opacity <= 0) return
    const color = linearColor(polygon.color)
    const first = this.project(positions[0]![0], positions[0]![1], heightsMeters[0]!, { x: 0, y: 0 })
    const previous = { x: 0, y: 0 }
    const current = { x: 0, y: 0 }
    if (first === null || this.project(positions[1]![0], positions[1]![1], heightsMeters[1]!, previous) === null) return
    for (let index = 2; index < positions.length; index++) {
      if (this.project(positions[index]![0], positions[index]![1], heightsMeters[index]!, current) === null) return
      this.batch.triangle(first.x, first.y, previous.x, previous.y, current.x, current.y, color, polygon.opacity)
      previous.x = current.x
      previous.y = current.y
    }
  }

  protected drawHandle(handle: OverlayHandle): void {
    const [longitude, latitude] = handle.position
    const point = this.project(longitude, latitude, handle.heightMeters ?? this.heights.heightAt(longitude, latitude), { x: 0, y: 0 })
    if (point === null) return
    const radius = handle.radiusPixels ?? 5
    const alpha = handle.faded === true ? 0.6 : 1
    const offset = handle.offsetYPixels ?? 0
    if (offset !== 0) {
      if (handle.stemWidthPixels !== undefined && handle.stemWidthPixels > 0) this.batch.segment(point.x, point.y, point.x, point.y + offset, handle.stemWidthPixels, linearColor(handle.outlineColor), alpha)
      point.y += offset
    }
    if (handle.shape === 'ring') {
      for (let index = 0; index <= RING_SEGMENTS; index++) {
        const angle = (index / RING_SEGMENTS) * Math.PI * 2
        ringPoints[index * 2] = point.x + Math.cos(angle) * radius
        ringPoints[index * 2 + 1] = point.y + Math.sin(angle) * radius
      }
      this.batch.polyline(ringPoints, handle.outlineWidthPixels + 2, linearColor(handle.outlineColor), alpha * 0.6)
      this.batch.polyline(ringPoints, handle.outlineWidthPixels, linearColor(handle.color), alpha)
      return
    }
    if (handle.shape === 'square') {
      this.square(point.x, point.y, radius + handle.outlineWidthPixels, linearColor(handle.outlineColor), alpha)
      this.square(point.x, point.y, radius, linearColor(handle.color), alpha)
      return
    }
    this.batch.circle(point.x, point.y, radius + handle.outlineWidthPixels, linearColor(handle.outlineColor), alpha)
    this.batch.circle(point.x, point.y, radius, linearColor(handle.color), alpha)
  }

  /** A filled square `half` pixels from its middle to each side. */
  protected square(x: number, y: number, half: number, color: readonly [number, number, number], alpha: number): void {
    this.batch.triangle(x - half, y - half, x + half, y - half, x + half, y + half, color, alpha)
    this.batch.triangle(x - half, y - half, x + half, y + half, x - half, y + half, color, alpha)
  }

  dispose(): void {
    this.batch.dispose()
    this.object.removeFromParent()
  }
}

const DEGREES = Math.PI / 180

/** The latitude a fraction of the way between two, straight in Web Mercator. */
export function mercatorLatitudeLerp(from: number, to: number, t: number): number {
  const y = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.06, Math.min(85.06, latitude)) * DEGREES) / 2))
  const value = y(from) + (y(to) - y(from)) * t
  return (2 * Math.atan(Math.exp(value)) - Math.PI / 2) / DEGREES
}
