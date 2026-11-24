import type { LineString, MultiPolygon, Point, Polygon, Position } from 'geojson'
import { describe, expect, it, vi } from 'vitest'

import { featureMidpoints, featureVertices, hitFeature, insertVertex, moveVertex, removeVertex, translateFeature } from '../src/editing.js'
import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import { prismMesh } from '../src/mesh.js'
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
    // A box mesh 30 km tall: its front wall spans y 100 down to 70.
    const box: DrawFeature = { ...square(), geometry: prismMesh(square().geometry.coordinates as Position[][], 0, 30_000) }
    expect(hitFeature(box, at(50, 105 - 30))).toBe(0)
    expect(hitFeature(box, at(50, -25))).toBe(0) // the top, 30 px above the far edge
    expect(hitFeature(box, at(50, 50))).toBe(0)
    expect(hitFeature(box, at(105, 50))).toBeCloseTo(5) // near its right edges
    expect(hitFeature(box, at(150, 50))).toBeNull()
    expect(hitFeature(box, at(50, 120))).toBeNull() // below its foot
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
    // The pick was on the old version, so it is gone: Delete takes the selected feature, never another vertex.
    expect(mode.inspect()).toMatchObject({ selectedVertex: null })
    expect(mode.deleteSelection()).toBe(true)
    expect(store.has('square')).toBe(false)
    store.set([square()])
    mode.setSelection(['square'])
    mode.setEditingVertices(true)
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

  it('moves sphere meshes whole, with a gizmo of corners, a turning knob and a lift knob, and no vertex handles', () => {
    const sphere = { ...createSphere([0.5, 0.5], 20_000), id: 'ball' } as DrawFeature
    const { context, store } = createContext([sphere])
    const mode = new SelectMode()
    mode.enter(context)
    // Drawn where it stands: its center 20 km up, 20 px above its foot.
    mode.click(pointer(50, 30))
    expect(mode.selectedFeatureIds()).toEqual(['ball'])
    const content = { features: [], lines: [], handles: [] }
    mode.overlay(content)
    // Scale corners, the turning knob and the lift knob: no height knob (no level top), no side handles (small on screen).
    expect(content.handles).toHaveLength(4 + 1 + 1)
    // A second tap keeps the gizmo: a mesh's vertices are not edited one by one.
    mode.click(pointer(50, 30))
    expect(mode.editingVertices).toBe(false)
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

  it('shows the gizmo first, swaps it for vertex handles with a second tap, and back with a third', () => {
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
    expect(handles()).toBe(4 + 4 + 1 + 1 + 1) // corners, sides, turning knob, height knob, lift knob
    // A tap (no drag) on the selected feature: vertex handles and midpoints instead.
    expect(mode.pointerDown(pointer(30, 70))).toBe(true)
    mode.pointerUp(pointer(30, 70))
    expect(mode.editingVertices).toBe(true)
    expect(mode.status().editingVertices).toBe(true)
    expect(handles()).toBe(4 + 4)
    // Again: the gizmo.
    mode.pointerDown(pointer(30, 70))
    mode.pointerUp(pointer(30, 70))
    expect(mode.editingVertices).toBe(false)
    // Another feature, or the empty map, starts with the gizmo again.
    mode.setEditingVertices(true)
    mode.click(pointer(250, 50))
    expect(mode.selectedFeatureIds()).toEqual(['other'])
    expect(mode.editingVertices).toBe(false)
    mode.setEditingVertices(true)
    mode.click(pointer(500, 500))
    expect(mode.selectedFeatureIds()).toEqual([])
    expect(mode.editingVertices).toBe(false)
    // A tap on the knob in the middle of a flat shape is a tap on the shape; Escape steps back to the gizmo first.
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
    expect(mode.deleteSelection()).toBe(true)
    expect(mode.editingVertices).toBe(false)
    mode.setSelection(['other'])
    mode.setEditingVertices(true)
    store.remove(['other'])
    expect(mode.status().editingVertices).toBe(false)
    expect(mode.editingVertices).toBe(false)
  })
})
