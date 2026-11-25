import { Imagery, MapStyleSource } from '@earthkit/globe/react'
import { GeoJSONProvider, Geocoder, PhotonProvider, type GeocoderProvider } from '@earthkit/geocoder'
import { useGeocoder, useGeocoderState } from '@earthkit/geocoder/react'
import type { FeatureCollection } from 'geojson'
import { useMemo } from 'react'

import { rasterBasemapStyle, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'
import { peaks } from './peaks'

/** The fixture terrain's places, for the browser checks (the sandbox reaches no geocoding service). */
const FIXTURE_PLACES: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'peak', properties: { name: 'Fixture Peak', region: 'Synthetic range' }, geometry: { type: 'Point', coordinates: [-90, 0] } },
    {
      type: 'Feature',
      id: 'basin',
      properties: { name: 'Fixture Basin', region: 'Synthetic range' },
      geometry: { type: 'Polygon', coordinates: [[[-90.6, -0.5], [-89.4, -0.5], [-89.4, 0.5], [-90.6, 0.5], [-90.6, -0.5]]] },
    },
    { type: 'Feature', id: 'ridge', properties: { name: 'Fixture Ridge Trail', region: 'Synthetic range' }, geometry: { type: 'LineString', coordinates: [[-90.05, 0.02], [-89.95, 0.02]] } },
  ],
}

export function createProviders(): GeocoderProvider[] {
  if (useFixtures) return [new GeoJSONProvider({ features: FIXTURE_PLACES, description: 'region' })]
  return [
    // The app's own places first, searched in memory…
    new GeoJSONProvider({ name: 'peaks', features: peaks, description: feature => `Summit, ${feature.properties?.elevationMeters} m, ${feature.properties?.country}` }),
    // …then OpenStreetMap through komoot's Photon, built for search as you type.
    new PhotonProvider({ url: 'https://photon.komoot.io' }),
  ]
}

/** The search box: an input and a list, from `useGeocoder`'s combobox props. The library ships none of this, nor any CSS. */
export function SearchBox({ geocoder }: { geocoder: Geocoder }) {
  const { inputProps, listboxProps, getOptionProps, results, status, query, resultsQuery } = useGeocoder(geocoder)
  const empty = status === 'success' && results.length === 0 && resultsQuery === query
  return (
    <div className="example-search">
      <label htmlFor={inputProps.id} className="example-search-label">
        Search places
      </label>
      <input {...inputProps} placeholder={useFixtures ? 'Try “fixture”' : 'Try “Chamonix” or “Everest”'} data-testid="geocoder-input" />
      <ul {...listboxProps} className="example-search-results" aria-label="Places">
        {results.map((result, index) => (
          <li key={result.id} {...getOptionProps(index)}>
            <strong>{result.name}</strong>
            {result.description !== '' && <span>{result.description}</span>}
          </li>
        ))}
      </ul>
      <p className="example-status" role="status" data-testid="geocoder-status">
        {status === 'loading' ? 'Searching…' : status === 'error' ? 'The search service did not answer.' : empty ? 'No place found.' : ' '}
      </p>
    </div>
  )
}

/** What a click on the map found: the reverse search's best place. */
function ReverseStatus({ geocoder }: { geocoder: Geocoder }) {
  const reverse = useGeocoderState(geocoder, state => state.reverse)
  const best = reverse.results[0]
  return (
    <p className="example-status" data-testid="geocoder-reverse">
      {reverse.status === 'idle'
        ? 'Click the map to see what is there.'
        : reverse.status === 'loading'
          ? 'Looking up…'
          : best === undefined
            ? 'Nothing named here.'
            : `Here: ${best.name}${best.description === '' ? '' : `, ${best.description}`}`}
    </p>
  )
}

/**
 * `?example=geocoder`: place search with `@earthkit/geocoder`, a headless plugin. Typing searches the app's own
 * summits in memory and OpenStreetMap through Photon; the arrow keys and Enter pick a place, the camera flies there and
 * a marker drops on it. A click on the map reverse geocodes it.
 */
export function GeocoderExample() {
  const geocoder = useMemo(() => {
    const created = new Geocoder({ provider: createProviders(), marker: true, reverseOnClick: true })
    // `window.geocoder` lets the browser checks drive it.
    ;(window as unknown as { geocoder: Geocoder }).geocoder = created
    return created
  }, [])
  const plugins = useMemo(() => [geocoder], [geocoder])
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.2 }), [])
  return (
    <ExampleShell
      title="Search places"
      description="Type a place's name: results come as you type, from the app's own summits and from OpenStreetMap. Pick one with the arrow keys and Enter, or a tap, and the camera flies there. Tap the map to look up what is there."
      camera={useFixtures ? { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 0, distanceMeters: 400_000, headingDegrees: 0, pitchDegrees: -90 } : { longitudeDegrees: 10, latitudeDegrees: 30, heightMeters: 0, distanceMeters: 14_000_000, headingDegrees: 0, pitchDegrees: -90 }}
      plugins={plugins}
      panel={
        <>
          <SearchBox geocoder={geocoder} />
          <ReverseStatus geocoder={geocoder} />
        </>
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}
