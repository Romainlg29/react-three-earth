import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource, QuantizedMeshSource, RasterDemSource, useEarth } from '@earthkit/globe/react'
import { resolveWaterState, WATER_PRESETS, WATER_QUALITY_LEVELS, type Water as WaterImpl, type WaterPreset, type WaterQuality, type WaterSettings } from '@earthkit/water'
import { useWaveBuoyancy, Water } from '@earthkit/water/react'
import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'

import { elevationAttribution, elevationTilesUrl, rasterBasemapStyle, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'

/** `?quality=minimal`, `low` or `high` forces the sea's quality level; by default the device decides. */
const requestedQuality = (() => {
  const quality = new URLSearchParams(location.search).get('quality')
  return quality === 'minimal' || quality === 'low' || quality === 'high' ? quality : 'auto'
})()
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
const QUALITIES = Object.keys(WATER_QUALITY_LEVELS) as WaterQuality[]

/** A gale's light: dim, as under thick cloud (the atmosphere's default exposure is 10). */
const STORM_EXPOSURE = 4

/** The hull's size, metres: the corners its buoyancy samples. */
const HULL_LENGTH_METERS = 11
const HULL_BEAM_METERS = 3.6

interface BoatProps {
  water: WaterImpl | null
  longitudeDegrees: number
  latitudeDegrees: number
  /** Where the bow points, degrees clockwise from north. */
  headingDegrees: number
}

/**
 * A small boat riding the waves: a `WaveBuoyancy` samples the sea at its hull's four corners and gives its height, pitch
 * and roll, followed with a little lag as a real hull's inertia would.
 */
function Boat({ water, longitudeDegrees, latitudeDegrees, headingDegrees }: BoatProps) {
  const earth = useEarth()
  const [boat, setBoat] = useState<ReturnType<typeof createBoat> | null>(null)
  const buoyancy = useWaveBuoyancy(water, { longitudeDegrees, latitudeDegrees, headingDegrees, lengthMeters: HULL_LENGTH_METERS, beamMeters: HULL_BEAM_METERS }, { draftMeters: 0.4 })

  // Made in the effect, not in state: a disposed anchor is no longer placed, and StrictMode runs effects twice.
  useLayoutEffect(() => {
    const created = createBoat(earth, longitudeDegrees, latitudeDegrees)
    earth.add(created.anchor)
    setBoat(created)
    return () => {
      earth.remove(created.anchor)
      created.anchor.dispose()
      created.dispose()
    }
  }, [earth, longitudeDegrees, latitudeDegrees])

  useFrame(() => {
    const state = buoyancy?.state
    if (boat === null || state === undefined || !state.ready) return
    boat.anchor.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters: state.heightMeters }, headingDegrees)
    // The hull's frame: x starboard, y forward, z up. Bow up turns about x, starboard up about y (the other way).
    boat.hull.rotation.set(state.pitchRadians, -state.rollRadians, 0)
  })
  return null
}

/** A hull, a cabin and a mast, in a frame anchored on the sea (x starboard, y forward, z up). */
function createBoat(earth: ReturnType<typeof useEarth>, longitudeDegrees: number, latitudeDegrees: number) {
  const anchor = earth.createGeographicAnchor({ longitudeDegrees, latitudeDegrees, heightMeters: 0 })
  const hull = new Group()
  const white = new MeshStandardNodeMaterial({ color: '#f2f0ea', roughness: 0.4 })
  const blue = new MeshStandardNodeMaterial({ color: '#1d3557', roughness: 0.5 })
  const body = new Mesh(new BoxGeometry(3.6, 11, 1.4), blue)
  body.position.z = 0.2
  const deck = new Mesh(new BoxGeometry(3.4, 10.6, 0.2), white)
  deck.position.z = 1
  const cabin = new Mesh(new BoxGeometry(2.4, 3.5, 1.4), white)
  cabin.position.set(0, -1, 1.8)
  const mast = new Mesh(new CylinderGeometry(0.08, 0.1, 9), white)
  mast.rotation.x = Math.PI / 2
  mast.position.set(0, 1.5, 5.5)
  hull.add(body, deck, cabin, mast)
  anchor.add(hull)
  const dispose = () => {
    for (const mesh of [body, deck, cabin, mast]) mesh.geometry.dispose()
    white.dispose()
    blue.dispose()
  }
  return { anchor, hull, dispose }
}

/**
 * `?example=sea`: `@earthkit/water` on Terrarium elevation, whose heights below sea level say where the sea is. Pick a
 * preset or set the wind: the colour comes from the water's optics, the gloss, waves and whitecaps from the wind. Under
 * WebGPU the waves run in compute shaders, with foam on the crests that break, a displaced mesh near the camera and a
 * boat floating on it (a wave probe).
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
  const [seed, setSeed] = useState(1)
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
      atmosphereExposure={preset === 'storm' ? STORM_EXPOSURE : undefined}
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
            <button type="button" onClick={() => setSeed(seed + 1)}>
              Another sea (seed {seed})
            </button>
            <button type="button" aria-pressed={seafloor} onClick={() => setSeafloor(!seafloor)} disabled={useFixtures}>
              Seafloor in shallow water
            </button>
          </div>
          <QualityPicker water={water} />
          <SeaState preset={preset} windSpeedMetersPerSecond={wind ?? undefined} windDirectionDegrees={windDirection} />
        </>
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
      <Water
        quality={requestedQuality}
        ref={setWater}
        preset={preset}
        windSpeedMetersPerSecond={wind ?? undefined}
        windDirectionDegrees={windDirection}
        depthFromElevation={seafloor && !useFixtures}
        waveSeed={seed}
      />
      <Boat key={coast.name} water={water} longitudeDegrees={coast.view.longitudeDegrees} latitudeDegrees={coast.view.latitudeDegrees} headingDegrees={windDirection} />
    </ExampleShell>
  )
}

/**
 * The quality the sea draws at, and buttons to change it: `'auto'` may have picked `'minimal'` (no wave mesh) on a software
 * renderer, and `adaptiveQuality` lowers high to low when frames run slow; `water.quality` changes without a render, so
 * it is read every half second.
 */
function QualityPicker({ water }: { water: WaterImpl | null }) {
  const [quality, setQuality] = useState<WaterQuality | null>(null)
  useEffect(() => {
    if (water === null) return
    setQuality(water.quality)
    const timer = setInterval(() => setQuality(water.quality), 500)
    return () => clearInterval(timer)
  }, [water])
  return (
    <div className="example-buttons" aria-label="Quality">
      {QUALITIES.map(level => (
        <button
          key={level}
          type="button"
          aria-pressed={level === quality}
          disabled={water === null}
          onClick={() => {
            water?.setQuality(level)
            setQuality(level)
          }}
        >
          {level === 'minimal' ? 'minimal (no wave mesh)' : `${level} quality`}
        </button>
      ))}
    </div>
  )
}

/**
 * What the settings resolve to, from the same settings as the `<Water>`: `water.state` would lag a render behind, as the
 * plugin takes new props in its layout effect, after the panel has rendered.
 */
function SeaState(settings: WaterSettings) {
  const { significantWaveHeightMeters, whitecapCoverage, waves } = resolveWaterState(settings)
  return (
    <p className="example-status">
      {waves ? `Waves of ${significantWaveHeightMeters.toFixed(1)} m (significant height)` : 'No waves'}, {(whitecapCoverage * 100).toFixed(1)} % whitecaps.
    </p>
  )
}
