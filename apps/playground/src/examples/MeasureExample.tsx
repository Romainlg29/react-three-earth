import { Imagery, MapStyleSource, Marker } from '@earthkit/globe/react'
import { formatArea, formatLength, Measure, type ElevationProfile, type Measurement, type UnitSystem } from '@earthkit/measure'
import { useElevationProfile, useMeasureState } from '@earthkit/measure/react'
import { useMemo, useState } from 'react'

import { rasterBasemapStyle } from './data'
import { ExampleShell } from './ExampleShell'

const TOOLS = [
  { mode: 'static', label: 'Pan' },
  { mode: 'select', label: 'Select' },
  { mode: 'distance', label: 'Distance' },
  { mode: 'area', label: 'Area' },
] as const

/** The figure a measurement's label shows. */
function describe(measurement: Measurement, unitSystem: UnitSystem): string {
  if (measurement.kind === 'distance') return formatLength(measurement.lengthMeters, { unitSystem })
  return `${formatArea(measurement.areaSquareMeters, { unitSystem })} · ${formatLength(measurement.perimeterMeters, { unitSystem })}`
}

/** A label on the map at each measurement, the one being drawn included. Plain markers: the measure draws no text. */
export function MeasurementLabels({ measure, unitSystem }: { measure: Measure; unitSystem: UnitSystem }) {
  const { measurements, live } = useMeasureState(measure)
  const shown = live === null ? measurements : [...measurements, live]
  return (
    <>
      {shown.map(measurement => (
        <Marker
          key={measurement.id}
          longitudeDegrees={measurement.labelPosition[0]}
          latitudeDegrees={measurement.labelPosition[1]}
          anchor={measurement.kind === 'distance' ? 'bottom' : 'center'}
          offsetPixels={measurement.kind === 'distance' ? { xPixels: 0, yPixels: -12 } : undefined}
          occludedOpacity={0.6}
          className="measure-label"
          label={describe(measurement, unitSystem)}
        >
          <span>{describe(measurement, unitSystem)}</span>
        </Marker>
      ))}
    </>
  )
}

/** A terrain height: whole metres or feet, whatever its size. */
function formatHeight(heightMeters: number, unitSystem: UnitSystem): string {
  return unitSystem === 'metric' ? `${Math.round(heightMeters).toLocaleString()} m` : `${Math.round(heightMeters / 0.3048).toLocaleString()} ft`
}

/** The profile as an SVG line: distance across, height up. */
function ProfileChart({ profile, unitSystem }: { profile: ElevationProfile; unitSystem: UnitSystem }) {
  const { samples, lengthMeters, minimumHeightMeters, maximumHeightMeters } = profile
  if (minimumHeightMeters === null || maximumHeightMeters === null || lengthMeters === 0) return <p className="example-status">Terrain along the line is still loading.</p>
  const width = 300
  const height = 80
  const span = Math.max(maximumHeightMeters - minimumHeightMeters, 1)
  const points = samples
    .filter(sample => sample.heightMeters !== null)
    .map(sample => `${((sample.distanceMeters / lengthMeters) * width).toFixed(1)},${(height - ((sample.heightMeters! - minimumHeightMeters) / span) * height).toFixed(1)}`)
    .join(' ')
  return (
    <figure className="measure-profile" data-testid="measure-profile">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Elevation profile along the line">
        <polyline points={`0,${height} ${points} ${width},${height}`} fill="rgba(250, 204, 21, 0.25)" stroke="none" />
        <polyline points={points} fill="none" stroke="#facc15" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>
        {formatHeight(minimumHeightMeters, unitSystem)} to {formatHeight(maximumHeightMeters, unitSystem)}, up {formatHeight(profile.ascentMeters, unitSystem)}, down {formatHeight(profile.descentMeters, unitSystem)}
        {profile.complete ? '' : ' (part of the line has no terrain loaded)'}
      </figcaption>
    </figure>
  )
}

/** The toolbar, the readout and the profile: plain elements on the measure's state. The plugin ships none of this. */
export function MeasurePanel({ measure, unitSystem, setUnitSystem }: { measure: Measure; unitSystem: UnitSystem; setUnitSystem: (system: UnitSystem) => void }) {
  const state = useMeasureState(measure)
  // The profile follows the selected line, else the last one drawn (not the one being drawn: it would sample the
  // terrain on every pointer move).
  const selected = state.measurements.find(measurement => state.selectedIds.includes(measurement.id))
  const profileTarget = selected?.kind === 'distance' ? selected : state.measurements.findLast(measurement => measurement.kind === 'distance')
  const profile = useElevationProfile(measure, profileTarget?.id ?? null, { sampleCount: 128 })
  return (
    <>
      <div className="example-buttons" role="toolbar" aria-label="Measuring tools">
        {TOOLS.map(tool => (
          <button key={tool.mode} type="button" aria-pressed={state.mode === tool.mode} onClick={() => measure.setMode(tool.mode)}>
            {tool.label}
          </button>
        ))}
      </div>
      <div className="example-buttons">
        <button type="button" disabled={!state.canFinish} onClick={() => measure.finish()}>
          Finish
        </button>
        <button type="button" disabled={!state.canUndo} onClick={() => measure.undo()}>
          Undo
        </button>
        <button type="button" disabled={state.selectedIds.length === 0} onClick={() => measure.deleteSelected()}>
          Delete
        </button>
        <button type="button" disabled={state.measurements.length === 0} onClick={() => measure.clear()}>
          Clear
        </button>
        <button type="button" aria-pressed={unitSystem === 'imperial'} onClick={() => setUnitSystem(unitSystem === 'metric' ? 'imperial' : 'metric')}>
          Imperial
        </button>
      </div>
      <p className="example-status" data-testid="measure-status">
        {state.live !== null
          ? `${describe(state.live, unitSystem)}. Tap the last vertex to finish.`
          : state.mode === 'distance' || state.mode === 'area'
            ? 'Tap the map to place the first vertex.'
            : `${state.measurements.length} measurements.`}
      </p>
      {profileTarget !== undefined && profile !== null ? <ProfileChart profile={profile} unitSystem={unitSystem} /> : null}
    </>
  )
}

/**
 * `?example=measure`: distances, areas and elevation profiles with `@earthkit/measure`, a headless plugin on
 * `@earthkit/draw`. Lengths and areas are geodesic on the WGS84 ellipsoid; the profile samples the loaded terrain.
 */
export function MeasureExample() {
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('metric')
  const measure = useMemo(() => {
    const created = new Measure({ keyboard: true })
    // `window.measure` lets the browser checks drive it.
    ;(window as unknown as { measure: Measure }).measure = created
    return created
  }, [])
  const plugins = useMemo(() => [measure], [measure])
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.3 }), [])
  return (
    <ExampleShell
      title="Measure distances, areas and elevation"
      description="Pick Distance or Area and tap the map to place vertices; the figure follows the pointer and finishes on a tap on the last vertex. Lengths and areas are geodesic on the WGS84 ellipsoid, on the globe and the flat map. A line shows the terrain's profile along it. Select a measurement to drag its vertices."
      camera={{ longitudeDegrees: 6.6, latitudeDegrees: 46.45, heightMeters: 0, distanceMeters: 70_000, headingDegrees: 0, pitchDegrees: -60 }}
      plugins={plugins}
      panel={<MeasurePanel measure={measure} unitSystem={unitSystem} setUnitSystem={setUnitSystem} />}
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
      <MeasurementLabels measure={measure} unitSystem={unitSystem} />
    </ExampleShell>
  )
}
