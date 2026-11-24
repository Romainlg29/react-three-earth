import type { MultiPolygon, Polygon, Position } from 'geojson'
import { Object3D, type Mesh } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import { indexMesh, isClosedMesh, isMeshFeature, meshEdges, meshFaces, meshFromIndexed, meshSharpEdges, meshTop, meshVolume, prismMesh, setMeshTop, sphereMesh, wallMesh } from '../src/mesh.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { LineStringMode, PolygonMode } from '../src/modes/PathModes.js'
import { CircleMode, RectangleMode, SphereMode } from '../src/modes/ShapeModes.js'
import { buildSolidGeometry, isSolidFeature, LocalFrame, refineTriangles, SolidFeatures } from '../src/render/SolidFeatures.js'
import { bearingDegrees, createCircle, createEllipse, createRectangle, createRegularPolygon, createSphere, destination } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

const CENTER: [number, number] = [6.6, 46.45]

/** Twice the signed area in degrees: positive for counter-clockwise rings. */
function signedArea(ring: number[][]): number {
  let area = 0
  for (let index = 0; index + 1 < ring.length; index++) area += ring[index]![0]! * ring[index + 1]![1]! - ring[index + 1]![0]! * ring[index]![1]!
  return area
}

/** Expects a mesh closed, wound outwards (counter-clockwise seen from outside), every ring closed and every position with an altitude. */
function expectClosedOutwards(geometry: MultiPolygon): void {
  for (const face of geometry.coordinates) for (const ring of face) {
    expect(ring[0]).toEqual(ring[ring.length - 1])
    for (const position of ring) expect(position).toHaveLength(3)
  }
  const mesh = indexMesh(geometry)
  expect(isClosedMesh(mesh)).toBe(true)
  expect(meshVolume(mesh)).toBeGreaterThan(0)
}

describe('shape builders', () => {
  it('moves along the ground by distance and bearing, and back', () => {
    const east = destination(CENTER, 10_000, 90)
    expect(distanceMeters(CENTER, east)).toBeCloseTo(10_000, 3)
    expect(bearingDegrees(CENTER, east)).toBeCloseTo(90, 0)
    expect(destination(CENTER, 5000, 0)[0]).toBeCloseTo(CENTER[0], 9)
  })

  it('builds flat circles whose vertices are the radius from the center, counter-clockwise and closed, with plain properties', () => {
    const circle = createCircle(CENTER, 2500, { steps: 32, properties: { name: 'tank' } })
    const ring = (circle.geometry as Polygon).coordinates[0]!
    expect(circle.geometry.type).toBe('Polygon')
    expect(ring).toHaveLength(33)
    expect(ring[0]).toEqual(ring[32])
    for (const position of ring) expect(distanceMeters(CENTER, position)).toBeCloseTo(2500, 3)
    expect(signedArea(ring)).toBeGreaterThan(0)
    expect(circle.properties).toEqual({ name: 'tank' })
  })

  it('builds rectangles, ellipses and regular polygons in metres, turned clockwise from north', () => {
    const rectangle = createRectangle(CENTER, 1000, 4000, { rotationDegrees: 90 })
    const corners = (rectangle.geometry as Polygon).coordinates[0]!
    // Turned a quarter: 4000 m east-west, 1000 m north-south.
    expect(distanceMeters(corners[0]!, corners[1]!)).toBeCloseTo(1000, 0)
    expect(distanceMeters(corners[1]!, corners[2]!)).toBeCloseTo(4000, 0)
    expect(Math.abs(corners[1]![1]! - corners[2]![1]!)).toBeLessThan(1e-3)
    expect(signedArea(corners)).toBeGreaterThan(0)
    const ellipse = createEllipse(CENTER, 3000, 1000, { steps: 4 })
    expect(distanceMeters(CENTER, (ellipse.geometry as Polygon).coordinates[0]![1]!)).toBeCloseTo(3000, 0) // the major axis points north
    const hexagon = createRegularPolygon(CENTER, 500, 6)
    expect((hexagon.geometry as Polygon).coordinates[0]).toHaveLength(7)
    expect(() => createRegularPolygon(CENTER, 500, 2)).toThrow(/3 or more/)
    expect(() => createCircle(CENTER, 0)).toThrow(/positive number of metres/)
  })

  it('writes a base height as the third coordinate of a flat polygon, from a number or the terrain under each vertex', () => {
    const floating = createRectangle(CENTER, 100, 100, { baseHeightMeters: 1200 })
    expect((floating.geometry as Polygon).coordinates[0]!.every(position => position[2] === 1200)).toBe(true)
    const relief = (longitude: number) => (longitude - CENTER[0]) * 10_000
    const draped = createRectangle(CENTER, 1000, 1000, { baseHeightMeters: relief })
    for (const position of (draped.geometry as Polygon).coordinates[0]!) expect(position[2]).toBeCloseTo(relief(position[0]!), 9)
  })

  it('makes a box mesh with a height: six faces, closed, wound outwards, its top level above the highest base vertex', () => {
    const relief = (longitude: number) => 400 + (longitude - CENTER[0]) * 10_000
    const box = createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30, baseHeightMeters: relief, heightMeters: 300, id: 'box', properties: { name: 'hall' } })
    expect(box).toMatchObject({ id: 'box', properties: { name: 'hall' }, geometry: { type: 'MultiPolygon' } })
    expect(box.properties).not.toHaveProperty('shape')
    expect(box.properties).not.toHaveProperty('extrusionHeightMeters')
    const geometry = box.geometry as MultiPolygon
    expect(geometry.coordinates).toHaveLength(6)
    expectClosedOutwards(geometry)
    const mesh = indexMesh(geometry)
    expect(mesh.vertices).toHaveLength(8)
    expect(meshEdges(mesh)).toHaveLength(12)
    // The top first, counter-clockwise from above; the bottom clockwise from above (facing down), on the terrain.
    const [top, bottom] = geometry.coordinates
    expect(signedArea(top![0]!)).toBeGreaterThan(0)
    expect(signedArea(bottom![0]!)).toBeLessThan(0)
    for (const position of bottom![0]!) expect(position[2]).toBeCloseTo(relief(position[0]!), 9)
    const highestBase = Math.max(...bottom![0]!.map(position => position[2]!))
    for (const position of top![0]!) expect(position[2]).toBeCloseTo(highestBase + 300, 9)
    expect(isMeshFeature(box)).toBe(true)
    expect(meshTop(geometry)).toEqual({ topMeters: highestBase + 300, belowMeters: highestBase })
    // Measured from its vertices: 1000 m by 2000 m.
    const corners = top![0]!
    expect(distanceMeters(corners[0]!, corners[1]!)).toBeCloseTo(1000, 0)
    expect(distanceMeters(corners[1]!, corners[2]!)).toBeCloseTo(2000, 0)
    // Without a base, the base is 0.
    expect(Math.min(...(createCircle(CENTER, 100, { heightMeters: 10 }).geometry as MultiPolygon).coordinates.flat(2).map(position => position[2]!))).toBe(0)
  })

  it('makes a resting sphere mesh: closed, wound outwards, its vertices the radius from its center', () => {
    const sphere = createSphere(CENTER, 80, { id: 'ball', baseHeightMeters: 500, segments: 16, rings: 8 })
    expect(sphere).toMatchObject({ id: 'ball', geometry: { type: 'MultiPolygon' } })
    const geometry = sphere.geometry
    expect(geometry.coordinates).toHaveLength(16 * 8)
    expectClosedOutwards(geometry)
    const mesh = indexMesh(geometry)
    expect(mesh.vertices).toHaveLength(2 + 16 * 7)
    const frame = new LocalFrame(CENTER[0], CENTER[1], 580)
    for (const position of mesh.vertices) expect(Math.hypot(...frame.toLocal(position[0]!, position[1]!, position[2]!))).toBeCloseTo(80, 6)
    const altitudes = mesh.vertices.map(position => position[2]!)
    expect(Math.min(...altitudes)).toBeCloseTo(500, 6)
    expect(Math.max(...altitudes)).toBeCloseTo(660, 6)
    // Smooth all round: no level top face, no sharp edges.
    expect(meshTop(geometry)).toBeNull()
    expect(meshSharpEdges(mesh, 30)).toHaveLength(0)
    expect(() => sphereMesh(CENTER, 10, 0, { segments: 2 })).toThrow(/at least 3 segments/)
  })
})

describe('meshes', () => {
  const square: Position[] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]

  it('builds prisms facing outwards whatever the winding, with holes as inner walls', () => {
    for (const ring of [square, [...square].reverse()]) {
      const prism = prismMesh([ring], 100, 50)
      expect(prism.coordinates).toHaveLength(2 + 4)
      expectClosedOutwards(prism)
    }
    const hole: Position[] = [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006]]
    const ringed = prismMesh([square, hole], 0, 20)
    // The top and bottom each with their hole, four outer and four inner walls.
    expect(ringed.coordinates).toHaveLength(2 + 4 + 4)
    expect(ringed.coordinates[0]).toHaveLength(2)
    expectClosedOutwards(ringed)
    expect(() => prismMesh([square], 0, 0)).toThrow(/positive number of metres/)
  })

  it('builds walls along a line, their top following the base', () => {
    const wall = wallMesh([[0, 0], [0.01, 0], [0.01, 0.01]], position => 100 + position[0]! * 1000, 5)
    expect(wall.coordinates).toHaveLength(2)
    const mesh = indexMesh(wall)
    expect(mesh.vertices).toHaveLength(6)
    expect(isClosedMesh(mesh)).toBe(false)
    expect(wall.coordinates[0]![0]!.map(position => position[2])).toEqual([100, 110, 115, 105, 100])
    expect(meshTop(wall)).toBeNull()
  })

  it('shares vertices between faces by equal coordinates, and rebuilds the multipolygon from them', () => {
    const prism = prismMesh([square], 0, 10)
    const mesh = indexMesh(prism)
    expect(mesh.faces.map(face => face[0]!.length)).toEqual([4, 4, 4, 4, 4, 4])
    expect(meshFromIndexed(mesh)).toEqual(prism)
    expect(meshFaces(prism)[0]![0]).toHaveLength(4)
    // A box's twelve edges are sharp; a mesh with a face turned inside out is no longer consistently closed.
    expect(meshSharpEdges(mesh)).toHaveLength(12)
    const flipped = { ...mesh, faces: mesh.faces.map((face, index) => (index === 0 ? face.map(ring => [...ring].reverse()) : face)) }
    expect(isClosedMesh(flipped)).toBe(false)
  })

  it('moves the top face of a prism, never closer than the gap to the rest', () => {
    const prism = prismMesh([square], position => (position[0] === 0 ? 100 : 120), 30)
    expect(meshTop(prism)).toEqual({ topMeters: 150, belowMeters: 120 })
    const raised = setMeshTop(prism, 400)
    expect(meshTop(raised)!.topMeters).toBe(400)
    expect(raised.coordinates[1]![0]!.map(position => position[2])).toEqual(prism.coordinates[1]![0]!.map(position => position[2]))
    expect(meshTop(setMeshTop(prism, 0))!.topMeters).toBe(121)
    expectClosedOutwards(setMeshTop(prism, 0))
  })
})

describe('solids', () => {
  const feature = (geometry: DrawFeature['geometry'], properties: Record<string, unknown> = {}): DrawFeature => ({ type: 'Feature', id: 'f', properties, geometry })

  it('tells 3D features from draped ones', () => {
    expect(isSolidFeature(feature(createCircle(CENTER, 100).geometry))).toBe(false)
    expect(isSolidFeature(feature(createCircle(CENTER, 100, { heightMeters: 20 }).geometry))).toBe(true)
    expect(isSolidFeature(feature(createRectangle(CENTER, 100, 100, { baseHeightMeters: 50 }).geometry))).toBe(true)
    expect(isSolidFeature({ ...createSphere(CENTER, 10), id: 's' } as DrawFeature)).toBe(true)
    expect(isSolidFeature(feature({ type: 'Point', coordinates: [6, 46, 300] }))).toBe(false)
    // A multipolygon without altitudes is draped, polygon by polygon.
    expect(isSolidFeature(feature({ type: 'MultiPolygon', coordinates: [[square2D()]] }))).toBe(false)
  })

  it('converts positions to the east-north-up frame, following the curve of the Earth', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const [east, north, up] = frame.toLocal(...destination(CENTER, 10_000, 90), 0)
    // destination() walks a sphere, the frame is WGS84: they differ by about 0.3%.
    expect(Math.abs(east - 10_000)).toBeLessThan(50)
    expect(Math.abs(north)).toBeLessThan(20)
    // 10 km away, the ground is about 8 m below the tangent plane.
    expect(up).toBeCloseTo(-7.85, 0)
    expect(frame.toLocal(CENTER[0], CENTER[1], 250)[2]).toBeCloseTo(250, 6)
  })

  it('converts back from the east-north-up frame to positions', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 300)
    const [longitude, latitude, height] = frame.toGeographic(...frame.toLocal(6.7, 46.5, 1234.5))
    expect(longitude).toBeCloseTo(6.7, 10)
    expect(latitude).toBeCloseTo(46.5, 10)
    expect(height).toBeCloseTo(1234.5, 5)
  })

  it('builds a box mesh into a closed solid: two triangles per face, every one facing outwards', () => {
    const box = createRectangle(CENTER, 1000, 1000, { baseHeightMeters: 0, heightMeters: 200 }).geometry
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const { faces, line, closed } = buildSolidGeometry(feature(box), frame)
    expect(line).toBeNull()
    expect(closed).toBe(true)
    const positions = faces!.getAttribute('position')
    expect(positions.count).toBe(6 * 2 * 3)
    for (let index = 0; index < positions.count; index += 3) {
      const [a, b, c] = [0, 1, 2].map(corner => [positions.getX(index + corner), positions.getY(index + corner), positions.getZ(index + corner)])
      const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
      const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
      const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      // From the middle of the box (100 m up) to the triangle's centroid.
      const outwards = [0, 1, 2].map(axis => (a![axis]! + b![axis]! + c![axis]!) / 3 - (axis === 2 ? 100 : 0))
      expect(normal[0]! * outwards[0]! + normal[1]! * outwards[1]! + normal[2]! * outwards[2]!).toBeGreaterThan(0)
    }
    // Sharp edges keep flat normals: the top's point straight up.
    const normals = faces!.getAttribute('normal')
    let up = 0
    for (let index = 0; index < normals.count; index++) if (normals.getZ(index) > 0.999) up++
    expect(up).toBe(6)
    // An open mesh (a wall) is drawn from both sides.
    expect(buildSolidGeometry(feature(wallMesh([CENTER, destination(CENTER, 100, 90)], 0, 10)), frame).closed).toBe(false)
  })

  it('shades a sphere mesh smoothly: normals point away from its center', () => {
    const sphere = createSphere(CENTER, 100, { baseHeightMeters: 0 }).geometry
    const frame = new LocalFrame(CENTER[0], CENTER[1], 100)
    const { faces, closed } = buildSolidGeometry(feature(sphere), frame)
    expect(closed).toBe(true)
    const positions = faces!.getAttribute('position')
    const normals = faces!.getAttribute('normal')
    for (let index = 0; index < positions.count; index++) {
      const length = Math.hypot(positions.getX(index), positions.getY(index), positions.getZ(index))
      const alignment = (positions.getX(index) * normals.getX(index) + positions.getY(index) * normals.getY(index) + positions.getZ(index) * normals.getZ(index)) / length
      expect(alignment).toBeGreaterThan(0.99)
    }
  })

  it('splits wide faces into small triangles, so they bend with the Earth instead of cutting under it', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const { faces } = buildSolidGeometry(feature(createRectangle(CENTER, 100_000, 100_000, { baseHeightMeters: 0, heightMeters: 500 }).geometry), frame)
    const positions = faces!.getAttribute('position')
    let longest = 0
    for (let index = 0; index < positions.count; index += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const next = index + ((corner + 1) % 3)
        longest = Math.max(longest, Math.hypot(positions.getX(index + corner) - positions.getX(next), positions.getY(index + corner) - positions.getY(next)))
      }
    }
    // Triangles about 2 km wide sag a few centimetres; one triangle across 100 km would sag 200 m.
    expect(longest).toBeLessThan(4000)
    // Every vertex is between the ground and 500 m above it (on the walls), the ground falling away from the tangent
    // plane with the curve; those of the top and bottom faces exactly on them.
    let level = 0
    let lowest = Infinity
    let highest = -Infinity
    for (let index = 0; index < positions.count; index++) {
      const [east, north, up] = [positions.getX(index), positions.getY(index), positions.getZ(index)]
      const aboveGround = up + (east * east + north * north) / (2 * 6_378_137)
      lowest = Math.min(lowest, aboveGround)
      highest = Math.max(highest, aboveGround)
      if (Math.min(Math.abs(aboveGround), Math.abs(aboveGround - 500)) < 5) level++
    }
    expect(lowest).toBeGreaterThan(-5)
    expect(highest).toBeLessThan(505)
    expect(level / positions.count).toBeGreaterThan(0.5)
  })

  it('refines triangles without cracks: inner edges are shared by two triangles, outline edges stay on the outline', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const corners = (createRectangle(CENTER, 9000, 9000).geometry as Polygon).coordinates[0]!.slice(0, 4).map(([longitude, latitude]) => [longitude!, latitude!, 0] as [number, number, number])
    const local = corners.map(([longitude, latitude, height]) => frame.toLocal(longitude, latitude, height))
    const triangles = refineTriangles(corners, local, [0, 1, 2, 0, 2, 3], 2000, frame)
    const uses = new Map<string, number>()
    for (let index = 0; index < triangles.length; index += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const [a, b] = [triangles[index + corner]!, triangles[index + ((corner + 1) % 3)]!]
        const edge = a < b ? `${a},${b}` : `${b},${a}`
        uses.set(edge, (uses.get(edge) ?? 0) + 1)
      }
    }
    for (const [edge, count] of uses) {
      expect(count).toBeLessThanOrEqual(2)
      if (count === 1) for (const vertex of edge.split(',').map(Number)) expect(Math.max(Math.abs(local[vertex]![0]), Math.abs(local[vertex]![1]))).toBeCloseTo(4500, -2)
    }
    expect(triangles.length / 3).toBeGreaterThan(16)
  })

  it('stands each solid on an anchor at its lowest altitude, shares materials, and rebuilds only changed features', () => {
    const anchors: Array<{ heightMeters: number }> = []
    const earth = {
      view: { morph: 0, flatMapLuminance: 1 },
      createGeographicAnchor: (position: { longitudeDegrees: number; latitudeDegrees: number; heightMeters: number }) => {
        anchors.push(position)
        return Object.assign(new Object3D(), { geographicPosition: { ...position }, dispose() { (this as unknown as Object3D).removeFromParent() } })
      },
    }
    const solids = new SolidFeatures(earth as never)
    const box = { ...createRectangle(CENTER, 100, 100, { baseHeightMeters: 420, heightMeters: 30 }), id: 'box' } as DrawFeature
    const ball = { ...createSphere(destination(CENTER, 500, 90), 40, { baseHeightMeters: 380 }), id: 'ball' } as DrawFeature
    solids.setFeatures([{ feature: box, style: DEFAULT_DRAW_STYLE }, { feature: ball, style: DEFAULT_DRAW_STYLE }])
    expect(solids.size).toBe(2)
    expect(anchors.map(anchor => Math.round(anchor.heightMeters))).toEqual([420, 380])
    // Mesh and edges on each anchor, one shared pair of materials (both closed).
    const [boxAnchor, ballAnchor] = solids.object.children as Object3D[]
    expect(boxAnchor!.children).toHaveLength(2)
    expect((boxAnchor!.children[0] as Mesh).material).toBe((ballAnchor!.children[0] as Mesh).material)
    solids.setFeatures([{ feature: box, style: DEFAULT_DRAW_STYLE }, { feature: ball, style: DEFAULT_DRAW_STYLE }])
    expect(anchors).toHaveLength(2)
    solids.setPreviews([{ feature: { ...box }, style: DEFAULT_DRAW_STYLE }])
    expect(solids.object.children).toHaveLength(3)
    solids.setPreviews([])
    solids.setFeatures([{ feature: ball, style: DEFAULT_DRAW_STYLE }])
    expect(solids.object.children).toHaveLength(1)
    solids.dispose()
    expect(solids.object.children).toHaveLength(0)
  })

  it('splits long edges so walls follow the ground, and draws lines at an altitude as lines', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const wall = buildSolidGeometry(feature(wallMesh([CENTER, destination(CENTER, 10_000, 90)], 0, 50)), frame)
    // 10 km split in halves until no piece is longer than 2 km across: its foot in 8 pieces, on the ground.
    const positions = wall.faces!.getAttribute('position')
    const foot = new Set<string>()
    for (let index = 0; index < positions.count; index++) {
      const [east, north, up] = [positions.getX(index), positions.getY(index), positions.getZ(index)]
      const aboveGround = up + (east * east + north * north) / (2 * 6_378_137)
      if (Math.abs(aboveGround) < 0.5) foot.add(east.toFixed(0))
    }
    expect(foot.size).toBe(9)
    const line = buildSolidGeometry(feature({ type: 'LineString', coordinates: [[6.6, 46.45, 900], [6.61, 46.45, 900]] }), frame)
    expect(line.faces).toBeNull()
    expect(line.line!.getAttribute('position').getZ(0)).toBeCloseTo(900, 3)
    // A polygon at an altitude: one flat face, seen from both sides.
    const slab = buildSolidGeometry(feature(createRectangle(CENTER, 100, 100, { baseHeightMeters: 300 }).geometry), frame)
    expect(slab.closed).toBe(false)
    expect(slab.faces!.getAttribute('position').getZ(0)).toBeCloseTo(300, 1)
  })
})

/** A mode context whose projection puts longitude, latitude at x = longitude × 1000, y = latitude × 1000 pixels. */
function createContext() {
  const created: DrawFeature[] = []
  let ids = 0
  const context: DrawModeContext = {
    earth: null as never,
    store: new FeatureStore(),
    heights: { remember: vi.fn(), heightAt: () => 0 } as never,
    style: () => DEFAULT_DRAW_STYLE,
    createId: () => `feature-${++ids}`,
    project: ([longitude, latitude]) => ({ x: longitude * 1000, y: latitude * 1000 }),
    changed: vi.fn(),
    create: features => void created.push(...features),
    update: vi.fn(),
    remove: vi.fn(),
    projectAtHeight: ([longitude, latitude]) => ({ x: longitude * 1000, y: latitude * 1000 }),
    setCursor: vi.fn(),
    holdDoubleClickZoom: vi.fn(),
  }
  return { context, created }
}

function tap(longitude: number, latitude: number): DrawPointerEvent {
  return { screen: { xPixels: longitude * 1000, yPixels: latitude * 1000 }, geographic: { longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters: 0 }, pointerType: 'mouse', originalEvent: {} as MouseEvent }
}

describe('shape modes', () => {
  it('draws a circle from its center and a point on its edge, ignoring a second tap on the center', () => {
    const { context, created } = createContext()
    const mode = new CircleMode({ heightMeters: 120 })
    mode.enter(context)
    mode.click(tap(6.6, 46.45))
    expect(mode.status()).toMatchObject({ drawing: true, canUndo: true })
    mode.click(tap(6.6001, 46.45)) // a double tap's second tap, within 10 px
    expect(created).toHaveLength(0)
    mode.click(tap(6.62, 46.45))
    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe('feature-1')
    // A cylinder mesh: 64 walls, a top and a bottom, on the terrain (0 m here), its top 120 m up.
    const cylinder = created[0]!.geometry as MultiPolygon
    expect(cylinder.type).toBe('MultiPolygon')
    expect(cylinder.coordinates).toHaveLength(66)
    expectClosedOutwards(cylinder)
    const radius = distanceMeters([6.6, 46.45], [6.62, 46.45])
    for (const position of cylinder.coordinates[0]![0]!) {
      expect(distanceMeters([6.6, 46.45], position)).toBeCloseTo(radius, 3)
      expect(position[2]).toBe(120)
    }
    expect(created[0]!.properties).toEqual({})
    expect(mode.status().drawing).toBe(false)
  })

  it('draws flat rectangles between two corners and sphere meshes from a center and radius, and cancels with Escape', () => {
    const { context, created } = createContext()
    const rectangle = new RectangleMode()
    rectangle.enter(context)
    rectangle.click(tap(6.6, 46.45))
    rectangle.click(tap(6.62, 46.47))
    const ring = (created[0]!.geometry as Polygon).coordinates[0]!
    expect(Math.min(...ring.map(position => position[0]!))).toBeCloseTo(6.6, 3)
    expect(Math.max(...ring.map(position => position[1]!))).toBeCloseTo(46.47, 3)
    rectangle.click(tap(6.7, 46.5))
    expect(rectangle.keyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true)
    expect(rectangle.status().drawing).toBe(false)
    const sphere = new SphereMode()
    sphere.enter(context)
    sphere.click(tap(6.6, 46.45))
    sphere.click(tap(6.6, 46.47))
    expect(created[0]!.geometry.type).toBe('Polygon')
    expect(created[1]!.geometry.type).toBe('MultiPolygon')
    expect(isSolidFeature(created[1]!)).toBe(true)
    expectClosedOutwards(created[1]!.geometry as MultiPolygon)
  })

  it('draws a rectangle across the antimeridian where it was tapped', () => {
    const { context, created } = createContext()
    context.project = ([longitude, latitude]) => ({ x: longitude * 1000, y: latitude * 1000 })
    const mode = new RectangleMode()
    mode.enter(context)
    mode.click(tap(179.9, 10))
    mode.click(tap(-179.9, 10.1))
    const ring = (created[0]!.geometry as Polygon).coordinates[0]!
    for (const [longitude] of ring) expect(Math.abs(Math.abs(longitude!) - 180)).toBeLessThan(0.2)
  })

  it('draws a box resting on the terrain under each corner, the tap heights standing in where it is not known', () => {
    const { context, created } = createContext()
    const relief = (longitude: number) => 400 + (longitude - 6.6) * 10_000
    context.heights.heightAt = ((longitude: number, _latitude: number, fallback = 0, options?: { immediate?: boolean }) => (options?.immediate === true ? relief(longitude) : fallback)) as never
    const mode = new RectangleMode({ heightMeters: 50, properties: { kind: 'shed' } })
    mode.enter(context)
    mode.click(tap(6.6, 46.45))
    mode.click(tap(6.61, 46.46))
    const box = created[0]!
    expect(box.properties).toEqual({ kind: 'shed' })
    const geometry = box.geometry as MultiPolygon
    expect(geometry.coordinates).toHaveLength(6)
    expectClosedOutwards(geometry)
    for (const position of geometry.coordinates[1]![0]!) expect(position[2]).toBeCloseTo(relief(position[0]!), 6)
    expect(meshTop(geometry)!.topMeters).toBeCloseTo(relief(6.61) + 50, 1)
  })

  it('makes prisms of polygons and walls of lines drawn with heightMeters, flat features without', () => {
    const { context, created } = createContext()
    const prisms = new PolygonMode({ heightMeters: 40 })
    prisms.enter(context)
    for (const [longitude, latitude] of [[6.6, 46.45], [6.62, 46.45], [6.62, 46.47]] as const) prisms.click(tap(longitude, latitude))
    prisms.finish()
    expect(created[0]!.properties).toEqual({})
    expect((created[0]!.geometry as MultiPolygon).coordinates).toHaveLength(2 + 3)
    expectClosedOutwards(created[0]!.geometry as MultiPolygon)
    const walls = new LineStringMode({ heightMeters: 3 })
    walls.enter(context)
    for (const [longitude, latitude] of [[6.6, 46.45], [6.62, 46.45], [6.62, 46.47]] as const) walls.click(tap(longitude, latitude))
    walls.finish()
    expect((created[1]!.geometry as MultiPolygon).coordinates).toHaveLength(2)
    walls.heightMeters = undefined
    for (const [longitude, latitude] of [[6.6, 46.45], [6.62, 46.45]] as const) walls.click(tap(longitude, latitude))
    walls.finish()
    expect(created[2]!.geometry.type).toBe('LineString')
  })
})

function square2D(): Position[] {
  return [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
}
