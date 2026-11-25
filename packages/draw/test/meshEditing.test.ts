import type { Polygon } from 'geojson'
import { describe, expect, it } from 'vitest'

import { moveVertices } from '../src/editing.js'
import { LocalFrame } from '../src/localFrame.js'
import { indexMesh, isClosedMesh, isMeshGeometry, meshFromIndexed, meshVolume, prismMesh, wallMesh, type IndexedMesh } from '../src/mesh.js'
import { extrudeMeshEdges, extrudeMeshFace, extrudeMeshFaces, meshElementFrame, meshFaceArea, meshFaceNormal, meshFaceTriangles, meshFaceVertices, moveMeshVertices, pushMeshFace } from '../src/meshEditing.js'
import type { DrawFeature } from '../src/types.js'

/** A box 100 m east, 50 m north and 30 m tall standing at 400 m, its south-west corner at 6.6° E, 46.45° N. */
function box(): IndexedMesh {
  const frame = new LocalFrame(6.6, 46.45, 0)
  const corner = (east: number, north: number) => frame.toGeographic(east, north, 0).slice(0, 2)
  return indexMesh(prismMesh([[corner(0, 0), corner(100, 0), corner(100, 50), corner(0, 50)]], 400, 30))
}

/** Every face of a mesh within `tolerance` metres of planar. */
function planar(mesh: IndexedMesh, tolerance = 0.02): boolean {
  const frame = meshElementFrame(mesh, [0])
  return mesh.faces.every((_, faceIndex) => {
    const normal = meshFaceNormal(mesh, faceIndex, frame)
    const points = meshFaceVertices(mesh, faceIndex).map(index => frame.toLocal(...(mesh.vertices[index] as [number, number, number])))
    const offsets = points.map(point => point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2])
    return Math.max(...offsets) - Math.min(...offsets) <= tolerance
  })
}

describe('mesh element editing', () => {
  it('finds a face\'s vertices, outward normal, area and triangles', () => {
    const mesh = box()
    expect(meshFaceVertices(mesh, 0)).toHaveLength(4)
    const top = meshFaceNormal(mesh, 0)
    expect(top[2]).toBeCloseTo(1, 6)
    expect(meshFaceNormal(mesh, 1)[2]).toBeCloseTo(-1, 6)
    // 430 m up the top is a little larger than its footprint (R + 430 m over R, squared).
    expect(meshFaceArea(mesh, 0) / 5000).toBeCloseTo(1, 3)
    const triangles = meshFaceTriangles(mesh, 0)
    expect(triangles).toHaveLength(2)
    // Wound like the face: counter-clockwise from above.
    const frame = meshElementFrame(mesh, meshFaceVertices(mesh, 0))
    for (const triangle of triangles) {
      const [a, b, c] = triangle.map(index => frame.toLocal(...(mesh.vertices[index] as [number, number, number])))
      expect((b![0] - a![0]) * (c![1] - a![1]) - (b![1] - a![1]) * (c![0] - a![0])).toBeGreaterThan(0)
    }
    expect(() => meshFaceVertices(mesh, 9)).toThrow(/below 6/)
  })

  it('pulls a face along its normal: the box grows that way only, closed and planar', () => {
    const mesh = box()
    const before = meshVolume(mesh)
    const taller = pushMeshFace(mesh, 0, 20)
    expect(taller.vertices).toHaveLength(mesh.vertices.length)
    expect(taller.faces).toHaveLength(6)
    const altitudes = taller.vertices.map(position => position[2]!)
    expect(Math.max(...altitudes)).toBeCloseTo(450, 2)
    expect(Math.min(...altitudes)).toBeCloseTo(400, 6)
    expect(meshVolume(taller) / before).toBeCloseTo(50 / 30, 3)
    expect(isClosedMesh(taller) && planar(taller)).toBe(true)
    // A wall pushed out widens the box that way.
    const east = mesh.faces.findIndex((_, index) => meshFaceNormal(mesh, index)[0] > 0.99)
    const wider = pushMeshFace(mesh, east, 10)
    expect(meshVolume(wider) / before).toBeCloseTo(110 / 100, 3)
    expect(planar(wider)).toBe(true)
  })

  it('stops a face pushed in short of the far side, so the solid never turns inside out', () => {
    const flat = pushMeshFace(box(), 0, -100)
    const altitudes = flat.vertices.map(position => position[2]!)
    expect(Math.max(...altitudes)).toBeCloseTo(400.01, 2)
    expect(meshVolume(flat)).toBeGreaterThan(0)
  })

  it('never turns a push in into a pull, even when the face is already within the gap', () => {
    // A box 5 mm tall, under the 1 cm gap: pushed in, the top stays; pulled out, it goes the whole way.
    const frame = new LocalFrame(6.6, 46.45, 0)
    const corner = (east: number, north: number) => frame.toGeographic(east, north, 0).slice(0, 2)
    const thin = indexMesh(prismMesh([[corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)]], 400, 0.005))
    const top = (mesh: IndexedMesh) => Math.max(...mesh.vertices.map(position => position[2]!))
    expect(top(pushMeshFace(thin, 0, -1))).toBeCloseTo(400.005, 6)
    expect(top(pushMeshFace(thin, 0, 1))).toBeCloseTo(401.005, 4)
    // A box 30 m tall pushed in 5 m goes the whole 5 m.
    expect(top(pushMeshFace(box(), 0, -5))).toBeCloseTo(425, 2)
  })

  it('moves a shared vertex in every face, splitting the faces it bends into triangles', () => {
    const mesh = box()
    // A top corner, raised 10 m.
    const corner = mesh.faces[0]![0]![0]!
    const moved = moveMeshVertices(mesh, [corner], [0, 0, 10])
    expect(moved.vertices[corner]![2]).toBeCloseTo(440, 2)
    expect(moved.vertices).toHaveLength(mesh.vertices.length)
    // Raised straight up, it stays in the plane of both walls: only the top bends.
    expect(moved.faces).toHaveLength(6 + 1)
    expect(isClosedMesh(moved) && planar(moved)).toBe(true)
    expect(isMeshGeometry(meshFromIndexed(moved))).toBe(true)
    // An edge moved along itself keeps the faces planar: nothing is split.
    const [a, b] = [mesh.faces[0]![0]![0]!, mesh.faces[0]![0]![1]!]
    const frame = meshElementFrame(mesh, [a, b])
    const along = frame.toLocal(...(mesh.vertices[b] as [number, number, number]))
    const length = Math.hypot(along[0], along[1])
    const slid = moveMeshVertices(mesh, [a, b], [0, 0, 5], frame)
    expect(slid.faces).toHaveLength(6)
    expect(length).toBeGreaterThan(0)
    expect(() => moveMeshVertices(mesh, [99], [1, 0, 0])).toThrow(/no vertex 99/)
  })

  it('extrudes a face: new walls wound outwards, the face keeping its index, the solid closed', () => {
    const mesh = box()
    const extruded = extrudeMeshFace(mesh, 0, 15)
    expect(extruded.faces).toHaveLength(6 + 4)
    expect(extruded.vertices).toHaveLength(8 + 4)
    expect(meshFaceVertices(extruded, 0).every(index => index >= 8)).toBe(true)
    expect(meshFaceNormal(extruded, 0)[2]).toBeCloseTo(1, 6)
    expect(isClosedMesh(extruded) && planar(extruded)).toBe(true)
    expect(meshVolume(extruded) / meshVolume(mesh)).toBeCloseTo(45 / 30, 3)
    // Then pushed further: the new walls stretch, the old ones stay.
    const further = pushMeshFace(extruded, 0, 5)
    expect(Math.max(...further.vertices.map(position => position[2]!))).toBeCloseTo(450, 2)
    // Inwards: a dent, still closed and wound outwards.
    const dent = extrudeMeshFace(mesh, 0, -10)
    expect(isClosedMesh(dent)).toBe(true)
    expect(meshVolume(dent) / meshVolume(mesh)).toBeCloseTo(20 / 30, 3)
    expect(() => extrudeMeshFace(mesh, 0, 0)).toThrow(/other than 0/)
  })

  it('extrudes faces together as one region: walls only around their outline, the solid closed', () => {
    const mesh = box()
    const wall = mesh.faces.findIndex((_, index) => Math.abs(meshFaceNormal(mesh, index)[2]) < 0.01 && meshFaceVertices(mesh, index).some(vertex => meshFaceVertices(mesh, 0).includes(vertex)))
    const extruded = extrudeMeshFaces(mesh, [0, wall], 10)
    // The top and a wall share one edge: six outline edges, six new walls; their vertices copied once.
    expect(extruded.faces).toHaveLength(6 + 6)
    expect(extruded.vertices).toHaveLength(8 + 6)
    expect(isClosedMesh(extruded) && planar(extruded)).toBe(true)
    expect(meshVolume(extruded)).toBeGreaterThan(meshVolume(mesh))
    // One face is extrudeMeshFace; faces pointing every way cannot go together.
    expect(extrudeMeshFaces(mesh, [0], 15)).toEqual(extrudeMeshFace(mesh, 0, 15))
    const bottom = mesh.faces.findIndex((_, index) => meshFaceNormal(mesh, index)[2] < -0.99)
    expect(() => extrudeMeshFaces(mesh, [0, bottom], 5)).toThrow(/cancel out/)
  })

  it('extrudes edges into new faces: a wall\'s top edges up continue the wall', () => {
    const frame = new LocalFrame(6.6, 46.45, 0)
    const at = (east: number) => frame.toGeographic(east, 0, 0).slice(0, 2)
    const wall = indexMesh(wallMesh([at(0), at(100), at(200)], 400, 10))
    const top = wall.faces.map(face => face[0]!.filter(index => wall.vertices[index]![2]! > 405))
    const edges = top.map(([a, b]) => [a!, b!] as [number, number])
    const { mesh, edges: copied } = extrudeMeshEdges(wall, edges, [0, 0, 5])
    expect(mesh.faces).toHaveLength(4)
    expect(mesh.vertices).toHaveLength(6 + 3)
    expect(copied.flat().every(index => index >= 6 && Math.abs(mesh.vertices[index]![2]! - 415) < 0.01)).toBe(true)
    expect(planar(mesh)).toBe(true)
    // Wound as the wall below: the same outward normal.
    for (const face of [0, 1]) {
      const below = meshFaceNormal(mesh, face)
      const above = meshFaceNormal(mesh, face + 2)
      expect(below[0] * above[0] + below[1] * above[1] + below[2] * above[2]).toBeCloseTo(1, 3)
    }
    expect(() => extrudeMeshEdges(wall, edges, [0, 0, 0])).toThrow(/not all 0/)
  })

  it('moves several vertices of a line or polygon by one step, keeping altitudes', () => {
    const square: DrawFeature<Polygon> = { type: 'Feature', id: 's', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 1, 5], [0, 0, 5]]] } }
    const moved = moveVertices(square, [{ ring: 0, index: 1 }, { ring: 0, index: 2 }], [0, 0], [0.5, 0]).geometry as Polygon
    expect(moved.coordinates[0]![1]![0]).toBeCloseTo(1.5, 6)
    expect(moved.coordinates[0]![2]![0]).toBeCloseTo(1.5, 3)
    expect(moved.coordinates[0]![2]![2]).toBe(5)
    expect(moved.coordinates[0]![0]).toEqual([0, 0, 5])
    expect(moved.coordinates[0]![4]).toEqual([0, 0, 5])
  })
})
