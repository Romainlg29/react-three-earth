import type { Polygon } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { TransformMode } from '../src/modes/TransformMode.js'
import { createCircle, createRectangle, createSphere, destination, shapeOf } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import { featureCenter, rotateFeature, scaleFeature, setExtrusionHeight, transformFrame } from '../src/transform.js'
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
    const line: DrawFeature = { type: 'Feature', id: 'l', properties: {}, geometry: { type: 'LineString', coordinates: [[179.9, 0], [180.1, 0]] } }
    expect(featureCenter(line)[0]).toBeCloseTo(180, 9)
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

describe('transform mode', () => {
  it('turns a selected box with its knob, snapping with Shift, in one update', () => {
    const setup = createContext([rectangle()])
    const mode = new TransformMode()
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
    const mode = new TransformMode()
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
    const mode = new TransformMode()
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
    const mode = new TransformMode()
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
    const mode = new TransformMode()
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
    expect(content.handles).toHaveLength(4 + 1 + 1) // corners, the turning knob, the height knob
  })

  it('moves a flat feature when a finger lands inside it near, but not on, the middle knob', () => {
    const flat = { ...createRectangle(CENTER, 1000, 2000), id: 'box' } as DrawFeature
    const setup = createContext([flat])
    const mode = new TransformMode()
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
    const mode = new TransformMode()
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
    const mode = new TransformMode()
    mode.enter(setup.context)
    mode.setSelection(['box'])
    const knob = transformFrame(turned).rotationHandle!
    expect(mode.pointerDown(pointerAt(setup, knob))).toBe(true)
    mode.pointerMove(pointerAt(setup, destination(CENTER, 1500, 40), { shiftKey: true }))
    mode.pointerUp(pointerAt(setup, destination(CENTER, 1500, 40), { shiftKey: true }))
    const rotation = (shapeOf(setup.store.get('box')!) as { rotationDegrees: number }).rotationDegrees
    expect(rotation % 15).toBeCloseTo(0, 6)
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
