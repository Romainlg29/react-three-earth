import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource } from '@earthkit/globe/react'
import { useMemo, useState } from 'react'

import { sdfGlow } from '../styleLayers/sdfGlow'
import { neonLabels } from '../symbolEffects/neonLabels'
import { vectorSchema } from './data'
import { ExampleShell } from './ExampleShell'
import { FIXTURE_PEAK, flyToPlace, placesFor, type Place } from './places'

// Module scope: the plugins are created once and installed on the earth for the page's life.
const neon = neonLabels({ coreColor: '#fff4fd', outlineColor: '#ff2bd6' })
const plugins = [sdfGlow(), neon]

const CITIES = placesFor<Place>(
  [
    { name: 'Tokyo', view: { longitudeDegrees: 139.75, latitudeDegrees: 35.68, heightMeters: 20, distanceMeters: 14_000, headingDegrees: -20, pitchDegrees: -45 } },
    { name: 'Paris', view: { longitudeDegrees: 2.3417, latitudeDegrees: 48.8567, heightMeters: 40, distanceMeters: 12_000, headingDegrees: 30, pitchDegrees: -45 } },
    { name: 'New York', view: { longitudeDegrees: -73.98, latitudeDegrees: 40.74, heightMeters: 10, distanceMeters: 13_000, headingDegrees: 30, pitchDegrees: -45 } },
    { name: 'Dubai', view: { longitudeDegrees: 55.27, latitudeDegrees: 25.2, heightMeters: 10, distanceMeters: 16_000, headingDegrees: -40, pitchDegrees: -45 } },
  ],
  [{ name: 'Fixture roads', view: { longitudeDegrees: 138.7, latitudeDegrees: 35.36, heightMeters: 0, distanceMeters: 40_000, headingDegrees: 0, pitchDegrees: -60 } }, FIXTURE_PEAK],
)

const GLOW_COLORS = { amber: '#ff8a1f', cyan: '#18e0ff', magenta: '#ff2bd6' }
type GlowColor = keyof typeof GLOW_COLORS

/**
 * A night map: dark ground, faint streets, major roads with a glow from the `sdf-glow` layer type (a plugin), dark
 * buildings, and place names drawn by the `neon` symbol effect (another plugin), named in the layer's metadata.
 */
function nightStyle(glowColor: string): object {
  const { source, water, roads, majorRoadClasses, places, buildings, buildingHeight, buildingBase } = vectorSchema
  const majorRoads = ['match', ['get', 'class'], majorRoadClasses, true, false]
  return {
    version: 8,
    sources: { map: source },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#070a14' } },
      { id: 'water', type: 'fill', source: 'map', 'source-layer': water, paint: { 'fill-color': '#0b1830' } },
      {
        id: 'streets',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        // Streets only: no rail, ferry or path lines.
        filter: ['match', ['get', 'class'], ['secondary', 'tertiary', 'minor', 'service', 'street', 'residential'], true, false],
        paint: { 'line-color': '#1f2a48', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.4, 16, 4] },
      },
      {
        id: 'road-glow',
        type: 'sdf-glow',
        source: 'map',
        'source-layer': roads,
        filter: majorRoads,
        paint: { 'sdf-glow-color': glowColor, 'sdf-glow-radius-pixels': 14, 'sdf-glow-intensity': 0.8 },
      },
      {
        id: 'major-roads',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        filter: majorRoads,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#fff1dc', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.6, 16, 3] },
      },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'map',
        'source-layer': buildings,
        minzoom: 14,
        paint: { 'fill-extrusion-color': '#151d33', 'fill-extrusion-height': buildingHeight, 'fill-extrusion-base': buildingBase, 'fill-extrusion-opacity': 0.9 },
      },
      {
        id: 'place-names',
        type: 'symbol',
        source: 'map',
        'source-layer': places,
        metadata: { 'react-three-earth:symbol-effect': 'neon' },
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-size': ['match', ['get', 'class'], 'city', 22, 'town', 18, 15],
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#ff2bd6', 'text-halo-width': 1.5 },
      },
    ],
  }
}

/**
 * `?example=night`: two example plugins on real data. `sdf-glow` (a custom style layer type, worker module and
 * shader) lights the major roads; the `neon` symbol effect redraws the place names.
 */
export function NightCityExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [city, setCity] = useState<Place>(CITIES[0]!)
  const [glow, setGlow] = useState<GlowColor>('amber')
  const style = useMemo(() => nightStyle(GLOW_COLORS[glow]), [glow])
  return (
    <ExampleShell
      title="Plugins: glowing roads, neon names"
      description="Two example plugins on OpenStreetMap data: a custom layer type draws a glow around the major roads, and a symbol effect turns place names into neon."
      camera={CITIES[0]!.view}
      onEarth={setEarth}
      plugins={plugins}
      atmosphere={false}
      panel={
        <>
          <div className="example-buttons">
            {CITIES.map(place => (
              <button key={place.name} type="button" aria-pressed={place === city} onClick={() => (setCity(place), flyToPlace(earth, place))}>
                {place.name}
              </button>
            ))}
          </div>
          <div className="example-buttons">
            {(Object.keys(GLOW_COLORS) as GlowColor[]).map(name => (
              <button key={name} type="button" aria-pressed={name === glow} onClick={() => setGlow(name)}>
                {name[0]!.toUpperCase() + name.slice(1)} glow
              </button>
            ))}
          </div>
        </>
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}
