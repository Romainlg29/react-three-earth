import type { LineString, MultiPolygon, Polygon, Position } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import { indexMesh, isClosedMesh, meshVolume } from '../src/mesh.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { SelectMode } from '../src/modes/SelectMode.js'
import { bearingDegrees, createCircle, createRectangle, createRegularPolygon, createSphere, destination } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import {
  baseAltitudeOf,
  extrudeFeature,
  featureCenter,
  featureRotationDegrees,
  liftFeature,
  meshTopOf,
  moveMeshTop,
  placeOnTerrain,
  rotateFeature,
  scaleFeature,
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
function createContext(features: DrawFeature[]) {
  const store = new FeatureStore()
  store.set(features)
  const updates: DrawFeature[][] = []
  const toScreen = ([longitude, latitude]: [number, number], heightMeters: number) => ({ x: (longitude - CENTER[0]) * 10_000, y: (CENTER[1] - latitude) * 10_000 - heightMeters / 10 })
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

describe('the gizmo of the select mode', () => {
  it('turns a selected box with its knob, snapping with Shift, in one update', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const knob = transformFrame(rectangle()).rotationHandle!
    expect(mode.pointerDown(pointerAt(setup, knob))).toBe(true)
    mode.pointerMove(pointerAt(setup, destination(CENTER, 1500, 50), { shiftKey: true }))
    mode.pointerMove(pointerAt(setup, destination(CENTER, 1500, 88), { shiftKey: true }))
    expect(setup.updates).toHaveLength(0)
    mode.pointerUp(pointerAt(setup, destination(CENTER, 1500, 88)))
    expect(setup.updates).toHaveLength(1)
    // Turned a quarter: its length runs east-west.
    const turned = setup.store.get('box')!
    expect(Math.abs(measure(turned).rotationDegrees)).toBeCloseTo(90, 1)
    expectBox(turned)
    mode.undo()
    expect(measure(setup.store.get('box')!).rotationDegrees).toBeCloseTo(0, 1)
  })

  it('scales with a corner, and raises the top face with the knob on top', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const corner = transformFrame(rectangle()).corners[2]!
    expect(mode.pointerDown(pointerAt(setup, corner))).toBe(true)
    const far = destination(CENTER, distanceMeters(CENTER, corner) * 1.5, 26.565)
    mode.pointerMove(pointerAt(setup, far))
    mode.pointerUp(pointerAt(setup, far))
    const scaled = setup.store.get('box')!
    expect(measure(scaled)).toMatchObject({ widthMeters: expect.closeTo(1500, 0), lengthMeters: expect.closeTo(3000, 0) })
    // Scaled in 3D from its base: 450 m tall now.
    expect(Math.max(...altitudes(scaled))).toBeCloseTo(450, 0)
    // The height knob is drawn on its top, 45 px above the center; dragging it 50 px up raises the top 500 m.
    const top = pointerAt(setup, CENTER, { heightMeters: Math.max(...altitudes(scaled)) })
    expect(mode.pointerDown(top)).toBe(true)
    mode.pointerMove({ ...top, screen: { xPixels: top.screen.xPixels, yPixels: top.screen.yPixels - 50 } })
    mode.pointerUp(top)
    const raised = setup.store.get('box')!
    expectBox(raised)
    expect(Math.max(...altitudes(raised))).toBeCloseTo(Math.max(...altitudes(scaled)) + 500, 6)
    expect(Math.min(...altitudes(raised))).toBe(0)
  })

  it('extrudes a flat rectangle into a box with the knob in its middle, whose top then goes no lower than 1 m', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'box' } as DrawFeature
    const setup = createContext([flat])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const middle = pointerAt(setup, CENTER)
    expect(mode.pointerDown(middle)).toBe(true) // the knob, not the body
    mode.pointerMove({ ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels - 30 } })
    mode.pointerUp(middle)
    const box = setup.store.get('box')!
    expectBox(box)
    expect(box.properties).toEqual({})
    expect(Math.max(...altitudes(box))).toBeCloseTo(300, 6)
    expect(Math.min(...altitudes(box))).toBe(0)
    expect(setup.updates).toHaveLength(1)
    const top = pointerAt(setup, CENTER, { heightMeters: 300 })
    expect(mode.pointerDown(top)).toBe(true)
    mode.pointerMove({ ...top, screen: { xPixels: top.screen.xPixels, yPixels: top.screen.yPixels + 40 } })
    mode.pointerUp(top)
    expect(Math.max(...altitudes(setup.store.get('box')!))).toBeCloseTo(1, 6)
    // A drag that stays under a metre leaves a flat feature flat.
    const other = createContext([{ ...flat, id: 'other' }])
    const second = new SelectMode()
    second.enter(other.context)
    second.setSelection(['other'])
    expect(second.pointerDown(middle)).toBe(true)
    second.pointerMove({ ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels - 0.05 } })
    second.pointerUp(middle)
    expect(other.store.get('other')!.geometry.type).toBe('Polygon')
  })

  it('extrudes by dragging up the screen when seen from straight above', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'box' } as DrawFeature
    const setup = createContext([flat])
    // From above, heights do not move anything on the screen.
    setup.context.projectAtHeight = position => setup.toScreen(position, 0)
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const middle = pointerAt(setup, CENTER)
    // 1 km of ground is (1000 / 111 320 / cos 46.45°) × 10 000 px, about 130 px.
    const pixelsPerKilometre = distanceMeters(CENTER, destination(CENTER, 1000, 90)) > 0 ? Math.hypot(setup.toScreen(destination(CENTER, 1000, 90), 0).x - middle.screen.xPixels, 0) : 0
    expect(mode.pointerDown(middle)).toBe(true)
    mode.pointerMove({ ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels - pixelsPerKilometre / 2 } })
    mode.pointerUp(middle)
    expect(Math.max(...altitudes(setup.store.get('box')!))).toBeCloseTo(500, 3)
  })

  it('still moves the feature by its body, and leaves presses elsewhere to the camera', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    expect(mode.pointerDown(pointerAt(setup, destination(CENTER, 5000, 90)))).toBe(false)
    const inside = destination(CENTER, 200, 200)
    expect(mode.pointerDown(pointerAt(setup, inside))).toBe(true)
    const moved = destination(inside, 3000, 90)
    mode.pointerMove(pointerAt(setup, moved))
    mode.pointerUp(pointerAt(setup, moved))
    expect(distanceMeters(featureCenter(setup.store.get('box')!), destination(CENTER, 3000, 90))).toBeLessThan(1)
    // No vertex handles: the gizmo instead.
    const content = { features: [], lines: [], handles: [] as unknown[] }
    mode.overlay(content as never)
    expect(content.handles).toHaveLength(4 + 4 + 1 + 1 + 1) // corners, sides, the turning knob, the height knob, the lift knob
  })

  it('moves a flat feature when a finger lands inside it near, but not on, the middle knob', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'box' } as DrawFeature
    const setup = createContext([flat])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const near = pointerAt(setup, CENTER)
    const press: DrawPointerEvent = { ...near, pointerType: 'touch', screen: { xPixels: near.screen.xPixels + 15, yPixels: near.screen.yPixels } }
    expect(mode.pointerDown(press)).toBe(true)
    const moved = { ...press, screen: { xPixels: press.screen.xPixels + 100, yPixels: press.screen.yPixels }, geographic: { ...press.geographic!, longitudeDegrees: press.geographic!.longitudeDegrees + 0.01 } }
    mode.pointerMove(moved)
    mode.pointerUp(moved)
    expect(setup.store.get('box')!.geometry.type).toBe('Polygon')
    expect(featureCenter(setup.store.get('box')!)[0]).toBeCloseTo(CENTER[0] + 0.01, 6)
  })

  it('records nothing when a knob is dragged back where it started', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const knob = transformFrame(rectangle()).rotationHandle!
    expect(mode.pointerDown(pointerAt(setup, knob))).toBe(true)
    mode.pointerMove(pointerAt(setup, destination(CENTER, 1500, 40)))
    mode.pointerMove(pointerAt(setup, knob))
    mode.pointerUp(pointerAt(setup, knob))
    expect(setup.updates).toHaveLength(0)
    expect(mode.status().canUndo).toBe(false)
  })

  it('snaps to absolute multiples of the step, from a shape already turned', () => {
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 7 }), id: 'box' } as DrawFeature
    const setup = createContext([turned])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const knob = transformFrame(turned).rotationHandle!
    expect(mode.pointerDown(pointerAt(setup, knob))).toBe(true)
    mode.pointerMove(pointerAt(setup, destination(CENTER, 1500, 40), { shiftKey: true }))
    mode.pointerUp(pointerAt(setup, destination(CENTER, 1500, 40), { shiftKey: true }))
    const rotation = featureRotationDegrees(setup.store.get('box')!)
    expect(rotation).not.toBeCloseTo(7, 1)
    expect(Math.abs(rotation - Math.round(rotation / 15) * 15)).toBeLessThan(1e-4)
  })

  it('stretches the box by the middle of an edge, the opposite edge fixed, in one update', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const frame = transformFrame(rectangle())
    const right = frame.sideHandles[1]!
    expect(mode.pointerDown(pointerAt(setup, right.position))).toBe(true)
    const pulled = destination(right.position, 500, 90)
    mode.pointerMove(pointerAt(setup, destination(right.position, 200, 90)))
    mode.pointerMove(pointerAt(setup, pulled))
    expect(setup.updates).toHaveLength(0)
    mode.pointerUp(pointerAt(setup, pulled))
    expect(setup.updates).toHaveLength(1)
    const box = setup.store.get('box')!
    expectBox(box)
    expect(measure(box)).toMatchObject({ widthMeters: expect.closeTo(1500, -1), lengthMeters: expect.closeTo(2000, 2) })
    // The west edge stayed.
    expect(distanceMeters(transformFrame(box).sideHandles[3]!.position, frame.sideHandles[3]!.position)).toBeLessThan(5)
    // It cannot cross the opposite edge: pulled far past it, the box keeps a sliver.
    mode.pointerDown(pointerAt(setup, transformFrame(box).sideHandles[1]!.position))
    const past = destination(CENTER, 5000, 270)
    mode.pointerMove(pointerAt(setup, past))
    mode.pointerUp(pointerAt(setup, past))
    expect(measure(setup.store.get('box')!).widthMeters).toBeCloseTo(15, 0)
  })

  it('lifts a box with the knob under its base, keeping its height, and lowers it keeping its altitudes', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    // The lift knob is drawn 24 px under the base's middle (here on the ground, at 0 m).
    const base = pointerAt(setup, CENTER)
    const knob: DrawPointerEvent = { ...base, screen: { xPixels: base.screen.xPixels, yPixels: base.screen.yPixels + 24 } }
    expect(mode.pointerDown(knob)).toBe(true)
    // 50 px up the screen is 500 m up (1 px per 10 m).
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 20 } })
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 50 } })
    expect(setup.updates).toHaveLength(0)
    mode.pointerUp(knob)
    expect(setup.updates).toHaveLength(1)
    const lifted = setup.store.get('box')!
    expectBox(lifted)
    expect(Math.min(...altitudes(lifted))).toBeCloseTo(500, 6)
    expect(Math.max(...altitudes(lifted))).toBeCloseTo(800, 6)
    expect(measure(lifted).widthMeters).toBeCloseTo(1000, 3)
    // Its knob follows it up; lowered near (even under) the ground, a box in the air keeps its altitudes.
    const raised: DrawPointerEvent = { ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 50 } }
    expect(mode.pointerDown(raised)).toBe(true)
    mode.pointerMove({ ...raised, screen: { xPixels: raised.screen.xPixels, yPixels: raised.screen.yPixels + 50.05 } })
    mode.pointerUp(raised)
    expect(setup.updates).toHaveLength(2)
    expect(baseAltitudeOf(setup.store.get('box')!)).toBeCloseTo(-0.5, 6)
    mode.undo()
    expect(baseAltitudeOf(setup.store.get('box')!)).toBeCloseTo(500, 6)
  })

  it('lifts a flat shape by the knob under its middle, apart from the height knob on it, and lifts a ball mesh whole', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'flat' } as DrawFeature
    const ball = { ...createSphere(destination(CENTER, 5000, 90), 100), id: 'ball' } as DrawFeature
    const setup = createContext([flat, ball])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['flat'])
    const middle = pointerAt(setup, CENTER)
    const knob: DrawPointerEvent = { ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels + 24 } }
    // A small lift that ends on the ground changes nothing.
    expect(mode.pointerDown(knob)).toBe(true)
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels + 10 } })
    mode.pointerUp(knob)
    expect(setup.updates).toHaveLength(0)
    expect(mode.pointerDown(knob)).toBe(true)
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 30 } })
    mode.pointerUp(knob)
    const lifted = setup.store.get('flat')!
    expect(baseAltitudeOf(lifted)).toBeCloseTo(300, 6)
    expect(lifted.geometry.type).toBe('Polygon')
    // The ball rests at 0 m: its knob hangs under its foot.
    mode.setSelection(['ball'])
    const foot = pointerAt(setup, featureCenter(ball))
    const ballKnob: DrawPointerEvent = { ...foot, screen: { xPixels: foot.screen.xPixels, yPixels: foot.screen.yPixels + 24 } }
    expect(mode.pointerDown(ballKnob)).toBe(true)
    mode.pointerMove({ ...ballKnob, screen: { xPixels: ballKnob.screen.xPixels, yPixels: ballKnob.screen.yPixels - 20 } })
    mode.pointerUp(ballKnob)
    const raised = setup.store.get('ball')!
    expect(Math.min(...altitudes(raised))).toBeCloseTo(200, 6)
    expect(Math.max(...altitudes(raised))).toBeCloseTo(400, 6)
    expect(setup.updates).toHaveLength(2)
  })

  it('lifts each position from the terrain under it, or the height under the press while the terrain is not known', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'flat' } as DrawFeature
    const setup = createContext([flat])
    const relief = (longitude: number, latitude: number) => 300 + (longitude - CENTER[0]) * 10_000
    setup.context.heights.heightAt = relief as never
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['flat'])
    // The base's middle is drawn at its terrain height (300 m: 30 px up), the knob 24 px below.
    const base = pointerAt(setup, CENTER, { heightMeters: 300 })
    const knob: DrawPointerEvent = { ...base, screen: { xPixels: base.screen.xPixels, yPixels: base.screen.yPixels + 24 } }
    expect(mode.pointerDown(knob)).toBe(true)
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 20 } })
    mode.pointerUp(knob)
    for (const position of (setup.store.get('flat')!.geometry as Polygon).coordinates[0]!) expect(position[2]).toBeCloseTo(relief(position[0]!, position[1]!) + 200, 6)
    // Unknown terrain: the press's ground height stands in, not 0.
    const other = createContext([{ ...flat, id: 'other' }])
    other.context.heights.heightAt = ((_longitude: number, _latitude: number, fallback = 0) => fallback) as never
    const second = new SelectMode()
    second.enter(other.context)
    second.setSelection(['other'])
    const ground = pointerAt(other, CENTER, { heightMeters: 700 })
    const press: DrawPointerEvent = { ...ground, screen: { xPixels: ground.screen.xPixels, yPixels: ground.screen.yPixels + 24 }, geographic: { ...ground.geographic!, heightMeters: 700 } }
    expect(second.pointerDown(press)).toBe(true)
    second.pointerMove({ ...press, screen: { xPixels: press.screen.xPixels, yPixels: press.screen.yPixels - 20 } })
    second.pointerUp(press)
    expect(baseAltitudeOf(other.store.get('other')!)).toBeCloseTo(900, 6)
  })

  it('leaves the body to moving: knobs inside grab only where drawn, and a small feature hides its side and middle knobs', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'flat' } as DrawFeature
    const setup = createContext([flat])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['flat'])
    // 9 px from the middle knob (drawn 8 px wide with its outline): the body.
    const middle = pointerAt(setup, CENTER)
    expect(mode.pointerDown({ ...middle, screen: { xPixels: middle.screen.xPixels + 9, yPixels: middle.screen.yPixels } })).toBe(true)
    expect(mode.inspect()).toMatchObject({ drag: { kind: 'feature' } })
    mode.pointerCancel()
    // 300 m square: about 39 × 27 px, under three knob diameters. A drag from its very middle moves it.
    const small = { ...createRectangle(CENTER, 300, 300), id: 'small' } as DrawFeature
    const tiny = createContext([small])
    const smallMode = new SelectMode()
    smallMode.enter(tiny.context)
    smallMode.setSelection(['small'])
    const content = { features: [], lines: [], handles: [] as unknown[] }
    smallMode.overlay(content as never)
    expect(content.handles).toHaveLength(4 + 1 + 1) // corners, the turning knob, the lift knob
    const press = pointerAt(tiny, CENTER)
    expect(smallMode.pointerDown(press)).toBe(true)
    const moved = destination(CENTER, 2000, 90)
    smallMode.pointerMove(pointerAt(tiny, moved))
    smallMode.pointerUp(pointerAt(tiny, moved))
    expect(distanceMeters(featureCenter(tiny.store.get('small')!), moved)).toBeLessThan(1)
  })

  it('stretches a straight line by its end rather than scaling it, where the handles meet', () => {
    const line: DrawFeature = { type: 'Feature', id: 'line', properties: {}, geometry: { type: 'LineString', coordinates: [[6.6, 46.45], [6.62, 46.45]] } }
    const setup = createContext([line])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['line'])
    const end = pointerAt(setup, [6.62, 46.45])
    expect(mode.pointerDown(end)).toBe(true)
    mode.pointerMove({ ...end, screen: { xPixels: end.screen.xPixels + 100, yPixels: end.screen.yPixels } })
    mode.pointerUp(end)
    const coordinates = (setup.store.get('line')!.geometry as LineString).coordinates
    expect(distanceMeters(coordinates[0]!, [6.6, 46.45])).toBeLessThan(0.5) // the far end stayed
    expect(coordinates[1]![0]).toBeCloseTo(6.63, 4)
  })

  it('turns handles off with options', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode({ rotate: false, stretch: false, lift: false })
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const content = { features: [], lines: [], handles: [] as unknown[] }
    mode.overlay(content as never)
    expect(content.handles).toHaveLength(4 + 1) // corners and the height knob
    // The middle of an edge only grabs the outline: the whole box moves.
    expect(mode.pointerDown(pointerAt(setup, transformFrame(rectangle()).sideHandles[1]!.position))).toBe(true)
    expect(mode.inspect()).toMatchObject({ drag: { kind: 'feature' } })
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
