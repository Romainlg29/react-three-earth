import { Draw, SelectMode, StaticMode, wrapLongitude, type DrawFeature, type DrawFeatureInput, type DrawMode, type DrawState, type DrawStyleInput, type LongitudeLatitude } from '@earthkit/draw'
import { PLUGIN_API_VERSION, type Earth, type EarthPlugin, type PluginContext } from '@earthkit/globe'
import { EventDispatcher } from 'three'

import { pathLengthMeters, polygonAreaSquareMeters, ringLabelPosition, segmentLengthsMeters, withoutClosingPosition } from './geodesic.js'
import { AreaMode, DistanceMode, isMeasureDrawMode } from './modes.js'
import { elevationProfile, type ElevationProfile, type ElevationProfileOptions } from './profile.js'

/** What a measurement measures: a path's length, or the area inside a ring. */
export type MeasurementKind = 'distance' | 'area'

interface MeasurementBase {
  /** The feature's id in `measure.draw`; `LIVE_MEASUREMENT_ID` for the one being drawn. */
  id: string
  /** The vertices: a path's, or a ring's without its closing position. */
  positions: LongitudeLatitude[]
  /** The geodesic length of each side, in order: for an area, the closing side last. */
  segmentLengthsMeters: number[]
  /** Where a label reads well: a path's last vertex, a ring's centroid (or a point inside a concave ring). */
  labelPosition: LongitudeLatitude
}

/** A path's length along geodesics on the WGS84 ellipsoid. */
export interface DistanceMeasurement extends MeasurementBase {
  kind: 'distance'
  lengthMeters: number
}

/** The area inside a ring whose sides are geodesics on the WGS84 ellipsoid, and its perimeter. */
export interface AreaMeasurement extends MeasurementBase {
  kind: 'area'
  /** Holes of a loaded polygon are taken out. */
  areaSquareMeters: number
  /** Around the outer ring (holes left out, as in `segmentLengthsMeters`). Below three vertices, the open path's length. */
  perimeterMeters: number
}

export type Measurement = DistanceMeasurement | AreaMeasurement

/** The id of `state.live`, the measurement being drawn. */
export const LIVE_MEASUREMENT_ID = 'measure:live'

export interface MeasureOptions {
  /** The plugin's name, unique on an earth; also the prefix of its draped layer. Change it to install two. Default: 'measure'. */
  name?: string
  /**
   * The modes `setMode` can switch to. Default: `'static'` (the map pans), `'select'` (tap a measurement to select it,
   * tap again to drag its vertices), `'distance'` and `'area'`.
   */
  modes?: DrawMode[]
  /** The mode to start in. Default: 'static'. */
  mode?: string
  /** How measurements look (see `@earthkit/draw`'s `DrawStyleInput`). Default: yellow lines and fills, white handles. */
  style?: DrawStyleInput
  /** Measurements to start with: GeoJSON line strings (distances) and polygons (areas). */
  features?: DrawFeatureInput
  /** Escape, Enter, Backspace and Delete act on the mode while the map has focus. Default: false (opt-in). */
  keyboard?: boolean
  /** Makes the id of each new measurement. Default: a random UUID. */
  createId?: () => string
}

/** What `getState()` returns: a new object on each change, so it can be compared by identity. */
export interface MeasureState {
  /** The active mode's name. */
  mode: string
  /** Every mode `setMode` takes. */
  modes: readonly string[]
  /** A measurement is being drawn. */
  drawing: boolean
  /** Vertices placed in the measurement being drawn. */
  vertexCount: number
  /** `finish()` would complete the measurement being drawn. */
  canFinish: boolean
  /** `undo()` would take something back. */
  canUndo: boolean
  /** Ids of the selected measurements (in the select mode). */
  selectedIds: readonly string[]
  /** Every finished measurement, in the order drawn. The same array until one changes. */
  measurements: readonly Measurement[]
  /** The measurement being drawn, through the pointer's position while it hovers the map, or null. */
  live: Measurement | null
}

/** Events a `Measure` fires (`measure.addEventListener('change', listener)`). */
export interface MeasureEventMap {
  /** The finished measurements changed: drawn, edited, removed or loaded. */
  change: { measurements: readonly Measurement[] }
  /**
   * The earth settled (its `idle` event): more terrain may have loaded, so an elevation profile sampled again can
   * be finer or more complete. `useElevationProfile` samples again on it.
   */
  terrainchange: object
}

/** Called with the new state on each change. */
export type MeasureStateListener = (state: MeasureState) => void

/** Yellow, visible on satellite imagery and on light basemaps alike. */
const DEFAULT_MEASURE_STYLE: DrawStyleInput = (_feature, { selected }) => ({
  lineColor: selected ? '#38bdf8' : '#facc15',
  fillColor: selected ? '#38bdf8' : '#facc15',
  fillOpacity: 0.2,
  lineWidthPixels: 3,
  vertexColor: '#ffffff',
  vertexOutlineColor: selected ? '#0284c7' : '#a16207',
})

/**
 * Headless measuring on the globe and the flat map, as an earthkit plugin: distances along paths and areas inside
 * rings, geodesic on the WGS84 ellipsoid, plus the terrain's elevation profile along a path. It is built on
 * `@earthkit/draw` (`measure.draw`): measurements are GeoJSON features drawn by tapping, draped on the terrain, editable
 * in the select mode. It draws the lines and their handles, and nothing else: no labels, no buttons, no CSS. Show the
 * numbers from `getState()` (with `formatLength` and `formatArea`) where your app wants them, on the map with
 * `<Marker>` at each measurement's `labelPosition`, or in a panel.
 *
 * ```ts
 * const measure = new Measure()
 * earth.addPlugin(measure)
 * distanceButton.onclick = () => measure.setMode('distance')
 * measure.subscribe(({ live, measurements }) => {
 *   const last = live ?? measurements.at(-1)
 *   if (last?.kind === 'distance') readout.textContent = formatLength(last.lengthMeters)
 * })
 * ```
 */
export class Measure extends EventDispatcher<MeasureEventMap> implements EarthPlugin {
  readonly name: string
  readonly apiVersion = PLUGIN_API_VERSION
  /** The drawing plugin underneath: its features are the measurements. Use it for what `Measure` does not wrap. */
  readonly draw: Draw
  protected readonly listeners = new Set<MeasureStateListener>()
  protected state: MeasureState
  protected earth: Earth | null = null
  /** Each feature's measurement, computed once per feature object (features are replaced, never changed in place). */
  protected readonly measured = new WeakMap<DrawFeature, Measurement | null>()
  protected measuredFeatures: DrawState['features'] | null = null
  protected measurements: readonly Measurement[] = []
  protected livePositions: LongitudeLatitude[] = []
  protected live: Measurement | null = null

  constructor({ name = 'measure', modes, mode = 'static', style = DEFAULT_MEASURE_STYLE, features, keyboard = false, createId }: MeasureOptions = {}) {
    super()
    this.name = name
    const drawModes = modes ?? [new StaticMode(), new SelectMode(), new DistanceMode(), new AreaMode()]
    for (const each of drawModes) if (isMeasureDrawMode(each)) each.onLiveChange = this.onLiveChange
    this.draw = new Draw({ name, modes: drawModes, mode, style, features, keyboard, createId })
    this.state = this.computeState(this.draw.getState())
    this.draw.subscribe(this.onDrawState)
  }

  // ---- State, for toolbars and labels ----

  /** The current state. The same object until something changes. */
  getState = (): MeasureState => this.state

  /** Calls `listener` on each change of state, and returns the function that stops it. */
  subscribe = (listener: MeasureStateListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every finished measurement. */
  getMeasurements(): readonly Measurement[] {
    return this.state.measurements
  }

  /** A finished measurement by id. */
  getMeasurement(id: string): Measurement | undefined {
    return this.state.measurements.find(measurement => measurement.id === id)
  }

  // ---- Actions ----

  /** Switches mode by name: `'static'`, `'select'`, `'distance'`, `'area'` or one of your own. */
  setMode(name: string): void {
    this.draw.setMode(name)
  }

  /** Completes the measurement being drawn, when it has enough vertices. */
  finish(): void {
    this.draw.finish()
  }

  /** Drops the measurement being drawn. */
  cancel(): void {
    this.draw.cancel()
  }

  /** Removes the last vertex placed, or takes back the last edit in the select mode. */
  undo(): void {
    this.draw.undo()
  }

  /** Selects measurements by id, switching to the select mode. */
  select(ids: readonly string[]): void {
    this.draw.select(ids)
  }

  /** Deletes the selected measurements (or the picked vertex of the one being edited). */
  deleteSelected(): boolean {
    return this.draw.deleteSelected()
  }

  /** Removes measurements by id. */
  remove(ids: readonly string[]): void {
    this.draw.removeFeatures(ids)
  }

  /** Removes every measurement. */
  clear(): void {
    this.draw.clear()
  }

  /**
   * The terrain's heights along a measurement (by id, a distance's path or an area's ring, closed) or along positions
   * of your own, at `sampleCount` even steps (default 256), with the lowest, highest, total ascent and descent. Samples
   * the terrain loaded now, at the detail loaded now: samples off the loaded terrain have a null height and
   * `complete` is false. Sample again on `terrainchange` (as `useElevationProfile` does) for a finer profile.
   */
  elevationProfile(target: string | readonly (readonly number[])[], options?: ElevationProfileOptions): ElevationProfile {
    const earth = this.earth
    if (earth === null) throw new Error(`Measure "${this.name}": elevationProfile needs the terrain; install it first with earth.addPlugin(measure) or <Earth plugins={[measure]}>.`)
    let positions: readonly (readonly number[])[]
    if (typeof target === 'string') {
      const measurement = target === LIVE_MEASUREMENT_ID ? this.live : this.getMeasurement(target)
      if (measurement === null || measurement === undefined) throw new Error(`Measure.elevationProfile: no measurement "${target}"; pass the id of one in getState().measurements.`)
      positions = measurement.kind === 'area' && measurement.positions.length > 0 ? [...measurement.positions, measurement.positions[0]!] : measurement.positions
    } else positions = target
    return elevationProfile(positions, (longitudeDegrees, latitudeDegrees) => earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees }), options)
  }

  // ---- Plugin ----

  /** Installed on an earth: `elevationProfile` can sample its terrain. */
  get installed(): boolean {
    return this.earth !== null
  }

  install(context: PluginContext): void {
    // The drawing plugin registers through this plugin's context: removing the measure removes what it added.
    this.draw.install(context)
    this.earth = context.earth
    context.onDispose(() => {
      this.earth = null
    })
    context.addEventListener('idle', () => this.dispatchEvent({ type: 'terrainchange' }))
    // Profiles asked for before install sample now (an earth already idle fires no idle until it moves again).
    this.dispatchEvent({ type: 'terrainchange' })
  }

  uninstall(): void {
    this.draw.uninstall()
  }

  inspect(): unknown {
    return {
      mode: this.state.mode,
      measurements: this.state.measurements.map(measurement =>
        measurement.kind === 'distance'
          ? { id: measurement.id, kind: measurement.kind, vertices: measurement.positions.length, lengthMeters: measurement.lengthMeters }
          : { id: measurement.id, kind: measurement.kind, vertices: measurement.positions.length, areaSquareMeters: measurement.areaSquareMeters, perimeterMeters: measurement.perimeterMeters },
      ),
      live: this.state.live === null ? null : { kind: this.state.live.kind, vertices: this.state.live.positions.length },
      draw: this.draw.inspect(),
    }
  }

  // ---- Internals ----

  protected onDrawState = (drawState: DrawState): void => {
    this.update(drawState)
  }

  protected onLiveChange = (): void => {
    this.update(this.draw.getState())
  }

  /** Recomputes the state; tells subscribers, and fires `change` when the finished measurements changed. */
  protected update(drawState: DrawState): void {
    const previous = this.state
    const next = this.computeState(drawState)
    if (shallowEqual(next, previous)) return
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
    if (next.measurements !== previous.measurements) this.dispatchEvent({ type: 'change', measurements: next.measurements })
  }

  protected computeState(drawState: DrawState): MeasureState {
    return {
      mode: drawState.mode,
      modes: drawState.modes,
      drawing: drawState.drawing,
      vertexCount: drawState.vertexCount,
      canFinish: drawState.canFinish,
      canUndo: drawState.canUndo,
      selectedIds: drawState.selectedIds,
      measurements: this.measureFeatures(drawState.features),
      live: this.measureLive(),
    }
  }

  protected measureFeatures(features: DrawState['features']): readonly Measurement[] {
    if (features === this.measuredFeatures) return this.measurements
    this.measuredFeatures = features
    const measurements: Measurement[] = []
    // The store gives every feature a string id.
    for (const feature of features.features as readonly DrawFeature[]) {
      let measurement = this.measured.get(feature)
      if (measurement === undefined) {
        measurement = measureFeature(feature)
        this.measured.set(feature, measurement)
      }
      if (measurement !== null) measurements.push(measurement)
    }
    // The same array while the measurements are the same ones (a feature collection rebuilt around unchanged features).
    if (measurements.length !== this.measurements.length || measurements.some((measurement, index) => measurement !== this.measurements[index])) this.measurements = measurements
    return this.measurements
  }

  protected measureLive(): Measurement | null {
    const mode = this.draw.getMode()
    const positions = isMeasureDrawMode(mode) ? mode.livePositions() : []
    if (samePositions(positions, this.livePositions) && (this.live === null) === (positions.length === 0)) return this.live
    this.livePositions = positions
    if (positions.length === 0) this.live = null
    else this.live = mode instanceof AreaMode ? measureRing(LIVE_MEASUREMENT_ID, positions, [positions]) : measurePath(LIVE_MEASUREMENT_ID, positions)
    return this.live
  }
}

/** A line string's distance or a polygon's area; null for other geometries (points, meshes). */
export function measureFeature(feature: DrawFeature): Measurement | null {
  const geometry = feature.geometry
  if (geometry.type === 'LineString') return measurePath(feature.id, geometry.coordinates.map(([longitude, latitude]) => [longitude!, latitude!] as LongitudeLatitude))
  if (geometry.type === 'Polygon' && geometry.coordinates[0] !== undefined) {
    const rings = geometry.coordinates.map(ring => withoutClosingPosition(ring.map(([longitude, latitude]) => [longitude!, latitude!] as LongitudeLatitude)))
    return measureRing(feature.id, rings[0]!, rings)
  }
  return null
}

function measurePath(id: string, positions: LongitudeLatitude[]): DistanceMeasurement {
  const segmentLengths = segmentLengthsMeters(positions)
  const last = positions[positions.length - 1] ?? [0, 0]
  return { kind: 'distance', id, positions, segmentLengthsMeters: segmentLengths, lengthMeters: pathLengthMeters(positions), labelPosition: [wrapLongitude(last[0]), last[1]] }
}

function measureRing(id: string, positions: LongitudeLatitude[], rings: LongitudeLatitude[][]): AreaMeasurement {
  // Below three vertices (a ring being drawn), the open path: no closing side back over the same segment.
  const closed = positions.length > 2 ? [...positions, positions[0]!] : positions
  const segmentLengths = segmentLengthsMeters(closed)
  return {
    kind: 'area',
    id,
    positions,
    segmentLengthsMeters: segmentLengths,
    areaSquareMeters: polygonAreaSquareMeters(rings),
    perimeterMeters: segmentLengths.reduce((sum, length) => sum + length, 0),
    labelPosition: ringLabelPosition(positions),
  }
}

function samePositions(a: readonly LongitudeLatitude[], b: readonly LongitudeLatitude[]): boolean {
  return a.length === b.length && a.every((position, index) => position[0] === b[index]![0] && position[1] === b[index]![1])
}

function shallowEqual(a: object, b: object): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  return true
}
