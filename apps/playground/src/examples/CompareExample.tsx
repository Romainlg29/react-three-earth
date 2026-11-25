import { Compare, type CompareOrientation } from '@earthkit/compare'
import { useCompareHandle, useCompareImagery, useCompareState } from '@earthkit/compare/react'
import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource, RasterTileSource } from '@earthkit/globe/react'
import { useMemo, useState } from 'react'

import { rasterAttribution, rasterTilesUrl, useFixtures, vectorSchema } from './data'
import { ExampleShell } from './ExampleShell'
import { flyToPlace, placesFor, type Place } from './places'

const PLACES = placesFor<Place>(
  [
    { name: 'Paris', view: { longitudeDegrees: 2.2945, latitudeDegrees: 48.8584, heightMeters: 40, distanceMeters: 3200, headingDegrees: -30, pitchDegrees: -40 } },
    { name: 'Dubai', view: { longitudeDegrees: 55.135, latitudeDegrees: 25.115, heightMeters: 0, distanceMeters: 28_000, headingDegrees: 0, pitchDegrees: -70 } },
    { name: 'Mount Fuji', view: { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2500, distanceMeters: 30_000, headingDegrees: -40, pitchDegrees: -30 } },
  ],
  [{ name: 'Fixture city', view: { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 3900, distanceMeters: 1800, headingDegrees: 20, pitchDegrees: -40 } }],
)

/** EOX's Sentinel-2 cloudless mosaics (s2maps.eu), one per year; `VITE_SATELLITE_URL` overrides the recent one. */
const satelliteUrl = (layer: string) => `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/{z}/{y}/{x}.jpg`
const SATELLITE = {
  recent: import.meta.env.VITE_SATELLITE_URL ?? satelliteUrl('s2cloudless-2020_3857'),
  older: satelliteUrl('s2cloudless_3857'),
  attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data)',
}

type Pair = 'map-satellite' | 'years'

/** A light street map with names and 3D buildings: everything a map style draws is clipped to its side. */
function streetStyle(): object {
  const { source, water, roads, majorRoadClasses, places, buildings, buildingHeight, buildingBase } = vectorSchema
  return {
    version: 8,
    sources: { map: source },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#efe9df' } },
      { id: 'water', type: 'fill', source: 'map', 'source-layer': water, paint: { 'fill-color': '#9fc4e4' } },
      {
        id: 'roads',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['match', ['get', 'class'], majorRoadClasses, '#f3c56d', '#ffffff'], 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.5, 18, 20] },
      },
      {
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'map',
        'source-layer': buildings,
        minzoom: 13,
        paint: { 'fill-extrusion-color': '#d8cbb6', 'fill-extrusion-height': buildingHeight, 'fill-extrusion-base': buildingBase, 'fill-extrusion-opacity': 0.95 },
      },
      {
        id: 'places',
        type: 'symbol',
        source: 'map',
        'source-layer': places,
        layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 15, 13], 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99] },
        paint: { 'text-color': '#2b2b33', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
    ],
  }
}

/** The slider: a line across the map with a grip, placed by `--compare-position` so a drag re-renders nothing. */
function CompareHandle({ compare }: { compare: Compare }) {
  const handleRef = useCompareHandle(compare, { label: 'Before and after' })
  return (
    <div ref={handleRef} className="compare-handle">
      <span className="compare-grip" aria-hidden="true" />
    </div>
  )
}

/**
 * `?example=compare`: a street map and satellite imagery, or two years of satellite pictures, on either side of a
 * slider (`@earthkit/compare`). Both sides share the terrain and the camera: one render.
 */
export function CompareExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [place, setPlace] = useState<Place>(PLACES[0]!)
  const [pair, setPair] = useState<Pair>('map-satellite')
  const compare = useMemo(() => new Compare(), [])
  const plugins = useMemo(() => [compare], [compare])
  const orientation = useCompareState(compare, state => state.orientation)
  const followPointer = useCompareState(compare, state => state.followPointer)
  const beforeRef = useCompareImagery(compare, 'before')
  const afterRef = useCompareImagery(compare, 'after')
  const style = useMemo(() => streetStyle(), [])
  const fixtureOrRecent = useFixtures ? rasterTilesUrl : SATELLITE.recent
  const setOrientation = (value: CompareOrientation) => (compare.orientation = value)

  return (
    <ExampleShell
      title="Compare"
      description="Drag the slider, or focus it and use the arrow keys. Both sides share the terrain and the camera, so they never drift apart, and cost a single render."
      camera={PLACES[0]!.view}
      onEarth={setEarth}
      plugins={plugins}
      overlay={<CompareHandle compare={compare} />}
      panel={
        <>
          <div className="example-buttons">
            {PLACES.map(entry => (
              <button key={entry.name} type="button" aria-pressed={entry === place} onClick={() => (setPlace(entry), flyToPlace(earth, entry))}>
                {entry.name}
              </button>
            ))}
          </div>
          <div className="example-buttons">
            <button type="button" aria-pressed={pair === 'map-satellite'} onClick={() => setPair('map-satellite')}>
              Map and satellite
            </button>
            <button type="button" aria-pressed={pair === 'years'} onClick={() => setPair('years')} disabled={useFixtures}>
              2016 and 2020
            </button>
          </div>
          <div className="example-buttons">
            <button type="button" aria-pressed={orientation === 'vertical'} onClick={() => setOrientation('vertical')}>
              Side by side
            </button>
            <button type="button" aria-pressed={orientation === 'horizontal'} onClick={() => setOrientation('horizontal')}>
              Top and bottom
            </button>
            <button type="button" aria-pressed={followPointer} onClick={() => (compare.followPointer = !followPointer)}>
              Follow the pointer
            </button>
          </div>
        </>
      }
    >
      {pair === 'map-satellite' ? (
        <Imagery key="map" ref={beforeRef}>
          <MapStyleSource style={style} />
        </Imagery>
      ) : (
        <Imagery key="older" ref={beforeRef}>
          <RasterTileSource url={SATELLITE.older} levels={15} attribution={SATELLITE.attribution} />
        </Imagery>
      )}
      <Imagery ref={afterRef}>
        <RasterTileSource url={fixtureOrRecent} levels={useFixtures ? 19 : 15} attribution={useFixtures ? rasterAttribution : SATELLITE.attribution} />
      </Imagery>
    </ExampleShell>
  )
}
