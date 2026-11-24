import type { LineString, MultiPolygon, Polygon, Position } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { Draw } from '../src/Draw.js'
import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import { LocalFrame } from '../src/localFrame.js'
import { indexMesh, isClosedMesh, meshVolume } from '../src/mesh.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { SelectMode, type GizmoHandle } from '../src/modes/SelectMode.js'
import type { OverlayContent } from '../src/render/LiveOverlay.js'
import { bearingDegrees, createCircle, createRectangle, createRegularPolygon, createSphere, destination } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import {
  baseAltitudeOf,
  extrudeFeature,
  featureAxes,
  featureCenter,
  featureRotationDegrees,
  liftFeature,
  meshTopOf,
  moveMeshTop,
  offsetFeature,
  placeOnTerrain,
  rotateFeature,
  rotateFeatureAroundAxis,
  scaleFeature,
  scaleFeatureAlongAxis,
  stretchFeature,
  transformFrame,
} from '../src/transform.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

const CENTER: [number, number] = [6.6, 46.45]
/** A box mesh 1000 m across, 2000 m along (north), on the ellipsoid, 300 m tall. */
const rectangle = (): DrawFeature => ({ ...createRectangle(CENTER, 1000, 2000, { baseHeightMeters: 0, heightMeters: 300 }), id: 'box' }) as DrawFeature

/**
 * A rectangle measured from its vertices (a flat polygon's ring, or a box mesh's top face): width (first edge), length
 * (second edge), turn (the bearing of the second edge, folded to -90°…90°) and center.
 */
function measure(feature: DrawFeature): { widthMeters: number; lengthMeters: number; rotationDegrees: number; center: [number, number] } {
  const geometry = feature.geometry
  const ring = geometry.type === 'MultiPolygon' ? geometry.coordinates[0]![0]! : (geometry as Polygon).coordinates[0]!
  const rotation = ((bearingDegrees(ring[1]!, ring[2]!) % 180) + 270) % 180 - 90
  return { widthMeters: distanceMeters(ring[0]!, ring[1]!), lengthMeters: distanceMeters(ring[1]!, ring[2]!), rotationDegrees: rotation, center: featureCenter(feature) }
}

/** Altitudes of every position of a feature. */
function altitudes(feature: DrawFeature): number[] {
  const geometry = feature.geometry
  const positions: Position[] = geometry.type === 'MultiPolygon' ? geometry.coordinates.flat(2) : geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.type === 'LineString' ? geometry.coordinates : [geometry.coordinates]
  return positions.map(position => position[2]!)
}

/** Expects a mesh still closed and wound outwards, with its six faces. */
function expectBox(feature: DrawFeature): void {
  const geometry = feature.geometry as MultiPolygon
  expect(geometry.coordinates).toHaveLength(6)
  const mesh = indexMesh(geometry)
  expect(mesh.vertices).toHaveLength(8)
  expect(isClosedMesh(mesh)).toBe(true)
  expect(meshVolume(mesh)).toBeGreaterThan(0)
}

describe('transforms', () => {
  it('turns a mesh around the vertical through its center, keeping its size, altitudes and faces', () => {
    const turned = rotateFeature(rectangle(), CENTER, 90)
    expectBox(turned)
    expect(altitudes(turned)).toEqual(altitudes(rectangle()))
    const { widthMeters, lengthMeters } = measure(turned)
    expect(widthMeters).toBeCloseTo(1000, 0)
    expect(lengthMeters).toBeCloseTo(2000, 0)
    // Now 2000 m east-west: the first two corners (formerly 1000 m apart, west-east) run north-south.
    const ring = (turned.geometry as MultiPolygon).coordinates[0]![0]!
    expect(Math.abs(ring[0]![0]! - ring[1]![0]!)).toBeLessThan(1e-4)
    expect(featureRotationDegrees(rotateFeature(rectangle(), CENTER, -30))).toBeCloseTo(-30, 4)
    expect(featureRotationDegrees(rotateFeature(rectangle(), CENTER, 100))).toBeCloseTo(10, 4)
    expect(turned.properties).toEqual({})
  })

  it('scales around the center: positions, and a mesh in 3D from its base', () => {
    const scaled = scaleFeature(rectangle(), CENTER, 2)
    expectBox(scaled)
    expect(measure(scaled).widthMeters).toBeCloseTo(2000, 0)
    expect(measure(scaled).lengthMeters).toBeCloseTo(4000, 0)
    expect(Math.max(...altitudes(scaled))).toBeCloseTo(600, 6)
    expect(Math.min(...altitudes(scaled))).toBe(0)
    const circle = { ...createCircle(CENTER, 500), id: 'c' } as DrawFeature
    for (const position of (scaleFeature(circle, CENTER, 0.5).geometry as Polygon).coordinates[0]!) expect(distanceMeters(CENTER, position)).toBeCloseTo(250, 3)
    // A ball resting at 100 m stays round and resting there.
    const ball = { ...createSphere(CENTER, 100, { baseHeightMeters: 100 }), id: 'b' } as DrawFeature
    const big = scaleFeature(ball, featureCenter(ball), 3)
    expect(Math.min(...altitudes(big))).toBeCloseTo(100, 6)
    expect(Math.max(...altitudes(big))).toBeCloseTo(700, 6)
    expect(() => scaleFeature(circle, CENTER, 0)).toThrow(/positive number/)
  })

  it('extrudes flat polygons into prisms and lines into walls, from their altitudes or the terrain', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'flat', properties: { name: 'hall' } } as DrawFeature
    const box = extrudeFeature(flat, 300, (longitude: number) => 100 + (longitude - CENTER[0]) * 1000)
    expectBox(box)
    expect(box.properties).toEqual({ name: 'hall' })
    expect(meshTopOf(box)!.topMeters).toBeCloseTo(Math.max(...altitudes(box).filter(altitude => altitude < 300)) + 300, 6)
    const slab = { ...createRectangle(CENTER, 100, 100, { baseHeightMeters: 2500 }), id: 's' } as DrawFeature
    expect(Math.min(...altitudes(extrudeFeature(slab, 50, () => 0)))).toBe(2500)
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [CENTER, destination(CENTER, 100, 90), destination(CENTER, 200, 80)] } }
    const wall = extrudeFeature(line, 4, 10)
    expect((wall.geometry as MultiPolygon).coordinates).toHaveLength(2)
    expect(Math.max(...altitudes(wall))).toBe(14)
    // Meshes and points stay as they are.
    expect(extrudeFeature(box, 10)).toBe(box)
  })

  it('moves the top face of a prism, keeping it at least 1 m above the rest', () => {
    const taller = moveMeshTop(rectangle(), 200)
    expectBox(taller)
    expect(Math.max(...altitudes(taller))).toBeCloseTo(500, 6)
    expect(Math.min(...altitudes(taller))).toBe(0)
    expect(Math.max(...altitudes(moveMeshTop(rectangle(), -1000)))).toBeCloseTo(1, 6)
    // A sphere has no level top face.
    const ball = { ...createSphere(CENTER, 100), id: 'b' } as DrawFeature
    expect(meshTopOf(ball)).toBeNull()
    expect(moveMeshTop(ball, 50)).toBe(ball)
  })

  it('puts the gizmo around the feature: corners on its box at its base, the knob beyond its top', () => {
    const frame = transformFrame(rectangle())
    expect(distanceMeters(frame.center, CENTER)).toBeLessThan(0.05)
    expect(frame.rotationDegrees).toBe(0)
    expect(frame.corners).toHaveLength(4)
    for (const corner of frame.corners) expect(distanceMeters(CENTER, corner)).toBeCloseTo(Math.hypot(500, 1000), -1)
    // 1000 m to the top edge, then a quarter of the 2000 m length.
    expect(distanceMeters(CENTER, frame.rotationHandle!)).toBeCloseTo(1500, -1)
    expect(frame.baseHeightMeters).toBe(0)
    expect(frame.topHeightMeters).toBe(300)
    // Circles face north and turn too; points have no box.
    const circleFrame = transformFrame({ ...createCircle(CENTER, 100), id: 'c' } as DrawFeature)
    expect(circleFrame.rotationDegrees).toBe(0)
    expect(circleFrame.rotationHandle).not.toBeNull()
    expect(transformFrame({ type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: CENTER } }).corners).toEqual([])
    expect(transformFrame({ ...createCircle(CENTER, 100), id: 'c' } as DrawFeature).baseHeightMeters).toBeNull()
    // Side handles in the middle of each edge (bottom, right, top, left).
    expect(frame.sideHandles.map(side => [side.axis, side.sideMeters, side.fixedMeters].map(value => (typeof value === 'number' ? Math.round(value) : value)))).toEqual([
      ['along', -1000, 1000],
      ['across', 500, -500],
      ['along', 1000, -1000],
      ['across', -500, 500],
    ])
    expect(distanceMeters(CENTER, frame.sideHandles[1]!.position)).toBeCloseTo(500, 0)
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [[179.9, 0], [180.1, 0]] } }
    expect(featureCenter(line)[0]).toBeCloseTo(180, 9)
  })

  it('turns the gizmo with the feature: the tightest box around a turned box, a hexagon, a ball', () => {
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30, baseHeightMeters: 0, heightMeters: 10 }), id: 't' } as DrawFeature
    const frame = transformFrame(turned)
    expect(frame.rotationDegrees).toBeCloseTo(30, 4)
    expect(frame.sideHandles[1]!.sideMeters).toBeCloseTo(500, 0)
    const ball = { ...createSphere(CENTER, 100), id: 'b' } as DrawFeature
    const ballFrame = transformFrame(ball)
    expect(Math.abs(ballFrame.rotationDegrees)).toBeLessThanOrEqual(45)
    expect(ballFrame.baseHeightMeters).toBeCloseTo(0, 6)
    expect(ballFrame.topHeightMeters).toBeCloseTo(200, 6)
    expect(Math.abs(transformFrame({ ...createRegularPolygon(CENTER, 500, 6), id: 'h' } as DrawFeature).rotationDegrees)).toBeLessThanOrEqual(45)
  })
})

describe('stretching and lifting', () => {
  it('stretches a box across, keeping the opposite edge where it was, its height and its faces', () => {
    const box = rectangle()
    const frame = transformFrame(box)
    const right = frame.sideHandles.find(side => side.axis === 'across' && side.sideMeters > 0)!
    const stretched = stretchFeature(box, frame, 'across', right.fixedMeters, 1.5)
    expectBox(stretched)
    expect(altitudes(stretched)).toEqual(altitudes(box))
    const shape = measure(stretched)
    expect(shape.widthMeters).toBeCloseTo(1500, 1)
    expect(shape.lengthMeters).toBeCloseTo(2000, 1)
    expect(distanceMeters(CENTER, shape.center)).toBeCloseTo(250, 0)
    // The west corners (the first and the last of the top face) stay; the east ones move 500 m east.
    const top = (feature: DrawFeature) => (feature.geometry as MultiPolygon).coordinates[0]![0]!
    expect(distanceMeters(top(box)[0]!, top(stretched)[0]!)).toBeLessThan(0.01)
    expect(distanceMeters(top(box)[3]!, top(stretched)[3]!)).toBeLessThan(0.01)
    expect(distanceMeters(top(box)[1]!, top(stretched)[1]!)).toBeCloseTo(500, 1)
    // A turned rectangle stretches along its own length.
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30 }), id: 't' } as DrawFeature
    const turnedFrame = transformFrame(turned)
    expect(measure(stretchFeature(turned, turnedFrame, 'along', -1000, 0.5))).toMatchObject({ widthMeters: expect.closeTo(1000, 1), lengthMeters: expect.closeTo(1000, 1), rotationDegrees: expect.closeTo(30, 1) })
    const point: DrawFeature = { type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: CENTER } }
    expect(stretchFeature(point, frame, 'across', 0, 2)).toBe(point)
    expect(() => stretchFeature(box, frame, 'across', 0, -1)).toThrow(/positive number/)
  })

  it('lifts features into the air from the terrain or their altitude, a mesh whole, and back down', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'f' } as DrawFeature
    const lifted = liftFeature(flat, 200, 50)
    for (const altitude of altitudes(lifted)) expect(altitude).toBe(250)
    expect(baseAltitudeOf(lifted)).toBe(250)
    expect(baseAltitudeOf(flat)).toBeNull()
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [[6.6, 46.45, 100], [6.61, 46.45, 300]] } }
    expect((liftFeature(line, -50).geometry as LineString).coordinates.map(position => position[2])).toEqual([50, 250])
    const box = liftFeature(rectangle(), 400)
    expectBox(box)
    expect(baseAltitudeOf(box)).toBe(400)
    expect(Math.max(...altitudes(box))).toBe(700)
    expect((placeOnTerrain(lifted).geometry as Polygon).coordinates[0]!.every((position: Position) => position.length === 2)).toBe(true)
    // A mesh needs its altitudes: it stays as it is.
    expect(placeOnTerrain(box)).toBe(box)
  })

  it('lifts a feature on the terrain from the height under each position, and fills the gaps of mixed altitudes', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'f' } as DrawFeature
    const relief = (longitude: number, latitude: number) => (longitude - 6.6) * 10_000 + (latitude - 46.45) * 1000
    const lifted = liftFeature(flat, 100, relief)
    for (const position of (lifted.geometry as Polygon).coordinates[0]!) expect(position[2]).toBeCloseTo(relief(position[0]!, position[1]!) + 100, 9)
    // Any altitude puts the feature in the air (as it is drawn): its base is the lowest, the others come from the terrain.
    const mixed: DrawFeature = { type: 'Feature', id: 'm', properties: {}, geometry: { type: 'LineString', coordinates: [[6.6, 46.45], [6.61, 46.45, 400]] } }
    expect(baseAltitudeOf(mixed)).toBe(400)
    expect((liftFeature(mixed, 10, () => 50).geometry as LineString).coordinates.map(position => position[2])).toEqual([60, 410])
  })
})

/**
 * A context projecting longitude, latitude to x = (longitude - 6.6) × 10 000, y = (46.45 - latitude) × 10 000 pixels
 * (north up), heights 1 px per 10 m up the screen.
 */
function createContext(features: DrawFeature[], { oblique = false }: { oblique?: boolean } = {}) {
  const store = new FeatureStore()
  store.set(features)
  const updates: DrawFeature[][] = []
  // Oblique: up also goes right on the screen, 1 px per 20 m, as seen from the south-west.
  const toScreen = ([longitude, latitude]: [number, number], heightMeters: number) => ({ x: (longitude - CENTER[0]) * 10_000 + (oblique ? heightMeters / 20 : 0), y: (CENTER[1] - latitude) * 10_000 - heightMeters / 10 })
  const context: DrawModeContext = {
    earth: null as never,
    store,
    heights: { remember: vi.fn(), heightAt: () => 0 } as never,
    style: () => DEFAULT_DRAW_STYLE,
    createId: () => 'new',
    project: position => toScreen(position, 0),
    projectAtHeight: toScreen,
    changed: vi.fn(),
    create: created => store.set(created),
    update: updated => {
      store.set(updated)
      updates.push(updated)
    },
    remove: ids => store.remove(ids),
    setCursor: vi.fn(),
    holdDoubleClickZoom: vi.fn(),
  }
  return { context, store, updates, toScreen }
}

function pointerAt(context: ReturnType<typeof createContext>, position: [number, number], options: { heightMeters?: number; shiftKey?: boolean } = {}): DrawPointerEvent {
  const screen = context.toScreen(position, options.heightMeters ?? 0)
  return { screen: { xPixels: screen.x, yPixels: screen.y }, geographic: { longitudeDegrees: position[0], latitudeDegrees: position[1], heightMeters: 0 }, pointerType: 'mouse', originalEvent: { shiftKey: options.shiftKey ?? false } as MouseEvent }
}

/** A pointer event at screen pixels of the fake context, its ground under it at 0 m. */
function screenEvent(x: number, y: number, options: { shiftKey?: boolean; pointerType?: string } = {}): DrawPointerEvent {
  return {
    screen: { xPixels: x, yPixels: y },
    geographic: { longitudeDegrees: CENTER[0] + x / 10_000, latitudeDegrees: CENTER[1] - y / 10_000, heightMeters: 0 },
    pointerType: options.pointerType ?? 'mouse',
    originalEvent: { shiftKey: options.shiftKey ?? false } as MouseEvent,
  }
}

/** Where a gizmo handle is drawn (the first piece of that handle). */
function handleOnScreen(mode: SelectMode, handle: GizmoHandle): { x: number; y: number } {
  const found = mode.gizmoHandles().find(each => each.handle === handle)
  if (found === undefined) throw new Error(`no ${handle} handle among ${mode.gizmoHandles().map(each => each.handle).join(', ')}`)
  return found
}

/** Presses at a screen point, drags through `path` (offsets from the press) and releases at the last one. */
function dragOnScreen(mode: SelectMode, from: { x: number; y: number }, path: Array<[number, number]>, options: { shiftKey?: boolean } = {}): boolean {
  const taken = mode.pointerDown(screenEvent(from.x, from.y))
  for (const [dx, dy] of path) mode.pointerMove(screenEvent(from.x + dx, from.y + dy, options))
  const [dx, dy] = path[path.length - 1]!
  mode.pointerUp(screenEvent(from.x + dx, from.y + dy, options))
  return taken
}

function selectIn(features: DrawFeature[], options: ConstructorParameters<typeof SelectMode>[0] = {}, oblique = false) {
  const setup = createContext(features, { oblique })
  const mode = new SelectMode(options)
  mode.enter(setup.context)
  mode.setSelection([features[0]!.id])
  return { setup, mode }
}

/** Distances between every pair of a mesh's vertices, in metres, in one east-north-up frame. */
function vertexDistances(feature: DrawFeature): number[] {
  const { vertices } = indexMesh(feature.geometry as MultiPolygon)
  const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
  const local = vertices.map(position => frame.toLocal(position[0]!, position[1]!, position[2]!))
  const distances: number[] = []
  for (let a = 0; a < local.length; a++) for (let b = a + 1; b < local.length; b++) distances.push(Math.hypot(local[a]![0] - local[b]![0], local[a]![1] - local[b]![1], local[a]![2] - local[b]![2]))
  return distances
}

/** The altitudes of a box mesh's top face (its first). */
const topFace = (feature: DrawFeature) => (feature.geometry as MultiPolygon).coordinates[0]![0]!.map(position => position[2]!)

describe('3D transforms', () => {
  it('tilts a box around an axis through its middle, keeping every distance and its faces', () => {
    const box = rectangle()
    const tilted = rotateFeatureAroundAxis(box, [...CENTER, 150], [1, 0, 0], 30)
    expectBox(tilted)
    const before = vertexDistances(box)
    vertexDistances(tilted).forEach((distance, index) => expect(distance).toBeCloseTo(before[index]!, 3))
    // Its top face is no longer level: the north edge rose.
    const top = topFace(tilted)
    expect(Math.max(...top) - Math.min(...top)).toBeGreaterThan(900)
    // Around up it is `rotateFeature`, counter-clockwise from above.
    expect(rotateFeatureAroundAxis(box, [...CENTER, 0], [0, 0, 1], 30)).toEqual(rotateFeature(box, CENTER, -30))
    expect(() => rotateFeatureAroundAxis(box, CENTER, [0, 0, 0], 10)).toThrow(/no length/)
  })

  it('gives a flat polygon altitudes when tilted, from the terrain under it', () => {
    const flat = { ...createRectangle(CENTER, 1000, 1000), id: 'f' } as DrawFeature
    const tilted = rotateFeatureAroundAxis(flat, [...CENTER, 400], [0, 1, 0], 20, 400)
    const heights = (tilted.geometry as Polygon).coordinates[0]!.map(position => position[2]!)
    expect(heights.every(Number.isFinite)).toBe(true)
    expect(Math.max(...heights) - Math.min(...heights)).toBeCloseTo(1000 * Math.sin((20 * Math.PI) / 180), -1)
  })

  it('scales along one axis: east keeps the length and the height, up from the base keeps the footprint', () => {
    const box = rectangle()
    const wider = scaleFeatureAlongAxis(box, [...CENTER, 150], [1, 0, 0], 2)
    expectBox(wider)
    expect(measure(wider)).toMatchObject({ widthMeters: expect.closeTo(2000, 0), lengthMeters: expect.closeTo(2000, 0) })
    expect(altitudes(wider)).toEqual(altitudes(box))
    const taller = scaleFeatureAlongAxis(box, [...CENTER, 0], [0, 0, 1], 2)
    expect(Math.min(...altitudes(taller))).toBeCloseTo(0, 3)
    expect(Math.max(...altitudes(taller))).toBeCloseTo(600, 3)
    expect(measure(taller).widthMeters).toBeCloseTo(1000, 0)
    expect(() => scaleFeatureAlongAxis(box, CENTER, [1, 0, 0], 0)).toThrow(/positive number/)
  })

  it('offsets a feature east, north and up, giving one on the terrain altitudes only when it rises', () => {
    const flat = { ...createRectangle(CENTER, 1000, 1000), id: 'f' } as DrawFeature
    const moved = offsetFeature(flat, [500, 0, 0])
    expect(featureCenter(moved)[0]).toBeGreaterThan(CENTER[0])
    expect(featureCenter(moved)[1]).toBeCloseTo(CENTER[1], 6)
    expect(baseAltitudeOf(moved)).toBeNull()
    expect(baseAltitudeOf(offsetFeature(flat, [0, 0, 50], 100))).toBe(150)
  })

  it("finds a feature's own axes: a turned box's edges, a tilted box's top", () => {
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30, baseHeightMeters: 0, heightMeters: 10 }), id: 't' } as DrawFeature
    const [x, y, z] = featureAxes(turned)
    const radians = (30 * Math.PI) / 180
    expect(x[0]).toBeCloseTo(Math.cos(radians), 2)
    expect(x[1]).toBeCloseTo(-Math.sin(radians), 2)
    expect(y[0]).toBeCloseTo(Math.sin(radians), 2)
    expect(z).toEqual([0, 0, 1])
    const tilted = rotateFeatureAroundAxis(rectangle(), [...CENTER, 150], [1, 0, 0], 20)
    expect(featureAxes(tilted)[2][2]).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3)
    expect(featureAxes({ ...createCircle(CENTER, 100), id: 'c' } as DrawFeature)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  })
})

describe('the gizmo of the select mode', () => {
  it('draws arrows, plane squares, the center ring, arcs, cubes and the outer ring, the same size at any zoom', () => {
    const { setup, mode } = selectIn([rectangle()], {}, true)
    const names = mode.gizmoHandles().map(each => each.handle)
    for (const handle of ['move-x', 'move-y', 'move-z', 'move-xy', 'move-free', 'rotate-x', 'rotate-y', 'rotate-z', 'scale-x', 'scale-y', 'scale-z', 'scale-uniform'] as const) expect(names).toContain(handle)
    const content: OverlayContent = { features: [], lines: [], handles: [], polygons: [] }
    mode.overlay(content)
    expect(content.lines.filter(line => line.arrowheadPixels !== undefined)).toHaveLength(3)
    expect(content.handles.filter(handle => handle.shape === 'square')).toHaveLength(3)
    expect(content.handles.filter(handle => handle.shape === 'ring')).toHaveLength(2)
    expect(content.polygons!.length).toBeGreaterThanOrEqual(1)
    // The east arrow is 80 px long on the screen; zoomed in twice as close, still 80 px.
    const center = mode.gizmoHandles().find(each => each.handle === 'move-free')!
    const east = handleOnScreen(mode, 'move-x')
    expect(Math.hypot(east.x - center.x, east.y - center.y) / 0.6).toBeLessThan(81)
    const project = setup.context.projectAtHeight
    setup.context.projectAtHeight = (position, height) => {
      const screen = project(position, height)
      return { x: screen!.x * 2, y: screen!.y * 2 }
    }
    const zoomedCenter = handleOnScreen(mode, 'move-free')
    const zoomedEast = handleOnScreen(mode, 'move-x')
    expect(Math.hypot(zoomedEast.x - zoomedCenter.x, zoomedEast.y - zoomedCenter.y)).toBeCloseTo(Math.hypot(east.x - center.x, east.y - center.y), 3)
  })

  it('moves along the east arrow only, in one update, and undoes it', () => {
    const { setup, mode } = selectIn([rectangle()])
    const arrow = handleOnScreen(mode, 'move-x')
    expect(dragOnScreen(mode, arrow, [[10, 3], [40, 12]])).toBe(true)
    expect(setup.updates).toHaveLength(1)
    const moved = setup.store.get('box')!
    expect(featureCenter(moved)[0]).toBeGreaterThan(CENTER[0] + 0.003)
    // East along a great circle: a few centimetres south of the parallel.
    expect(featureCenter(moved)[1]).toBeCloseTo(CENTER[1], 5)
    expect(altitudes(moved)).toEqual(altitudes(rectangle()))
    expectBox(moved)
    mode.undo()
    expect(featureCenter(setup.store.get('box')!)[0]).toBeCloseTo(CENTER[0], 9)
  })

  it('raises a box with the up arrow, and gives a flat polygon altitudes', () => {
    const { setup, mode } = selectIn([rectangle()])
    // 1 px up the screen is 10 m up: 30 px raise it 300 m.
    dragOnScreen(mode, handleOnScreen(mode, 'move-z'), [[0, -10], [0, -30]])
    const raised = setup.store.get('box')!
    expect(Math.min(...altitudes(raised))).toBeCloseTo(300, 3)
    expect(Math.max(...altitudes(raised))).toBeCloseTo(600, 3)
    expect(featureCenter(raised)[0]).toBeCloseTo(CENTER[0], 9)
    const flat = selectIn([{ ...createRectangle(CENTER, 1000, 2000), id: 'flat' } as DrawFeature])
    dragOnScreen(flat.mode, handleOnScreen(flat.mode, 'move-z'), [[0, -20]])
    expect(baseAltitudeOf(flat.setup.store.get('flat')!)).toBeCloseTo(200, 3)
  })

  it('moves on the ground with the center ring and the east-north square, the center under the pointer', () => {
    for (const handle of ['move-free', 'move-xy'] as const) {
      const { setup, mode } = selectIn([rectangle()])
      const grab = handleOnScreen(mode, handle)
      dragOnScreen(mode, grab, [[30, 0], [100, -50]])
      const center = featureCenter(setup.store.get('box')!)
      expect(center[0]).toBeCloseTo(CENTER[0] + 0.01, 4)
      expect(center[1]).toBeCloseTo(CENTER[1] + 0.005, 4)
      expect(altitudes(setup.store.get('box')!)).toEqual(altitudes(rectangle()))
    }
  })

  it('turns the heading with the arc around up, and snaps with Shift only when snapping is on', () => {
    const turnBy = (options: ConstructorParameters<typeof SelectMode>[0], shiftKey: boolean) => {
      const { setup, mode } = selectIn([rectangle()], options)
      const center = handleOnScreen(mode, 'move-free')
      const grab = handleOnScreen(mode, 'rotate-z')
      const radius = Math.hypot(grab.x - center.x, grab.y - center.y)
      const start = Math.atan2(grab.y - center.y, grab.x - center.x)
      const path: Array<[number, number]> = [0.2, 0.5, 0.7].map(turn => [center.x + radius * Math.cos(start + turn) - grab.x, center.y + radius * Math.sin(start + turn) - grab.y])
      dragOnScreen(mode, grab, path, { shiftKey })
      expect(setup.updates).toHaveLength(1)
      const turned = setup.store.get('box')!
      expectBox(turned)
      expect(altitudes(turned)).toEqual(altitudes(rectangle()))
      return featureRotationDegrees(turned)
    }
    // 0.7 rad clockwise on the screen (north up) is clockwise seen from above.
    const free = turnBy({}, true)
    expect(free).toBeGreaterThan(20)
    expect(Math.abs(free - Math.round(free / 15) * 15)).toBeGreaterThan(0.01)
    const snapped = turnBy({ snapping: true }, true)
    expect(Math.abs(snapped - Math.round(snapped / 15) * 15)).toBeLessThan(1e-6)
    expect(snapped).not.toBe(0)
  })

  it('tilts with the arc around east: the top face is no longer level, distances are kept', () => {
    // Seen looking north the arc around east is edge on, on the arrows: it hides.
    expect(selectIn([rectangle()]).mode.gizmoHandles().map(each => each.handle)).not.toContain('rotate-x')
    const { setup, mode } = selectIn([rectangle()], {}, true)
    dragOnScreen(mode, handleOnScreen(mode, 'rotate-x'), [[3, -5], [10, -20]])
    expect(setup.updates).toHaveLength(1)
    const tilted = setup.store.get('box')!
    expectBox(tilted)
    const top = topFace(tilted)
    expect(Math.max(...top) - Math.min(...top)).toBeGreaterThan(10)
    const before = vertexDistances(rectangle())
    vertexDistances(tilted).forEach((distance, index) => expect(distance).toBeCloseTo(before[index]!, 2))
  })

  it('scales along one axis with its cube, and uniformly with the outer ring', () => {
    const { setup, mode } = selectIn([rectangle()])
    const cube = handleOnScreen(mode, 'scale-x')
    const center = handleOnScreen(mode, 'move-free')
    // Dragged as far again from the center: twice as wide.
    dragOnScreen(mode, cube, [[10, 0], [cube.x - center.x, 0]])
    const wider = setup.store.get('box')!
    expect(measure(wider)).toMatchObject({ widthMeters: expect.closeTo(2000, -1), lengthMeters: expect.closeTo(2000, 0) })
    expect(altitudes(wider)).toEqual(altitudes(rectangle()))
    const ring = mode.gizmoHandles().filter(each => each.handle === 'scale-uniform').at(-1)!
    dragOnScreen(mode, ring, [[10, 0], [ring.x - center.x, 0]])
    const bigger = setup.store.get('box')!
    expect(measure(bigger).lengthMeters).toBeCloseTo(4000, -1)
    expect(Math.max(...altitudes(bigger))).toBeCloseTo(600, 0)
    expect(setup.updates).toHaveLength(2)
  })

  it('records nothing for a handle dragged back where it started, and still moves the body away from the handles', () => {
    const { setup, mode } = selectIn([rectangle()])
    const arrow = handleOnScreen(mode, 'move-x')
    dragOnScreen(mode, arrow, [[30, 0], [0, 0]])
    expect(setup.updates).toHaveLength(0)
    expect(mode.status().canUndo).toBe(false)
    // Inside the box, south-west of the gizmo: the body.
    expect(mode.pointerDown(screenEvent(-50, 70))).toBe(true)
    expect(mode.inspect()).toMatchObject({ drag: { kind: 'feature' } })
    mode.pointerCancel()
    // A finger next to (not on) the east arrow inside the box still moves the body; outside the box it takes the arrow.
    expect(mode.pointerDown(screenEvent(arrow.x, arrow.y + 9, { pointerType: 'touch' }))).toBe(true)
    expect(mode.inspect()).toMatchObject({ drag: { kind: 'feature' } })
    mode.pointerCancel()
    expect(mode.pointerDown(screenEvent(5000, 0))).toBe(false)
  })

  it('shows only the picked tool, and turns handle groups off with options', () => {
    const { mode } = selectIn([rectangle()])
    const kinds = () => [...new Set(mode.gizmoHandles().map(each => each.handle.split('-')[0]))].sort()
    expect(kinds()).toEqual(['move', 'rotate', 'scale'])
    mode.setGizmoTool('move')
    expect(kinds()).toEqual(['move'])
    mode.setGizmoTool('rotate')
    expect(kinds()).toEqual(['rotate'])
    mode.setGizmoTool('scale')
    expect(kinds()).toEqual(['scale'])
    // With the scale tool the center ring scales too.
    expect(mode.gizmoHandles().filter(each => each.handle === 'scale-uniform')).toHaveLength(2)
    expect(() => mode.setGizmoTool('stretch' as never)).toThrow(/pick one of all, move, rotate, scale/)
    const limited = selectIn([rectangle()], { rotate: false, scale: false })
    expect([...new Set(limited.mode.gizmoHandles().map(each => each.handle.split('-')[0]))]).toEqual(['move'])
  })

  it('moves along the feature’s own axes in local space', () => {
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30, baseHeightMeters: 0, heightMeters: 10 }), id: 'box' } as DrawFeature
    const { setup, mode } = selectIn([turned], { gizmoSpace: 'local' })
    expect(mode.gizmoSpace).toBe('local')
    dragOnScreen(mode, handleOnScreen(mode, 'move-x'), [[5, 5], [30, 20]])
    const moved = featureCenter(setup.store.get('box')!)
    // Along its width: 120° from north.
    expect(bearingDegrees(featureCenter(turned), moved)).toBeCloseTo(120, 0)
  })

  it('raises with a knob up the screen when seen from straight above', () => {
    const { setup, mode } = selectIn([rectangle()])
    setup.context.projectAtHeight = position => setup.toScreen(position, 0)
    const knob = handleOnScreen(mode, 'move-z')
    const center = handleOnScreen(mode, 'move-free')
    expect(knob.x).toBeCloseTo(center.x, 6)
    expect(center.y - knob.y).toBeCloseTo(68, 0)
    dragOnScreen(mode, knob, [[0, -10], [0, -40]])
    expect(Math.min(...altitudes(setup.store.get('box')!))).toBeGreaterThan(100)
  })
})

describe('gizmo settings of a Draw', () => {
  it('sets the tool and the space on its select modes, in its state', () => {
    const select = new SelectMode({ gizmoTool: 'rotate' })
    const draw = new Draw({ modes: [select], mode: 'select' })
    expect(draw.getState().gizmoTool).toBe('rotate')
    const states: string[] = []
    draw.subscribe(state => states.push(`${state.gizmoTool} ${state.gizmoSpace}`))
    draw.setGizmoTool('scale')
    draw.setGizmoSpace('local')
    expect(states).toEqual(['scale world', 'scale local'])
    expect([select.gizmoTool, select.gizmoSpace]).toEqual(['scale', 'local'])
    expect(() => draw.setGizmoTool('stretch' as never)).toThrow(/Draw.setGizmoTool: "stretch" is no gizmo tool/)
    expect(() => draw.setGizmoSpace('screen' as never)).toThrow(/pick 'world' or 'local'/)
  })
})

describe('keyboard transforms', () => {
  it('is off by default in a Draw', () => {
    expect(new Draw().keyboard).toBe(false)
    expect(new Draw({ keyboard: true }).keyboard).toBe(true)
    expect(new Draw().getState()).toMatchObject({ gizmoTool: 'all', gizmoSpace: 'world' })
  })

  it('moves with G under the pointer, locks to east with X, and confirms with Enter in one update', () => {
    const { setup, mode } = selectIn([rectangle()])
    mode.hover(screenEvent(0, 0))
    expect(mode.keyDown(key('g'))).toBe(true)
    expect(mode.transforming).toBe('move')
    mode.hover(screenEvent(50, -40))
    expect(setup.updates).toHaveLength(0)
    expect(mode.keyDown(key('x'))).toBe(true)
    expect(mode.keyDown(key('Enter'))).toBe(true)
    expect(setup.updates).toHaveLength(1)
    const moved = featureCenter(setup.store.get('box')!)
    expect(moved[0]).toBeCloseTo(CENTER[0] + 0.005, 4)
    expect(moved[1]).toBeCloseTo(CENTER[1], 5)
    expect(mode.transforming).toBeNull()
  })

  it('turns with R and scales up with S then Z; Escape and a right click cancel, a click confirms', () => {
    const { setup, mode } = selectIn([rectangle()])
    mode.hover(screenEvent(60, 0))
    mode.keyDown(key('r'))
    mode.hover(screenEvent(0, 60))
    expect(mode.keyDown(key('Escape'))).toBe(true)
    expect(setup.updates).toHaveLength(0)
    mode.hover(screenEvent(60, 0))
    mode.keyDown(key('r'))
    mode.hover(screenEvent(0, 60))
    expect(mode.secondaryPress()).toBe(true)
    expect(setup.updates).toHaveLength(0)
    expect(mode.secondaryPress()).toBe(false)
    mode.hover(screenEvent(60, 0))
    mode.keyDown(key('r'))
    mode.hover(screenEvent(0, 60))
    mode.click(screenEvent(0, 60))
    expect(setup.updates).toHaveLength(1)
    expect(Math.abs(featureRotationDegrees(setup.store.get('box')!))).toBeGreaterThan(1)
    // Twice as far from the gizmo's center: twice as tall.
    const center = handleOnScreen(mode, 'move-free')
    mode.hover(screenEvent(center.x + 30, center.y))
    mode.keyDown(key('s'))
    mode.keyDown(key('z'))
    expect(mode.pointerDown(screenEvent(center.x + 60, center.y))).toBe(true)
    mode.pointerUp(screenEvent(center.x + 60, center.y))
    expect(setup.updates).toHaveLength(2)
    const scaled = setup.store.get('box')!
    expect(Math.max(...altitudes(scaled))).toBeCloseTo(600, 0)
    expect(Math.min(...altitudes(scaled))).toBeCloseTo(0, 3)
  })
})

describe('free-form pivots', () => {
  it('turns a polygon around its vertex average, which stays put', () => {
    const triangle: DrawFeature = { type: 'Feature', id: 't', properties: {}, geometry: { type: 'Polygon', coordinates: [[[6.6, 46.45], [6.62, 46.45], [6.6, 46.47], [6.6, 46.45]]] } }
    const center = featureCenter(triangle)
    expect(center[0]).toBeCloseTo(6.6 + 0.02 / 3, 9)
    expect(center[1]).toBeCloseTo(46.45 + 0.02 / 3, 9)
    const after = featureCenter(rotateFeature(triangle, center, 40))
    expect(distanceMeters(center, after)).toBeLessThan(5)
  })
})

function key(name: string): KeyboardEvent {
  return { key: name } as KeyboardEvent
}
