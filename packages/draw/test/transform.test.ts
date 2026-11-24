import type { LineString, Point, Polygon, Position } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { SelectMode } from '../src/modes/SelectMode.js'
import { createCircle, createEllipse, createRectangle, createRegularPolygon, createSphere, destination, shapeOf } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import { baseAltitudeOf, featureCenter, liftFeature, placeOnTerrain, rotateFeature, scaleFeature, setExtrusionHeight, stretchFeature, transformFrame } from '../src/transform.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

const CENTER: [number, number] = [6.6, 46.45]
const rectangle = (): DrawFeature => ({ ...createRectangle(CENTER, 1000, 2000, { extrusionHeightMeters: 300 }), id: 'box' }) as DrawFeature

describe('transforms', () => {
  it('turns a shape around its center, keeping its size and updating its rotation', () => {
    const turned = rotateFeature(rectangle(), CENTER, 90)
    expect(shapeOf(turned)).toMatchObject({ type: 'rectangle', widthMeters: 1000, lengthMeters: 2000, rotationDegrees: 90 })
    const ring = (turned.geometry as Polygon).coordinates[0]!
    // Now 2000 m east-west: the first two corners (formerly 1000 m apart, west-east) run north-south.
    expect(distanceMeters(ring[0]!, ring[1]!)).toBeCloseTo(1000, 0)
    expect(distanceMeters(ring[1]!, ring[2]!)).toBeCloseTo(2000, 0)
    expect(Math.abs(ring[0]![0]! - ring[1]![0]!)).toBeLessThan(1e-4) // same longitude: a north-south edge
    expect(turned.properties?.extrusionHeightMeters).toBe(300)
    expect(shapeOf(rotateFeature(rectangle(), CENTER, -30))).toMatchObject({ rotationDegrees: 330 })
  })

  it('scales around the center: positions, shape measurements and sphere radii', () => {
    const scaled = scaleFeature(rectangle(), CENTER, 2)
    expect(shapeOf(scaled)).toMatchObject({ widthMeters: 2000, lengthMeters: 4000 })
    const ring = (scaled.geometry as Polygon).coordinates[0]!
    expect(distanceMeters(ring[1]!, ring[2]!)).toBeCloseTo(4000, 0)
    const circle = { ...createCircle(CENTER, 500), id: 'c' } as DrawFeature
    expect(shapeOf(scaleFeature(circle, CENTER, 0.5))).toMatchObject({ radiusMeters: 250 })
    const ball = { ...createSphere(CENTER, 100), id: 'b' } as DrawFeature
    expect(shapeOf(scaleFeature(ball, CENTER, 3))).toMatchObject({ radiusMeters: 300 })
    expect(() => scaleFeature(circle, CENTER, 0)).toThrow(/positive number/)
  })

  it('sets and removes extrusion heights', () => {
    expect(setExtrusionHeight(rectangle(), 900).properties?.extrusionHeightMeters).toBe(900)
    expect(setExtrusionHeight(rectangle(), 0).properties).not.toHaveProperty('extrusionHeightMeters')
  })

  it('puts the gizmo around the feature: corners on its box, the knob beyond its top, none on circles', () => {
    const frame = transformFrame(rectangle())
    expect(frame.center).toEqual(CENTER)
    expect(frame.corners).toHaveLength(4)
    for (const corner of frame.corners) expect(distanceMeters(CENTER, corner)).toBeCloseTo(Math.hypot(500, 1000), -1)
    // 1000 m to the top edge, then a quarter of the 2000 m length.
    expect(distanceMeters(CENTER, frame.rotationHandle!)).toBeCloseTo(1500, -1)
    expect(frame.extrusionHeightMeters).toBe(300)
    expect(transformFrame({ ...createCircle(CENTER, 100), id: 'c' } as DrawFeature).rotationHandle).toBeNull()
    expect(transformFrame({ type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: CENTER } }).corners).toEqual([])
    // Side handles in the middle of each edge (bottom, right, top, left), none on spheres.
    expect(frame.sideHandles.map(side => [side.axis, side.sideMeters, side.fixedMeters].map(value => (typeof value === 'number' ? Math.round(value) : value)))).toEqual([
      ['along', -1000, 1000],
      ['across', 500, -500],
      ['along', 1000, -1000],
      ['across', -500, 500],
    ])
    expect(distanceMeters(CENTER, frame.sideHandles[1]!.position)).toBeCloseTo(500, 0)
    expect(transformFrame({ ...createSphere(CENTER, 100), id: 'b' } as DrawFeature).sideHandles).toEqual([])
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [[179.9, 0], [180.1, 0]] } }
    expect(featureCenter(line)[0]).toBeCloseTo(180, 9)
  })
})

describe('stretching and lifting', () => {
  const ring = (feature: DrawFeature) => (feature.geometry as Polygon).coordinates[0]!

  it('stretches a rectangle across, keeping the opposite edge where it was', () => {
    const box = rectangle()
    const frame = transformFrame(box)
    const right = frame.sideHandles.find(side => side.axis === 'across' && side.sideMeters > 0)!
    const stretched = stretchFeature(box, frame, 'across', right.fixedMeters, 1.5)
    const shape = shapeOf(stretched) as { widthMeters: number; lengthMeters: number; center: [number, number] }
    expect(shape.widthMeters).toBeCloseTo(1500, 6)
    expect(shape.lengthMeters).toBe(2000)
    expect(distanceMeters(CENTER, shape.center)).toBeCloseTo(250, 1)
    // The west corners (the first and the last) stay; the east ones move 500 m east.
    expect(distanceMeters(ring(box)[0]!, ring(stretched)[0]!)).toBeLessThan(0.01)
    expect(distanceMeters(ring(box)[3]!, ring(stretched)[3]!)).toBeLessThan(0.01)
    expect(distanceMeters(ring(box)[1]!, ring(stretched)[1]!)).toBeCloseTo(500, 1)
    expect(distanceMeters(ring(stretched)[0]!, ring(stretched)[1]!)).toBeCloseTo(1500, 1)
    expect(stretched.properties?.extrusionHeightMeters).toBe(300)
    // A turned rectangle stretches along its own length.
    const turned = { ...createRectangle(CENTER, 1000, 2000, { rotationDegrees: 30 }), id: 't' } as DrawFeature
    const turnedFrame = transformFrame(turned)
    expect(shapeOf(stretchFeature(turned, turnedFrame, 'along', -1000, 0.5))).toMatchObject({ widthMeters: 1000, lengthMeters: expect.closeTo(1000, 6), rotationDegrees: 30 })
  })

  it('makes an ellipse of a stretched circle, keeps an ellipse one, and a regular polygon a plain polygon', () => {
    const circle = { ...createCircle(CENTER, 500), id: 'c' } as DrawFeature
    const oval = stretchFeature(circle, transformFrame(circle), 'along', -500, 2)
    expect(shapeOf(oval)).toMatchObject({ type: 'ellipse', semiMajorAxisMeters: 1000, semiMinorAxisMeters: 500, rotationDegrees: 0 })
    expect(distanceMeters(CENTER, shapeOf(oval)!.center)).toBeCloseTo(500, 1)
    const wide = stretchFeature(oval, transformFrame(oval), 'across', 500, 3)
    expect(shapeOf(wide)).toMatchObject({ type: 'ellipse', semiMajorAxisMeters: 1000, semiMinorAxisMeters: 1500 })
    const ellipse = { ...createEllipse(CENTER, 800, 400, { rotationDegrees: 45 }), id: 'e' } as DrawFeature
    expect(shapeOf(stretchFeature(ellipse, transformFrame(ellipse), 'across', -400, 0.5))).toMatchObject({ type: 'ellipse', semiMajorAxisMeters: 800, semiMinorAxisMeters: 200, rotationDegrees: 45 })
    const hexagon = { ...createRegularPolygon(CENTER, 500, 6, { extrusionHeightMeters: 50 }), id: 'h' } as DrawFeature
    const squashed = stretchFeature(hexagon, transformFrame(hexagon), 'across', 0, 0.5)
    expect(shapeOf(squashed)).toBeNull()
    expect(squashed.properties).toEqual({ extrusionHeightMeters: 50 })
    const ball = { ...createSphere(CENTER, 100), id: 'b' } as DrawFeature
    expect(stretchFeature(ball, transformFrame(ball), 'across', 0, 2)).toBe(ball)
    expect(() => stretchFeature(circle, transformFrame(circle), 'across', 0, -1)).toThrow(/positive number/)
  })

  it('lifts features into the air from the terrain or their altitude, keeping the extrusion, and back down', () => {
    const lifted = liftFeature(rectangle(), 200, 50)
    for (const position of ring(lifted)) expect(position[2]).toBe(250)
    expect(lifted.properties?.extrusionHeightMeters).toBe(300)
    expect(baseAltitudeOf(lifted)).toBe(250)
    expect(baseAltitudeOf(rectangle())).toBeNull()
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [[6.6, 46.45, 100], [6.61, 46.45, 300]] } }
    expect((liftFeature(line, -50).geometry as LineString).coordinates.map(position => position[2])).toEqual([50, 250])
    // A resting ball's altitude is its center: the ground plus its radius.
    const ball = liftFeature({ ...createSphere(CENTER, 100), id: 'b' } as DrawFeature, 400, 10)
    expect((ball.geometry as Point).coordinates).toEqual([CENTER[0], CENTER[1], 510])
    expect(baseAltitudeOf(ball)).toBe(410)
    expect(ring(placeOnTerrain(lifted)).every((position: Position) => position.length === 2)).toBe(true)
    expect(placeOnTerrain(lifted).properties?.extrusionHeightMeters).toBe(300)
  })

  it('lifts a feature on the terrain from the height under each position, and fills the gaps of mixed altitudes', () => {
    const relief = (longitude: number, latitude: number) => (longitude - 6.6) * 10_000 + (latitude - 46.45) * 1000
    const lifted = liftFeature(rectangle(), 100, relief)
    for (const position of ring(lifted)) expect(position[2]).toBeCloseTo(relief(position[0]!, position[1]!) + 100, 9)
    // Any altitude puts the feature in the air (as it is drawn): its base is the first one, the others come from the terrain.
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
    expect(shapeOf(setup.store.get('box')!)).toMatchObject({ rotationDegrees: 90 })
    mode.undo()
    expect(shapeOf(setup.store.get('box')!)).toMatchObject({ rotationDegrees: 0 })
  })

  it('scales with a corner, and raises the height with the knob on top', () => {
    const setup = createContext([rectangle()])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const corner = transformFrame(rectangle()).corners[2]!
    expect(mode.pointerDown(pointerAt(setup, corner))).toBe(true)
    const far = destination(CENTER, distanceMeters(CENTER, corner) * 1.5, 26.565)
    mode.pointerMove(pointerAt(setup, far))
    mode.pointerUp(pointerAt(setup, far))
    expect(shapeOf(setup.store.get('box')!)).toMatchObject({ widthMeters: expect.closeTo(1500, 0), lengthMeters: expect.closeTo(3000, 0) })
    // The height knob is drawn 300 m up, 30 px above the center; dragging it 50 px up adds 500 m.
    const top = pointerAt(setup, CENTER, { heightMeters: 300 })
    expect(mode.pointerDown(top)).toBe(true)
    mode.pointerMove({ ...top, screen: { xPixels: top.screen.xPixels, yPixels: top.screen.yPixels - 50 } })
    mode.pointerUp(top)
    expect(setup.store.get('box')!.properties?.extrusionHeightMeters).toBeCloseTo(800, 6)
  })

  it('extrudes a flat rectangle with the knob in its middle, and flattens it again', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'box' } as DrawFeature
    const setup = createContext([flat])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const middle = pointerAt(setup, CENTER)
    expect(mode.pointerDown(middle)).toBe(true) // the knob, not the body
    mode.pointerMove({ ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels - 30 } })
    mode.pointerUp(middle)
    expect(setup.store.get('box')!.properties?.extrusionHeightMeters).toBeCloseTo(300, 6)
    const top = pointerAt(setup, CENTER, { heightMeters: 300 })
    expect(mode.pointerDown(top)).toBe(true)
    mode.pointerMove({ ...top, screen: { xPixels: top.screen.xPixels, yPixels: top.screen.yPixels + 40 } })
    mode.pointerUp(top)
    expect(setup.store.get('box')!.properties).not.toHaveProperty('extrusionHeightMeters')
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
    expect(setup.store.get('box')!.properties?.extrusionHeightMeters).toBeCloseTo(500, 3)
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
    expect(distanceMeters(shapeOf(setup.store.get('box')!)!.center, destination(CENTER, 3000, 90))).toBeLessThan(1)
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
    expect(setup.store.get('box')!.properties).not.toHaveProperty('extrusionHeightMeters')
    expect(shapeOf(setup.store.get('box')!)!.center[0]).toBeCloseTo(CENTER[0] + 0.01, 6)
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
    const rotation = (shapeOf(setup.store.get('box')!) as { rotationDegrees: number }).rotationDegrees
    expect(rotation % 15).toBeCloseTo(0, 6)
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
    expect(shapeOf(box)).toMatchObject({ type: 'rectangle', widthMeters: expect.closeTo(1500, -1), lengthMeters: 2000 })
    // The west edge stayed.
    expect(distanceMeters(transformFrame(box).sideHandles[3]!.position, frame.sideHandles[3]!.position)).toBeLessThan(5)
    // It cannot cross the opposite edge: pulled far past it, the box keeps a sliver.
    mode.pointerDown(pointerAt(setup, transformFrame(box).sideHandles[1]!.position))
    const past = destination(CENTER, 5000, 270)
    mode.pointerMove(pointerAt(setup, past))
    mode.pointerUp(pointerAt(setup, past))
    expect((shapeOf(setup.store.get('box')!) as { widthMeters: number }).widthMeters).toBeCloseTo(15, 0)
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
    for (const position of (lifted.geometry as Polygon).coordinates[0]!) expect(position[2]).toBeCloseTo(500, 6)
    expect(lifted.properties?.extrusionHeightMeters).toBe(300)
    expect(shapeOf(lifted)).toMatchObject({ type: 'rectangle', widthMeters: 1000 })
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

  it('lifts a flat shape by the knob under its middle, apart from the height knob on it, and lifts a ball by its center', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'flat' } as DrawFeature
    const ball = { ...createSphere(destination(CENTER, 5000, 90), 100), id: 'ball' } as DrawFeature
    const setup = createContext([flat, ball])
    const mode = new SelectMode()
    mode.enter(setup.context)
    mode.setSelection(['flat'])
    const middle = pointerAt(setup, CENTER)
    const knob: DrawPointerEvent = { ...middle, screen: { xPixels: middle.screen.xPixels, yPixels: middle.screen.yPixels + 24 } }
    expect(mode.pointerDown(knob)).toBe(true)
    mode.pointerMove({ ...knob, screen: { xPixels: knob.screen.xPixels, yPixels: knob.screen.yPixels - 30 } })
    mode.pointerUp(knob)
    const lifted = setup.store.get('flat')!
    expect(baseAltitudeOf(lifted)).toBeCloseTo(300, 6)
    expect(lifted.properties).not.toHaveProperty('extrusionHeightMeters')
    // A small lift that ends on the ground changes nothing.
    mode.setSelection(['ball'])
    const ground = pointerAt(setup, destination(CENTER, 5000, 90))
    const ballKnob: DrawPointerEvent = { ...ground, screen: { xPixels: ground.screen.xPixels, yPixels: ground.screen.yPixels + 24 } }
    expect(mode.pointerDown(ballKnob)).toBe(true)
    mode.pointerMove({ ...ballKnob, screen: { xPixels: ballKnob.screen.xPixels, yPixels: ballKnob.screen.yPixels + 10 } })
    mode.pointerUp(ballKnob)
    expect(setup.updates).toHaveLength(1)
    expect(mode.pointerDown(ballKnob)).toBe(true)
    mode.pointerMove({ ...ballKnob, screen: { xPixels: ballKnob.screen.xPixels, yPixels: ballKnob.screen.yPixels - 20 } })
    mode.pointerUp(ballKnob)
    // Resting on the ground, its center was at its radius: 100 m, now 300 m.
    expect((setup.store.get('ball')!.geometry as Point).coordinates[2]).toBeCloseTo(300, 6)
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
    expect(distanceMeters(shapeOf(tiny.store.get('small')!)!.center, moved)).toBeLessThan(1)
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
