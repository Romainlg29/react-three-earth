import type { Point, Polygon } from 'geojson'
import { Object3D, type LineSegments, type Mesh } from 'three'
import { TRANSLUCENT_LAYER, TRANSLUCENT_RENDER_PASS_NAME } from 'react-three-earth'
import { describe, expect, it, vi } from 'vitest'

import { FeatureStore } from '../src/FeatureStore.js'
import { distanceMeters } from '../src/geometry.js'
import type { DrawModeContext } from '../src/modes/DrawMode.js'
import { PolygonMode } from '../src/modes/PathModes.js'
import { CircleMode, RectangleMode, SphereMode } from '../src/modes/ShapeModes.js'
import { buildSolidGeometry, isSolidFeature, LocalFrame, refineTriangles, SolidFeatures } from '../src/render/SolidFeatures.js'
import { bearingDegrees, createCircle, createEllipse, createRectangle, createRegularPolygon, createSphere, destination, shapeOf } from '../src/shapes.js'
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import type { DrawFeature, DrawPointerEvent } from '../src/types.js'

const CENTER: [number, number] = [6.6, 46.45]

/** Twice the signed area in degrees: positive for counter-clockwise rings. */
function signedArea(ring: number[][]): number {
  let area = 0
  for (let index = 0; index + 1 < ring.length; index++) area += ring[index]![0]! * ring[index + 1]![1]! - ring[index + 1]![0]! * ring[index]![1]!
  return area
}

describe('shape builders', () => {
  it('moves along the ground by distance and bearing, and back', () => {
    const east = destination(CENTER, 10_000, 90)
    expect(distanceMeters(CENTER, east)).toBeCloseTo(10_000, 3)
    expect(bearingDegrees(CENTER, east)).toBeCloseTo(90, 0)
    expect(destination(CENTER, 5000, 0)[0]).toBeCloseTo(CENTER[0], 9)
  })

  it('builds circles whose vertices are the radius from the center, counter-clockwise and closed, with their shape', () => {
    const circle = createCircle(CENTER, 2500, { steps: 32, extrusionHeightMeters: 300, properties: { name: 'tank' } })
    const ring = circle.geometry.coordinates[0]!
    expect(ring).toHaveLength(33)
    expect(ring[0]).toEqual(ring[32])
    for (const position of ring) expect(distanceMeters(CENTER, position)).toBeCloseTo(2500, 3)
    expect(signedArea(ring)).toBeGreaterThan(0)
    expect(circle.properties).toEqual({ name: 'tank', shape: { type: 'circle', center: CENTER, radiusMeters: 2500 }, extrusionHeightMeters: 300 })
  })

  it('builds rectangles, ellipses and regular polygons in metres, turned clockwise from north', () => {
    const rectangle = createRectangle(CENTER, 1000, 4000, { rotationDegrees: 90 })
    const corners = rectangle.geometry.coordinates[0]!
    // Turned a quarter: 4000 m east-west, 1000 m north-south.
    expect(distanceMeters(corners[0]!, corners[1]!)).toBeCloseTo(1000, 0)
    expect(distanceMeters(corners[1]!, corners[2]!)).toBeCloseTo(4000, 0)
    expect(Math.abs(corners[1]![1]! - corners[2]![1]!)).toBeLessThan(1e-3)
    expect(signedArea(corners)).toBeGreaterThan(0)
    const ellipse = createEllipse(CENTER, 3000, 1000, { steps: 4 })
    expect(distanceMeters(CENTER, ellipse.geometry.coordinates[0]![1]!)).toBeCloseTo(3000, 0) // the major axis points north
    const hexagon = createRegularPolygon(CENTER, 500, 6)
    expect(hexagon.geometry.coordinates[0]).toHaveLength(7)
    expect(() => createRegularPolygon(CENTER, 500, 2)).toThrow(/3 or more/)
    expect(() => createCircle(CENTER, 0)).toThrow(/positive number of metres/)
  })

  it('writes the base height as the third coordinate, and keeps the shape', () => {
    const floating = createRectangle(CENTER, 100, 100, { baseHeightMeters: 1200 })
    expect(floating.geometry.coordinates[0]!.every(position => position[2] === 1200)).toBe(true)
    const sphere = createSphere(CENTER, 80, { id: 'ball' })
    expect(sphere).toMatchObject({ id: 'ball', geometry: { type: 'Point', coordinates: CENTER } })
    expect(shapeOf(sphere)).toEqual({ type: 'sphere', center: CENTER, radiusMeters: 80 })
  })
})

describe('solids', () => {
  const feature = (geometry: DrawFeature['geometry'], properties: Record<string, unknown> = {}): DrawFeature => ({ type: 'Feature', id: 'f', properties, geometry })

  it('tells 3D features from draped ones', () => {
    expect(isSolidFeature(feature(createCircle(CENTER, 100).geometry))).toBe(false)
    expect(isSolidFeature(feature(createCircle(CENTER, 100).geometry, { extrusionHeightMeters: 20 }))).toBe(true)
    expect(isSolidFeature(feature(createRectangle(CENTER, 100, 100, { baseHeightMeters: 50 }).geometry))).toBe(true)
    expect(isSolidFeature({ ...createSphere(CENTER, 10), id: 's' } as DrawFeature)).toBe(true)
    expect(isSolidFeature(feature({ type: 'Point', coordinates: [6, 46, 300] }))).toBe(false)
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

  it('extrudes a polygon into a closed prism: top, bottom and walls', () => {
    const square = createRectangle(CENTER, 1000, 1000).geometry as Polygon
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const { faces, line } = buildSolidGeometry(feature(square, { extrusionHeightMeters: 200 }), frame, () => 0)
    expect(line).toBeNull()
    const positions = faces!.getAttribute('position')
    // 2 triangles on top, 2 at the bottom, 2 per wall.
    expect(positions.count).toBe((2 + 2 + 4 * 2) * 3)
    let highest = -Infinity
    for (let index = 0; index < positions.count; index++) highest = Math.max(highest, positions.getZ(index))
    expect(highest).toBeCloseTo(200, 0)
  })

  it('faces every triangle of an extruded polygon outwards, whatever the winding of its ring', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const counterClockwise = (createRectangle(CENTER, 1000, 1000).geometry as Polygon).coordinates[0]!
    for (const ring of [counterClockwise, [...counterClockwise].reverse()]) {
      const { faces, closed } = buildSolidGeometry(feature({ type: 'Polygon', coordinates: [ring] }, { extrusionHeightMeters: 200 }), frame, () => 0)
      expect(closed).toBe(true)
      const positions = faces!.getAttribute('position')
      for (let index = 0; index < positions.count; index += 3) {
        const [a, b, c] = [0, 1, 2].map(corner => [positions.getX(index + corner), positions.getY(index + corner), positions.getZ(index + corner)])
        const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
        const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
        const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
        // From the middle of the box (100 m up) to the triangle's centroid.
        const outwards = [0, 1, 2].map(axis => (a![axis]! + b![axis]! + c![axis]!) / 3 - (axis === 2 ? 100 : 0))
        expect(normal[0]! * outwards[0]! + normal[1]! * outwards[1]! + normal[2]! * outwards[2]!).toBeGreaterThan(0)
      }
    }
  })

  it('splits wide faces into small triangles, so they bend with the Earth instead of cutting under it', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const { faces } = buildSolidGeometry(feature(createRectangle(CENTER, 100_000, 100_000).geometry, { extrusionHeightMeters: 500 }), frame, () => 0)
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
    // Every vertex is on the ground or 500 m above it, the ground falling away from the tangent plane with the curve.
    for (let index = 0; index < positions.count; index++) {
      const [east, north, up] = [positions.getX(index), positions.getY(index), positions.getZ(index)]
      const aboveGround = up + (east * east + north * north) / (2 * 6_378_137)
      expect(Math.min(Math.abs(aboveGround), Math.abs(aboveGround - 500))).toBeLessThan(5)
    }
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

  it('lifts ground solids onto the terrain a few lookups per frame, and asks for frames until the terrain answers', () => {
    vi.useFakeTimers()
    let terrain: number | null = null
    const lookups = vi.fn(() => terrain)
    const requestFrame = vi.fn()
    const releaseTranslucentPass = vi.fn()
    const earth = {
      view: { morph: 0, flatMapLuminance: 1 },
      queryTerrainElevation: lookups,
      requestFrame,
      atmosphere: {},
      renderPasses: { retainTranslucentPass: () => releaseTranslucentPass, isBuilt: (name: string) => name === TRANSLUCENT_RENDER_PASS_NAME },
      createGeographicAnchor: (position: { longitudeDegrees: number; latitudeDegrees: number; heightMeters: number }) =>
        Object.assign(new Object3D(), {
          geographicPosition: { ...position },
          setPosition(next: typeof position) { this.geographicPosition = { ...next } },
          dispose() { (this as unknown as Object3D).removeFromParent() },
        }),
    }
    const solids = new SolidFeatures(earth as never)
    solids.setFeatures(Array.from({ length: 10 }, (_, index) => ({ feature: { ...createCircle(destination(CENTER, index * 1000, 90), 100, { extrusionHeightMeters: 50 }), id: `c${index}` } as DrawFeature, style: DEFAULT_DRAW_STYLE })))
    expect(lookups).not.toHaveBeenCalled() // nothing raycast while features change
    expect(solids.update(0)).toBe(false)
    // With an atmosphere and the pass running, see-through faces are drawn after the atmosphere, hazed at their own distance; their edges stay in the scene.
    const objects: Object3D[] = []
    solids.object.traverse(object => void objects.push(object))
    expect(objects.filter(object => (object as Mesh).isMesh === true).every(mesh => mesh.layers.mask === 1 << TRANSLUCENT_LAYER)).toBe(true)
    expect(objects.some(object => (object as LineSegments).isLineSegments === true && object.layers.mask === 1)).toBe(true)
    expect(lookups).toHaveBeenCalledTimes(4)
    vi.runAllTimers()
    expect(requestFrame).toHaveBeenCalled() // the terrain had no answer: try again soon
    solids.update(16)
    expect(lookups).toHaveBeenCalledTimes(8)
    solids.update(32)
    expect(lookups).toHaveBeenCalledTimes(10)
    terrain = 420
    expect(solids.update(100)).toBe(false) // each solid waits 500 ms between lookups
    expect(solids.update(600)).toBe(true)
    const anchors = solids.object.children as unknown as Array<{ geographicPosition: { heightMeters: number } }>
    expect(anchors.filter(anchor => anchor.geographicPosition.heightMeters === 420)).toHaveLength(4)
    solids.dispose()
    expect(solids.object.children).toHaveLength(0)
    expect(releaseTranslucentPass).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('splits long edges so walls follow the ground, and draws lines at an altitude as lines', () => {
    const frame = new LocalFrame(CENTER[0], CENTER[1], 0)
    const wall = buildSolidGeometry(feature({ type: 'LineString', coordinates: [CENTER, destination(CENTER, 10_000, 90)] }, { extrusionHeightMeters: 50 }), frame, () => 0)
    // 10 km in pieces of at most 2 km: 5 quads.
    expect(wall.faces!.getAttribute('position').count).toBe(5 * 6)
    const line = buildSolidGeometry(feature({ type: 'LineString', coordinates: [[6.6, 46.45, 900], [6.61, 46.45, 900]] }), frame, position => position[2]!)
    expect(line.faces).toBeNull()
    expect(line.line!.getAttribute('position').getZ(0)).toBeCloseTo(900, 3)
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
    const mode = new CircleMode({ extrusionHeightMeters: 120 })
    mode.enter(context)
    mode.click(tap(6.6, 46.45))
    expect(mode.status()).toMatchObject({ drawing: true, canUndo: true })
    mode.click(tap(6.6001, 46.45)) // a double tap's second tap, within 10 px
    expect(created).toHaveLength(0)
    mode.click(tap(6.62, 46.45))
    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe('feature-1')
    const shape = shapeOf(created[0]!)
    expect(shape?.type).toBe('circle')
    expect(shape?.type === 'circle' && shape.radiusMeters).toBeCloseTo(distanceMeters([6.6, 46.45], [6.62, 46.45]), 3)
    expect(created[0]!.properties?.extrusionHeightMeters).toBe(120)
    expect(mode.status().drawing).toBe(false)
  })

  it('draws rectangles between two corners and spheres from a center and radius, and cancels with Escape', () => {
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
    expect((created[1]!.geometry as Point).type).toBe('Point')
    expect(isSolidFeature(created[1]!)).toBe(true)
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

  it('extrudes polygons drawn with extrusionHeightMeters', () => {
    const { context, created } = createContext()
    const mode = new PolygonMode({ extrusionHeightMeters: 40 })
    mode.enter(context)
    for (const [longitude, latitude] of [[6.6, 46.45], [6.62, 46.45], [6.62, 46.47]] as const) mode.click(tap(longitude, latitude))
    mode.finish()
    expect(created[0]!.properties).toEqual({ extrusionHeightMeters: 40 })
  })
})
