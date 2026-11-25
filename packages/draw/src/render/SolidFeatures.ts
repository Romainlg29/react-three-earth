import earcut from 'earcut'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import { createFlatMapEmissionNode, TRANSLUCENT_LAYER, TRANSLUCENT_RENDER_PASS_NAME, type Earth, type GeographicAnchor } from '@earthkit/globe'
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, FrontSide, Group, Line, LineSegments, Mesh, type Object3D } from 'three'
import { uniform, vec4 } from 'three/tsl'
import { LineBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'

import { distanceMeters, hasAltitude, storedPositions, unwrapLongitudeNear } from '../geometry.js'
import { LocalFrame, type LocalPoint } from '../localFrame.js'
import { type IndexedMesh, indexMesh, isClosedMesh, isMeshGeometry, meshSharpEdges, meshVolume, newellNormal, openRing } from '../mesh.js'
import type { DrawFeature, DrawStyle } from '../types.js'

export { LocalFrame } from '../localFrame.js'

/** Edges longer than this are split, and faces wider than this get inner vertices, so solids follow the curve of the Earth. */
const MAXIMUM_EDGE_METERS = 2000
/** At most this many pieces per edge of a line. */
const MAXIMUM_EDGE_PIECES = 64
/** About this many triangles at most per face: wider faces get longer triangles. */
const MAXIMUM_FACE_TRIANGLES = 4096
/** How much longer a preview's triangles may be than a solid's: a rebuild per pointer move stays cheap. */
const PREVIEW_COARSENESS = 4
/** Edges between faces meeting at more than this angle are outlined (so a cylinder's wall shows no seams). */
const EDGE_THRESHOLD_DEGREES = 30
/** Faces meeting at less than this angle are shaded smoothly across their edge (a cylinder's wall, a sphere). */
const SMOOTH_THRESHOLD_DEGREES = 30

/**
 * Whether a feature is drawn in 3D rather than draped on the terrain: a line string, polygon or multipolygon with an
 * altitude (a third coordinate) on any position. A mesh (`isMeshFeature`) is drawn as a solid from its faces; the others
 * as flat faces or a line at their altitudes, positions without one at the lowest altitude given. Hit testing
 * (`hitFeature`), the gizmo (`transformFrame`) and the selection outline place them the same way.
 */
export function isSolidFeature(feature: DrawFeature): boolean {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return false
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
    const corners = triangles * 3
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
      weighted[triangle * 3] = nx
      weighted[triangle * 3 + 1] = ny
      weighted[triangle * 3 + 2] = nz
      if (length > 0) {
        unit[triangle * 3] = nx / length
        unit[triangle * 3 + 1] = ny / length
        unit[triangle * 3 + 2] = nz / length
      }
    }
    // The corners at each position (to the millimetre), as groups linked through `nextInGroup`.
    const quantized = new Float64Array(corners * 3)
    for (let index = 0; index < corners * 3; index++) quantized[index] = Math.round(positions[index]! * 1000)
    const groupFirst: number[] = []
    const nextInGroup = new Int32Array(corners).fill(-1)
    const groupsByHash = new Map<number, number | number[]>()
    const samePlace = (a: number, b: number) => quantized[a * 3] === quantized[b * 3] && quantized[a * 3 + 1] === quantized[b * 3 + 1] && quantized[a * 3 + 2] === quantized[b * 3 + 2]
    for (let corner = 0; corner < corners; corner++) {
      const hash = quantized[corner * 3]! * 73_856_093 + quantized[corner * 3 + 1]! * 19_349_663 + quantized[corner * 3 + 2]! * 83_492_791
      const bucket = groupsByHash.get(hash)
      let group = -1
      if (bucket !== undefined) {
        for (const candidate of typeof bucket === 'number' ? [bucket] : bucket) {
          if (samePlace(groupFirst[candidate]!, corner)) {
            group = candidate
            break
          }
        }
      }
      if (group === -1) {
        group = groupFirst.push(corner) - 1
        if (bucket === undefined) groupsByHash.set(hash, group)
        else groupsByHash.set(hash, typeof bucket === 'number' ? [bucket, group] : [...bucket, group])
      } else {
        const first = groupFirst[group]!
        nextInGroup[corner] = nextInGroup[first]!
        nextInGroup[first] = corner
      }
    }
    const normals = new Float32Array(positions.length)
    const cosine = Math.cos((SMOOTH_THRESHOLD_DEGREES * Math.PI) / 180)
    const members: number[] = []
    for (const first of groupFirst) {
      members.length = 0
      for (let corner = first; corner !== -1; corner = nextInGroup[corner]!) members.push(Math.floor(corner / 3))
      let index = 0
      for (let corner = first; corner !== -1; corner = nextInGroup[corner]!, index++) {
        const triangle = members[index]!
        let x = 0
        let y = 0
        let z = 0
        for (const neighbour of members) {
          const alignment = unit[triangle * 3]! * unit[neighbour * 3]! + unit[triangle * 3 + 1]! * unit[neighbour * 3 + 1]! + unit[triangle * 3 + 2]! * unit[neighbour * 3 + 2]!
          if (neighbour !== triangle && alignment < cosine) continue
          x += weighted[neighbour * 3]!
          y += weighted[neighbour * 3 + 1]!
          z += weighted[neighbour * 3 + 2]!
        }
        const length = Math.hypot(x, y, z)
        normals[corner * 3] = length > 0 ? x / length : 0
        normals[corner * 3 + 1] = length > 0 ? y / length : 0
        normals[corner * 3 + 2] = length > 0 ? z / length : 1
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
  /**
   * The outline of the faces, as line segments: a mesh's sharp edges (between faces meeting at more than 30°, and its
   * open borders), or every ring of a polygon at an altitude. Null without faces.
   */
  edges: BufferGeometry | null
  /** A line string at an altitude, or null. */
  line: BufferGeometry | null
  /**
   * True when the faces close a volume, all facing outwards (a closed mesh wound counter-clockwise seen from outside),
   * so they can be drawn on one side. Open faces are seen from both sides.
   */
  closed: boolean
}

/** Options of `buildSolidGeometry`. */
export interface SolidGeometryOptions {
  /**
   * How much longer the triangles may be than the finest that follows the curve of the Earth: 1 for the solid as it
   * stays, more for a preview rebuilt under the pointer (`SolidFeatures.setPreviews` uses 4). Default: 1.
   */
  coarseness?: number
}

/** A face ready to triangulate: its rings' positions (longitudes unwrapped near the frame's) and points in the frame. */
interface PreparedFace {
  rings: GeographicPoint[][]
  local: LocalPoint[][]
  /** Newell's normal of its exterior ring: its length is twice the face's area. */
  normal: LocalPoint
}

function prepareFace(rings: readonly Position[][], frame: LocalFrame, heightOf: (position: Position) => number): PreparedFace | null {
  const geographic = rings.map(ring => openRing(ring).map(position => geographicPoint(position, frame, heightOf))).filter(ring => ring.length >= 3)
  if (geographic.length === 0) return null
  const local = geographic.map(ring => ring.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)))
  return { rings: geographic, local, normal: newellNormal(local[0]!) }
}

function geographicPoint(position: Position, frame: LocalFrame, heightOf: (position: Position) => number): GeographicPoint {
  return [unwrapLongitudeNear(position[0]!, frame.longitudeDegrees), position[1]!, heightOf(position)]
}

/** Orders two points, so an edge is split from the same end in every face that shares it. */
function comparePoints(a: GeographicPoint, b: GeographicPoint): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * The points splitting an edge into pieces at most `maximumEdgeMeters` long across (measured level in the frame, so a
 * vertical edge is never split), from `from` towards `to`, without its ends. Interpolated from the smaller end, so the
 * faces sharing an edge, and its outline, get the very same points.
 */
function splitEdge(from: GeographicPoint, to: GeographicPoint, fromLocal: LocalPoint, toLocal: LocalPoint, maximumEdgeMeters: number, frame: LocalFrame): Array<{ geographic: GeographicPoint; local: LocalPoint }> {
  const pieces = Math.ceil(Math.hypot(toLocal[0] - fromLocal[0], toLocal[1] - fromLocal[1]) / maximumEdgeMeters - 1e-9)
  if (!(pieces > 1)) return []
  const forward = comparePoints(from, to) <= 0
  const [start, end] = forward ? [from, to] : [to, from]
  const points: Array<{ geographic: GeographicPoint; local: LocalPoint }> = []
  for (let piece = 1; piece < pieces; piece++) {
    const t = piece / pieces
    const geographic: GeographicPoint = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t]
    points.push({ geographic, local: frame.toLocal(...geographic) })
  }
  return forward ? points : points.reverse()
}

/**
 * Inner points of a level face are this many times the edge limit apart (and half that from its edges): few enough to
 * triangulate fast, and the triangles between them are well shaped, so splitting them to the limit adds few.
 */
const INNER_POINT_SPACING = 2
/**
 * Triangles are split until no edge is longer than this many times the limit. More than 1, so the split boundary
 * edges (at most the limit) are never split again: the faces sharing them stay joined.
 */
const REFINEMENT_SLACK = 1.5

/**
 * Adds one planar face to the soup, following the curve of the Earth with about as few triangles as it takes: its
 * edges split into pieces at most `maximumEdgeMeters` long, inner points on a grid twice that wide when it is mostly
 * level, triangulated in its own plane (made Delaunay, so no slivers), every triangle wound as the exterior ring, and
 * triangle edges still longer than 1.5 times the limit split (`refineTriangles`). Every face of a solid takes the same limit and splits
 * shared edges at the same points, so the surface never cracks.
 */
function addFace(soup: TriangleSoup, face: PreparedFace, frame: LocalFrame, maximumEdgeMeters: number): void {
  const length = Math.hypot(...face.normal)
  if (!(length > 1e-9)) return
  if (addSmallFace(soup, face, maximumEdgeMeters)) return
  const n: LocalPoint = [face.normal[0] / length, face.normal[1] / length, face.normal[2] / length]
  // A basis of the face's plane, (u, v, n) right-handed: counter-clockwise in (u, v) is counter-clockwise seen from n.
  const axis: LocalPoint = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const uRaw: LocalPoint = [axis[1] * n[2] - axis[2] * n[1], axis[2] * n[0] - axis[0] * n[2], axis[0] * n[1] - axis[1] * n[0]]
  const uLength = Math.hypot(...uRaw)
  const u: LocalPoint = [uRaw[0] / uLength, uRaw[1] / uLength, uRaw[2] / uLength]
  const v: LocalPoint = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const positions: GeographicPoint[] = []
  const points: LocalPoint[] = []
  const flat: number[] = []
  const holes: number[] = []
  const push = (geographic: GeographicPoint, local: LocalPoint) => {
    positions.push(geographic)
    points.push(local)
    flat.push(local[0] * u[0] + local[1] * u[1] + local[2] * u[2], local[0] * v[0] + local[1] * v[1] + local[2] * v[2])
  }
  const ringStarts: number[] = []
  face.rings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) holes.push(positions.length)
    ringStarts.push(positions.length)
    const local = face.local[ringIndex]!
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length
      push(ring[index]!, local[index]!)
      for (const point of splitEdge(ring[index]!, ring[next]!, local[index]!, local[next]!, maximumEdgeMeters, frame)) push(point.geographic, point.local)
    }
  })
  ringStarts.push(positions.length)
  // A mostly level face wider than the limit gets inner points, so it bends with the Earth (a wall bends along its edges).
  if (Math.abs(n[2]) > 0.5) addInnerPoints(face, frame, maximumEdgeMeters * INNER_POINT_SPACING, { n, u, v }, flat, ringStarts, (geographic, local) => {
    holes.push(positions.length)
    push(geographic, local)
  })
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
  if (positions.length > 4) makeDelaunay(flat, indices)
  const triangles = refineTriangles(positions, points, indices, maximumEdgeMeters * REFINEMENT_SLACK, frame)
  for (let index = 0; index < triangles.length; index += 3) soup.triangle(points[triangles[index]!]!, points[triangles[index + 1]!]!, points[triangles[index + 2]!]!)
}

/**
 * Adds a triangle, or a convex quad (split along its shorter diagonal), whose edges are all within the limit, without
 * triangulating it: most faces of a sphere, a box or a wall. Returns false for any other face.
 */
function addSmallFace(soup: TriangleSoup, face: PreparedFace, maximumEdgeMeters: number): boolean {
  if (face.local.length !== 1) return false
  const ring = face.local[0]!
  if (ring.length !== 3 && ring.length !== 4) return false
  const limit = maximumEdgeMeters * maximumEdgeMeters
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > limit) return false
  }
  // The exterior winds counter-clockwise around its own normal, so its corners go in as they are.
  if (ring.length === 3) {
    soup.triangle(ring[0]!, ring[1]!, ring[2]!)
    return true
  }
  const [a, b, c, d] = ring as [LocalPoint, LocalPoint, LocalPoint, LocalPoint]
  // Convex: every corner turns the way the face's normal says.
  const normal = face.normal
  for (const [p, q, r] of [[a, b, c], [b, c, d], [c, d, a], [d, a, b]] as const) {
    const cross: LocalPoint = [(q[1] - p[1]) * (r[2] - q[2]) - (q[2] - p[2]) * (r[1] - q[1]), (q[2] - p[2]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[2] - q[2]), (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0])]
    if (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] <= 0) return false
  }
  const ac = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2
  const bd = (b[0] - d[0]) ** 2 + (b[1] - d[1]) ** 2 + (b[2] - d[2]) ** 2
  if (ac <= bd) {
    soup.triangle(a, b, c)
    soup.triangle(a, c, d)
  } else {
    soup.triangle(a, b, d)
    soup.triangle(b, c, d)
  }
  return true
}

/**
 * Adds points inside a face, on a grid `spacing` wide in its plane, at least half that from its edges: each where the
 * plane meets the grid, at the altitude that best fits the face's vertices (exact for a level face).
 */
function addInnerPoints(
  face: PreparedFace,
  frame: LocalFrame,
  spacing: number,
  basis: { n: LocalPoint; u: LocalPoint; v: LocalPoint },
  flat: readonly number[],
  ringStarts: readonly number[],
  add: (geographic: GeographicPoint, local: LocalPoint) => void,
): void {
  const exteriorEnd = ringStarts[1]!
  let minimumU = Infinity
  let maximumU = -Infinity
  let minimumV = Infinity
  let maximumV = -Infinity
  for (let index = 0; index < exteriorEnd; index++) {
    minimumU = Math.min(minimumU, flat[index * 2]!)
    maximumU = Math.max(maximumU, flat[index * 2]!)
    minimumV = Math.min(minimumV, flat[index * 2 + 1]!)
    maximumV = Math.max(maximumV, flat[index * 2 + 1]!)
  }
  const columns = Math.floor((maximumU - minimumU) / spacing)
  const rows = Math.floor((maximumV - minimumV) / spacing)
  if (columns < 1 || rows < 1) return
  const altitude = altitudeFit(face, basis)
  const { n, u, v } = basis
  let offset = 0
  for (const ring of face.local) for (const point of ring) offset += point[0] * n[0] + point[1] * n[1] + point[2] * n[2]
  offset /= face.local.reduce((count, ring) => count + ring.length, 0)
  const margin = (spacing / 2) ** 2
  const middleU = (minimumU + maximumU) / 2
  const middleV = (minimumV + maximumV) / 2
  for (let column = 0; column < columns; column++) {
    const pointU = middleU + (column - (columns - 1) / 2) * spacing
    for (let row = 0; row < rows; row++) {
      const pointV = middleV + (row - (rows - 1) / 2) * spacing
      if (!insideRings(pointU, pointV, flat, ringStarts, margin)) continue
      const [longitude, latitude] = frame.toGeographic(pointU * u[0] + pointV * v[0] + offset * n[0], pointU * u[1] + pointV * v[1] + offset * n[1], pointU * u[2] + pointV * v[2] + offset * n[2])
      const geographic: GeographicPoint = [longitude, latitude, altitude(pointU, pointV)]
      add(geographic, frame.toLocal(...geographic))
    }
  }
}

/** Whether a point of the plane is inside the rings (even-odd) and at least √`marginSquared` from all their edges. */
function insideRings(x: number, y: number, flat: readonly number[], ringStarts: readonly number[], marginSquared: number): boolean {
  let inside = false
  for (let ring = 0; ring + 1 < ringStarts.length; ring++) {
    const start = ringStarts[ring]!
    const end = ringStarts[ring + 1]!
    for (let index = start, previous = end - 1; index < end; previous = index++) {
      const ax = flat[index * 2]!
      const ay = flat[index * 2 + 1]!
      const bx = flat[previous * 2]!
      const by = flat[previous * 2 + 1]!
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
      const dx = bx - ax
      const dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 < marginSquared) return false
    }
  }
  return inside
}

/** The altitude over a face's plane that best fits its vertices (least squares), as a function of (u, v). */
function altitudeFit(face: PreparedFace, { u, v }: { u: LocalPoint; v: LocalPoint }): (pointU: number, pointV: number) => number {
  // Sums for the normal equations of altitude = a + b·u + c·v.
  let count = 0
  let su = 0
  let sv = 0
  let suu = 0
  let suv = 0
  let svv = 0
  let sh = 0
  let suh = 0
  let svh = 0
  face.rings.forEach((ring, ringIndex) => {
    ring.forEach((position, index) => {
      const local = face.local[ringIndex]![index]!
      const pu = local[0] * u[0] + local[1] * u[1] + local[2] * u[2]
      const pv = local[0] * v[0] + local[1] * v[1] + local[2] * v[2]
      const h = position[2]
      count++
      su += pu
      sv += pv
      suu += pu * pu
      suv += pu * pv
      svv += pv * pv
      sh += h
      suh += pu * h
      svh += pv * h
    })
  })
  const mean = sh / count
  // Centred, so the system stays well conditioned far from the frame's origin.
  const mu = su / count
  const mv = sv / count
  const cuu = suu / count - mu * mu
  const cuv = suv / count - mu * mv
  const cvv = svv / count - mv * mv
  const cuh = suh / count - mu * mean
  const cvh = svh / count - mv * mean
  const determinant = cuu * cvv - cuv * cuv
  if (!(Math.abs(determinant) > 1e-12 * (cuu * cvv + 1e-30))) return () => mean
  const b = (cuh * cvv - cvh * cuv) / determinant
  const c = (cvh * cuu - cuh * cuv) / determinant
  return (pointU, pointV) => mean + b * (pointU - mu) + c * (pointV - mv)
}

/**
 * Flips the diagonals of a triangulation (counter-clockwise triangles over `flat` 2D points) until it is Delaunay:
 * no point inside another triangle's circumcircle, so no long thin slivers. Edges with one triangle (the rings) stay.
 */
function makeDelaunay(flat: readonly number[], indices: number[]): void {
  const vertices = flat.length / 2
  const key = (a: number, b: number) => a * vertices + b
  // Each directed edge (a to b, as a × vertices + b) to the triangle holding it.
  const owner = new Map<number, number>()
  const stack: number[] = []
  for (let triangle = 0; triangle * 3 < indices.length; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const a = indices[triangle * 3 + corner]!
      const b = indices[triangle * 3 + ((corner + 1) % 3)]!
      owner.set(key(a, b), triangle)
      stack.push(key(a, b))
    }
  }
  const opposite = (triangle: number, a: number): number => {
    for (let corner = 0; corner < 3; corner++) if (indices[triangle * 3 + corner] === a) return indices[triangle * 3 + ((corner + 2) % 3)]!
    return -1
  }
  const x = (index: number) => flat[index * 2]!
  const y = (index: number) => flat[index * 2 + 1]!
  const orientation = (a: number, b: number, c: number) => (x(b) - x(a)) * (y(c) - y(a)) - (x(c) - x(a)) * (y(b) - y(a))
  // Lawson's flips always end; the budget only guards against rounding cycling them.
  let budget = indices.length * 64
  while (stack.length > 0 && budget-- > 0) {
    const edge = stack.pop()!
    const a = Math.floor(edge / vertices)
    const b = edge - a * vertices
    const first = owner.get(key(a, b))
    const second = owner.get(key(b, a))
    if (first === undefined || second === undefined) continue
    const c = opposite(first, a)
    const d = opposite(second, b)
    // d inside the circumcircle of (a, b, c), counter-clockwise.
    const adx = x(a) - x(d)
    const ady = y(a) - y(d)
    const bdx = x(b) - x(d)
    const bdy = y(b) - y(d)
    const cdx = x(c) - x(d)
    const cdy = y(c) - y(d)
    const ad = adx * adx + ady * ady
    const bd = bdx * bdx + bdy * bdy
    const cd = cdx * cdx + cdy * cdy
    const determinant = adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx)
    if (!(determinant > 1e-9 * Math.max(ad, bd, cd) ** 2)) continue
    // The new diagonal must cross the old one: a and b on either side of c to d.
    if (!(orientation(c, d, a) < 0 && orientation(c, d, b) > 0)) continue
    for (const [from, to] of [[a, b], [b, c], [c, a], [b, a], [a, d], [d, b]] as const) owner.delete(key(from, to))
    indices[first * 3] = a
    indices[first * 3 + 1] = d
    indices[first * 3 + 2] = c
    indices[second * 3] = d
    indices[second * 3 + 1] = b
    indices[second * 3 + 2] = c
    for (const [from, to] of [[a, d], [d, c], [c, a]] as const) owner.set(key(from, to), first)
    for (const [from, to] of [[d, b], [b, c], [c, d]] as const) owner.set(key(from, to), second)
    stack.push(key(a, d), key(d, b), key(b, c), key(c, a))
  }
}

/** The edges outlined on a solid's faces, as pairs of positions: a mesh's sharp edges, or every ring's edges. */
function outlineEdges(geometry: Polygon | MultiPolygon, mesh: IndexedMesh | null): Array<[Position, Position]> {
  if (mesh !== null) {
    return meshSharpEdges(mesh, EDGE_THRESHOLD_DEGREES).map(([a, b]) => [mesh.vertices[a]!, mesh.vertices[b]!])
  }
  const edges: Array<[Position, Position]> = []
  for (const polygon of geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) {
    for (const ring of polygon) {
      const open = openRing(ring)
      for (let index = 0; index < open.length; index++) edges.push([open[index]!, open[(index + 1) % open.length]!])
    }
  }
  return edges
}

/**
 * The geometry of a solid feature, in the local frame: a mesh's faces, a polygon (or each of a multipolygon's) at an
 * altitude as a flat face, or a line string with altitudes as a line. Positions without an altitude stand at
 * `fallbackHeightMeters`.
 */
export function buildSolidGeometry(feature: DrawFeature, frame: LocalFrame, fallbackHeightMeters = 0, { coarseness = 1 }: SolidGeometryOptions = {}): SolidGeometry {
  const geometry = feature.geometry
  const heightOf = (position: Position) => (hasAltitude(position) ? position[2]! : fallbackHeightMeters)
  if (geometry.type === 'LineString') {
    const line = densify(geometry.coordinates, frame.longitudeDegrees, heightOf, false)
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new Float32BufferAttribute(line.flatMap(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height)), 3))
    return { faces: null, edges: null, line: lineGeometry, closed: false }
  }
  if (geometry.type === 'Point') return { faces: null, edges: null, line: null, closed: false }
  const soup = new TriangleSoup()
  const faces = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).map(face => prepareFace(face, frame, heightOf)).filter(face => face !== null)
  // Wider faces get longer triangles (about 4096 at most for the widest), all faces the same limit.
  let largestArea = 0
  for (const face of faces) largestArea = Math.max(largestArea, Math.hypot(...face.normal) / 2)
  const maximumEdgeMeters = Math.max(MAXIMUM_EDGE_METERS, Math.sqrt((2 * largestArea) / MAXIMUM_FACE_TRIANGLES)) * Math.max(1, coarseness)
  for (const face of faces) addFace(soup, face, frame, maximumEdgeMeters)
  const mesh = geometry.type === 'MultiPolygon' && isMeshGeometry(geometry) ? indexMesh(geometry) : null
  // The outline, split at the faces' points so it lies on them.
  const outline: number[] = []
  for (const [from, to] of outlineEdges(geometry, mesh)) {
    const a = geographicPoint(from, frame, heightOf)
    const b = geographicPoint(to, frame, heightOf)
    const aLocal = frame.toLocal(...a)
    const bLocal = frame.toLocal(...b)
    let previous = aLocal
    for (const { local } of [...splitEdge(a, b, aLocal, bLocal, maximumEdgeMeters, frame), { local: bLocal }]) {
      outline.push(...previous, ...local)
      previous = local
    }
  }
  let edges: BufferGeometry | null = null
  if (outline.length > 0) {
    edges = new BufferGeometry()
    edges.setAttribute('position', new Float32BufferAttribute(outline, 3))
  }
  // Closed and wound outwards: one side. Wound inwards, or open: both, rather than guess.
  const closed = mesh !== null && isClosedMesh(mesh) && meshVolume(mesh) > 0
  return { faces: soup.positions.length > 0 ? soup.toGeometry() : null, edges, line: null, closed }
}

/** Edge keys of `refineTriangles`: smaller × 2^26 + larger. */
const EDGE_KEY_BASE = 2 ** 26

/**
 * Splits triangles until no edge is longer than `maximumEdgeMeters` (measured level in the frame), by conforming
 * longest-edge bisection: an edge is always split in both triangles that share it, so the surface never cracks. New
 * vertices are appended to `positions` (geographic, at the middle of the edge) and `local` (in the frame, on the curve
 * of the Earth). Keeps each triangle's winding. Returns the triangles' vertex indices.
 */
export function refineTriangles(positions: Array<[number, number, number]>, local: LocalPoint[], indices: readonly number[], maximumEdgeMeters: number, frame: LocalFrame): number[] {
  const lengthSquared = (a: number, b: number) => (local[a]![0] - local[b]![0]) ** 2 + (local[a]![1] - local[b]![1]) ** 2
  const limit = maximumEdgeMeters * maximumEdgeMeters
  // Nothing to split: the common case, once edges are split and inner points added before triangulating.
  let longestSquared = 0
  for (let index = 0; index + 2 < indices.length; index += 3) {
    longestSquared = Math.max(longestSquared, lengthSquared(indices[index]!, indices[index + 1]!), lengthSquared(indices[index + 1]!, indices[index + 2]!), lengthSquared(indices[index + 2]!, indices[index]!))
  }
  if (longestSquared <= limit) return indices.slice(0, indices.length - (indices.length % 3))
  const triangles: Array<[number, number, number] | null> = []
  const edgeTriangles = new Map<number, number[]>()
  const key = (a: number, b: number) => (a < b ? a * EDGE_KEY_BASE + b : b * EDGE_KEY_BASE + a)
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
  const longest = (triangle: [number, number, number]): { corner: number; length: number; edge: number } => {
    let best = { corner: 0, length: -1, edge: Infinity }
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
  const split = (edge: number, a: number, b: number) => {
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
  /** Lets go of the translucent pass, held while there is an atmosphere (see `update`). */
  protected releaseTranslucentPass: (() => void) | null = null
  /** Whether see-through faces are on the translucent layer, which needs the pass built into a pipeline. */
  protected onTranslucentLayer = false

  constructor(protected readonly earth: Earth) {
    this.object.name = 'DrawSolids'
  }

  /** Replaces the solids. Unchanged features (same object, same colours) keep theirs. */
  setFeatures(features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    this.sync(this.solids, features)
  }

  /**
   * Replaces the previews: features changing under the pointer (a drag, a gizmo), drawn as solids alongside the others
   * and rebuilt only when their feature object changes, with coarser triangles (`PREVIEW_COARSENESS`) so a rebuild per
   * pointer move stays cheap. Pass none when the change ends: the feature then gets its full solid from `setFeatures`.
   */
  setPreviews(features: Iterable<{ feature: DrawFeature; style: DrawStyle }>): void {
    this.sync(this.previews, features, PREVIEW_COARSENESS)
  }

  protected sync(solids: Map<string, Solid>, features: Iterable<{ feature: DrawFeature; style: DrawStyle }>, coarseness = 1): void {
    const kept = new Set<string>()
    for (const { feature, style } of features) {
      kept.add(feature.id)
      const existing = solids.get(feature.id)
      if (existing !== undefined && existing.feature === feature && sameSolidStyle(existing.style, style)) continue
      // Built before the old one goes, so the shared materials it uses are kept rather than disposed and compiled again.
      solids.set(feature.id, this.createSolid(feature, style, coarseness))
      if (existing !== undefined) this.removeSolid(existing)
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
    this.releaseTranslucentPass?.()
    this.releaseTranslucentPass = null
  }

  /**
   * Call once per frame. With an atmosphere, see-through faces go on the translucent layer, drawn after the atmosphere
   * and hazed at their own distance (in the scene, a face crossing the horizon changes shade along it). They move there
   * only once a pipeline runs the translucent pass, and back when none does, so apps composing their own pipeline
   * still see them.
   */
  update(): void {
    const hasAtmosphere = this.earth.atmosphere !== null
    if (hasAtmosphere && this.releaseTranslucentPass === null) this.releaseTranslucentPass = this.earth.renderPasses.retainTranslucentPass()
    else if (!hasAtmosphere && this.releaseTranslucentPass !== null) {
      this.releaseTranslucentPass()
      this.releaseTranslucentPass = null
    }
    const translucent = hasAtmosphere && this.earth.renderPasses.isBuilt(TRANSLUCENT_RENDER_PASS_NAME)
    if (translucent === this.onTranslucentLayer) return
    this.onTranslucentLayer = translucent
    this.object.traverse(object => this.placeOnLayer(object))
    this.earth.requestFrame()
  }

  protected placeOnLayer(object: Object3D): void {
    const mesh = object as Mesh
    if (mesh.isMesh !== true || !(mesh.material as MeshStandardNodeMaterial).transparent) return
    mesh.layers.set(this.onTranslucentLayer ? TRANSLUCENT_LAYER : 0)
  }

  protected createSolid(feature: DrawFeature, style: DrawStyle, coarseness = 1): Solid {
    const [longitudeDegrees, latitudeDegrees, heightMeters] = anchorPosition(feature)
    const anchor = this.earth.createGeographicAnchor({ longitudeDegrees, latitudeDegrees, heightMeters })
    this.object.add(anchor)
    const solid: Solid = { feature, style, anchor, owned: [], materialKey: null }
    const add = (object: Object3D, geometry: BufferGeometry) => {
      this.placeOnLayer(object)
      solid.owned.push(geometry)
      anchor.add(object)
    }
    const frame = new LocalFrame(longitudeDegrees, latitudeDegrees, heightMeters)
    const { faces, edges, line, closed } = buildSolidGeometry(feature, frame, heightMeters, { coarseness })
    // Closed solids show their outside only, so transparent faces never blend with the far side; open faces show both.
    const shared = this.acquireMaterials(style, !closed)
    solid.materialKey = shared.key
    if (faces !== null) {
      add(new Mesh(faces, shared.material), faces)
    }
    if (edges !== null) add(new LineSegments(edges, shared.edgeMaterial), edges)
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
