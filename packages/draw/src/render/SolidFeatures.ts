import earcut from 'earcut'
import type { Position } from 'geojson'
import { createFlatMapEmissionNode, type Earth, type GeographicAnchor } from 'react-three-earth'
import { BufferGeometry, Color, DoubleSide, EdgesGeometry, Float32BufferAttribute, FrontSide, Group, Line, LineSegments, Mesh, type Object3D } from 'three'
import { uniform, vec4 } from 'three/tsl'
import { LineBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'

import { distanceMeters, hasAltitude, storedPositions, unwrapLongitudeNear } from '../geometry.js'
import { LocalFrame, type LocalPoint } from '../localFrame.js'
import { indexMesh, isClosedMesh, isMeshGeometry, meshVolume, newellNormal, openRing } from '../mesh.js'
import type { DrawFeature, DrawStyle } from '../types.js'

export { LocalFrame } from '../localFrame.js'

/** Edges longer than this are split, and faces wider than this get inner vertices, so solids follow the curve of the Earth. */
const MAXIMUM_EDGE_METERS = 2000
/** At most this many pieces per edge of a line. */
const MAXIMUM_EDGE_PIECES = 64
/** About this many triangles at most per face: wider faces get longer triangles. */
const MAXIMUM_FACE_TRIANGLES = 4096
/** Edges between faces meeting at more than this angle are outlined (so a cylinder's wall shows no seams). */
const EDGE_THRESHOLD_DEGREES = 30
/** Faces meeting at less than this angle are shaded smoothly across their edge (a cylinder's wall, a sphere). */
const SMOOTH_THRESHOLD_DEGREES = 30

/**
 * Whether a feature is drawn as a 3D solid rather than draped on the terrain: a mesh (a multipolygon with an altitude on
 * every position, see `isMeshFeature`), or a polygon or line string with altitudes (a third coordinate) on its positions.
 */
export function isSolidFeature(feature: DrawFeature): boolean {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return false
  if (geometry.type === 'MultiPolygon') return isMeshGeometry(geometry)
  return storedPositions(geometry).some(hasAltitude)
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
}

/** Materials shared by the solids of one style. */
interface SharedMaterials {
  key: string
  material: MeshStandardNodeMaterial
  edgeMaterial: LineBasicNodeMaterial
  users: number
}

type GeographicPoint = [longitude: number, latitude: number, height: number]

/** Pieces an edge of a line is split into: at most 2 km long, never more than 64. */
function edgePieces(from: GeographicPoint, to: GeographicPoint): number {
  return Math.max(1, Math.min(MAXIMUM_EDGE_PIECES, Math.ceil(distanceMeters(from, to) / MAXIMUM_EDGE_METERS)))
}

/**
 * Positions with their long edges split (around a ring, back to the first, when `closed`), longitudes unwrapped near
 * the previous one (from `referenceLongitude`), each with its height.
 */
function densify(positions: readonly Position[], referenceLongitude: number, heightOf: (position: Position) => number, closed: boolean): GeographicPoint[] {
  const points: GeographicPoint[] = []
  let previous = referenceLongitude
  for (const position of positions) {
    // Near the previous position, so an edge is never split the long way round (a ring around a pole keeps going east).
    const longitude = unwrapLongitudeNear(position[0]!, previous)
    points.push([longitude, position[1]!, heightOf(position)])
    previous = longitude
  }
  const result: GeographicPoint[] = []
  const edges = closed ? points.length : points.length - 1
  for (let index = 0; index < points.length; index++) {
    const from = points[index]!
    result.push(from)
    if (index >= edges) continue
    const next = points[(index + 1) % points.length]!
    const to: GeographicPoint = [unwrapLongitudeNear(next[0], from[0]), next[1], next[2]]
    const pieces = edgePieces(from, to)
    for (let piece = 1; piece < pieces; piece++) {
      const t = piece / pieces
      result.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t])
    }
  }
  return result
}

/** Triangles as a flat list of local points (three per triangle). */
class TriangleSoup {
  readonly positions: number[] = []

  triangle(a: LocalPoint, b: LocalPoint, c: LocalPoint): void {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  }

  /**
   * The geometry, with normals smoothed across edges where faces meet at less than 30° (a cylinder's wall, a sphere)
   * and sharp elsewhere (a box's edges).
   */
  toGeometry(): BufferGeometry {
    const positions = this.positions
    const triangles = positions.length / 9
    const unit = new Float64Array(triangles * 3)
    const weighted = new Float64Array(triangles * 3)
    for (let triangle = 0; triangle < triangles; triangle++) {
      const offset = triangle * 9
      const ux = positions[offset + 3]! - positions[offset]!
      const uy = positions[offset + 4]! - positions[offset + 1]!
      const uz = positions[offset + 5]! - positions[offset + 2]!
      const vx = positions[offset + 6]! - positions[offset]!
      const vy = positions[offset + 7]! - positions[offset + 1]!
      const vz = positions[offset + 8]! - positions[offset + 2]!
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const length = Math.hypot(nx, ny, nz)
      weighted.set([nx, ny, nz], triangle * 3)
      if (length > 0) unit.set([nx / length, ny / length, nz / length], triangle * 3)
    }
    // The corners at each position (to the millimetre).
    const corners = new Map<string, number[]>()
    for (let corner = 0; corner < triangles * 3; corner++) {
      const key = `${Math.round(positions[corner * 3]! * 1000)},${Math.round(positions[corner * 3 + 1]! * 1000)},${Math.round(positions[corner * 3 + 2]! * 1000)}`
      const list = corners.get(key)
      if (list === undefined) corners.set(key, [corner])
      else list.push(corner)
    }
    const normals = new Float32Array(positions.length)
    const cosine = Math.cos((SMOOTH_THRESHOLD_DEGREES * Math.PI) / 180)
    for (const group of corners.values()) {
      for (const corner of group) {
        const triangle = Math.floor(corner / 3)
        let x = 0
        let y = 0
        let z = 0
        for (const other of group) {
          const neighbour = Math.floor(other / 3)
          const alignment = unit[triangle * 3]! * unit[neighbour * 3]! + unit[triangle * 3 + 1]! * unit[neighbour * 3 + 1]! + unit[triangle * 3 + 2]! * unit[neighbour * 3 + 2]!
          if (neighbour !== triangle && alignment < cosine) continue
          x += weighted[neighbour * 3]!
          y += weighted[neighbour * 3 + 1]!
          z += weighted[neighbour * 3 + 2]!
        }
        const length = Math.hypot(x, y, z)
        if (length > 0) normals.set([x / length, y / length, z / length], corner * 3)
        else normals.set([0, 0, 1], corner * 3)
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    return geometry
  }
}

/** What `buildSolidGeometry` returns. */
export interface SolidGeometry {
  /** The faces, or null for a line drawn as a line. */
  faces: BufferGeometry | null
  /** A line string at an altitude, or null. */
  line: BufferGeometry | null
  /**
   * True when the faces close a volume, all facing outwards (a closed mesh wound counter-clockwise seen from outside),
   * so they can be drawn on one side. Open faces are seen from both sides.
   */
  closed: boolean
}

/** A face ready to triangulate: its rings' positions (longitudes unwrapped near the frame's) and points in the frame. */
interface PreparedFace {
  rings: GeographicPoint[][]
  local: LocalPoint[][]
  /** Newell's normal of its exterior ring: its length is twice the face's area. */
  normal: LocalPoint
}

function prepareFace(rings: readonly Position[][], frame: LocalFrame, heightOf: (position: Position) => number): PreparedFace | null {
  const geographic = rings
    .map(ring => openRing(ring).map(position => [unwrapLongitudeNear(position[0]!, frame.longitudeDegrees), position[1]!, heightOf(position)] as GeographicPoint))
    .filter(ring => ring.length >= 3)
  if (geographic.length === 0) return null
  const local = geographic.map(ring => ring.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)))
  return { rings: geographic, local, normal: newellNormal(local[0]!) }
}

/**
 * Adds one planar face to the soup: triangulated in its own plane, every triangle wound as the exterior ring (facing
 * where its normal points), then split until no edge is longer than `maximumEdgeMeters` across, so it follows the curve
 * of the Earth. Every face of a solid takes the same limit, so an edge two faces share is split the same way in both.
 */
function addFace(soup: TriangleSoup, face: PreparedFace, frame: LocalFrame, maximumEdgeMeters: number): void {
  const length = Math.hypot(...face.normal)
  if (!(length > 1e-9)) return
  const n: LocalPoint = [face.normal[0] / length, face.normal[1] / length, face.normal[2] / length]
  // A basis of the face's plane, (u, v, n) right-handed: counter-clockwise in (u, v) is counter-clockwise seen from n.
  const axis: LocalPoint = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const uRaw: LocalPoint = [axis[1] * n[2] - axis[2] * n[1], axis[2] * n[0] - axis[0] * n[2], axis[0] * n[1] - axis[1] * n[0]]
  const uLength = Math.hypot(...uRaw)
  const u: LocalPoint = [uRaw[0] / uLength, uRaw[1] / uLength, uRaw[2] / uLength]
  const v: LocalPoint = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const flat: number[] = []
  const holes: number[] = []
  for (const ring of face.local) {
    if (flat.length > 0) holes.push(flat.length / 2)
    for (const point of ring) flat.push(point[0] * u[0] + point[1] * u[1] + point[2] * u[2], point[0] * v[0] + point[1] * v[1] + point[2] * v[2])
  }
  const indices = earcut(flat, holes.length > 0 ? holes : undefined, 2)
  // Counter-clockwise in the plane, so each triangle faces as the face does.
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 2
    const b = indices[index + 1]! * 2
    const c = indices[index + 2]! * 2
    if ((flat[b]! - flat[a]!) * (flat[c + 1]! - flat[a + 1]!) - (flat[c]! - flat[a]!) * (flat[b + 1]! - flat[a + 1]!) < 0) {
      ;[indices[index + 1], indices[index + 2]] = [indices[index + 2]!, indices[index + 1]!]
    }
  }
  // Long edges are split, so faces bend with the Earth instead of cutting under it.
  const positions = face.rings.flat()
  const points = face.local.flat()
  const triangles = refineTriangles(positions, points, indices, maximumEdgeMeters, frame)
  for (let index = 0; index < triangles.length; index += 3) soup.triangle(points[triangles[index]!]!, points[triangles[index + 1]!]!, points[triangles[index + 2]!]!)
}

/**
 * The geometry of a solid feature, in the local frame: a mesh's faces, a polygon at an altitude as one flat face, or a
 * line string with altitudes as a line. Positions without an altitude stand at `fallbackHeightMeters`.
 */
export function buildSolidGeometry(feature: DrawFeature, frame: LocalFrame, fallbackHeightMeters = 0): SolidGeometry {
  const geometry = feature.geometry
  const heightOf = (position: Position) => (hasAltitude(position) ? position[2]! : fallbackHeightMeters)
  if (geometry.type === 'LineString') {
    const line = densify(geometry.coordinates, frame.longitudeDegrees, heightOf, false)
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new Float32BufferAttribute(line.flatMap(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)), 3))
    return { faces: null, line: lineGeometry, closed: false }
  }
  if (geometry.type === 'Point') return { faces: null, line: null, closed: false }
  const soup = new TriangleSoup()
  const faces = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).map(face => prepareFace(face, frame, heightOf)).filter(face => face !== null)
  // Wider faces get longer triangles (about 4096 at most for the widest), all faces the same limit.
  let largestArea = 0
  for (const face of faces) largestArea = Math.max(largestArea, Math.hypot(...face.normal) / 2)
  const maximumEdgeMeters = Math.max(MAXIMUM_EDGE_METERS, Math.sqrt((2 * largestArea) / MAXIMUM_FACE_TRIANGLES))
  for (const face of faces) addFace(soup, face, frame, maximumEdgeMeters)
  let closed = false
  if (geometry.type === 'MultiPolygon') {
    const mesh = indexMesh(geometry)
    // Closed and wound outwards: one side. Wound inwards, or open: both, rather than guess.
    closed = isClosedMesh(mesh) && meshVolume(mesh) > 0
  }
  return { faces: soup.positions.length > 0 ? soup.toGeometry() : null, line: null, closed }
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


/** The longitude and latitude a feature's anchor stands at (the middle of its extent), and its lowest altitude. */
function anchorPosition(feature: DrawFeature): [longitude: number, latitude: number, height: number] {
  const positions = storedPositions(feature.geometry)
  const reference = positions[0]?.[0] ?? 0
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  let lowest = Infinity
  for (const position of positions) {
    const longitude = unwrapLongitudeNear(position[0]!, reference)
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
    south = Math.min(south, position[1]!)
    north = Math.max(north, position[1]!)
    if (hasAltitude(position)) lowest = Math.min(lowest, position[2]!)
  }
  return [(west + east) / 2, (south + north) / 2, Number.isFinite(lowest) ? lowest : 0]
}

function sameSolidStyle(a: DrawStyle, b: DrawStyle): boolean {
  return a.fillColor === b.fillColor && a.solidOpacity === b.solidOpacity && a.lineColor === b.lineColor && a.lineOpacity === b.lineOpacity
}

/**
 * Draws 3D features as solids in the scene: meshes (prisms, boxes, cylinders, walls, spheres, imported solids) from
 * their faces, and polygons or lines at an altitude. Each feature gets a `GeographicAnchor`, so it stays on its spot
 * through the globe-to-map morph; its geometry is built once per change, in the anchor's frame, at the altitudes its
 * positions give.
 */
export class SolidFeatures {
  /** Holds the anchors: add it under the earth (`context.addObject`). */
  readonly object = new Group()
  protected readonly solids = new Map<string, Solid>()
  /** Features being dragged or transformed, shown in 3D while they change (`setPreviews`). */
  protected readonly previews = new Map<string, Solid>()
  protected readonly materials = new Map<string, SharedMaterials>()

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
    this.sync(this.previews, features)
  }

  protected sync(solids: Map<string, Solid>, features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    const kept = new Set<string>()
    for (const { feature, style } of features) {
      kept.add(feature.id)
      const existing = solids.get(feature.id)
      if (existing !== undefined && existing.feature === feature && sameSolidStyle(existing.style, style)) continue
      if (existing !== undefined) this.removeSolid(existing)
      solids.set(feature.id, this.createSolid(feature, style))
    }
    for (const [id, solid] of solids) {
      if (kept.has(id)) continue
      this.removeSolid(solid)
      solids.delete(id)
    }
  }

  get size(): number {
    return this.solids.size
  }

  dispose(): void {
    for (const solid of this.solids.values()) this.removeSolid(solid)
    for (const solid of this.previews.values()) this.removeSolid(solid)
    this.solids.clear()
    this.previews.clear()
    this.object.removeFromParent()
  }

  protected createSolid(feature: DrawFeature, style: DrawStyle): Solid {
    const [longitudeDegrees, latitudeDegrees, heightMeters] = anchorPosition(feature)
    const anchor = this.earth.createGeographicAnchor({ longitudeDegrees, latitudeDegrees, heightMeters })
    this.object.add(anchor)
    const solid: Solid = { feature, style, anchor, owned: [], materialKey: null }
    const add = (object: Object3D, geometry: BufferGeometry) => {
      solid.owned.push(geometry)
      anchor.add(object)
    }
    const frame = new LocalFrame(longitudeDegrees, latitudeDegrees, heightMeters)
    const { faces, line, closed } = buildSolidGeometry(feature, frame, heightMeters)
    // Closed solids show their outside only, so transparent faces never blend with the far side; open faces show both.
    const shared = this.acquireMaterials(style, !closed)
    solid.materialKey = shared.key
    if (faces !== null) {
      add(new Mesh(faces, shared.material), faces)
      const edges = new EdgesGeometry(faces, EDGE_THRESHOLD_DEGREES)
      add(new LineSegments(edges, shared.edgeMaterial), edges)
    }
    if (line !== null) add(new Line(line, shared.edgeMaterial), line)
    return solid
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
