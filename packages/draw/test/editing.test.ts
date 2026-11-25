import type { LineString, MultiPolygon, Point, Polygon, Position } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, offsetVertices, removeVertex, translateFeature } from '../src/editing.js'
import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import { LocalFrame } from '../src/localFrame.js'
import { indexMesh, meshFromIndexed, prismMesh } from '../src/mesh.js'
import { moveMeshVertices } from '../src/meshEditing.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { SelectMode } from '../src/modes/SelectMode.js'
import { createCircle, createRectangle, createSphere } from '../src/shapes.js'
import { featureCenter } from '../src/transform.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

const square = (): DrawFeature<Polygon> => ({ type: 'Feature', id: 'square', properties: { name: 'field' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } })
const line = (): DrawFeature<LineString> => ({ type: 'Feature', id: 'road', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0, 100], [1, 0, 300]] } })

describe('editing helpers', () => {
  it('lists vertices without the closing position, and the midpoints of every edge', () => {
    expect(featureVertices(square()).map(vertex => vertex.position)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]])
    expect(featureMidpoints(square()).map(midpoint => midpoint.position)).toEqual([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]])
    expect(featureMidpoints(line())).toEqual([{ path: { ring: 0, index: 1 }, position: [0.5, 0], heightMeters: 200 }])
  })

  it('moves the first vertex of a ring together with its closing position, keeping altitudes', () => {
    const moved = moveVertex(square(), { ring: 0, index: 0 }, [-0.5, -0.5])
    const ring = (moved.geometry as Polygon).coordinates[0]!
    expect(ring[0]).toEqual([-0.5, -0.5])
    expect(ring[ring.length - 1]).toEqual([-0.5, -0.5])
    expect(moved.properties).toEqual({ name: 'field' })
    expect((moveVertex(line(), { ring: 0, index: 1 }, [2, 0]).geometry as LineString).coordinates[1]).toEqual([2, 0, 300])
  })

  it('inserts vertices (altitude between its neighbours) and removes them down to the minimum', () => {
    const inserted = insertVertex(line(), { ring: 0, index: 1 }, [0.5, 0.1])
    expect((inserted.geometry as LineString).coordinates).toEqual([[0, 0, 100], [0.5, 0.1, 200], [1, 0, 300]])
    expect(removeVertex(line(), { ring: 0, index: 0 })).toBeNull()
    const triangle = removeVertex(square(), { ring: 0, index: 2 })!
    expect((triangle.geometry as Polygon).coordinates[0]).toEqual([[0, 0], [1, 0], [0, 1], [0, 0]])
    expect(removeVertex(triangle, { ring: 0, index: 0 })).toBeNull()
  })

  it('moves a feature whole keeping its size in metres, and a mesh keeping its altitudes and faces', () => {
    const circle = { ...createCircle([6.6, 46.45], 1000, { steps: 16 }), id: 'c' } as DrawFeature
    const moved = translateFeature(circle, [6.6, 46.45], [8, 60])
    const center = featureCenter(moved)
    // The average of its vertices: within centimetres of where its center went.
    expect(center[0]).toBeCloseTo(8, 5)
    expect(center[1]).toBeCloseTo(60, 5)
    // Still 1 km round, though longitude degrees are much shorter at 60° N.
    for (const position of (moved.geometry as Polygon).coordinates[0]!) expect(distanceMeters(center, position)).toBeCloseTo(1000, 0)
    const box = { ...createRectangle([6.6, 46.45], 100, 200, { baseHeightMeters: 400, heightMeters: 30 }), id: 'b' } as DrawFeature<MultiPolygon>
    const carried = translateFeature(box, [6.6, 46.45], [7, 46]) as DrawFeature<MultiPolygon>
    expect(carried.geometry.coordinates).toHaveLength(6)
    expect(carried.geometry.coordinates.flat(2).map(position => position[2])).toEqual(box.geometry.coordinates.flat(2).map(position => position[2]))
    // Its vertices are shared by its faces, so they are not edited one by one here.
    expect(featureVertices(box)).toEqual([])
    expect(moveVertex(box, { ring: 0, index: 0 }, [7, 46])).toBe(box)
    expect(removeVertex(box, { ring: 0, index: 0 })).toBeNull()
  })

  it('hits solids where they are drawn: a slab at an altitude, and the walls of a box', () => {
    const project = (position: number[], above = 0) => ({ x: position[0]! * 100, y: position[1]! * 100 - ((position[2] ?? 0) + above) / 1000 })
    const at = (x: number, y: number) => ({ ground: [x / 100, y / 100] as [number, number], screen: { x, y }, tolerancePixels: 10, project })
    // A slab 50 km up (drawn 50 px higher than its footprint).
    const slab: DrawFeature = { ...square(), geometry: { type: 'Polygon', coordinates: [[[0, 0, 50_000], [1, 0, 50_000], [1, 1, 50_000], [0, 1, 50_000], [0, 0, 50_000]]] } }
    expect(hitFeature(slab, at(50, 0))).toBe(0)
    expect(hitFeature(slab, at(50, 90))).toBeNull() // its footprint on the ground is not where it is drawn
    // A position without an altitude stands at the lowest given, where it is drawn, not on the ground.
    const partial: DrawFeature = { ...square(), geometry: { type: 'Polygon', coordinates: [[[0, 0, 50_000], [1, 0, 50_000], [1, 1], [0, 1, 50_000], [0, 0, 50_000]]] } }
    expect(hitFeature(partial, at(95, 45))).toBe(0)
    expect(hitFeature(partial, at(95, 95))).toBeNull()
    // A box mesh 30 km tall: its front wall spans y 100 down to 70.
    const box: DrawFeature = { ...square(), geometry: prismMesh(square().geometry.coordinates as Position[][], 0, 30_000) }
    expect(hitFeature(box, at(50, 105 - 30))).toBe(0)
    expect(hitFeature(box, at(50, -25))).toBe(0) // the top, 30 px above the far edge
    expect(hitFeature(box, at(50, 50))).toBe(0)
    expect(hitFeature(box, at(105, 50))).toBeCloseTo(5) // near its right edges
    expect(hitFeature(box, at(150, 50))).toBeNull()
    expect(hitFeature(box, at(50, 120))).toBeNull() // below its foot
  })

  it('offsets picked vertices in a frame: across the terrain, or up giving every position an altitude', () => {
    const frame = new LocalFrame(0.5, 0.5, 0)
    const ground = (longitude: number) => longitude * 1000
    // East 1 km across the terrain: still draped, the others untouched.
    const east = offsetVertices(square(), [{ ring: 0, index: 1 }], [1000, 0, 0], frame, ground)
    const ring = (east.geometry as Polygon).coordinates[0]!
    expect(ring[1]).toHaveLength(2)
    expect(distanceMeters([1, 0], ring[1] as [number, number])).toBeCloseTo(1000, -1)
    expect(ring[0]).toEqual([0, 0])
    // Up 50 m: the picked corner stands 50 m over the terrain, the others on it, the ring still closed.
    const raised = (offsetVertices(square(), [{ ring: 0, index: 2 }], [0, 0, 50], frame, ground).geometry as Polygon).coordinates[0]!
    expect(raised.map(position => position[2])).toEqual([0, 1000, expect.closeTo(1050, 1), 0, 0])
    expect(raised[2]![0]).toBeCloseTo(1, 5) // straight up in the frame, 78 km away: within half a metre
    // A vertex at an altitude moves exactly; no offset changes nothing.
    const lifted = (offsetVertices(line(), [{ ring: 0, index: 0 }], [0, 0, -40], frame).geometry as LineString).coordinates
    expect(lifted[0]![2]).toBeCloseTo(60, 1)
    expect(lifted[1]).toEqual([1, 0, 300])
    expect(offsetVertices(square(), [{ ring: 0, index: 0 }], [0, 0, 0], frame)).toEqual(square())
  })

  it('moves vertices over the antimeridian without wrapping them to the other side', () => {
    const crossing: DrawFeature = { type: 'Feature', id: 'x', properties: {}, geometry: { type: 'LineString', coordinates: [[179, 0], [181, 0]] } }
    expect((moveVertex(crossing, { ring: 0, index: 1 }, [-178.5, 0.5]).geometry as LineString).coordinates[1]).toEqual([181.5, 0.5])
    expect((insertVertex(crossing, { ring: 0, index: 1 }, [-179.9, 0]).geometry as LineString).coordinates[1]).toEqual([180.1, 0])
  })

  it('hits points and lines within the tolerance, polygons inside, sphere meshes inside their faces', () => {
    // Heights rise up the screen, 1 px per kilometre; positions without an altitude stand on terrain at 0 m.
    const project = (position: number[], above = 0) => ({ x: position[0]! * 100, y: position[1]! * 100 - ((position[2] ?? 0) + above) / 1000 })
    const at = (x: number, y: number) => ({ ground: [x / 100, y / 100] as [number, number], screen: { x, y }, tolerancePixels: 10, project })
    expect(hitFeature(square(), at(50, 50))).toBe(0)
    expect(hitFeature(square(), at(105, 50))).toBeCloseTo(5)
    expect(hitFeature(square(), at(150, 50))).toBeNull()
    expect(hitFeature(line(), at(50, 8))).toBeCloseTo(8, 0) // the line is 100 to 300 m up: a fraction of a pixel
    // A 20 km ball resting on the ground: its center is drawn 20 px up, its outline about 18 px around it.
    const sphere = { ...createSphere([0, 0], 20_000), id: 's' } as DrawFeature
    expect(hitFeature(sphere, at(0, -20))).toBe(0)
    expect(hitFeature(sphere, at(15, -20))).toBe(0)
    expect(hitFeature(sphere, at(0, 60))).toBeNull()
    expect(hitFeature({ type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } }, at(103, 104))).toBeCloseTo(5)
  })
})

/** A context over a real store, projecting longitude, latitude to x = longitude × 100, y = latitude × 100 pixels. */
function createContext(features: DrawFeature[]) {
  const store = new FeatureStore()
  store.set(features)
  const events: string[] = []
  const context: DrawModeContext = {
    earth: null as never,
    store,
    heights: { remember: vi.fn(), heightAt: () => 0 } as never,
    style: () => DEFAULT_DRAW_STYLE,
    createId: () => 'new',
    project: ([longitude, latitude]) => ({ x: longitude * 100, y: latitude * 100 }),
    // Heights rise up the screen, 1 px per kilometre.
    projectAtHeight: ([longitude, latitude], heightMeters) => ({ x: longitude * 100, y: latitude * 100 - heightMeters / 1000 }),
    changed: vi.fn(),
    create: created => {
      store.set(created)
      events.push(`create ${created.map(feature => feature.id).join()}`)
    },
    update: updated => {
      store.set(updated)
      events.push(`update ${updated.map(feature => feature.id).join()}`)
    },
    remove: ids => {
      store.remove(ids)
      events.push(`delete ${ids.join()}`)
    },
    setCursor: vi.fn(),
    holdDoubleClickZoom: vi.fn(),
    releaseDoubleClickZoom: vi.fn(),
  }
  return { context, store, events }
}

function pointer(x: number, y: number, pointerType = 'touch'): DrawPointerEvent {
  return { screen: { xPixels: x, yPixels: y }, geographic: { longitudeDegrees: x / 100, latitudeDegrees: y / 100, heightMeters: 0 }, pointerType, originalEvent: {} as MouseEvent }
}

describe('select mode', () => {
  it('selects with a tap, prefers a line over the polygon under it, and clears on the empty map', () => {
    const { context } = createContext([square(), { ...line(), geometry: { type: 'LineString', coordinates: [[0.2, 0.5], [0.8, 0.5]] } }])
    const mode = new SelectMode()
    mode.enter(context)
    mode.click(pointer(50, 52))
    expect(mode.selectedFeatureIds()).toEqual(['road'])
    mode.click(pointer(50, 80))
    expect(mode.selectedFeatureIds()).toEqual(['square'])
    const selection = mode.selectedFeatureIds()
    expect(mode.selectedFeatureIds()).toBe(selection) // the same array until it changes
    mode.click(pointer(300, 300))
    expect(mode.selectedFeatureIds()).toEqual([])
  })

  it('selects the polygon that contains a tap over a neighbour whose edge is near', () => {
    const left = square()
    const right: DrawFeature<Polygon> = { ...square(), id: 'right', geometry: { type: 'Polygon', coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] } }
    const { context } = createContext([right, left])
    const mode = new SelectMode()
    mode.enter(context)
    mode.click(pointer(110, 50)) // 10 px inside the right one, within a finger's reach of the left one's edge
    expect(mode.selectedFeatureIds()).toEqual(['right'])
  })

  it('selects a point inside the selected polygon with a tap on it', () => {
    const { context } = createContext([square(), { type: 'Feature', id: 'well', properties: {}, geometry: { type: 'Point', coordinates: [0.5, 0.5] } }])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    expect(mode.pointerDown(pointer(52, 50))).toBe(true) // a press inside the selection may be a drag
    mode.pointerUp(pointer(52, 50))
    expect(mode.selectedFeatureIds()).toEqual(['well'])
  })

  it('forgets the picked vertex and the undo history when the feature changes elsewhere, and drops a drag on it', () => {
    const { context, store } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    mode.pointerDown(pointer(50, 0)) // insert a vertex: one edit to undo
    mode.pointerUp(pointer(50, 0))
    mode.pointerDown(pointer(100, 100))
    mode.pointerUp(pointer(100, 100))
    expect(mode.status().canUndo).toBe(true)
    store.set([square()]) // replaced by the app
    expect(mode.status().canUndo).toBe(false)
    // The pick was on the old version, so it is gone: Delete removes nothing, never another vertex (nor the feature
    // in edit mode).
    expect(mode.inspect()).toMatchObject({ picked: null, pickedElements: [] })
    expect(mode.deleteSelection()).toBe(false)
    expect((store.get('square')!.geometry as Polygon).coordinates[0]).toHaveLength(5)
    mode.pointerDown(pointer(100, 100))
    store.set([{ ...square(), properties: { name: 'renamed' } }])
    mode.pointerMove(pointer(150, 150))
    mode.pointerUp(pointer(150, 150))
    expect((store.get('square')!.geometry as Polygon).coordinates[0]![2]).toEqual([1, 1])
    expect(store.get('square')!.properties).toEqual({ name: 'renamed' })
  })

  it('leaves presses off the selection to the camera, so one finger still pans', () => {
    const { context } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    expect(mode.pointerDown(pointer(50, 50))).toBe(false) // nothing selected yet
    mode.setSelection(['square'])
    expect(mode.pointerDown(pointer(300, 300))).toBe(false)
  })

  it('drags a vertex, firing one update on release, and undoes it', () => {
    const { context, store, events } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    expect(mode.pointerDown(pointer(100, 100))).toBe(true)
    mode.pointerMove(pointer(120, 110))
    mode.pointerMove(pointer(150, 150))
    expect(events).toEqual([]) // drawn live meanwhile
    expect(mode.liveFeatureIds()).toEqual(['square'])
    mode.pointerUp(pointer(150, 150))
    expect(events).toEqual(['update square'])
    expect((store.get('square')!.geometry as Polygon).coordinates[0]![2]).toEqual([1.5, 1.5])
    expect(mode.status().canUndo).toBe(true)
    mode.undo()
    expect((store.get('square')!.geometry as Polygon).coordinates[0]![2]).toEqual([1, 1])
  })

  it('inserts a vertex with a tap on a midpoint, and deletes a picked vertex', () => {
    const { context, store } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    mode.pointerDown(pointer(50, 0))
    mode.pointerUp(pointer(50, 0))
    expect(featureVertices(store.get('square')!)).toHaveLength(5)
    // A tap on a vertex picks it; Delete removes it.
    mode.pointerDown(pointer(100, 100))
    mode.pointerUp(pointer(100, 100))
    expect(mode.keyDown({ key: 'Delete' } as KeyboardEvent)).toBe(true)
    expect(featureVertices(store.get('square')!).map(vertex => vertex.position)).toEqual([[0, 0], [0.5, 0], [1, 0], [0, 1]])
  })

  it('moves a whole feature by dragging inside it, and deletes the selection', () => {
    const { context, store, events } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    expect(mode.pointerDown(pointer(30, 40))).toBe(true) // inside, off the gizmo's knob in the middle
    mode.pointerMove(pointer(230, 40))
    mode.pointerUp(pointer(230, 40))
    const ring = (store.get('square')!.geometry as Polygon).coordinates[0]!
    expect(ring[0]![0]).toBeCloseTo(2, 2)
    expect(mode.deleteSelection()).toBe(true)
    expect(store.has('square')).toBe(false)
    expect(events).toEqual(['update square', 'delete square'])
    mode.undo()
    expect(store.has('square')).toBe(true)
    expect(events.at(-1)).toBe('create square')
  })

  it('moves sphere meshes whole with the gizmo, and a double tap edits their faces', () => {
    const sphere = { ...createSphere([0.5, 0.5], 20_000), id: 'ball' } as DrawFeature
    const { context, store } = createContext([sphere])
    const mode = new SelectMode()
    mode.enter(context)
    // Drawn where it stands: its center 20 km up, 20 px above its foot.
    mode.click(pointer(50, 30))
    expect(mode.selectedFeatureIds()).toEqual(['ball'])
    const content = { features: [], lines: [], handles: [] }
    mode.overlay(content)
    // The gizmo's handles: three scale cubes, the center ring and the outer ring (its arrows and arcs are lines).
    expect(content.handles).toHaveLength(3 + 2)
    // A second tap at once, a double tap: edit mode, picking the face under it.
    mode.click(pointer(50, 30))
    expect(mode.editingVertices).toBe(true)
    expect(mode.elementMode).toBe('face')
    expect(mode.canExtrude).toBe(true)
    mode.setEditingVertices(false)
    expect(mode.pointerDown(pointer(50, 30))).toBe(true)
    mode.pointerMove(pointer(150, 30))
    mode.pointerUp(pointer(150, 30))
    const moved = store.get('ball')!
    expect(featureCenter(moved)[0]).toBeCloseTo(1.5, 2)
    expect((moved.geometry as MultiPolygon).coordinates).toHaveLength((sphere.geometry as MultiPolygon).coordinates.length)
  })

  it('cancels a drag with pointerCancel (a second finger) without changing the feature', () => {
    const { context, store, events } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    mode.pointerDown(pointer(100, 100))
    mode.pointerMove(pointer(150, 150))
    mode.pointerCancel()
    mode.pointerUp(pointer(150, 150))
    expect(events).toEqual([])
    expect((store.get('square')!.geometry as Polygon).coordinates[0]![2]).toEqual([1, 1])
  })

  it('shows the gizmo first, vertex handles after a second tap, and the gizmo again after a tap on the empty map', () => {
    const { context } = createContext([square(), { ...square(), id: 'other', geometry: { type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]] } }])
    const mode = new SelectMode()
    mode.enter(context)
    const handles = () => {
      const content = { features: [], lines: [], handles: [] as unknown[] }
      mode.overlay(content as never)
      return content.handles.length
    }
    mode.click(pointer(30, 70))
    expect(mode.selectedFeatureIds()).toEqual(['square'])
    expect(mode.editingVertices).toBe(false)
    expect(handles()).toBe(3 + 2) // the gizmo's scale cubes, center ring and outer ring
    // A tap (no drag) on the selected feature: vertex handles and midpoints instead.
    expect(mode.pointerDown(pointer(30, 70))).toBe(true)
    mode.pointerUp(pointer(30, 70))
    expect(mode.editingVertices).toBe(true)
    expect(mode.status().editingVertices).toBe(true)
    expect(handles()).toBe(4 + 4)
    // Again: still editing (a tap off its handles picks nothing).
    mode.pointerDown(pointer(30, 70))
    mode.pointerUp(pointer(30, 70))
    expect(mode.editingVertices).toBe(true)
    // Another feature starts with the gizmo again.
    mode.click(pointer(250, 50))
    expect(mode.selectedFeatureIds()).toEqual(['other'])
    expect(mode.editingVertices).toBe(false)
    // The empty map leaves edit mode first, keeping the selection, then clears it.
    mode.setEditingVertices(true)
    mode.click(pointer(500, 500))
    expect(mode.selectedFeatureIds()).toEqual(['other'])
    expect(mode.editingVertices).toBe(false)
    mode.click(pointer(500, 500))
    expect(mode.selectedFeatureIds()).toEqual([])
    // A tap on the gizmo's center ring over a flat shape is a tap on the shape; Escape steps back to the gizmo first.
    mode.setSelection(['square'])
    expect(mode.pointerDown(pointer(50, 50))).toBe(true)
    mode.pointerUp(pointer(50, 50))
    expect(mode.editingVertices).toBe(true)
    expect(mode.keyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true)
    expect(mode.editingVertices).toBe(false)
    expect(mode.selectedFeatureIds()).toEqual(['square'])
  })

  it('keeps the gizmo with editVertices: false, and edits the vertices of shapes, which are plain polygons', () => {
    const circle = { ...createCircle([0.5, 0.5], 20_000, { steps: 8 }), id: 'c' } as DrawFeature
    const { context, store } = createContext([circle])
    const locked = new SelectMode({ editVertices: false })
    locked.enter(context)
    locked.setSelection(['c'])
    locked.setEditingVertices(true)
    expect(locked.editingVertices).toBe(false)
    locked.exit()
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['c'])
    mode.setEditingVertices(true)
    const first = (store.get('c')!.geometry as Polygon).coordinates[0]![0]!
    const [x, y] = [first[0]! * 100, first[1]! * 100]
    expect(mode.pointerDown(pointer(x, y))).toBe(true)
    mode.pointerMove(pointer(x + 30, y))
    mode.pointerUp(pointer(x + 30, y))
    expect((store.get('c')!.geometry as Polygon).coordinates[0]![0]![0]).toBeCloseTo(first[0]! + 0.3, 6)
  })

  it('draws, hits and drags the vertices of a feature in the air at their altitude, keeping it', () => {
    // A slab 50 km up: drawn 50 px above its footprint.
    const slab: DrawFeature = { ...square(), geometry: { type: 'Polygon', coordinates: [[[0, 0, 50_000], [1, 0, 50_000], [1, 1, 50_000], [0, 1, 50_000], [0, 0, 50_000]]] } }
    const { context, store } = createContext([slab])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    const content = { features: [], lines: [], handles: [] as Array<{ heightMeters?: number }> }
    mode.overlay(content as never)
    expect(content.handles.every(handle => handle.heightMeters === 50_000)).toBe(true)
    expect(mode.pointerDown(pointer(100, 100))).toBe(false) // its footprint's corner, where nothing is drawn
    expect(mode.pointerDown(pointer(100, 50))).toBe(true)
    // The pointer over the ground at (150, 80): the vertex goes where it is under it 50 km up.
    mode.pointerMove(pointer(130, 60))
    mode.pointerMove(pointer(150, 80))
    mode.pointerUp(pointer(150, 80))
    const moved = (store.get('square')!.geometry as Polygon).coordinates[0]![2]!
    expect(moved[0]).toBeCloseTo(1.5, 6)
    expect(moved[1]).toBeCloseTo(1.3, 6)
    expect(moved[2]).toBe(50_000)
    // A midpoint inserts a vertex at its altitude, under the pointer.
    expect(mode.pointerDown(pointer(50, -50))).toBe(true)
    mode.pointerMove(pointer(50, -80))
    mode.pointerUp(pointer(50, -80))
    const inserted = (store.get('square')!.geometry as Polygon).coordinates[0]![1]!
    expect(inserted[1]).toBeCloseTo(-0.3, 6)
    expect(inserted[2]).toBe(50_000)
  })

  it('ends the vertex editing when the selection empties, by deletion or elsewhere', () => {
    const { context, store } = createContext([square(), { ...square(), id: 'other' }])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    // Edit mode never deletes the whole feature: out of it, Delete does.
    expect(mode.deleteSelection()).toBe(false)
    mode.setEditingVertices(false)
    expect(mode.deleteSelection()).toBe(true)
    expect(mode.editingVertices).toBe(false)
    mode.setSelection(['other'])
    mode.setEditingVertices(true)
    store.remove(['other'])
    expect(mode.status().editingVertices).toBe(false)
    expect(mode.editingVertices).toBe(false)
  })
})

describe('select mode, edit mode', () => {
  /** A box mesh 30 km tall over 0.2° to 0.8° east and north. */
  const box = (): DrawFeature<MultiPolygon> => ({ type: 'Feature', id: 'box', properties: {}, geometry: prismMesh([[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]], 0, 30_000) })
  /** Seen from the south and above, north up the screen: x = longitude × 100, y = -latitude × 100, heights 1 px per kilometre up. */
  function northUp(features: DrawFeature[]) {
    const created = createContext(features)
    created.context.project = ([longitude, latitude]) => ({ x: longitude * 100, y: -latitude * 100 })
    created.context.projectAtHeight = ([longitude, latitude], heightMeters) => ({ x: longitude * 100, y: -latitude * 100 - heightMeters / 1000 })
    return created
  }
  const at = (x: number, y: number, pointerType = 'mouse'): DrawPointerEvent => ({ screen: { xPixels: x, yPixels: y }, geographic: { longitudeDegrees: x / 100, latitudeDegrees: -y / 100, heightMeters: 0 }, pointerType, originalEvent: {} as MouseEvent })
  const drag = (mode: SelectMode, from: { x: number; y: number }, to: { x: number; y: number }) => {
    expect(mode.pointerDown(at(from.x, from.y))).toBe(true)
    mode.pointerMove(at((from.x + to.x) / 2, (from.y + to.y) / 2))
    mode.pointerMove(at(to.x, to.y))
    mode.pointerUp(at(to.x, to.y))
  }
  const altitudes = (feature: DrawFeature) => (feature.geometry as MultiPolygon).coordinates.flat(2).map(position => position[2]!)

  it('double tap on a face picks it; its arrow pulls the box taller in one update, and undo takes it back', () => {
    const { context, store, events } = northUp([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.click(at(50, -80)) // the top, 30 px above its footprint
    mode.click(at(50, -80))
    expect(mode.editingVertices).toBe(true)
    expect(mode.elementMode).toBe('face')
    expect(mode.inspect()).toMatchObject({ picked: { featureId: 'box', kind: 'face', index: 0 } })
    const handle = mode.pushPullHandle()!
    expect(handle.x).toBeCloseTo(50, 0)
    expect(handle.y).toBeLessThan(-80) // up the screen from the top's middle
    // The top's arrow is about 69 km long (80 px): 20 px further up is about 17 km taller.
    drag(mode, handle, { x: handle.x, y: handle.y - 20 })
    expect(events).toEqual(['update box'])
    const pulled = store.get('box')!
    expect(Math.max(...altitudes(pulled))).toBeGreaterThan(45_000)
    expect(Math.min(...altitudes(pulled))).toBeCloseTo(0, 6)
    expect((pulled.geometry as MultiPolygon).coordinates).toHaveLength(6)
    expect(mode.inspect()).toMatchObject({ picked: { featureId: 'box', kind: 'face', index: 0 } })
    mode.undo()
    expect(Math.max(...altitudes(store.get('box')!))).toBeCloseTo(30_000, 6)
  })

  it('extrudes the picked face with E (one update, the new face picked) and from code', () => {
    const { context, store, events } = northUp([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['box'])
    mode.setElementMode('face')
    expect(mode.extrude()).toBe(false) // nothing picked
    expect(mode.keyDown({ key: 'Tab' } as KeyboardEvent)).toBe(true)
    expect(mode.editingVertices).toBe(true)
    expect(mode.pointerDown(at(50, -80))).toBe(true)
    mode.pointerUp(at(50, -80))
    expect(mode.status().canExtrude).toBe(true)
    expect(mode.keyDown({ key: 'e' } as KeyboardEvent)).toBe(true)
    expect(events).toEqual(['update box'])
    const extruded = store.get('box')!
    expect((extruded.geometry as MultiPolygon).coordinates).toHaveLength(10)
    // Half the arrow's length, about 35 km.
    expect(Math.max(...altitudes(extruded))).toBeGreaterThan(55_000)
    expect(mode.extrude(1000)).toBe(true)
    expect((store.get('box')!.geometry as MultiPolygon).coordinates).toHaveLength(14)
    expect(() => mode.extrude(0)).toThrow(/other than 0/)
    // A picked face is never deleted, nor its feature.
    expect(mode.deleteSelection()).toBe(false)
    expect(store.has('box')).toBe(true)
    expect(mode.keyDown({ key: 'Tab' } as KeyboardEvent)).toBe(true)
    expect(mode.editingVertices).toBe(false)
  })

  it('drags a mesh vertex level, moving it in every face that shares it', () => {
    const { context, store, events } = northUp([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['box'])
    mode.setEditingVertices(true)
    expect(mode.keyDown({ key: '1' } as KeyboardEvent)).toBe(true)
    // The top's south-west corner, 30 km up.
    const content = { features: [], lines: [], handles: [] as Array<{ position: number[] }> }
    mode.overlay(content as never)
    expect(content.handles.length).toBeGreaterThan(0)
    drag(mode, { x: 20, y: -50 }, { x: 30, y: -50 })
    expect(events).toEqual(['update box'])
    const positions = (store.get('box')!.geometry as MultiPolygon).coordinates.flat(2)
    expect(positions.some(position => position[0] === 0.2 && position[1] === 0.2 && position[2] === 30_000)).toBe(false)
    const moved = positions.filter(position => Math.abs(position[0]! - 0.3) < 1e-6 && Math.abs(position[1]! - 0.2) < 1e-6)
    expect(moved.length).toBeGreaterThanOrEqual(3)
    expect(moved.every(position => Math.abs(position[2]! - 30_000) < 1e-3)).toBe(true)
  })

  it('survives undo after hovering an element the restored version lacks, and an app replacing the mesh', () => {
    const { context, store } = northUp([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.click(at(50, -80))
    mode.click(at(50, -80))
    expect(mode.extrude(35_000)).toBe(true)
    mode.setElementMode('edge')
    // An edge of the new top (65 km up), whose vertices the box before the extrusion does not have.
    mode.hover(at(50, -85))
    const overlay = () => mode.overlay({ features: [], lines: [], handles: [], polygons: [] })
    expect(overlay).not.toThrow()
    mode.undo()
    expect((store.get('box')!.geometry as MultiPolygon).coordinates).toHaveLength(6)
    expect(overlay).not.toThrow()
    // Again, the smaller mesh coming from the app.
    expect(mode.extrude(35_000)).toBe(false) // nothing picked after undo
    mode.setElementMode('face')
    mode.pointerDown(at(50, -80))
    mode.pointerUp(at(50, -80))
    mode.extrude(35_000)
    mode.setElementMode('vertex')
    mode.hover(at(20, -85))
    store.set([box()])
    expect(overlay).not.toThrow()
  })

  it('never shows nor picks an edge that only faces turned away from the camera hold', () => {
    class Probe extends SelectMode {
      visibleEdges(feature: DrawFeature) {
        const elements = this.elementsOf(feature)!
        const screens = this.screensOf(feature, elements)
        return elements.edges.filter((_, index) => screens.visibleEdges[index] === 1).map(([a, b]) => [elements.positions[a]!, elements.positions[b]!])
      }
    }
    // A box with its north-east bottom corner raised 5 km: its bottom splits into two triangles along a diagonal.
    const mesh = indexMesh(box().geometry)
    const corner = mesh.vertices.findIndex(position => position[0] === 0.8 && position[1] === 0.8 && position[2] === 0)
    const bent: DrawFeature = { ...box(), geometry: meshFromIndexed(moveMeshVertices(mesh, [corner], [0, 0, 5000])) }
    // Seen from the south-west and above: the south and west walls face the camera, so both ends of the diagonal show.
    const { context } = northUp([bent])
    context.projectAtHeight = ([longitude, latitude], heightMeters) => ({ x: longitude * 100 - latitude * 40, y: -latitude * 100 - heightMeters / 1000 })
    const mode = new Probe()
    mode.enter(context)
    mode.setSelection(['box'])
    mode.setEditingVertices(true)
    mode.setElementMode('edge')
    const isDiagonal = ([a, b]: Position[]) => Math.abs(a![0]! - b![0]!) > 0.5 && Math.abs(a![1]! - b![1]!) > 0.5
    expect(mode.visibleEdges(bent).some(isDiagonal)).toBe(false)
    expect(mode.visibleEdges(bent).length).toBeGreaterThan(0)
    // A tap on it, a quarter along from the south-east corner, on the south wall away from its edges, picks nothing.
    mode.pointerDown(at(51, -35))
    mode.pointerUp(at(51, -35))
    expect(mode.inspect()).toMatchObject({ picked: null })
    const content = { features: [], lines: [] as Array<{ positions: number[][] }>, handles: [], polygons: [] }
    mode.overlay(content as never)
    expect(content.lines.some(line => line.positions.length === 2 && Math.abs(line.positions[0]![0]! - line.positions[1]![0]!) > 0.5 && Math.abs(line.positions[0]![1]! - line.positions[1]![1]!) > 0.5)).toBe(false)
  })

  it('drops a drag when the element mode changes during it, so its release picks nothing', () => {
    const { context, store, events } = northUp([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['box'])
    mode.setEditingVertices(true)
    // A press on the top's south-west corner, moved, then the mode switched to faces before the release.
    expect(mode.pointerDown(at(20, -50))).toBe(true)
    mode.pointerMove(at(25, -50))
    mode.setElementMode('face')
    mode.pointerMove(at(30, -50))
    mode.pointerUp(at(30, -50))
    expect(events).toEqual([])
    expect(mode.inspect()).toMatchObject({ picked: null, drag: null, elementMode: 'face' })
    expect(Math.max(...altitudes(store.get('box')!))).toBe(30_000)
  })

  it('drags an edge of a polygon, moving both its ends, and pulls a picked polygon face up into a prism', () => {
    const { context, store, events } = createContext([square()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
    mode.setElementMode('edge')
    // The east edge, from (1, 0) to (1, 1).
    expect(mode.pointerDown(pointer(100, 50))).toBe(true)
    mode.pointerMove(pointer(115, 50))
    mode.pointerMove(pointer(130, 50))
    mode.pointerUp(pointer(130, 50))
    const ring = (store.get('square')!.geometry as Polygon).coordinates[0]!
    expect(ring[1]![0]).toBeCloseTo(1.3, 3)
    expect(ring[2]![0]).toBeCloseTo(1.3, 3)
    expect(ring[0]).toEqual([0, 0])
    expect(events).toEqual(['update square'])
    mode.setElementMode('face')
    mode.pointerDown(pointer(50, 50))
    mode.pointerUp(pointer(50, 50))
    expect(mode.canExtrude).toBe(true)
    expect(mode.extrude(500)).toBe(true)
    const prism = store.get('square')!
    expect(prism.geometry.type).toBe('MultiPolygon')
    expect((prism.geometry as MultiPolygon).coordinates).toHaveLength(6)
    expect(Math.max(...altitudes(prism))).toBeCloseTo(500, 6)
    expect(mode.inspect()).toMatchObject({ picked: { kind: 'face', index: 0 }, elementMode: 'face' })
  })

  /** Seen from the south-east and above: up goes up and right on the screen, so it never lies on north. */
  function slanted(features: DrawFeature[]) {
    const created = createContext(features)
    created.context.project = ([longitude, latitude]) => ({ x: longitude * 100, y: -latitude * 100 })
    created.context.projectAtHeight = ([longitude, latitude], heightMeters) => ({ x: longitude * 100 + heightMeters / 2000, y: -latitude * 100 - heightMeters / 1000 })
    return created
  }
  const shift = (x: number, y: number): DrawPointerEvent => ({ ...at(x, y), originalEvent: { shiftKey: true } as MouseEvent })
  const tapAt = (mode: SelectMode, event: DrawPointerEvent) => {
    mode.pointerDown(event)
    mode.pointerUp(event)
  }
  const road = (): DrawFeature<LineString> => ({ type: 'Feature', id: 'road', properties: {}, geometry: { type: 'LineString', coordinates: [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.8, 0.5]] } })

  it('picks several vertices with Shift, all with A, none with Alt+A, and deletes the picked ones', () => {
    const { context, store, events } = slanted([road()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['road'])
    mode.setEditingVertices(true)
    tapAt(mode, at(20, -20))
    tapAt(mode, shift(50, -20))
    expect(mode.status().pickedElementCount).toBe(2)
    tapAt(mode, shift(20, -20)) // again: taken away
    expect(mode.inspect()).toMatchObject({ pickedElements: [{ kind: 'vertex', index: 1 }] })
    tapAt(mode, at(80, -20)) // without Shift: that one alone
    expect(mode.inspect()).toMatchObject({ pickedElements: [{ kind: 'vertex', index: 2 }] })
    expect(mode.keyDown({ key: 'a' } as KeyboardEvent)).toBe(true)
    expect(mode.pickedElementCount).toBe(4)
    expect(mode.keyDown({ key: 'å', code: 'KeyA', altKey: true } as KeyboardEvent)).toBe(true)
    expect(mode.pickedElementCount).toBe(0)
    tapAt(mode, at(20, -20))
    tapAt(mode, shift(80, -50))
    expect(mode.deleteSelection()).toBe(true)
    expect((store.get('road')!.geometry as LineString).coordinates).toEqual([[0.5, 0.2], [0.8, 0.2]])
    expect(events).toEqual(['update road'])
    mode.undo()
    expect(store.get('road')).toEqual(road())
  })

  it('moves one picked vertex of a draped line straight up with the gizmo, the line getting altitudes', () => {
    const { context, store, events } = slanted([road()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['road'])
    mode.setEditingVertices(true)
    expect(mode.gizmoHandles()).toEqual([]) // nothing picked: no gizmo in edit mode
    tapAt(mode, at(50, -20))
    const handles = mode.gizmoHandles()
    // Move handles only, over the picked vertex.
    expect(handles.every(handle => handle.handle.startsWith('move-'))).toBe(true)
    const up = handles.find(handle => handle.handle === 'move-z')!
    const free = handles.find(handle => handle.handle === 'move-free')!
    expect(free.x).toBeCloseTo(50, 3)
    expect(free.y).toBeCloseTo(-20, 3)
    // 20 px further along the up arrow (as drawn: up and right) is about 20 km up.
    const along = { x: up.x - free.x, y: up.y - free.y }
    const length = Math.hypot(along.x, along.y)
    drag(mode, up, { x: up.x + (along.x / length) * 20, y: up.y + (along.y / length) * 20 })
    expect(events).toEqual(['update road'])
    const coordinates = (store.get('road')!.geometry as LineString).coordinates
    expect(coordinates[1]![0]).toBeCloseTo(0.5, 6)
    expect(coordinates[1]![1]).toBeCloseTo(0.2, 6)
    expect(coordinates[1]![2]).toBeGreaterThan(15_000)
    expect(coordinates.filter((_, index) => index !== 1).map(position => position[2])).toEqual([0, 0, 0])
    // Still picked, its gizmo up there with it.
    expect(mode.inspect()).toMatchObject({ pickedElements: [{ kind: 'vertex', index: 1 }] })
    expect(mode.gizmoHandles().find(handle => handle.handle === 'move-free')!.y).toBeLessThan(-30)
    // G moves it from the keyboard; turning and scaling picked elements does not start.
    expect(mode.startTransform('rotate')).toBe(false)
    expect(mode.startTransform('move')).toBe(true)
  })

  it('moves every picked vertex of a mesh together: A, then the gizmo east, or a drag on one of them', () => {
    const { context, store, events } = slanted([box()])
    const mode = new SelectMode()
    mode.enter(context)
    mode.setSelection(['box'])
    mode.setEditingVertices(true)
    expect(mode.selectAllElements()).toBe(true)
    expect(mode.pickedElementCount).toBe(8)
    const handles = mode.gizmoHandles()
    const east = handles.find(handle => handle.handle === 'move-x')!
    const free = handles.find(handle => handle.handle === 'move-free')!
    // 10 px east is 0.1°.
    drag(mode, east, { x: east.x + 10, y: east.y })
    expect(events).toEqual(['update box'])
    const longitudes = (store.get('box')!.geometry as MultiPolygon).coordinates.flat(2).map(position => position[0]!)
    expect(Math.min(...longitudes)).toBeCloseTo(0.3, 2)
    expect(Math.max(...longitudes)).toBeCloseTo(0.9, 2)
    // Moved in the gizmo's frame: a box 60 km wide keeps its altitudes within the Earth's curvature over 10 km.
    expect(Math.abs(Math.max(...altitudes(store.get('box')!)) - 30_000)).toBeLessThan(100)
    expect(free.x).toBeGreaterThan(0)
    // A drag on a picked vertex takes the others along.
    expect(mode.pickedElementCount).toBe(8)
    drag(mode, { x: 30 + 7.5, y: -20 - 15 }, { x: 30 + 7.5, y: -20 - 25 }) // the top's south-west corner, 30 km up
    expect(events).toEqual(['update box', 'update box'])
    const latitudes = (store.get('box')!.geometry as MultiPolygon).coordinates.flat(2).map(position => position[1]!)
    expect(Math.min(...latitudes)).toBeCloseTo(0.3, 2)
    expect((store.get('box')!.geometry as MultiPolygon).coordinates).toHaveLength(6)
  })
})

