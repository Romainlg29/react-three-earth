import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource, QuantizedMeshSource, RasterDemSource, useEarth } from '@earthkit/globe/react'
import { WATER_PRESETS, type Water as WaterImpl, type WaterPreset, type WaveProbePoint } from '@earthkit/water'
import { useWaveProbe, Water } from '@earthkit/water/react'
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useState } from 'react'
import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'

import { elevationAttribution, elevationTilesUrl, rasterBasemapStyle, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'

/** `?quality=low` or `high` forces the sea's quality level; by default the device decides. */
const requestedQuality = (() => {
  const quality = new URLSearchParams(location.search).get('quality')
  return quality === 'low' || quality === 'high' ? quality : 'auto'
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

/** Where the hull is probed, metres in the boat's frame (x starboard, y forward): its bow and the two sides of its stern. */
const HULL_POINTS = [
  [0, 5],
  [-2, -4],
  [2, -4],
] as const
const METERS_PER_DEGREE = 111_320

interface BoatProps {
  water: WaterImpl | null
  longitudeDegrees: number
  latitudeDegrees: number
  /** Where the bow points, degrees clockwise from north. */
  headingDegrees: number
}

/**
 * A small boat riding the waves: a probe reads the sea's height under its bow and both sides of its stern, and the
 * plane through the three gives its height, pitch and roll.
 */
function Boat({ water, longitudeDegrees, latitudeDegrees, headingDegrees }: BoatProps) {
  const earth = useEarth()
  const [boat, setBoat] = useState<ReturnType<typeof createBoat> | null>(null)
  const points = useMemo<WaveProbePoint[]>(() => {
    const heading = (headingDegrees * Math.PI) / 180
    const metersPerDegreeEast = METERS_PER_DEGREE * Math.cos((latitudeDegrees * Math.PI) / 180)
    return HULL_POINTS.map(([starboard, forward]) => {
      const east = forward * Math.sin(heading) + starboard * Math.cos(heading)
      const north = forward * Math.cos(heading) - starboard * Math.sin(heading)
      return { longitudeDegrees: longitudeDegrees + east / metersPerDegreeEast, latitudeDegrees: latitudeDegrees + north / METERS_PER_DEGREE }
    })
  }, [longitudeDegrees, latitudeDegrees, headingDegrees])
  const probe = useWaveProbe(water, points)

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
    const [bow, port, starboard] = probe?.samples ?? []
    if (boat === null || bow === undefined || port === undefined || starboard === undefined || !bow.ready) return
    // The plane z = height + roll x + pitch y through the three samples.
    const roll = (starboard.heightMeters - port.heightMeters) / 4
    const pitch = (bow.heightMeters - (port.heightMeters + starboard.heightMeters) / 2) / 9
    const height = bow.heightMeters - 5 * pitch
    boat.anchor.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters: height }, headingDegrees)
    boat.hull.rotation.set(Math.atan(pitch), -Math.atan(roll), 0)
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
          {water !== null ? <SeaState water={water} /> : null}
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

/** What the settings resolve to: read from `water.state` on every render of the panel. */
function SeaState({ water }: { water: WaterImpl }) {
  const { significantWaveHeightMeters, whitecapCoverage, waves } = water.state
  return (
    <p className="example-status">
      {waves ? `Waves of ${significantWaveHeightMeters.toFixed(1)} m (significant height)` : 'No waves'}, {(whitecapCoverage * 100).toFixed(1)} % whitecaps.
    </p>
  )
}
