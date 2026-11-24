import type { DrapedLayerDrawInputs, GeographicBounds } from 'react-three-earth'
import { Scene, type BufferGeometry } from 'three'

import { geometryBounds, geometryLines, geometryPolygons, toMercator, triangulatePolygon, type MercatorCoordinate } from '../geometry.js'
import { linearColor } from '../style.js'
import type { DrawFeature, DrawStyle } from '../types.js'
import { ShapeBatch } from './ShapeBatch.js'

/** A feature ready to drape: its geometry in Web Mercator, triangulated once, and its style. */
interface PreparedFeature {
  feature: DrawFeature
  style: DrawStyle
  /** Normalised Web Mercator bounds: [west, south, east, north]. */
  mercatorBounds: [number, number, number, number]
  /** Lines (a line string, or a polygon's rings) as flat Mercator x, y pairs. */
  lines: Float64Array[]
  /** Polygon fill: flat Mercator x, y pairs and triangle indices. */
  fill: { vertices: number[]; indices: number[] } | null
  point: MercatorCoordinate | null
}

/** The widest a feature reaches past its geometry, in CSS pixels at the region's zoom: half a line, a point and its ring. */
function reachPixels(style: DrawStyle): number {
  return Math.max(style.lineWidthPixels / 2, style.pointRadiusPixels + style.pointOutlineWidthPixels) + 2
}

/**
 * Drapes finished features on the terrain through a draped layer: fills, lines and points, drawn per terrain region
 * with straight edges on the map (as GeoJSON is drawn in Web Mercator). Static, like every draped layer: a feature that
 * changes is redrawn by invalidating its bounds, once, not every frame.
 */
export class DrapedFeatures {
  protected readonly batch = new ShapeBatch({ flipY: false, premultipliedAlpha: true })
  protected readonly scene = new Scene()
  /**
   * Geometries of earlier regions, disposed a few frames later. Every region gets its own vertex buffers: regions drawn
   * in the same frame must not share them, or the GPU draws them all with the last region's vertices.
   */
  protected readonly retired: Array<{ geometry: BufferGeometry; frame: number }> = []
  protected frame = 0
  protected prepared = new Map<string, PreparedFeature>()

  constructor() {
    this.scene.add(this.batch.mesh)
  }

  /** Call once per frame (the plugin's `onUpdate`): disposes the vertex buffers of regions drawn two frames ago. */
  startFrame(): void {
    this.frame++
    while (this.retired.length > 0 && this.retired[0]!.frame < this.frame - 2) this.retired.shift()!.geometry.dispose()
  }

  /** Replaces the features to drape. Unchanged features (same object, same style) keep their triangulation. */
  setFeatures(features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    const next = new Map<string, PreparedFeature>()
    for (const { feature, style } of features) {
      const previous = this.prepared.get(feature.id)
      next.set(feature.id, previous !== undefined && previous.feature === feature ? { ...previous, style } : prepare(feature, style))
    }
    this.prepared = next
  }

  /** Where the features are, for the layer's `bounds`: null with none. */
  bounds(): GeographicBounds | null {
    let bounds: GeographicBounds | null = null
    for (const { feature } of this.prepared.values()) {
      const own = geometryBounds(feature.geometry)
      bounds =
        bounds === null
          ? own
          : {
              westDegrees: Math.min(bounds.westDegrees, own.westDegrees),
              southDegrees: Math.min(bounds.southDegrees, own.southDegrees),
              eastDegrees: Math.max(bounds.eastDegrees, own.eastDegrees),
              northDegrees: Math.max(bounds.northDegrees, own.northDegrees),
            }
    }
    return bounds
  }

  /** Draws the features crossing one region into its target. */
  draw({ renderer, region }: DrapedLayerDrawInputs): void {
    const [west, south, east, north] = region.mercatorRange
    const width = east - west
    const height = north - south
    const resolution = region.resolutionPixels
    // Texels per CSS pixel of the map at the region's zoom (the world is 512 × 2^zoom pixels wide).
    const texelsPerPixel = resolution / (512 * 2 ** region.zoom * width)
    const batch = this.batch
    batch.clear()
    for (const prepared of this.prepared.values()) {
      const reach = (reachPixels(prepared.style) * texelsPerPixel * width) / resolution
      const [featureWest, featureSouth, featureEast, featureNorth] = prepared.mercatorBounds
      if (featureSouth - reach > north || featureNorth + reach < south) continue
      // The copy of the world (whole turns in x) that falls on the region, if any.
      const shift = Math.round((west + east) / 2 - (featureWest + featureEast) / 2)
      if (featureWest + shift - reach > east || featureEast + shift + reach < west) continue
      const toX = (x: number) => ((x + shift - west) / width) * resolution
      const toY = (y: number) => ((y - south) / height) * resolution
      drawPrepared(batch, prepared, toX, toY, texelsPerPixel)
    }
    if (batch.empty) return
    batch.sizePixels.value.set(resolution, resolution)
    const previous = batch.upload({ fresh: true })
    if (previous !== null) this.retired.push({ geometry: previous, frame: this.frame })
    renderer.render(this.scene, region.camera)
  }

  dispose(): void {
    for (const { geometry } of this.retired) geometry.dispose()
    this.retired.length = 0
    this.batch.dispose()
  }
}

function prepare(feature: DrawFeature, style: DrawStyle): PreparedFeature {
  const geometry = feature.geometry
  const lines = geometryLines(geometry).map(line => {
    const flat = new Float64Array(line.length * 2)
    line.forEach((position, index) => {
      const { x, y } = toMercator(position)
      flat[index * 2] = x
      flat[index * 2 + 1] = y
    })
    return flat
  })
  const fill = triangulateFill(geometry)
  const point = geometry.type === 'Point' ? toMercator(geometry.coordinates) : null
  const mercatorBounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  const extend = (x: number, y: number) => {
    mercatorBounds[0] = Math.min(mercatorBounds[0], x)
    mercatorBounds[1] = Math.min(mercatorBounds[1], y)
    mercatorBounds[2] = Math.max(mercatorBounds[2], x)
    mercatorBounds[3] = Math.max(mercatorBounds[3], y)
  }
  for (const line of lines) for (let index = 0; index < line.length; index += 2) extend(line[index]!, line[index + 1]!)
  if (point !== null) extend(point.x, point.y)
  return { feature, style, mercatorBounds, lines, fill, point }
}

/** The triangles of a polygon's or multipolygon's fill, in one list; null for points and lines. */
function triangulateFill(geometry: DrawFeature['geometry']): { vertices: number[]; indices: number[] } | null {
  const polygons = geometryPolygons(geometry).filter(rings => rings.length > 0)
  if (polygons.length === 0) return null
  if (polygons.length === 1) return triangulatePolygon(polygons[0]!)
  const vertices: number[] = []
  const indices: number[] = []
  for (const rings of polygons) {
    const part = triangulatePolygon(rings)
    const offset = vertices.length / 2
    for (const value of part.vertices) vertices.push(value)
    for (const index of part.indices) indices.push(index + offset)
  }
  return { vertices, indices }
}

function drawPrepared(batch: ShapeBatch, { style, lines, fill, point }: PreparedFeature, toX: (x: number) => number, toY: (y: number) => number, texelsPerPixel: number): void {
  if (fill !== null && style.fillOpacity > 0) {
    const color = linearColor(style.fillColor)
    const { vertices, indices } = fill
    for (let index = 0; index < indices.length; index += 3) {
      const a = indices[index]! * 2
      const b = indices[index + 1]! * 2
      const c = indices[index + 2]! * 2
      batch.triangle(toX(vertices[a]!), toY(vertices[a + 1]!), toX(vertices[b]!), toY(vertices[b + 1]!), toX(vertices[c]!), toY(vertices[c + 1]!), color, style.fillOpacity)
    }
  }
  if (lines.length > 0 && style.lineOpacity > 0 && style.lineWidthPixels > 0) {
    const color = linearColor(style.lineColor)
    for (const line of lines) {
      const pixels = new Float64Array(line.length)
      for (let index = 0; index < line.length; index += 2) {
        pixels[index] = toX(line[index]!)
        pixels[index + 1] = toY(line[index + 1]!)
      }
      batch.polyline(pixels, style.lineWidthPixels * texelsPerPixel, color, style.lineOpacity)
    }
  }
  if (point !== null) {
    const x = toX(point.x)
    const y = toY(point.y)
    batch.circle(x, y, (style.pointRadiusPixels + style.pointOutlineWidthPixels) * texelsPerPixel, linearColor(style.pointOutlineColor), 1)
    batch.circle(x, y, style.pointRadiusPixels * texelsPerPixel, linearColor(style.pointColor), 1)
  }
}
