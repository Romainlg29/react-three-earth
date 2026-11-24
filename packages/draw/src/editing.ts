import type { Position } from 'geojson'

import { distanceMeters, distanceToSegment, pointInPolygon, unwrapLongitudeNear } from './geometry.js'
import { bearingDegrees, destination, extrusionHeightOf, shapeOf, type ShapeDescription } from './shapes.js'
import type { DrawFeature, LongitudeLatitude } from './types.js'

/**
 * Where a vertex sits in a feature's coordinates: the ring of a polygon (0 for the exterior, 1… for holes) and the index
 * in it. Line strings and points use ring 0.
 */
export interface VertexPath {
  ring: number
  index: number
}

/** A vertex of a feature, without the closing position of polygon rings. */
export interface FeatureVertex {
  path: VertexPath
  position: Position
}

/** The middle of an edge: dragging or tapping it inserts a vertex at `path`. */
export interface FeatureMidpoint {
  /** Where the new vertex goes (after the edge's first vertex). */
  path: VertexPath
  position: LongitudeLatitude
}

/** Fewest vertices of a line string, and of a polygon ring (without the closing position). */
const MINIMUM_LINE_VERTICES = 2
const MINIMUM_RING_VERTICES = 3

/** The rings of a feature as open vertex lists: a polygon's rings without their closing position, a line, a point. */
function openRings(feature: DrawFeature): Position[][] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [[geometry.coordinates]]
  if (geometry.type === 'LineString') return [geometry.coordinates]
  return geometry.coordinates.map(ring => (ring.length > 1 && samePosition(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring))
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** A feature with new open rings: closes polygon rings again. Keeps the id and properties. */
function withRings(feature: DrawFeature, rings: Position[][]): DrawFeature {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return { ...feature, geometry: { type: 'Point', coordinates: rings[0]![0]! } }
  if (geometry.type === 'LineString') return { ...feature, geometry: { type: 'LineString', coordinates: rings[0]! } }
  return { ...feature, geometry: { type: 'Polygon', coordinates: rings.map(ring => [...ring, [...ring[0]!]]) } }
}

/** Properties without `shape`: a shape whose outline was edited is no longer that shape. */
function withoutShape(feature: DrawFeature): DrawFeature {
  if (shapeOf(feature) === null) return feature
  const { shape: _shape, ...properties } = feature.properties ?? {}
  return { ...feature, properties }
}

/**
 * A position moved to `to`, keeping its altitude (third coordinate) when it has one. The longitude is unwrapped near the
 * original's, so a feature over the antimeridian keeps continuous longitudes (taps come wrapped to ±180°).
 */
function moved(original: Position, to: LongitudeLatitude): Position {
  const longitude = unwrapLongitudeNear(to[0], original[0]!)
  return original.length > 2 ? [longitude, to[1], original[2]!] : [longitude, to[1]]
}

/** The vertices of a feature, in order, without the closing positions of polygon rings. */
export function featureVertices(feature: DrawFeature): FeatureVertex[] {
  const vertices: FeatureVertex[] = []
  openRings(feature).forEach((ring, ringIndex) => ring.forEach((position, index) => vertices.push({ path: { ring: ringIndex, index }, position })))
  return vertices
}

/** The middles of a line string's or polygon's edges (none for points). */
export function featureMidpoints(feature: DrawFeature): FeatureMidpoint[] {
  if (feature.geometry.type === 'Point') return []
  const closed = feature.geometry.type === 'Polygon'
  const midpoints: FeatureMidpoint[] = []
  openRings(feature).forEach((ring, ringIndex) => {
    const edges = closed ? ring.length : ring.length - 1
    for (let index = 0; index < edges; index++) {
      const from = ring[index]!
      const to = ring[(index + 1) % ring.length]!
      const toLongitude = unwrapLongitudeNear(to[0]!, from[0]!)
      midpoints.push({ path: { ring: ringIndex, index: index + 1 }, position: [(from[0]! + toLongitude) / 2, (from[1]! + to[1]!) / 2] })
    }
  })
  return midpoints
}

/** The feature with the vertex at `path` moved to `position` (its altitude kept). A shape loses `properties.shape`. */
export function moveVertex(feature: DrawFeature, path: VertexPath, position: LongitudeLatitude): DrawFeature {
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  const original = ring?.[path.index]
  if (ring === undefined || original === undefined) return feature
  ring[path.index] = moved(original, position)
  return withoutShape(withRings(feature, rings))
}

/** The feature with a vertex inserted at `path` (pushing the others along). Its altitude is its neighbours' average. */
export function insertVertex(feature: DrawFeature, path: VertexPath, position: LongitudeLatitude): DrawFeature {
  if (feature.geometry.type === 'Point') return feature
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  if (ring === undefined || path.index < 0 || path.index > ring.length) return feature
  const before = ring[path.index - 1] ?? ring[ring.length - 1]!
  const after = ring[path.index] ?? ring[0]!
  const longitude = unwrapLongitudeNear(position[0], before[0]!)
  const vertex: Position = before.length > 2 && after.length > 2 ? [longitude, position[1], (before[2]! + after[2]!) / 2] : [longitude, position[1]]
  ring.splice(path.index, 0, vertex)
  return withoutShape(withRings(feature, rings))
}

/**
 * The feature without the vertex at `path`, or null when that would leave too few (a line needs 2 vertices, a polygon
 * ring 3; points cannot lose theirs).
 */
export function removeVertex(feature: DrawFeature, path: VertexPath): DrawFeature | null {
  if (feature.geometry.type === 'Point') return null
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  if (ring === undefined || ring[path.index] === undefined) return null
  if (ring.length <= (feature.geometry.type === 'Polygon' ? MINIMUM_RING_VERTICES : MINIMUM_LINE_VERTICES)) return null
  ring.splice(path.index, 1)
  return withoutShape(withRings(feature, rings))
}

/**
 * The feature moved as a whole from `from` to `to`: every position keeps its distance and bearing from the pointer, so
 * shapes keep their size in metres wherever they go. Altitudes are kept; a shape's center moves with it.
 */
export function translateFeature(feature: DrawFeature, from: LongitudeLatitude, to: LongitudeLatitude): DrawFeature {
  const move = (position: Position): Position => moved(position, destination(to, distanceMeters(from, position), bearingDegrees(from, position)))
  const rings = openRings(feature).map(ring => ring.map(move))
  const result = withRings(feature, rings)
  const shape = shapeOf(feature)
  if (shape === null) return result
  const center = move(shape.center)
  const movedShape: ShapeDescription = { ...shape, center: [center[0]!, center[1]!] }
  return { ...result, properties: { ...result.properties, shape: movedShape } }
}

/** How a mode measures a tap against features: screen positions of geographic ones, and the tap. */
export interface HitTestInput {
  /** The tap on the ground. */
  ground: LongitudeLatitude
  /** The tap in screen pixels. */
  screen: { x: number; y: number }
  /** How far from a point or line a tap still hits it, in pixels. */
  tolerancePixels: number
  /**
   * Screen pixels of a position `aboveMeters` over its altitude (its third coordinate) or, without one, over the
   * terrain; null when it is hidden.
   */
  project(position: Position, aboveMeters?: number): { x: number; y: number } | null
}

type ScreenPoint = { x: number; y: number }

/** Whether a screen point lies inside a screen polygon (even-odd). */
function insideScreenRing(point: ScreenPoint, ring: readonly ScreenPoint[]): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!
    const b = ring[previous]!
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function hasAltitudes(positions: readonly Position[]): boolean {
  return positions.some(position => position.length > 2 && Number.isFinite(position[2]))
}

/**
 * Whether a tap hits a feature where it is drawn: within the tolerance of a point or a line (in pixels), inside a
 * draped polygon's outline on the ground, inside the faces of a solid (its top, bottom and walls on the screen, at
 * their altitudes), or inside a sphere's outline on the screen. Returns the distance in pixels (0 inside), or null.
 */
export function hitFeature(feature: DrawFeature, input: HitTestInput): number | null {
  const geometry = feature.geometry
  const extrusion = extrusionHeightOf(feature)
  if (geometry.type === 'Point') {
    const shape = shapeOf(feature)
    if (shape?.type === 'sphere') {
      // Resting on the terrain, or centered on its altitude.
      const above = hasAltitudes([geometry.coordinates]) ? 0 : shape.radiusMeters
      const center = input.project(geometry.coordinates, above)
      const top = input.project(geometry.coordinates, above + shape.radiusMeters)
      if (center === null) return null
      const radiusPixels = top === null ? 0 : Math.hypot(top.x - center.x, top.y - center.y)
      const distance = Math.hypot(center.x - input.screen.x, center.y - input.screen.y)
      if (distance <= radiusPixels) return 0
      return distance - radiusPixels <= input.tolerancePixels ? distance - radiusPixels : null
    }
    const screen = input.project(geometry.coordinates)
    if (screen === null) return null
    const distance = Math.hypot(screen.x - input.screen.x, screen.y - input.screen.y)
    return distance <= input.tolerancePixels ? distance : null
  }
  const lines = geometry.type === 'Polygon' ? geometry.coordinates : [geometry.coordinates]
  const solid = extrusion > 0 || lines.some(hasAltitudes)
  if (geometry.type === 'Polygon' && !solid) {
    const rings = geometry.coordinates.map(ring => ring.map(position => [position[0]!, position[1]!] as LongitudeLatitude))
    if (pointInPolygon(input.ground, rings)) return 0
  }
  if (solid) {
    for (const line of lines) {
      const bottom = line.map(position => input.project(position))
      const top = extrusion > 0 ? line.map(position => input.project(position, extrusion)) : bottom
      // A polygon's top and bottom faces.
      if (geometry.type === 'Polygon') {
        for (const face of [bottom, top]) if (face.every(point => point !== null) && insideScreenRing(input.screen, face as ScreenPoint[])) return 0
      }
      // Walls.
      if (extrusion > 0) {
        for (let index = 0; index + 1 < line.length; index++) {
          const quad = [bottom[index], bottom[index + 1], top[index + 1], top[index]]
          if (quad.every(point => point !== null && point !== undefined) && insideScreenRing(input.screen, quad as ScreenPoint[])) return 0
        }
      }
    }
  }
  // Lines, and outlines tapped from just outside, where they are drawn.
  let closest = Infinity
  for (const line of lines) {
    let previous = input.project(line[0]!)
    for (let index = 1; index < line.length; index++) {
      const current = input.project(line[index]!)
      if (previous !== null && current !== null) closest = Math.min(closest, distanceToSegment(input.screen.x, input.screen.y, previous.x, previous.y, current.x, current.y))
      previous = current
    }
  }
  return closest <= input.tolerancePixels ? closest : null
}
