import earcut from 'earcut'
import type { Position } from 'geojson'
import { createFlatMapEmissionNode, type Earth, type GeographicAnchor } from 'react-three-earth'
import { BufferGeometry, Color, DoubleSide, EdgesGeometry, Float32BufferAttribute, FrontSide, Group, Line, LineSegments, Mesh, SphereGeometry, type Object3D } from 'three'
import { uniform, vec4 } from 'three/tsl'
import { LineBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'

import { distanceMeters, unwrapLongitudeNear } from '../geometry.js'
import { extrusionHeightOf, shapeOf } from '../shapes.js'
import type { DrawFeature, DrawStyle } from '../types.js'

const DEGREES = Math.PI / 180
const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137
const WGS84_FLATTENING = 1 / 298.257223563
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING)
/** Edges longer than this are split, and faces wider than this get inner vertices, so solids follow the curve of the Earth. */
const MAXIMUM_EDGE_METERS = 2000
/** At most this many vertices per ring after splitting edges. */
const MAXIMUM_RING_VERTICES = 2048
/** About this many triangles at most per face: wider faces get longer triangles. */
const MAXIMUM_FACE_TRIANGLES = 4096
/** Milliseconds between two terrain height lookups of one solid standing on the ground. */
const GROUND_CHECK_INTERVAL_MILLISECONDS = 500
/** Terrain height lookups per frame, for all the solids together: each raycasts the loaded tiles. */
const GROUND_LOOKUPS_PER_FRAME = 4
/** Checks keep running, with follow-up frames, this long after the last height change (tiles still refining). */
const GROUND_SETTLE_MILLISECONDS = 3000
/** Edges between faces meeting at more than this angle are outlined (so a cylinder's wall shows no seams). */
const EDGE_THRESHOLD_DEGREES = 30

/**
 * Whether a feature is drawn as a 3D solid rather than draped on the terrain: an extruded polygon or line string
 * (`properties.extrusionHeightMeters`), a sphere (`properties.shape.type === 'sphere'`), or a polygon or line string
 * with altitudes (a third coordinate) on its positions.
 */
export function isSolidFeature(feature: DrawFeature): boolean {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return shapeOf(feature)?.type === 'sphere'
  if (extrusionHeightOf(feature) > 0) return true
  const lines = geometry.type === 'Polygon' ? geometry.coordinates : [geometry.coordinates]
  return lines.some(line => line.some(position => position.length > 2 && Number.isFinite(position[2])))
}

/** The solids of one feature: their anchor and what it holds. */
interface Solid {
  feature: DrawFeature
  style: DrawStyle
  anchor: GeographicAnchor
  /** The geometries to dispose with it. */
  owned: Array<{ dispose(): void }>
  /** The shared materials it uses (`acquireMaterials`), released with it. */
  materialKey: string | null
  /** Stands on the terrain (no altitudes): the anchor follows the terrain's height. */
  onGround: boolean
  longitudeDegrees: number
  latitudeDegrees: number
  /** When the terrain under it was last looked up (performance.now()), or -Infinity before the first lookup. */
  groundCheckedMilliseconds: number
  /** The terrain's height has been found under it at least once. */
  groundFound: boolean
}

/** Materials shared by the solids of one style. */
interface SharedMaterials {
  key: string
  material: MeshStandardNodeMaterial
  edgeMaterial: LineBasicNodeMaterial
  users: number
}

/** A point in a local east-north-up frame, in metres. */
type LocalPoint = [east: number, north: number, up: number]

/**
 * Converts positions to the east-north-up frame of an origin (x east, y north, z up, metres), on the WGS84 ellipsoid:
 * the frame of a `GeographicAnchor` at that origin. Exact on the globe. On the flat map the anchor keeps this curved
geometry, so solids hundreds of kilometres wide droop at their edges there.
 */
export class LocalFrame {
  protected readonly origin: [number, number, number]
  protected readonly east: [number, number, number]
  protected readonly north: [number, number, number]
  protected readonly up: [number, number, number]
  readonly longitudeDegrees: number

  constructor(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number) {
    this.longitudeDegrees = longitudeDegrees
    const longitude = longitudeDegrees * DEGREES
    const latitude = latitudeDegrees * DEGREES
    this.origin = earthCentered(longitude, latitude, heightMeters)
    const sinLongitude = Math.sin(longitude)
    const cosLongitude = Math.cos(longitude)
    const sinLatitude = Math.sin(latitude)
    const cosLatitude = Math.cos(latitude)
    this.east = [-sinLongitude, cosLongitude, 0]
    this.north = [-sinLatitude * cosLongitude, -sinLatitude * sinLongitude, cosLatitude]
    this.up = [cosLatitude * cosLongitude, cosLatitude * sinLongitude, sinLatitude]
  }

  toLocal(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number): LocalPoint {
    const longitude = unwrapLongitudeNear(longitudeDegrees, this.longitudeDegrees) * DEGREES
    const point = earthCentered(longitude, latitudeDegrees * DEGREES, heightMeters)
    const dx = point[0] - this.origin[0]
    const dy = point[1] - this.origin[1]
    const dz = point[2] - this.origin[2]
    const { east, north, up } = this
    return [dx * east[0] + dy * east[1] + dz * east[2], dx * north[0] + dy * north[1] + dz * north[2], dx * up[0] + dy * up[1] + dz * up[2]]
  }
}

function earthCentered(longitude: number, latitude: number, heightMeters: number): [number, number, number] {
  const sinLatitude = Math.sin(latitude)
  const radius = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  const cosLatitude = Math.cos(latitude)
  return [(radius + heightMeters) * cosLatitude * Math.cos(longitude), (radius + heightMeters) * cosLatitude * Math.sin(longitude), (radius * (1 - WGS84_ECCENTRICITY_SQUARED) + heightMeters) * sinLatitude]
}

/** A ring or line with its long edges split, longitudes unwrapped near `referenceLongitude`, each with its height. */
function densify(positions: readonly Position[], referenceLongitude: number, heightOf: (position: Position) => number): Array<[number, number, number]> {
  const result: Array<[number, number, number]> = []
  let previous: [number, number, number] | null = null
  const budget = Math.max(1, Math.floor(MAXIMUM_RING_VERTICES / Math.max(1, positions.length)))
  for (const position of positions) {
    // Near the previous position, so an edge is never split the long way round (a ring around a pole keeps going east).
    const current: [number, number, number] = [unwrapLongitudeNear(position[0]!, previous?.[0] ?? referenceLongitude), position[1]!, heightOf(position)]
    if (previous !== null) {
      const pieces = Math.min(budget, Math.ceil(distanceMeters(previous, current) / MAXIMUM_EDGE_METERS))
      for (let piece = 1; piece < pieces; piece++) {
        const t = piece / pieces
        result.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t, previous[2] + (current[2] - previous[2]) * t])
      }
    }
    result.push(current)
    previous = current
  }
  return result
}

/** Triangles as a flat list of local points (three per triangle), with face normals. */
class TriangleSoup {
  readonly positions: number[] = []

  triangle(a: LocalPoint, b: LocalPoint, c: LocalPoint): void {
    this.positions.push(...a, ...b, ...c)
  }

  quad(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): void {
    this.triangle(a, b, c)
    this.triangle(a, c, d)
  }

  toGeometry(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3))
    geometry.computeVertexNormals()
    return geometry
  }
}

/** Twice the signed area of a ring in the local frame's east-north plane: positive when counter-clockwise. */
function signedArea(ring: readonly LocalPoint[]): number {
  let area = 0
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area
}

/** What `buildSolidGeometry` returns. */
export interface SolidGeometry {
  /** The faces, or null for a line drawn as a line. */
  faces: BufferGeometry | null
  /** A line string at an altitude and not extruded, or null. */
  line: BufferGeometry | null
  /** True when the faces close a volume, all facing outwards: an extruded polygon. Open faces are seen from both sides. */
  closed: boolean
}

/**
 * The geometry of a polygon or line string solid, in the local frame: faces (a polygon's bottom and top, walls along an
 * extruded outline) and, for a line string with altitudes and no extrusion, the line itself. Faces of an extruded
 * polygon face outwards whatever the winding of its rings, so they can be drawn on one side.
 */
export function buildSolidGeometry(feature: DrawFeature, frame: LocalFrame, baseHeightMeters: (position: Position) => number): SolidGeometry {
  const geometry = feature.geometry
  const extrusion = extrusionHeightOf(feature)
  const reference = frame.longitudeDegrees
  if (geometry.type === 'LineString') {
    const line = densify(geometry.coordinates, reference, baseHeightMeters)
    if (extrusion === 0) {
      const lineGeometry = new BufferGeometry()
      lineGeometry.setAttribute('position', new Float32BufferAttribute(line.flatMap(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)), 3))
      return { faces: null, line: lineGeometry, closed: false }
    }
    const soup = new TriangleSoup()
    for (let index = 0; index + 1 < line.length; index++) wall(soup, frame, line[index]!, line[index + 1]!, extrusion)
    return { faces: soup.toGeometry(), line: null, closed: false }
  }
  if (geometry.type !== 'Polygon') return { faces: null, line: null, closed: false }
  const rings = geometry.coordinates.map((ring, ringIndex) => {
    const dense = densify(ring, reference, baseHeightMeters)
    // Closed rings repeat their first position: earcut and the walls want each vertex once.
    const first = dense[0]
    const last = dense[dense.length - 1]
    if (dense.length > 1 && first !== undefined && last !== undefined && unwrapLongitudeNear(last[0], first[0]) === first[0] && first[1] === last[1]) dense.pop()
    // The exterior counter-clockwise and the holes clockwise, seen from above: then every wall faces outwards.
    const counterClockwise = signedArea(dense.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height))) > 0
    if (counterClockwise !== (ringIndex === 0)) dense.reverse()
    return dense
  })
  const bottom = rings.map(ring => ring.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)))
  const top = extrusion === 0 ? bottom : rings.map(ring => ring.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height + extrusion)))
  const flat: number[] = []
  const holes: number[] = []
  for (const ring of bottom) {
    if (flat.length > 0) holes.push(flat.length / 2)
    for (const [east, north] of ring) flat.push(east, north)
  }
  const bottomPoints = bottom.flat()
  const indices = earcut(flat, holes, 2)
  // Counter-clockwise from above, so the top faces up and the bottom down.
  for (let index = 0; index < indices.length; index += 3) {
    if (signedArea([bottomPoints[indices[index]!]!, bottomPoints[indices[index + 1]!]!, bottomPoints[indices[index + 2]!]!]) < 0) {
      ;[indices[index + 1], indices[index + 2]] = [indices[index + 2]!, indices[index + 1]!]
    }
  }
  // Wide faces are split into small triangles, so they bend with the Earth instead of cutting under it.
  const positions = rings.flat()
  const area = Math.abs(bottom.reduce((sum, ring, ringIndex) => sum + (ringIndex === 0 ? 1 : -1) * Math.abs(signedArea(ring)), 0)) / 2
  const maximumEdgeMeters = Math.max(MAXIMUM_EDGE_METERS, Math.sqrt((2 * area) / MAXIMUM_FACE_TRIANGLES))
  const triangles = refineTriangles(positions, bottomPoints, indices, maximumEdgeMeters, frame)
  const topPoints = extrusion === 0 ? bottomPoints : positions.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height + extrusion))
  const soup = new TriangleSoup()
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index]!
    const b = triangles[index + 1]!
    const c = triangles[index + 2]!
    soup.triangle(topPoints[a]!, topPoints[b]!, topPoints[c]!)
    if (extrusion > 0) soup.triangle(bottomPoints[a]!, bottomPoints[c]!, bottomPoints[b]!)
  }
  if (extrusion > 0) {
    for (const ring of rings) for (let index = 0; index < ring.length; index++) wall(soup, frame, ring[index]!, ring[(index + 1) % ring.length]!, extrusion)
  }
  return { faces: soup.toGeometry(), line: null, closed: extrusion > 0 }
}

/**
 * Splits triangles until no edge is longer than `maximumEdgeMeters`, by conforming longest-edge bisection: an edge is
 * always split in both triangles that share it, so the surface never cracks. New vertices are appended to `positions`
 * (geographic, at the middle of the edge) and `local` (in the frame, on the curve of the Earth). Keeps each triangle's
 * winding. Returns the triangles' vertex indices.
 */
export function refineTriangles(positions: Array<[number, number, number]>, local: LocalPoint[], indices: readonly number[], maximumEdgeMeters: number, frame: LocalFrame): number[] {
  const triangles: Array<[number, number, number] | null> = []
  const edgeTriangles = new Map<string, number[]>()
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  const lengthSquared = (a: number, b: number) => (local[a]![0] - local[b]![0]) ** 2 + (local[a]![1] - local[b]![1]) ** 2
  const limit = maximumEdgeMeters * maximumEdgeMeters
  const add = (triangle: [number, number, number]) => {
    const id = triangles.push(triangle) - 1
    for (let corner = 0; corner < 3; corner++) {
      const edge = key(triangle[corner]!, triangle[(corner + 1) % 3]!)
      const list = edgeTriangles.get(edge)
      if (list === undefined) edgeTriangles.set(edge, [id])
      else list.push(id)
    }
    return id
  }
  const remove = (id: number) => {
    const triangle = triangles[id]!
    triangles[id] = null
    for (let corner = 0; corner < 3; corner++) {
      const edge = key(triangle[corner]!, triangle[(corner + 1) % 3]!)
      const list = edgeTriangles.get(edge)!
      list.splice(list.indexOf(id), 1)
      if (list.length === 0) edgeTriangles.delete(edge)
    }
  }
  // The longest edge, as the corner it starts from; ties go to the smaller key, so every triangle agrees on one order.
  const longest = (triangle: [number, number, number]): { corner: number; length: number; edge: string } => {
    let best = { corner: 0, length: -1, edge: '' }
    for (let corner = 0; corner < 3; corner++) {
      const a = triangle[corner]!
      const b = triangle[(corner + 1) % 3]!
      const length = lengthSquared(a, b)
      const edge = key(a, b)
      if (length > best.length || (length === best.length && edge < best.edge)) best = { corner, length, edge }
    }
    return best
  }
  const work: number[] = []
  for (let index = 0; index + 2 < indices.length; index += 3) work.push(add([indices[index]!, indices[index + 1]!, indices[index + 2]!]))
  const split = (edge: string, a: number, b: number) => {
    const [from, to] = [positions[a]!, positions[b]!]
    const middle: [number, number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2]
    const vertex = positions.push(middle) - 1
    local.push(frame.toLocal(...middle))
    for (const id of [...(edgeTriangles.get(edge) ?? [])]) {
      const triangle = triangles[id]!
      // Turned so the split edge runs from corner 0 to corner 1: (p, q, r) becomes (p, m, r) and (m, q, r).
      const corner = triangle.findIndex((vertexIndex, index) => key(vertexIndex, triangle[(index + 1) % 3]!) === edge)
      const p = triangle[corner]!
      const q = triangle[(corner + 1) % 3]!
      const r = triangle[(corner + 2) % 3]!
      remove(id)
      work.push(add([p, vertex, r]), add([vertex, q, r]))
    }
  }
  while (work.length > 0) {
    const path = [work.pop()!]
    while (path.length > 0) {
      const id = path[path.length - 1]!
      const triangle = triangles[id]
      if (triangle === null || triangle === undefined) {
        path.pop()
        continue
      }
      const edge = longest(triangle)
      if (edge.length <= limit) {
        path.pop()
        continue
      }
      // The neighbour across the longest edge must share it as its own longest edge, or be refined first.
      const neighbour = edgeTriangles.get(edge.edge)!.find(other => other !== id)
      if (neighbour !== undefined && longest(triangles[neighbour]!).edge !== edge.edge) {
        path.push(neighbour)
        continue
      }
      split(edge.edge, triangle[edge.corner]!, triangle[(edge.corner + 1) % 3]!)
      path.pop()
    }
  }
  const result: number[] = []
  for (const triangle of triangles) if (triangle !== null) result.push(...triangle)
  return result
}

function wall(soup: TriangleSoup, frame: LocalFrame, from: [number, number, number], to: [number, number, number], extrusion: number): void {
  const a = frame.toLocal(from[0], from[1], from[2])
  const b = frame.toLocal(to[0], to[1], to[2])
  soup.quad(a, b, frame.toLocal(to[0], to[1], to[2] + extrusion), frame.toLocal(from[0], from[1], from[2] + extrusion))
}

/** The longitude and latitude a feature's anchor stands at: the middle of its extent. */
function anchorPosition(feature: DrawFeature): [number, number] {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [geometry.coordinates[0]!, geometry.coordinates[1]!]
  const positions = geometry.type === 'Polygon' ? (geometry.coordinates[0] ?? []) : geometry.coordinates
  const reference = positions[0]?.[0] ?? 0
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const position of positions) {
    const longitude = unwrapLongitudeNear(position[0]!, reference)
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
    south = Math.min(south, position[1]!)
    north = Math.max(north, position[1]!)
  }
  return [(west + east) / 2, (south + north) / 2]
}

/** The first altitude among a feature's positions, or null when it has none. */
function firstAltitude(feature: DrawFeature): number | null {
  const geometry = feature.geometry
  const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates.flat()
  for (const position of positions) if (position.length > 2 && Number.isFinite(position[2])) return position[2]!
  return null
}

function sameSolidStyle(a: DrawStyle, b: DrawStyle): boolean {
  return a.fillColor === b.fillColor && a.solidOpacity === b.solidOpacity && a.lineColor === b.lineColor && a.lineOpacity === b.lineOpacity
}

/**
 * Draws 3D features as solids in the scene: extruded polygons (prisms, cylinders, boxes), extruded line strings
 * (walls), spheres, and polygons or lines at an altitude. Each feature gets a `GeographicAnchor`, so it stays on its
 * spot through the globe-to-map morph; its geometry is built once per change, in the anchor's frame. Features without
 * altitudes stand on the terrain, following its height as it loads.
 */
export class SolidFeatures {
  /** Holds the anchors: add it under the earth (`context.addObject`). */
  readonly object = new Group()
  protected readonly solids = new Map<string, Solid>()
  /** Features being dragged or transformed, shown in 3D while they change (`setPreviews`). */
  protected readonly previews = new Map<string, Solid>()
  /** The last terrain height found under each feature, so a rebuilt solid starts there rather than at 0 m. */
  protected readonly lastGroundHeights = new Map<string, number>()
  protected readonly materials = new Map<string, SharedMaterials>()
  /** The solids standing on the ground, checked in turn. */
  protected groundSolids: Solid[] = []
  /** The ground solid looked up first next frame, so every solid gets its turn. */
  protected groundCursor = 0
  protected lastGroundChangeMilliseconds = -Infinity
  protected followUpTimer: ReturnType<typeof setTimeout> | null = null

  constructor(protected readonly earth: Earth) {
    this.object.name = 'DrawSolids'
  }

  /** Replaces the solids. Unchanged features (same object, same colours) keep theirs. */
  setFeatures(features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    this.sync(this.solids, features)
  }

  /**
   * Replaces the previews: features changing under the pointer (a drag, a gizmo), drawn as solids alongside the others
   * and rebuilt only when their feature object changes. Pass none when the change ends.
   */
  setPreviews(features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    this.sync(this.previews, features, true)
  }

  /** `immediate`: ground solids look the terrain up now (a preview must not show at 0 m for a frame). */
  protected sync(solids: Map<string, Solid>, features: Iterable<{ feature: DrawFeature; style: DrawStyle }>, immediate = false): void {
    const kept = new Set<string>()
    let changed = false
    for (const { feature, style } of features) {
      kept.add(feature.id)
      const existing = solids.get(feature.id)
      if (existing !== undefined && existing.feature === feature && sameSolidStyle(existing.style, style)) continue
      if (existing !== undefined) this.removeSolid(existing)
      const solid = this.createSolid(feature, style)
      if (immediate && solid.onGround) {
        this.placeOnGround(solid)
        solid.groundCheckedMilliseconds = performance.now()
      }
      solids.set(feature.id, solid)
      changed = true
    }
    for (const [id, solid] of solids) {
      if (kept.has(id)) continue
      this.removeSolid(solid)
      solids.delete(id)
      changed = true
    }
    if (changed) this.groundSolids = [...this.solids.values(), ...this.previews.values()].filter(solid => solid.onGround)
  }

  /**
   * Call once per frame: moves solids standing on the ground to the terrain's height, a few lookups per frame, each
   * solid at most every 500 ms. While a solid has no height yet, or heights changed in the last seconds (tiles still
   * refining), it asks the earth for follow-up frames, so the final height lands even when frames are on demand.
   * Returns true if a solid moved.
   */
  update(timeMilliseconds: number = performance.now()): boolean {
    const ground = this.groundSolids
    const count = ground.length
    if (count === 0) return false
    let moved = false
    let lookups = 0
    let waitMilliseconds = Infinity
    let pending = false
    const start = this.groundCursor
    for (let offset = 0; offset < count; offset++) {
      const index = (start + offset) % count
      const solid = ground[index]!
      if (!solid.groundFound) pending = true
      const wait = GROUND_CHECK_INTERVAL_MILLISECONDS - (timeMilliseconds - solid.groundCheckedMilliseconds)
      if (wait > 0) {
        waitMilliseconds = Math.min(waitMilliseconds, wait)
        continue
      }
      if (lookups === GROUND_LOOKUPS_PER_FRAME) {
        // Out of budget: the next frame serves the next solids, at once.
        waitMilliseconds = 0
        break
      }
      lookups++
      solid.groundCheckedMilliseconds = timeMilliseconds
      this.groundCursor = (index + 1) % count
      if (this.placeOnGround(solid)) {
        moved = true
        this.lastGroundChangeMilliseconds = timeMilliseconds
      }
    }
    const settling = pending || timeMilliseconds - this.lastGroundChangeMilliseconds < GROUND_SETTLE_MILLISECONDS
    if (settling && Number.isFinite(waitMilliseconds)) this.scheduleFollowUp(waitMilliseconds)
    return moved
  }

  get size(): number {
    return this.solids.size
  }

  dispose(): void {
    if (this.followUpTimer !== null) clearTimeout(this.followUpTimer)
    this.followUpTimer = null
    this.groundSolids = []
    for (const solid of this.solids.values()) this.removeSolid(solid)
    for (const solid of this.previews.values()) this.removeSolid(solid)
    this.solids.clear()
    this.previews.clear()
    this.object.removeFromParent()
  }

  protected createSolid(feature: DrawFeature, style: DrawStyle): Solid {
    const [longitudeDegrees, latitudeDegrees] = anchorPosition(feature)
    const altitude = firstAltitude(feature)
    const onGround = altitude === null
    const shape = shapeOf(feature)
    // Standing on the ground: built at height 0 and lifted by the anchor; otherwise at the altitudes given.
    const anchorHeight = altitude ?? 0
    // A ground solid starts where its feature last stood, until the terrain under it answers.
    const anchor = this.earth.createGeographicAnchor({ longitudeDegrees, latitudeDegrees, heightMeters: onGround ? (this.lastGroundHeights.get(feature.id) ?? 0) : anchorHeight })
    this.object.add(anchor)
    const solid: Solid = { feature, style, anchor, owned: [], materialKey: null, onGround, longitudeDegrees, latitudeDegrees, groundCheckedMilliseconds: -Infinity, groundFound: false }
    const materials = (doubleSided: boolean) => {
      const shared = this.acquireMaterials(style, doubleSided)
      solid.materialKey = shared.key
      return shared
    }
    const add = (object: Object3D, geometry: BufferGeometry) => {
      solid.owned.push(geometry)
      anchor.add(object)
    }
    if (feature.geometry.type === 'Point' && shape?.type === 'sphere') {
      if (!(shape.radiusMeters > 0) || !Number.isFinite(shape.radiusMeters)) {
        console.warn(`react-three-earth-draw: sphere ${feature.id} has radiusMeters ${String(shape.radiusMeters)}; set properties.shape.radiusMeters to a positive number of metres (or build it with createSphere).`)
        return solid
      }
      const sphere = new SphereGeometry(shape.radiusMeters, 48, 24)
      const mesh = new Mesh(sphere, materials(false).material)
      // Resting on the ground; with an altitude, the altitude is the center.
      if (onGround) mesh.position.z = shape.radiusMeters
      add(mesh, sphere)
    } else {
      const frame = new LocalFrame(longitudeDegrees, latitudeDegrees, anchorHeight)
      const { faces, line, closed } = buildSolidGeometry(feature, frame, position => (position.length > 2 && Number.isFinite(position[2]) ? position[2]! : anchorHeight))
      // Closed solids show their outside only, so transparent faces never blend with the far side; open faces show both.
      const { material, edgeMaterial } = materials(!closed)
      if (faces !== null) {
        add(new Mesh(faces, material), faces)
        const edges = new EdgesGeometry(faces, EDGE_THRESHOLD_DEGREES)
        add(new LineSegments(edges, edgeMaterial), edges)
      }
      if (line !== null) add(new Line(line, edgeMaterial), line)
    }
    // Lifted to the terrain by the next `update()`, which spreads the lookups over frames.
    return solid
  }

  /** Asks the earth for a frame in `delayMilliseconds`, unless one is already asked for sooner. */
  protected scheduleFollowUp(delayMilliseconds: number): void {
    if (this.followUpTimer !== null) return
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null
      this.earth.requestFrame()
    }, delayMilliseconds)
  }

  /** Sets a ground solid's anchor at the terrain's height under it. Returns true if it moved. */
  protected placeOnGround(solid: Solid): boolean {
    const { longitudeDegrees, latitudeDegrees } = solid
    const height = this.earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees })
    if (height === null) return false
    solid.groundFound = true
    if (this.lastGroundHeights.size > 4096) this.lastGroundHeights.clear()
    this.lastGroundHeights.set(solid.feature.id, height)
    if (Math.abs(height - solid.anchor.geographicPosition.heightMeters) < 0.25) return false
    solid.anchor.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters: height })
    return true
  }

  protected removeSolid(solid: Solid): void {
    solid.anchor.dispose()
    for (const owned of solid.owned) owned.dispose()
    if (solid.materialKey !== null) this.releaseMaterials(solid.materialKey)
    solid.materialKey = null
  }

  /**
   * Materials for a style, shared by every solid in it: a solid rebuilt (an edit, a preview following the pointer)
   * reuses them, so WebGPU never compiles a new node material mid-drag. Released with `releaseMaterials`.
   */
  protected acquireMaterials(style: DrawStyle, doubleSided: boolean): SharedMaterials {
    const key = `${style.fillColor}|${style.solidOpacity}|${style.lineColor}|${style.lineOpacity}|${doubleSided ? 2 : 1}`
    let shared = this.materials.get(key)
    if (shared === undefined) {
      const colorNode = vec4(uniform(new Color(style.fillColor)), 1)
      const material = new MeshStandardNodeMaterial({ side: doubleSided ? DoubleSide : FrontSide, transparent: style.solidOpacity < 1, opacity: style.solidOpacity, depthWrite: style.solidOpacity >= 1 })
      material.colorNode = colorNode
      // On the flat map the sun fades out: keep the colour, like the flat terrain.
      material.emissiveNode = createFlatMapEmissionNode(colorNode, this.earth.view)
      const edgeMaterial = new LineBasicNodeMaterial({ color: new Color(style.lineColor), transparent: style.lineOpacity < 1, opacity: style.lineOpacity })
      shared = { key, material, edgeMaterial, users: 0 }
      this.materials.set(key, shared)
    }
    shared.users++
    return shared
  }

  protected releaseMaterials(key: string): void {
    const shared = this.materials.get(key)
    if (shared === undefined || --shared.users > 0) return
    shared.material.dispose()
    shared.edgeMaterial.dispose()
    this.materials.delete(key)
  }
}
