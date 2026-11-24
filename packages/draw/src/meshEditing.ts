import earcut from 'earcut'
import type { Position } from 'geojson'

import { unwrapLongitudeNear } from './geometry.js'
import { LocalFrame, type LocalPoint } from './localFrame.js'
import { newellNormal, type IndexedMesh } from './mesh.js'

/**
 * Editing a mesh's elements, as Blender's edit mode does: moving vertices (and the edges and faces they make), pushing a
 * face along its normal, extruding a face. Each works on an `IndexedMesh` (`indexMesh`) and returns a new one whose
 * vertex indices and face indices are those of the input (new vertices and faces come after), so an element picked
 * before an edit is the same element after it. `meshFromIndexed` turns the result back into a `MultiPolygon`.
 */

/** Below this (metres), a face that was planar and is no longer gets split into triangles: 1 mm, or a millionth of its size. */
const PLANAR_TOLERANCE_METERS = 1e-3
const PLANAR_TOLERANCE_SHARE = 1e-6
/** Neighbours closer than this to a face's plane (metres) do not limit how far it is pushed in: they lie beside it. */
const BESIDE_FACE_METERS = 1e-3

/** Each vertex index of a face once: its exterior ring, then its holes. */
export function meshFaceVertices(mesh: IndexedMesh, faceIndex: number): number[] {
  const face = mesh.faces[faceIndex]
  if (face === undefined) throw new Error(`meshFaceVertices: the mesh has no face ${faceIndex}; give an index below ${mesh.faces.length}.`)
  return [...new Set(face.flat())]
}

/**
 * The east-north-up frame at the middle of some vertices of a mesh (the mean of their longitudes, unwrapped, latitudes
 * and altitudes): the frame element edits measure their offsets and normals in.
 */
export function meshElementFrame(mesh: IndexedMesh, vertexIndices: readonly number[]): LocalFrame {
  if (vertexIndices.length === 0) throw new Error('meshElementFrame: give at least one vertex index.')
  const reference = mesh.vertices[vertexIndices[0]!]![0]!
  let longitude = 0
  let latitude = 0
  let altitude = 0
  for (const index of vertexIndices) {
    const position = mesh.vertices[index]!
    longitude += unwrapLongitudeNear(position[0]!, reference)
    latitude += position[1]!
    altitude += position[2] ?? 0
  }
  const count = vertexIndices.length
  return new LocalFrame(longitude / count, latitude / count, altitude / count)
}

function toLocal(frame: LocalFrame, position: Position): LocalPoint {
  return frame.toLocal(position[0]!, position[1]!, position[2] ?? 0)
}

/**
 * The outward unit normal of a face (its exterior ring counter-clockwise seen from outside, by the right-hand rule), in
 * `frame` (default: `meshElementFrame` of the face). [0, 0, 0] for a face without area.
 */
export function meshFaceNormal(mesh: IndexedMesh, faceIndex: number, frame: LocalFrame = meshElementFrame(mesh, meshFaceVertices(mesh, faceIndex))): LocalPoint {
  const ring = mesh.faces[faceIndex]?.[0] ?? []
  const normal = newellNormal(ring.map(index => toLocal(frame, mesh.vertices[index]!)))
  const length = Math.hypot(normal[0], normal[1], normal[2])
  return length > 0 ? [normal[0] / length, normal[1] / length, normal[2] / length] : [0, 0, 0]
}

/** The area of a face in square metres (its exterior less its holes). */
export function meshFaceArea(mesh: IndexedMesh, faceIndex: number): number {
  const face = mesh.faces[faceIndex] ?? []
  const frame = meshElementFrame(mesh, meshFaceVertices(mesh, faceIndex))
  const normal = meshFaceNormal(mesh, faceIndex, frame)
  let area = 0
  face.forEach((ring, ringIndex) => {
    const ringNormal = newellNormal(ring.map(index => toLocal(frame, mesh.vertices[index]!)))
    const signed = (ringNormal[0] * normal[0] + ringNormal[1] * normal[1] + ringNormal[2] * normal[2]) / 2
    area += ringIndex === 0 ? Math.abs(signed) : -Math.abs(signed)
  })
  return Math.max(0, area)
}

/** The points of a face in a frame, ring by ring. */
function facePoints(vertices: readonly Position[], face: readonly number[][], frame: LocalFrame): LocalPoint[][] {
  return face.map(ring => ring.map(index => toLocal(frame, vertices[index]!)))
}

/** How far the points of a face stray from the plane through their exterior's middle across its normal, in metres. */
function planarityDeviation(points: readonly LocalPoint[][]): number {
  const exterior = points[0] ?? []
  const normal = newellNormal(exterior)
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!(length > 0)) return 0
  const center = [0, 0, 0]
  for (const point of exterior) for (let axis = 0; axis < 3; axis++) center[axis]! += point[axis]! / exterior.length
  let deviation = 0
  for (const ring of points) {
    for (const point of ring) {
      const distance = Math.abs((point[0] - center[0]!) * normal[0] + (point[1] - center[1]!) * normal[1] + (point[2] - center[2]!) * normal[2]) / length
      if (distance > deviation) deviation = distance
    }
  }
  return deviation
}

/** The largest distance between the exterior points of a face, roughly: its bounding box's diagonal. */
function faceSize(points: readonly LocalPoint[][]): number {
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  for (const point of points[0] ?? []) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis]!, point[axis]!)
      maximum[axis] = Math.max(maximum[axis]!, point[axis]!)
    }
  }
  return Math.hypot(maximum[0]! - minimum[0]!, maximum[1]! - minimum[1]!, maximum[2]! - minimum[2]!)
}

/**
 * The triangles of a face (its holes left out), as vertex index triples wound like the face: counter-clockwise seen
 * from outside. Measured in `frame` (default: the face's own), across the face's normal.
 */
export function meshFaceTriangles(mesh: IndexedMesh, faceIndex: number, frame?: LocalFrame): Array<[number, number, number]> {
  const face = mesh.faces[faceIndex] ?? []
  return triangulateFace(mesh.vertices, face, frame ?? meshElementFrame(mesh, meshFaceVertices(mesh, faceIndex)))
}

function triangulateFace(vertices: readonly Position[], face: readonly number[][], frame: LocalFrame): Array<[number, number, number]> {
  const points = facePoints(vertices, face, frame)
  const normal = newellNormal(points[0] ?? [])
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!(length > 0)) return []
  const n: LocalPoint = [normal[0] / length, normal[1] / length, normal[2] / length]
  // Two axes across the normal: the face seen along it.
  const helper: LocalPoint = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const u = normalize(cross(helper, n))
  const v = cross(n, u)
  const flat: number[] = []
  const holes: number[] = []
  const indices: number[] = []
  points.forEach((ring, ringIndex) => {
    if (ringIndex > 0) holes.push(indices.length)
    ring.forEach((point, pointIndex) => {
      flat.push(dot(point, u), dot(point, v))
      indices.push(face[ringIndex]![pointIndex]!)
    })
  })
  const triangles = earcut(flat, holes.length > 0 ? holes : undefined, 2)
  const result: Array<[number, number, number]> = []
  const all = points.flat()
  for (let index = 0; index + 2 < triangles.length; index += 3) {
    const a = triangles[index]!
    const b = triangles[index + 1]!
    const c = triangles[index + 2]!
    // Wound like the face: its normal along the face's.
    const winding = dot(cross(subtract(all[b]!, all[a]!), subtract(all[c]!, all[a]!)), n)
    result.push(winding >= 0 ? [indices[a]!, indices[b]!, indices[c]!] : [indices[a]!, indices[c]!, indices[b]!])
  }
  return result
}

/**
 * The mesh with some vertices moved by `offset` (metres east, north and up in `frame`, by default `meshElementFrame` of
 * those vertices): moving a vertex shared by several faces moves it in each, so the faces stay joined. A face moved
 * whole stays planar; a face only partly moved that is no longer planar (a box's top with one corner raised) is split
 * into triangles, the first in its place and the others after the last face, so face indices hold. Vertex indices hold
 * too.
 */
export function moveMeshVertices(mesh: IndexedMesh, vertexIndices: readonly number[], offset: readonly [number, number, number], frame?: LocalFrame): IndexedMesh {
  if (!offset.every(Number.isFinite)) throw new Error(`moveMeshVertices: the offset is ${offset.join(', ')}; give finite metres east, north and up.`)
  for (const index of vertexIndices) {
    if (mesh.vertices[index] === undefined) throw new Error(`moveMeshVertices: the mesh has no vertex ${index}; give indices below ${mesh.vertices.length}.`)
  }
  const moved = new Set(vertexIndices)
  if (moved.size === 0 || (offset[0] === 0 && offset[1] === 0 && offset[2] === 0)) return mesh
  const measure = frame ?? meshElementFrame(mesh, [...moved])
  const vertices = mesh.vertices.slice()
  for (const index of moved) {
    const local = toLocal(measure, vertices[index]!)
    vertices[index] = measure.toGeographic(local[0] + offset[0], local[1] + offset[1], local[2] + offset[2])
  }
  const faces = mesh.faces.slice()
  const extra: number[][][] = []
  mesh.faces.forEach((face, faceIndex) => {
    let count = 0
    let total = 0
    for (const ring of face) {
      for (const index of ring) {
        total++
        if (moved.has(index)) count++
      }
    }
    if (count === 0 || count === total) return
    const before = facePoints(mesh.vertices, face, measure)
    const after = facePoints(vertices, face, measure)
    const tolerance = Math.max(PLANAR_TOLERANCE_METERS, faceSize(after) * PLANAR_TOLERANCE_SHARE)
    if (planarityDeviation(after) <= planarityDeviation(before) + tolerance) return
    const triangles = triangulateFace(vertices, face, measure)
    if (triangles.length === 0) return
    faces[faceIndex] = [triangles[0]!]
    for (const triangle of triangles.slice(1)) extra.push([triangle])
  })
  return { vertices, faces: extra.length > 0 ? [...faces, ...extra] : faces }
}

/** The vertices joined by an edge to a face's vertices, outside the face. */
function neighboursOfFace(mesh: IndexedMesh, faceIndex: number): Set<number> {
  const inFace = new Set(meshFaceVertices(mesh, faceIndex))
  const neighbours = new Set<number>()
  for (const face of mesh.faces) {
    for (const ring of face) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!
        const b = ring[(index + 1) % ring.length]!
        if (inFace.has(a) && !inFace.has(b)) neighbours.add(b)
        if (inFace.has(b) && !inFace.has(a)) neighbours.add(a)
      }
    }
  }
  return neighbours
}

/**
 * The mesh with a face moved `distanceMeters` along its outward normal (negative: inwards): the faces around it stretch,
 * as a box grows when its top is pulled. Pushed in, the face stops `minimumGapMeters` short of the nearest vertex joined
 * to it behind it (a box's bottom), so the solid never turns inside out.
 */
export function pushMeshFace(mesh: IndexedMesh, faceIndex: number, distanceMeters: number, minimumGapMeters = 0.01): IndexedMesh {
  if (!Number.isFinite(distanceMeters)) throw new Error(`pushMeshFace: distanceMeters is ${distanceMeters}; give a finite number of metres.`)
  const indices = meshFaceVertices(mesh, faceIndex)
  const frame = meshElementFrame(mesh, indices)
  const normal = meshFaceNormal(mesh, faceIndex, frame)
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return mesh
  const center = [0, 0, 0]
  for (const index of indices) {
    const point = toLocal(frame, mesh.vertices[index]!)
    for (let axis = 0; axis < 3; axis++) center[axis]! += point[axis]! / indices.length
  }
  let nearestBehind = -Infinity
  for (const index of neighboursOfFace(mesh, faceIndex)) {
    const point = toLocal(frame, mesh.vertices[index]!)
    const along = (point[0] - center[0]!) * normal[0] + (point[1] - center[1]!) * normal[1] + (point[2] - center[2]!) * normal[2]
    if (along < -BESIDE_FACE_METERS) nearestBehind = Math.max(nearestBehind, along)
  }
  const distance = Number.isFinite(nearestBehind) ? Math.max(distanceMeters, nearestBehind + minimumGapMeters) : distanceMeters
  return moveMeshVertices(mesh, indices, [normal[0] * distance, normal[1] * distance, normal[2] * distance], frame)
}

/**
 * The mesh with a face extruded `distanceMeters` along its outward normal (negative: into the solid), as Blender's
 * extrude: the face moves out on new vertices and a four-sided wall joins each of its edges to where it was, wound to
 * face outwards. The moved face keeps its index (pick it again to push it further); the walls come after the last
 * face, and the new vertices after the last vertex.
 */
export function extrudeMeshFace(mesh: IndexedMesh, faceIndex: number, distanceMeters: number): IndexedMesh {
  if (!Number.isFinite(distanceMeters) || distanceMeters === 0) {
    throw new Error(`extrudeMeshFace: distanceMeters is ${distanceMeters}; give a finite number of metres other than 0 (negative extrudes inwards).`)
  }
  const indices = meshFaceVertices(mesh, faceIndex)
  const frame = meshElementFrame(mesh, indices)
  const normal = meshFaceNormal(mesh, faceIndex, frame)
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) throw new Error(`extrudeMeshFace: face ${faceIndex} has no area; pick a face with three or more distinct vertices.`)
  const vertices = mesh.vertices.slice()
  const copies = new Map<number, number>()
  for (const index of indices) {
    const local = toLocal(frame, mesh.vertices[index]!)
    copies.set(index, vertices.push(frame.toGeographic(local[0] + normal[0] * distanceMeters, local[1] + normal[1] * distanceMeters, local[2] + normal[2] * distanceMeters)) - 1)
  }
  const face = mesh.faces[faceIndex]!
  const faces = mesh.faces.slice()
  faces[faceIndex] = face.map(ring => ring.map(index => copies.get(index)!))
  // Along each edge (a to b, counter-clockwise seen from outside), then out: the wall faces away from the face's inside.
  for (const ring of face) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index]!
      const b = ring[(index + 1) % ring.length]!
      faces.push([[a, b, copies.get(b)!, copies.get(a)!]])
    }
  }
  return { vertices, faces }
}

function cross(a: LocalPoint, b: LocalPoint): LocalPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: LocalPoint, b: LocalPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function subtract(a: LocalPoint, b: LocalPoint): LocalPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function normalize(a: LocalPoint): LocalPoint {
  const length = Math.hypot(a[0], a[1], a[2])
  return [a[0] / length, a[1] / length, a[2] / length]
}
