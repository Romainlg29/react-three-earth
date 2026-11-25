import { DEFAULT_DRAW_STYLE, FeatureStore, type DrawFeature, type DrawModeContext, type DrawPointerEvent } from '@earthkit/draw'
import { describe, expect, it, vi } from 'vitest'

import { formatArea, formatLength } from '../src/format.js'
import { densifyPath, geodesicDistanceMeters, geodesicMidpoint, pathLengthMeters, polygonAreaSquareMeters, ringAreaSquareMeters, ringLabelPosition, ringPerimeterMeters } from '../src/geodesic.js'
import { LIVE_MEASUREMENT_ID, Measure, measureFeature } from '../src/Measure.js'
import { AreaMode, DistanceMode } from '../src/modes.js'
import { elevationProfile } from '../src/profile.js'

/** WGS84: equatorial radius and flattening, for the closed-form checks. */
const A = 6_378_137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const B = A * (1 - F)

/** The ellipsoid's area from the equator to a latitude, per radian of longitude (the exact zone formula). */
function zoneArea(latitudeDegrees: number): number {
  const sin = Math.sin((latitudeDegrees * Math.PI) / 180)
  const e = Math.sqrt(E2)
  return ((B * B) / 2) * (sin / (1 - E2 * sin * sin) + Math.log((1 + e * sin) / (1 - e * sin)) / (2 * e))
}

describe('geodesics on WGS84', () => {
  it('measures distances as GeographicLib does', () => {
    // GeographicLib's documented example: JFK to LHR, 5551.759 km.
    expect(geodesicDistanceMeters([-73.8, 40.6], [-0.5, 51.6])).toBeCloseTo(5_551_759.4, 0)
    // A quarter meridian, pole to equator: 10 001 965.729 m.
    expect(geodesicDistanceMeters([0, 0], [0, 90])).toBeCloseTo(10_001_965.729, 2)
    // One degree of longitude on the equator: the equatorial radius, not the mean one.
    expect(geodesicDistanceMeters([0, 0], [1, 0])).toBeCloseTo((A * Math.PI) / 180, 3)
  })

  it('crosses the antimeridian the short way', () => {
    expect(geodesicDistanceMeters([179.5, 0], [-179.5, 0])).toBeCloseTo((A * Math.PI) / 180, 3)
    expect(pathLengthMeters([[179.5, 0], [-179.5, 0], [-178.5, 0]])).toBeCloseTo((2 * A * Math.PI) / 180, 3)
  })

  it('measures areas whatever the winding, open or closed, holes taken out', () => {
    // An octant of the ellipsoid: its sides are a meridian, the equator and a meridian, all geodesics.
    const octant = (4 * Math.PI * zoneArea(90)) / 8
    expect(ringAreaSquareMeters([[0, 0], [90, 0], [0, 90]])).toBeCloseTo(octant, -3)
    expect(ringAreaSquareMeters([[0, 90], [90, 0], [0, 0], [0, 90]])).toBeCloseTo(octant, -3)
    // A small cell: its north side is a geodesic, close to the parallel (relative error well under 1e-4).
    const cell = ((zoneArea(0.01) - zoneArea(0)) * 0.01 * Math.PI) / 180
    const ring = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]
    expect(Math.abs(ringAreaSquareMeters(ring) / cell - 1)).toBeLessThan(1e-6)
    const hole = [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006]]
    expect(polygonAreaSquareMeters([ring, hole])).toBeCloseTo(ringAreaSquareMeters(ring) - ringAreaSquareMeters(hole), 3)
    expect(ringAreaSquareMeters([[0, 0], [1, 1]])).toBe(0)
    expect(ringPerimeterMeters([[0, 0], [1, 0], [1, 1]])).toBeCloseTo(pathLengthMeters([[0, 0], [1, 0], [1, 1], [0, 0]]), 6)
  })

  it('finds midpoints and densifies along the geodesic, keeping every vertex', () => {
    const [longitude, latitude] = geodesicMidpoint([0, 0], [0, 10])
    expect(longitude).toBeCloseTo(0, 9)
    expect(latitude).toBeCloseTo(5, 1)
    const dense = densifyPath([[-73.8, 40.6], [-0.5, 51.6]], 100_000)
    expect(dense.length).toBe(57) // 5552 km in 56 steps of under 100 km
    expect(dense[0]).toEqual([-73.8, 40.6])
    expect(dense.at(-1)).toEqual([-0.5, 51.6])
    // The great-circle route bows north of both ends.
    expect(Math.max(...dense.map(([, latitude]) => latitude))).toBeGreaterThan(52)
    expect(() => densifyPath([[0, 0]], 0)).toThrow(/above 0/)
    // Across the antimeridian: continuous longitudes, the midpoint wrapped.
    const across = densifyPath([[170, 0], [-170, 0]], 500_000)
    expect(across.every((position, index) => index === 0 || Math.abs(position[0] - across[index - 1]![0]) < 10)).toBe(true)
    expect(across.at(-1)).toEqual([190, 0])
    expect(geodesicMidpoint([179, 0], [-177, 0])[0]).toBeCloseTo(-179, 6)
  })

  it('labels rings at their centroid, or inside a concave ring that does not hold it', () => {
    const [x, y] = ringLabelPosition([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])
    expect(x).toBeCloseTo(1, 9)
    expect(y).toBeCloseTo(1, 9)
    // A thin U: its centroid falls in the gap between the arms.
    const u = [[0, 0], [10, 0], [10, 10], [9, 10], [9, 1], [1, 1], [1, 10], [0, 10]]
    const label = ringLabelPosition(u)
    const insideArm = (label[0] > 0 && label[0] < 1) || (label[0] > 9 && label[0] < 10) || label[1] < 1
    expect(insideArm).toBe(true)
    // Across the antimeridian: the label stays between the vertices, wrapped.
    const [longitude] = ringLabelPosition([[179, 0], [-179, 0], [-179, 2], [179, 2]])
    expect(Math.abs(longitude)).toBeCloseTo(180, 6)
  })
})

describe('elevation profiles', () => {
  it('samples evenly along the path, with the extremes, ascent and descent', () => {
    // A hill: 100 m at the ends, 600 m at longitude 0.5.
    const hill = (longitude: number) => 600 - 1000 * Math.abs(longitude - 0.5)
    const profile = elevationProfile([[0, 0], [0.5, 0], [1, 0]], longitude => hill(longitude), { sampleCount: 11 })
    expect(profile.samples.length).toBe(11)
    expect(profile.lengthMeters).toBeCloseTo((A * Math.PI) / 180, 3)
    expect(profile.samples[0]!.distanceMeters).toBe(0)
    expect(profile.samples[10]!.distanceMeters).toBe(profile.lengthMeters)
    expect(profile.samples[5]!.longitudeDegrees).toBeCloseTo(0.5, 6)
    expect(profile.minimumHeightMeters).toBeCloseTo(100, 3)
    expect(profile.maximumHeightMeters).toBeCloseTo(600, 3)
    expect(profile.ascentMeters).toBeCloseTo(500, 3)
    expect(profile.descentMeters).toBeCloseTo(500, 3)
    expect(profile.complete).toBe(true)
  })

  it('reports samples off the loaded terrain as null, and the profile as incomplete', () => {
    const profile = elevationProfile([[0, 0], [1, 0]], longitude => (longitude < 0.5 ? 10 : null), { sampleCount: 5 })
    expect(profile.samples.map(sample => sample.heightMeters)).toEqual([10, 10, null, null, null])
    expect(profile.complete).toBe(false)
    expect(profile.minimumHeightMeters).toBe(10)
    expect(() => elevationProfile([[0, 0], [1, 0]], () => 0, { sampleCount: 1 })).toThrow(/2 or more/)
    expect(elevationProfile([], () => 0).samples).toEqual([])
  })
})

describe('formatting', () => {
  it('writes lengths and areas in metric or imperial units, in the locale', () => {
    expect(formatLength(850.4, { locale: 'en-US' })).toBe('850 m')
    expect(formatLength(999.7, { locale: 'en-US' })).toBe('1 km')
    expect(formatLength(12_345, { locale: 'en-US' })).toBe('12.3 km')
    expect(formatLength(1234, { locale: 'fr-FR' })).toMatch(/^1,23\skm$/)
    expect(formatLength(300, { unitSystem: 'imperial', locale: 'en-US' })).toBe('984 ft')
    expect(formatLength(5000, { unitSystem: 'imperial', locale: 'en-US' })).toBe('3.11 mi')
    expect(formatArea(950, { locale: 'en-US' })).toBe('950 m²')
    expect(formatArea(42_000, { locale: 'en-US' })).toBe('4.2 ha')
    expect(formatArea(12_345_678, { locale: 'en-US' })).toBe('12.3 km²')
    expect(formatArea(10_000, { unitSystem: 'imperial', locale: 'en-US' })).toBe('2.47 ac')
    expect(formatArea(9999.7, { locale: 'en-US' })).toBe('1 ha')
    expect(() => formatLength(Number.NaN)).toThrow(/finite/)
    expect(() => formatLength(1, { significantDigits: 0 })).toThrow(/1 to 21/)
  })
})

function createContext() {
  const context: DrawModeContext = {
    earth: null as never,
    store: new FeatureStore(),
    heights: { remember: vi.fn(), heightAt: () => 0 } as never,
    style: () => DEFAULT_DRAW_STYLE,
    createId: () => 'created',
    project: ([longitude, latitude]) => ({ x: longitude * 10_000, y: latitude * 10_000 }),
    projectAtHeight: ([longitude, latitude]) => ({ x: longitude * 10_000, y: latitude * 10_000 }),
    changed: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setCursor: vi.fn(),
    holdDoubleClickZoom: vi.fn(),
    releaseDoubleClickZoom: vi.fn(),
  }
  return context
}

function pointer(longitude: number, latitude: number): DrawPointerEvent {
  return { screen: { xPixels: longitude * 10_000, yPixels: latitude * 10_000 }, geographic: { longitudeDegrees: longitude, latitudeDegrees: latitude, heightMeters: 0 }, pointerType: 'mouse', originalEvent: {} as MouseEvent }
}

const line = (id: string, coordinates: number[][]): DrawFeature => ({ type: 'Feature', id, properties: {}, geometry: { type: 'LineString', coordinates } })

describe('Measure', () => {
  it('measures loaded line strings and polygons, skipping other geometries', () => {
    const measure = new Measure({
      features: [
        line('road', [[0, 0], [1, 0], [1, 1]]),
        { type: 'Feature', id: 'field', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } },
        { type: 'Feature', id: 'pin', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
      ],
    })
    const [road, field] = measure.getState().measurements
    expect(measure.getState().measurements.length).toBe(2)
    expect(road?.kind).toBe('distance')
    expect(road?.kind === 'distance' && road.lengthMeters).toBeCloseTo(pathLengthMeters([[0, 0], [1, 0], [1, 1]]), 6)
    expect(road?.segmentLengthsMeters.length).toBe(2)
    expect(road?.labelPosition).toEqual([1, 1])
    expect(field?.kind).toBe('area')
    expect(field?.positions.length).toBe(4) // the closing position dropped
    expect(field?.segmentLengthsMeters.length).toBe(4) // the closing side included
    expect(field?.kind === 'area' && field.areaSquareMeters).toBeCloseTo(ringAreaSquareMeters([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]), 3)
    expect(measureFeature({ type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } })).toBeNull()
  })

  it('keeps measurements by identity until their feature changes, and fires change', () => {
    const measure = new Measure({ features: [line('a', [[0, 0], [1, 0]]), line('b', [[0, 0], [0, 1]])] })
    const [a, b] = measure.getState().measurements
    const changes = vi.fn()
    measure.addEventListener('change', changes)
    measure.draw.addFeatures([line('b', [[0, 0], [0, 2]])])
    const [a2, b2] = measure.getState().measurements
    expect(a2).toBe(a)
    expect(b2).not.toBe(b)
    expect(changes).toHaveBeenCalledTimes(1)
    measure.remove(['a'])
    expect(measure.getMeasurements().map(measurement => measurement.id)).toEqual(['b'])
    measure.clear()
    expect(measure.getMeasurements()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it('measures the path being drawn live, through the pointer', () => {
    const measure = new Measure({ mode: 'distance' })
    const states: unknown[] = []
    measure.subscribe(state => states.push(state.live))
    const mode = measure.draw.getMode() as DistanceMode
    expect(mode).toBeInstanceOf(DistanceMode)
    // Entered by hand: the measure is not installed on an earth here.
    mode.enter(createContext())
    mode.click(pointer(0, 0))
    expect(measure.getState().live).toMatchObject({ id: LIVE_MEASUREMENT_ID, kind: 'distance', lengthMeters: 0 })
    mode.hover(pointer(1, 0))
    const live = measure.getState().live
    expect(live?.kind === 'distance' && live.lengthMeters).toBeCloseTo((A * Math.PI) / 180, 3)
    expect(live?.positions).toEqual([[0, 0], [1, 0]])
    mode.cancel()
    expect(measure.getState().live).toBeNull()
    expect(states.length).toBeGreaterThanOrEqual(3)
  })

  it('measures the area being drawn live', () => {
    const measure = new Measure({ mode: 'area' })
    const mode = measure.draw.getMode() as AreaMode
    mode.enter(createContext())
    mode.click(pointer(0, 0))
    mode.hover(pointer(0.01, 0))
    // Two positions: the open path, not twice the segment.
    const two = measure.getState().live
    expect(two?.kind === 'area' && two.perimeterMeters).toBeCloseTo(geodesicDistanceMeters([0, 0], [0.01, 0]), 6)
    for (const [longitude, latitude] of [[0.01, 0], [0.01, 0.01]] as const) mode.click(pointer(longitude, latitude))
    mode.hover(pointer(0, 0.01))
    const live = measure.getState().live
    expect(live?.kind).toBe('area')
    expect(live?.kind === 'area' && live.areaSquareMeters).toBeCloseTo(ringAreaSquareMeters([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]), 3)
  })

  it('needs an earth for elevation profiles, and says how to install it', () => {
    const measure = new Measure({ features: [line('a', [[0, 0], [1, 0]])] })
    expect(() => measure.elevationProfile('a')).toThrow(/earth\.addPlugin\(measure\)/)
  })
})
