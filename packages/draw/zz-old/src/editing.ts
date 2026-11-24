import type { Position } from 'geojson'

import { distanceMeters, distanceToSegment, hasAltitude, mapGeometryPositions, pointInPolygon, unwrapLongitudeNear } from './geometry.js'
import { bearingDegrees, destination } from './shapes.js'
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
  /** The middle's altitude above the WGS84 ellipsoid, when both ends of the edge have one (where an inserted vertex goes). */
  heightMeters?: number
}

/** Fewest vertices of a line string, and of a polygon ring (without the closing position). */
const MINIMUM_LINE_VERTICES = 2
const MINIMUM_RING_VERTICES = 3

/**
 * The rings of a feature as open vertex lists: a polygon's rings without their closing position, a line, a point. None
 * for multipolygons (meshes): their vertices are shared between faces, which these helpers do not edit.
 */
function openRings(feature: DrawFeature): Position[][] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [[geometry.coordinates]]
  if (geometry.type === 'LineString') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return []
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
  if (geometry.type === 'MultiPolygon') return feature
  return { ...feature, geometry: { type: 'Polygon', coordinates: rings.map(ring => [...ring, [...ring[0]!]]) } }
}

/**
 * A position moved to `to`, keeping its altitude (third coordinate) when it has one. The longitude is unwrapped near the
 * original's, so a feature over the antimeridian keeps continuous longitudes (taps come wrapped to ±180°).
 */
function moved(original: Position, to: LongitudeLatitude): Position {
  const longitude = unwrapLongitudeNear(to[0], original[0]!)
  return original.length > 2 ? [longitude, to[1], original[2]!] : [longitude, to[1]]
}

/** The vertices of a feature, in order, without the closing positions of polygon rings. None for multipolygons (meshes). */
export function featureVertices(feature: DrawFeature): FeatureVertex[] {
  const vertices: FeatureVertex[] = []
  openRings(feature).forEach((ring, ringIndex) => ring.forEach((position, index) => vertices.push({ path: { ring: ringIndex, index }, position })))
  return vertices
}

/** The middles of a line string's or polygon's edges (none for points and multipolygons). */
export function featureMidpoints(feature: DrawFeature): FeatureMidpoint[] {
  if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPolygon') return []
  const closed = feature.geometry.type === 'Polygon'
  const midpoints: FeatureMidpoint[] = []
  openRings(feature).forEach((ring, ringIndex) => {
    const edges = closed ? ring.length : ring.length - 1
    for (let index = 0; index < edges; index++) {
      const from = ring[index]!
      const to = ring[(index + 1) % ring.length]!
      const toLongitude = unwrapLongitudeNear(to[0]!, from[0]!)
      const midpoint: FeatureMidpoint = { path: { ring: ringIndex, index: index + 1 }, position: [(from[0]! + toLongitude) / 2, (from[1]! + to[1]!) / 2] }
      if (from.length > 2 && to.length > 2 && Number.isFinite(from[2]) && Number.isFinite(to[2])) midpoint.heightMeters = (from[2]! + to[2]!) / 2
      midpoints.push(midpoint)
    }
  })
  return midpoints
}

/** The feature with the vertex at `path` moved to `position` (its altitude kept). Multipolygons are returned unchanged. */
export function moveVertex(feature: DrawFeature, path: VertexPath, position: LongitudeLatitude): DrawFeature {
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  const original = ring?.[path.index]
  if (ring === undefined || original === undefined) return feature
  ring[path.index] = moved(original, position)
  return withRings(feature, rings)
}

/** The feature with a vertex inserted at `path` (pushing the others along). Its altitude is its neighbours' average. */
export function insertVertex(feature: DrawFeature, path: VertexPath, position: LongitudeLatitude): DrawFeature {
  if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPolygon') return feature
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  if (ring === undefined || path.index < 0 || path.index > ring.length) return feature
  const before = ring[path.index - 1] ?? ring[ring.length - 1]!
  const after = ring[path.index] ?? ring[0]!
  const longitude = unwrapLongitudeNear(position[0], before[0]!)
  const vertex: Position = before.length > 2 && after.length > 2 ? [longitude, position[1], (before[2]! + after[2]!) / 2] : [longitude, position[1]]
  ring.splice(path.index, 0, vertex)
  return withRings(feature, rings)
}

/**
 * The feature without the vertex at `path`, or null when that would leave too few (a line needs 2 vertices, a polygon
 * ring 3; points cannot lose theirs).
 */
export function removeVertex(feature: DrawFeature, path: VertexPath): DrawFeature | null {
  if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPolygon') return null
  const rings = openRings(feature).map(ring => [...ring])
  const ring = rings[path.ring]
  if (ring === undefined || ring[path.index] === undefined) return null
  if (ring.length <= (feature.geometry.type === 'Polygon' ? MINIMUM_RING_VERTICES : MINIMUM_LINE_VERTICES)) return null
  ring.splice(path.index, 1)
  return withRings(feature, rings)
}

/**
 * The feature moved as a whole from `from` to `to`: every position keeps its distance and bearing from the pointer, so
 * shapes keep their size in metres wherever they go. Altitudes are kept.
 */
export function translateFeature(feature: DrawFeature, from: LongitudeLatitude, to: LongitudeLatitude): DrawFeature {
  return { ...feature, geometry: mapGeometryPositions(feature.geometry, position => moved(position, destination(to, distanceMeters(from, position), bearingDegrees(from, position)))) }
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
  return positions.some(hasAltitude)
}

/**
 * Whether a tap is inside a face (its rings drawn at their altitudes, or on the terrain where they have none): inside
 * its exterior and outside its holes. False when part of it is hidden.
 */
function insideFace(rings: readonly Position[][], input: HitTestInput): boolean {
  for (const [ringIndex, ring] of rings.entries()) {
    const screen: ScreenPoint[] = []
    for (const position of ring) {
      const point = input.project(position)
      if (point === null) return false
      screen.push(point)
    }
    const inside = insideScreenRing(input.screen, screen)
    if (ringIndex === 0 ? !inside : inside) return false
  }
  return rings.length > 0
}

/**
 * Whether a tap hits a feature where it is drawn: within the tolerance of a point or a line (in pixels), inside a
 * draped polygon's outline on the ground, inside a face of a mesh or of a polygon at an altitude (on the screen, at the
 * altitudes of its vertices), or within the tolerance of their edges. Returns the distance in pixels (0 inside), or null.
 */
export function hitFeature(feature: DrawFeature, input: HitTestInput): number | null {
  const geometry = feature.geometry
  if (geometry.type === 'Point') {
    const screen = input.project(geometry.coordinates)
    if (screen === null) return null
    const distance = Math.hypot(screen.x - input.screen.x, screen.y - input.screen.y)
    return distance <= input.tolerancePixels ? distance : null
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : []
  for (const rings of polygons) {
    if (rings.some(hasAltitudes)) {
      // A face in the air (a mesh's, a polygon's at an altitude): where it is drawn.
      if (insideFace(rings, input)) return 0
    } else if (pointInPolygon(input.ground, rings.map(ring => ring.map(position => [position[0]!, position[1]!] as LongitudeLatitude)))) return 0
  }
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : polygons.flat()
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
