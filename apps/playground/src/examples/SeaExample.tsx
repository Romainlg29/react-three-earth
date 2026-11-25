import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource, QuantizedMeshSource, RasterDemSource } from '@earthkit/globe/react'
import { WATER_PRESETS, type Water as WaterImpl, type WaterPreset } from '@earthkit/water'
import { Water } from '@earthkit/water/react'
import { useMemo, useState } from 'react'

import { elevationAttribution, elevationTilesUrl, rasterBasemapStyle, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'
import { flyToPlace, placesFor, type Place } from './places'

interface Coast extends Place {
  /** The sea the place is known for. */
  preset: WaterPreset
}

/** Low over the water, looking along it: the waves draw within a few kilometres of the camera. */
const COASTS = placesFor<Coast>(
  [
    { name: 'Étretat', preset: 'breeze', view: { longitudeDegrees: 0.196, latitudeDegrees: 49.713, heightMeters: 0, distanceMeters: 900, headingDegrees: 200, pitchDegrees: -12 } },
    { name: 'Big Sur', preset: 'open-ocean', view: { longitudeDegrees: -121.91, latitudeDegrees: 36.37, heightMeters: 0, distanceMeters: 1500, headingDegrees: 230, pitchDegrees: -10 } },
    { name: 'Whitsundays', preset: 'coastal', view: { longitudeDegrees: 149.04, latitudeDegrees: -20.28, heightMeters: 0, distanceMeters: 2500, headingDegrees: 30, pitchDegrees: -25 } },
    { name: 'North Atlantic', preset: 'storm', view: { longitudeDegrees: -14, latitudeDegrees: 53, heightMeters: 0, distanceMeters: 400, headingDegrees: 90, pitchDegrees: -12 } },
  ],
  [{ name: 'Fixture sea', preset: 'open-ocean', view: { longitudeDegrees: -60, latitudeDegrees: -7.5, heightMeters: 0, distanceMeters: 300, headingDegrees: 60, pitchDegrees: -12 } }],
)

const PRESETS = Object.keys(WATER_PRESETS) as WaterPreset[]

/**
 * `?example=sea`: `@earthkit/water` on Terrarium elevation, whose heights below sea level say where the sea is. Pick a
 * preset or set the wind: the colour comes from the water's optics, the gloss, waves and whitecaps from the wind. Under
 * WebGPU the waves run in compute shaders, with foam on the crests that break.
 */
export function SeaExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [water, setWater] = useState<WaterImpl | null>(null)
  const [coast, setCoast] = useState<Coast>(COASTS[0]!)
  const [preset, setPreset] = useState<WaterPreset>(COASTS[0]!.preset)
  // null: the preset's own wind.
  const [wind, setWind] = useState<number | null>(null)
  const [windDirection, setWindDirection] = useState(270)
  const [seafloor, setSeafloor] = useState(true)
  const style = useMemo(() => rasterBasemapStyle(), [])
  const windShown = wind ?? WATER_PRESETS[preset].windSpeedMetersPerSecond
  const goTo = (place: Coast) => {
    setCoast(place)
    setPreset(place.preset)
    setWind(null)
    flyToPlace(earth, place)
  }

  return (
    <ExampleShell
      title="Sea"
      description="A physically based sea: its colour from the water's optics, its gloss, waves and whitecaps from the wind. Fly low over the water to see the waves."
      camera={COASTS[0]!.view}
      onEarth={setEarth}
      terrain={
        useFixtures ? (
          <QuantizedMeshSource url={`${import.meta.env.BASE_URL}fixtures/terrain-water/`} />
        ) : (
          <RasterDemSource url={elevationTilesUrl} encoding="terrarium" maximumZoom={15} flattenBelowSeaLevel attribution={elevationAttribution} />
        )
      }
      panel={
        <>
          <div className="example-buttons">
            {COASTS.map(place => (
              <button key={place.name} type="button" aria-pressed={place === coast} onClick={() => goTo(place)}>
                {place.name}
              </button>
            ))}
          </div>
          <div className="example-buttons">
            {PRESETS.map(name => (
              <button key={name} type="button" aria-pressed={name === preset} onClick={() => (setPreset(name), setWind(null))}>
                {name}
              </button>
            ))}
          </div>
          <label className="example-field">
            Wind {windShown.toFixed(0)} m/s
            <input type="range" min={0} max={25} step={0.5} value={windShown} onChange={event => setWind(Number(event.target.value))} />
          </label>
          <label className="example-field">
            From {windDirection}°
            <input type="range" min={0} max={359} step={1} value={windDirection} onChange={event => setWindDirection(Number(event.target.value))} />
          </label>
          <div className="example-buttons">
            <button type="button" aria-pressed={seafloor} onClick={() => setSeafloor(!seafloor)} disabled={useFixtures}>
              Seafloor in shallow water
            </button>
          </div>
          {water !== null ? <SeaState water={water} /> : null}
        </>
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
      <Water
        ref={setWater}
        preset={preset}
        windSpeedMetersPerSecond={wind ?? undefined}
        windDirectionDegrees={windDirection}
        depthFromElevation={seafloor && !useFixtures}
      />
    </ExampleShell>
  )
}

/** What the settings resolve to: read from `water.state` on every render of the panel. */
function SeaState({ water }: { water: WaterImpl }) {
  const { significantWaveHeightMeters, whitecapCoverage, waves } = water.state
  return (
    <p className="example-status">
      {waves ? `Waves of ${significantWaveHeightMeters.toFixed(1)} m (significant height)` : 'No waves'}, {(whitecapCoverage * 100).toFixed(1)} % whitecaps.
    </p>
  )
}
