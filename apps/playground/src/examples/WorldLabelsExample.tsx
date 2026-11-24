import type { Earth as EarthImpl } from 'react-three-earth'
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import { useMemo, useState } from 'react'

import { vectorSchema } from './data'
import { ExampleShell } from './ExampleShell'
import { flyToPlace, placesFor, type Place } from './places'

/** A city and the language its names are read in (`name:<language>`, falling back to the local `name`). */
interface City extends Place {
  language: string
  script: string
}

const fixtureView = { longitudeDegrees: 138.58, latitudeDegrees: 35.35, heightMeters: 0, distanceMeters: 45_000, headingDegrees: 0, pitchDegrees: -70 }

const CITIES: City[] = placesFor<City>(
  [
    { name: 'Cairo', language: 'ar', script: 'Arabic, right to left', view: { longitudeDegrees: 31.2357, latitudeDegrees: 30.0444, heightMeters: 30, distanceMeters: 30_000, headingDegrees: 0, pitchDegrees: -60 } },
    { name: 'Tel Aviv', language: 'he', script: 'Hebrew, right to left', view: { longitudeDegrees: 34.7818, latitudeDegrees: 32.0853, heightMeters: 20, distanceMeters: 25_000, headingDegrees: 0, pitchDegrees: -60 } },
    { name: 'Delhi', language: 'hi', script: 'Hindi, Devanagari clusters', view: { longitudeDegrees: 77.209, latitudeDegrees: 28.6139, heightMeters: 220, distanceMeters: 35_000, headingDegrees: 0, pitchDegrees: -60 } },
    { name: 'Bangkok', language: 'th', script: 'Thai, no spaces between words', view: { longitudeDegrees: 100.5018, latitudeDegrees: 13.7563, heightMeters: 5, distanceMeters: 30_000, headingDegrees: 0, pitchDegrees: -60 } },
    { name: 'Tokyo', language: 'ja', script: 'Japanese, vertical or horizontal', view: { longitudeDegrees: 139.7454, latitudeDegrees: 35.6586, heightMeters: 30, distanceMeters: 30_000, headingDegrees: 0, pitchDegrees: -60 } },
  ],
  [{ name: 'Fixture names', language: 'local', script: 'Arabic, Hebrew, Hindi, Thai and Japanese', view: fixtureView }],
)

/** A quiet map whose place and road names are read in one language; `vertical` stands CJK names in columns. */
function labelStyle(language: string, vertical: boolean): object {
  const { source, water, roads, roadNames, majorRoadClasses, places } = vectorSchema
  const name = ['coalesce', ['get', `name:${language}`], ['get', 'name']]
  return {
    version: 8,
    sources: { map: source },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f3efe6' } },
      { id: 'water', type: 'fill', source: 'map', 'source-layer': water, paint: { 'fill-color': '#a8cbe8' } },
      {
        id: 'roads',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        filter: ['match', ['get', 'class'], majorRoadClasses, true, false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f1c776', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.8, 16, 10] },
      },
      {
        id: 'road-names',
        type: 'symbol',
        source: 'map',
        'source-layer': roadNames,
        minzoom: 12,
        layout: { 'symbol-placement': 'line', 'text-field': name, 'text-size': 13 },
        paint: { 'text-color': '#5b4a2e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
      {
        id: 'place-names',
        type: 'symbol',
        source: 'map',
        'source-layer': places,
        layout: {
          'text-field': name,
          'text-size': ['match', ['get', 'class'], 'city', 20, 'town', 16, 14],
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
          'text-max-width': 8,
          ...(vertical ? { 'text-writing-mode': ['vertical'] } : {}),
        },
        paint: { 'text-color': '#1f2430', 'text-halo-color': 'rgba(255, 255, 255, 0.95)', 'text-halo-width': 2 },
      },
    ],
  }
}

/**
 * `?example=labels`: place and road names in Arabic, Hebrew, Hindi, Thai and Japanese, shaped by the library itself
 * (bidi, Arabic joining, grapheme clusters, vertical columns) and drawn with the device's own fonts.
 */
export function WorldLabelsExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [city, setCity] = useState<City>(CITIES[0]!)
  const [vertical, setVertical] = useState(false)
  const style = useMemo(() => labelStyle(city.language, vertical), [city.language, vertical])
  return (
    <ExampleShell
      title="Labels in every script"
      description={
        <>
          Names in the local language, shaped without a plugin and drawn with the device's fonts. Now: <strong>{city.script}</strong>.
        </>
      }
      camera={CITIES[0]!.view}
      onEarth={setEarth}
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
            <button type="button" aria-pressed={vertical} onClick={() => setVertical(value => !value)}>
              Vertical Japanese and Chinese
            </button>
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
