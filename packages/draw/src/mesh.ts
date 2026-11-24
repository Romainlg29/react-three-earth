import type { MultiPolygon, Position } from 'geojson'

import { hasAltitude } from './geometry.js'
import { LocalFrame, type LocalPoint } from './localFrame.js'
import type { DrawFeature, DrawGeometry } from './types.js'

/**
 * Meshes: solids stored as their faces only, the way Blender stores them.
 *
 * A mesh is a GeoJSON `MultiPolygon` whose every position has a third coordinate, its altitude in metres above the
 * WGS84 ellipsoid. Each polygon is one planar face (a prism's bottom, its top, each wall; a sphere's quads and
 * triangles), its exterior ring counter-clockwise seen from outside the solid, so its normal (right-hand rule) points
 * outwards. A face may have holes, clockwise seen from outside. Vertices are shared between faces by equal
 * coordinates. Nothing else describes the solid: moving, turning or scaling it writes new vertex positions.
 */

/** A feature holding a mesh. */
export type MeshFeature = DrawFeature<MultiPolygon>

/**
 * A mesh with each vertex once: `vertices` are the distinct positions (equal coordinates are one vertex), `faces[face][ring]`
 * the indices of a face's rings in order, without the closing position.
 */
export interface IndexedMesh {
  vertices: Position[]
  faces: number[][][]
}

declare const meshBrand: unique symbol

/**
 * A multipolygon `isMeshGeometry` found to be a mesh. The brand exists only for the type checker, so a multipolygon
 * that is not a mesh keeps its type where `isMeshGeometry` returns false.
 */
export type MeshGeometry = MultiPolygon & { readonly [meshBrand]: true }

/**
 * Whether a geometry is a mesh: a multipolygon with an altitude on every position that looks like a solid's surface,
 * with at least one steep face (steeper than 60°: a wall, a sphere's side) or closed (`isClosedMesh`). Any other
 * multipolygon is a set of flat polygons: draped on the terrain, or standing at their altitudes when they have them
 * (like a polygon with altitudes, even lifted over relief), and placing it back on the terrain drapes it again.
 */
export function isMeshGeometry(geometry: DrawGeometry): geometry is MeshGeometry {
  if (geometry.type !== 'MultiPolygon' || geometry.coordinates.length === 0) return false
  for (const polygon of geometry.coordinates) {
    if (polygon.length === 0) return false
    for (const ring of polygon) {
      if (ring.length < 3) return false
      for (const position of ring) if (!hasAltitude(position)) return false
    }
  }
  return geometry.coordinates.some(isSteepFace) || isClosedMesh(indexMesh(geometry))
}

/** The cosine of 60°: a face whose unit normal points less upwards than this is steep. */
const STEEP_FACE_UP = 0.5

/** Whether a face (with altitudes) is steeper than 60°: its normal, in the frame at its first vertex, points that far from up. */
function isSteepFace(polygon: readonly Position[][]): boolean {
  const ring = openRing(polygon[0] ?? [])
  if (ring.length < 3) return false
  const first = ring[0]!
  const frame = new LocalFrame(first[0]!, first[1]!, first[2]!)
  const normal = newellNormal(ring.map(position => frame.toLocal(position[0]!, position[1]!, position[2]!)))
  const length = Math.hypot(...normal)
  return length > 0 && Math.abs(normal[2]) < STEEP_FACE_UP * length
}

/** Whether a feature is a mesh (see `isMeshGeometry`). */
export function isMeshFeature(feature: Pick<DrawFeature, 'geometry'>): feature is MeshFeature {
  return isMeshGeometry(feature.geometry)
}

/** A ring without its closing position (the first, repeated at the end). */
export function openRing<P extends Position>(ring: readonly P[]): P[] {
  if (ring.length > 1 && samePosition(ring[0]!, ring[ring.length - 1]!)) return ring.slice(0, -1)
  return [...ring]
}

/** A ring with its first position repeated at the end (a copy). */
function closedRing(ring: readonly Position[]): Position[] {
  return ring.length === 0 ? [] : [...ring, [...ring[0]!]]
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1] && (a[2] ?? null) === (b[2] ?? null)
}

/** A number for a position, equal for equal positions: a hash, so different positions may share it. */
function positionHash(position: Position): number {
  return position[0]! * 92_821 + position[1]! * 1_000_003 + (position[2] ?? 0.5) * 7.919
}

/** The faces of a mesh, each as its rings without their closing position. */
export function meshFaces(geometry: MultiPolygon): Position[][][] {
  return geometry.coordinates.map(polygon => polygon.map(ring => openRing(ring)))
}

/** The mesh with each vertex once, shared by the faces that use it (equal coordinates make one vertex). */
export function indexMesh(geometry: MultiPolygon): IndexedMesh {
  const vertices: Position[] = []
  // The vertices with each hash: almost always one.
  const buckets = new Map<number, number | number[]>()
  const indexOf = (position: Position): number => {
    const hash = positionHash(position)
    const bucket = buckets.get(hash)
    if (bucket === undefined) {
      buckets.set(hash, vertices.length)
      return vertices.push(position) - 1
    }
    const candidates = typeof bucket === 'number' ? [bucket] : bucket
    for (const candidate of candidates) if (samePosition(vertices[candidate]!, position)) return candidate
    const index = vertices.push(position) - 1
    buckets.set(hash, [...candidates, index])
    return index
  }
  const faces = geometry.coordinates.map(polygon => polygon.map(ring => openRing(ring).map(indexOf)))
  return { vertices, faces }
}

/** The multipolygon of an indexed mesh: each face's rings closed, positions copied. */
export function meshFromIndexed(mesh: IndexedMesh): MultiPolygon {
  return { type: 'MultiPolygon', coordinates: mesh.faces.map(face => face.map(ring => closedRing(ring.map(index => [...mesh.vertices[index]!])))) }
}

/** Each edge of a mesh once, as the indices of its two vertices (the smaller first). */
export function meshEdges(mesh: IndexedMesh): Array<[number, number]> {
  const seen = new Set<number>()
  const edges: Array<[number, number]> = []
  const count = mesh.vertices.length
  for (const face of mesh.faces) {
    for (const ring of face) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!
        const b = ring[(index + 1) % ring.length]!
        if (a === b) continue
        const edge: [number, number] = a < b ? [a, b] : [b, a]
        const key = edge[0] * count + edge[1]
        if (seen.has(key)) continue
        seen.add(key)
        edges.push(edge)
      }
    }
  }
  return edges
}

/**
 * Whether a mesh is closed with a consistent winding: every edge is used by exactly two faces, once in each direction.
 * Its faces then all face outwards, or all inwards (`meshVolume` tells which).
 */
export function isClosedMesh(mesh: IndexedMesh): boolean {
  // Each directed edge (a to b) as a × vertices + b, counted.
  const directed = new Map<number, number>()
  const vertices = mesh.vertices.length
  for (const face of mesh.faces) {
    for (const ring of face) {
      for (let index = 0; index < ring.length; index++) {
        const key = ring[index]! * vertices + ring[(index + 1) % ring.length]!
        directed.set(key, (directed.get(key) ?? 0) + 1)
      }
    }
  }
  if (directed.size === 0) return false
  for (const [key, count] of directed) {
    if (count !== 1) return false
    const a = Math.floor(key / vertices)
    const b = key - a * vertices
    if (directed.get(b * vertices + a) !== 1) return false
  }
  return true
}

/** The frame meshes are measured in: east-north-up at the first vertex. */
function meshFrame(vertices: readonly Position[]): LocalFrame {
  const first = vertices[0] ?? [0, 0, 0]
  return new LocalFrame(first[0]!, first[1]!, first[2] ?? 0)
}

/**
 * The signed volume of a mesh, in cubic metres: positive when its faces wind counter-clockwise seen from outside (the
 * convention), negative when they all face inwards. Only meaningful for a closed mesh.
 */
export function meshVolume(mesh: IndexedMesh): number {
  const frame = meshFrame(mesh.vertices)
  const local = mesh.vertices.map(position => frame.toLocal(position[0]!, position[1]!, position[2] ?? 0))
  let volume = 0
  for (const face of mesh.faces) {
    for (const ring of face) {
      const a = local[ring[0]!]!
      for (let index = 1; index + 1 < ring.length; index++) {
        const b = local[ring[index]!]!
        const c = local[ring[index + 1]!]!
        volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
      }
    }
  }
  return volume / 6
}

/** Newell's normal of a ring (not normalised): its length is twice the ring's area. */
export function newellNormal(ring: readonly LocalPoint[]): LocalPoint {
  let x = 0
  let y = 0
  let z = 0
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    x += (a[1] - b[1]) * (a[2] + b[2])
    y += (a[2] - b[2]) * (a[0] + b[0])
    z += (a[0] - b[0]) * (a[1] + b[1])
  }
  return [x, y, z]
}

/**
 * The edges worth outlining: those on the boundary of an open mesh (one face) and those between faces meeting at more
 * than `thresholdDegrees` (a box's twelve edges, a cylinder's rims, none on a sphere).
 */
export function meshSharpEdges(mesh: IndexedMesh, thresholdDegrees = 30): Array<[number, number]> {
  const frame = meshFrame(mesh.vertices)
  const local = mesh.vertices.map(position => frame.toLocal(position[0]!, position[1]!, position[2] ?? 0))
  const normals = mesh.faces.map(face => {
    const normal = newellNormal((face[0] ?? []).map(index => local[index]!))
    const length = Math.hypot(...normal)
    return length > 0 ? normal.map(value => value / length) : [0, 0, 0]
  })
  // Each edge as smaller × vertices + larger, with the faces using it.
  const edgeFaces = new Map<number, number[]>()
  const count = mesh.vertices.length
  mesh.faces.forEach((face, faceIndex) => {
    for (const ring of face) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!
        const b = ring[(index + 1) % ring.length]!
        if (a === b) continue
        const key = a < b ? a * count + b : b * count + a
        const list = edgeFaces.get(key)
        if (list === undefined) edgeFaces.set(key, [faceIndex])
        else list.push(faceIndex)
      }
    }
  })
  const cosine = Math.cos((thresholdDegrees * Math.PI) / 180)
  const edges: Array<[number, number]> = []
  for (const [key, faces] of edgeFaces) {
    const sharp = faces.length !== 2 || dot(normals[faces[0]!]!, normals[faces[1]!]!) < cosine
    if (!sharp) continue
    const a = Math.floor(key / count)
    edges.push([a, key - a * count])
  }
  return edges
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

/** The lowest and highest altitudes of a mesh's positions. */
export function meshAltitudeRange(geometry: MultiPolygon): { minimumMeters: number; maximumMeters: number } {
  let minimumMeters = Infinity
  let maximumMeters = -Infinity
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      for (const position of ring) {
        const altitude = position[2] ?? 0
        if (altitude < minimumMeters) minimumMeters = altitude
        if (altitude > maximumMeters) maximumMeters = altitude
      }
    }
  }
  return { minimumMeters, maximumMeters }
}

/** Altitudes this close to the top count as the top (metres): a face built at one altitude stays level through edits. */
const LEVEL_TOLERANCE_METERS = 1e-6

/**
 * The top of a mesh with a level top face (a prism's): its altitude, and the highest altitude below it (the base of the
 * shortest wall). Null for a mesh without a face whose every vertex is at the highest altitude (a sphere, a wall).
 */
export function meshTop(geometry: MultiPolygon): { topMeters: number; belowMeters: number } | null {
  const { maximumMeters } = meshAltitudeRange(geometry)
  const atTop = (position: Position) => Math.abs((position[2] ?? 0) - maximumMeters) <= LEVEL_TOLERANCE_METERS
  const hasTopFace = geometry.coordinates.some(polygon => openRing(polygon[0] ?? []).length >= 3 && polygon.every(ring => ring.every(atTop)))
  if (!hasTopFace) return null
  let belowMeters = -Infinity
  for (const polygon of geometry.coordinates) for (const ring of polygon) for (const position of ring) if (!atTop(position)) belowMeters = Math.max(belowMeters, position[2] ?? 0)
  return Number.isFinite(belowMeters) ? { topMeters: maximumMeters, belowMeters } : null
}

/**
 * The mesh with its top vertices (those at its highest altitude) moved to `topMeters`, kept at least `minimumGapMeters`
 * above every other vertex. Returns the geometry unchanged when it has no level top face (`meshTop`).
 */
export function setMeshTop(geometry: MultiPolygon, topMeters: number, minimumGapMeters = 1): MultiPolygon {
  const top = meshTop(geometry)
  if (top === null) return geometry
  const next = Math.max(topMeters, top.belowMeters + minimumGapMeters)
  const move = (position: Position): Position => (Math.abs((position[2] ?? 0) - top.topMeters) <= LEVEL_TOLERANCE_METERS ? [position[0]!, position[1]!, next] : position)
  return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(move))) }
}

/** The altitude of a base vertex, from its position (longitude, latitude, and the altitude it may already have). */
export type BaseHeightOf = (position: Position) => number

/**
 * Twice the signed area of a ring seen from above, in square metres: positive when counter-clockwise. Measured in the
 * east-north-up frame at the ring's middle (the mean of its directions from the Earth's centre), so it holds for a
 * ring around a pole or across the antimeridian, where plain degrees give noise.
 */
export function signedAreaFromAbove(ring: readonly Position[]): number {
  let x = 0
  let y = 0
  let z = 0
  for (const position of ring) {
    const longitude = (position[0]! * Math.PI) / 180
    const latitude = (position[1]! * Math.PI) / 180
    x += Math.cos(latitude) * Math.cos(longitude)
    y += Math.cos(latitude) * Math.sin(longitude)
    z += Math.sin(latitude)
  }
  const middleLongitude = (Math.atan2(y, x) * 180) / Math.PI
  const middleLatitude = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI
  const frame = new LocalFrame(middleLongitude, middleLatitude, 0)
  const local = ring.map(position => frame.toLocal(position[0]!, position[1]!, 0))
  let area = 0
  for (let index = 0; index < local.length; index++) {
    const a = local[index]!
    const b = local[(index + 1) % local.length]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area
}

function requireHeight(name: string, heightMeters: number): void {
  if (!(heightMeters > 0) || !Number.isFinite(heightMeters)) throw new Error(`${name}: heightMeters is ${heightMeters}; give a positive number of metres.`)
}

/**
 * A closed prism: the polygon `rings` (an exterior and holes, closed or not; altitudes ignored) with its bottom at the
 * altitude `baseOf` gives each vertex (the terrain under it, say) and a level top `heightMeters` above the highest of
 * them, so the shortest wall is that tall. Faces: the top (counter-clockwise from above), the bottom (clockwise from
 * above, so it faces down) and a wall per edge, all facing outwards whatever the rings' winding.
 */
export function prismMesh(rings: readonly (readonly Position[])[], baseOf: BaseHeightOf | number, heightMeters: number): MultiPolygon {
  requireHeight('prismMesh', heightMeters)
  const base: BaseHeightOf = typeof baseOf === 'number' ? () => baseOf : baseOf
  const oriented = rings
    .map(ring => openRing(ring))
    .filter(ring => ring.length >= 3)
    .map((ring, ringIndex) => {
      // The exterior counter-clockwise and the holes clockwise, seen from above.
      const counterClockwise = signedAreaFromAbove(ring) > 0
      const ordered = counterClockwise === (ringIndex === 0) ? ring : [...ring].reverse()
      return ordered.map(position => [position[0]!, position[1]!, base(position)] as Position)
    })
  if (oriented.length === 0) throw new Error('prismMesh: give a ring of 3 or more distinct positions.')
  let highest = -Infinity
  for (const ring of oriented) for (const position of ring) highest = Math.max(highest, position[2]!)
  const topMeters = highest + heightMeters
  const tops = oriented.map(ring => ring.map(position => [position[0]!, position[1]!, topMeters] as Position))
  const faces: Position[][][] = [tops.map(closedRing), oriented.map(ring => closedRing([...ring].reverse()))]
  oriented.forEach((ring, ringIndex) => {
    const top = tops[ringIndex]!
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length
      // Counter-clockwise seen from outside: along the bottom edge, then up.
      faces.push([closedRing([ring[index]!, ring[next]!, top[next]!, top[index]!])])
    }
  })
  return { type: 'MultiPolygon', coordinates: copyPositions(faces) }
}

/**
 * A wall along a line (altitudes ignored): a quad per segment from the altitude `baseOf` gives each vertex up to
 * `heightMeters` above it, so the top follows the base. An open mesh: each quad winds counter-clockwise seen from the
 * right of the line's direction.
 */
export function wallMesh(line: readonly Position[], baseOf: BaseHeightOf | number, heightMeters: number): MultiPolygon {
  requireHeight('wallMesh', heightMeters)
  if (line.length < 2) throw new Error('wallMesh: give a line of 2 or more positions.')
  const base: BaseHeightOf = typeof baseOf === 'number' ? () => baseOf : baseOf
  const bottom = line.map(position => [position[0]!, position[1]!, base(position)] as Position)
  const top = bottom.map(position => [position[0]!, position[1]!, position[2]! + heightMeters] as Position)
  const faces: Position[][][] = []
  for (let index = 0; index + 1 < bottom.length; index++) faces.push([closedRing([bottom[index]!, bottom[index + 1]!, top[index + 1]!, top[index]!])])
  return { type: 'MultiPolygon', coordinates: copyPositions(faces) }
}

/** Options of `sphereMesh`. */
export interface SphereMeshOptions {
  /** Faces around the equator. Default: 24. */
  segments?: number
  /** Bands from pole to pole. Default: 12. */
  rings?: number
}

/**
 * A UV sphere of `radiusMeters` centred `centerHeightMeters` above the ellipsoid at `center`, built in the local
 * east-north-up frame there: a triangle fan at each pole and quads between (each planar), all facing outwards. A closed
 * mesh of `segments × rings` faces.
 */
export function sphereMesh(center: readonly number[], radiusMeters: number, centerHeightMeters: number, { segments = 24, rings = 12 }: SphereMeshOptions = {}): MultiPolygon {
  if (!(radiusMeters > 0) || !Number.isFinite(radiusMeters)) throw new Error(`sphereMesh: radiusMeters is ${radiusMeters}; give a positive number of metres.`)
  if (!Number.isInteger(segments) || segments < 3 || !Number.isInteger(rings) || rings < 2) {
    throw new Error(`sphereMesh: segments is ${segments} and rings ${rings}; give whole numbers, at least 3 segments and 2 rings.`)
  }
  const frame = new LocalFrame(center[0]!, center[1]!, centerHeightMeters)
  const at = (east: number, north: number, up: number): Position => frame.toGeographic(east, north, up)
  const top = at(0, 0, radiusMeters)
  const bottom = at(0, 0, -radiusMeters)
  // Each vertex once, so faces share equal coordinates.
  const bands: Position[][] = []
  for (let ring = 1; ring < rings; ring++) {
    const polar = (Math.PI * ring) / rings
    const band: Position[] = []
    for (let segment = 0; segment < segments; segment++) {
      const azimuth = (2 * Math.PI * segment) / segments
      band.push(at(radiusMeters * Math.sin(polar) * Math.cos(azimuth), radiusMeters * Math.sin(polar) * Math.sin(azimuth), radiusMeters * Math.cos(polar)))
    }
    bands.push(band)
  }
  const faces: Position[][][] = []
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments
    // Counter-clockwise seen from outside: around the pole eastwards then northwards (azimuth grows), downwards on the sides.
    faces.push([closedRing([top, bands[0]![segment]!, bands[0]![next]!])])
    for (let band = 0; band + 1 < bands.length; band++) {
      faces.push([closedRing([bands[band]![segment]!, bands[band + 1]![segment]!, bands[band + 1]![next]!, bands[band]![next]!])])
    }
    const last = bands[bands.length - 1]!
    faces.push([closedRing([last[segment]!, bottom, last[next]!])])
  }
  return { type: 'MultiPolygon', coordinates: copyPositions(faces) }
}

/** Every position its own array, so editing one face's copy never changes another's. */
function copyPositions(faces: Position[][][]): Position[][][] {
  return faces.map(face => face.map(ring => ring.map(position => [...position])))
}
