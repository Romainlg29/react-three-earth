import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource, RasterDemSource } from '@earthkit/globe/react'
import { useMemo, useState } from 'react'

import { elevationAttribution, elevationTilesUrl, rasterAttribution, rasterTilesUrl, useFixtures } from './data'
import { ExampleShell } from './ExampleShell'
import { flyToPlace, placesFor, type Place } from './places'

const MOUNTAINS = placesFor<Place>(
  [
    { name: 'Matterhorn', view: { longitudeDegrees: 7.6586, latitudeDegrees: 45.9763, heightMeters: 3600, distanceMeters: 16_000, headingDegrees: -110, pitchDegrees: -18 } },
    { name: 'Everest', view: { longitudeDegrees: 86.925, latitudeDegrees: 27.9881, heightMeters: 7000, distanceMeters: 32_000, headingDegrees: 200, pitchDegrees: -16 } },
    { name: 'Grand Canyon', view: { longitudeDegrees: -112.11, latitudeDegrees: 36.1, heightMeters: 1500, distanceMeters: 22_000, headingDegrees: 20, pitchDegrees: -28 } },
    { name: 'Mount Fuji', view: { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2500, distanceMeters: 40_000, headingDegrees: -40, pitchDegrees: -20 } },
  ],
  [{ name: 'Fixture peak', view: { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 2000, distanceMeters: 60_000, headingDegrees: 30, pitchDegrees: -25 } }],
)

type Look = 'relief' | 'map'

/**
 * Colour relief and hillshade from the same Terrarium tiles the terrain is built from (`raster-dem`), or
 * OpenStreetMap with a softer hillshade on top.
 */
function terrainStyle(look: Look): object {
  const demSource = { type: 'raster-dem', tiles: [elevationTilesUrl], tileSize: 256, maxzoom: useFixtures ? 12 : 15, encoding: 'terrarium', attribution: elevationAttribution }
  const hillshade = (exaggeration: number) => ({ id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': exaggeration, 'hillshade-shadow-color': '#2b2140' } })
  if (look === 'map') {
    return {
      version: 8,
      sources: { dem: demSource, basemap: { type: 'raster', tiles: [rasterTilesUrl], tileSize: 256, maxzoom: 19, attribution: rasterAttribution } },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }, hillshade(0.35)],
    }
  }
  return {
    version: 8,
    sources: { dem: demSource },
    layers: [
            {
        id: 'relief',
        type: 'color-relief',
        source: 'dem',
        paint: {
          'color-relief-color': [
            'interpolate',
            ['linear'],
            ['elevation'],
            -6000, '#284b6e',
            -1, '#9cc3df',
            0, '#5d9a5a',
            600, '#a3c27a',
            1500, '#e3d595',
            2500, '#c09468',
            3500, '#8f7464',
            4500, '#e8e8ee',
            6500, '#ffffff',
          ],
        },
      },
      hillshade(0.6),
    ],
  }
}

/**
 * `?example=terrain`: terrain from Terrarium elevation tiles (`<RasterDemSource>`), shaded with colour relief and
 * hillshade from the same tiles, with an exaggeration slider (`<Terrain exaggeration>`).
 */
export function TerrainExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [mountain, setMountain] = useState<Place>(MOUNTAINS[0]!)
  const [look, setLook] = useState<Look>('relief')
  const [exaggeration, setExaggeration] = useState(1.5)
  const style = useMemo(() => terrainStyle(look), [look])
  return (
    <ExampleShell
      title="Terrain and relief"
      description="Elevation tiles build the terrain and shade it: colour relief by height and hillshade. Exaggerate the heights to read the landscape."
      camera={MOUNTAINS[0]!.view}
      onEarth={setEarth}
      exaggeration={exaggeration}
      terrain={<RasterDemSource url={elevationTilesUrl} encoding="terrarium" maximumZoom={useFixtures ? 12 : 15} attribution={elevationAttribution} />}
      panel={
        <>
          <div className="example-buttons">
            {MOUNTAINS.map(place => (
              <button key={place.name} type="button" aria-pressed={place === mountain} onClick={() => (setMountain(place), flyToPlace(earth, place))}>
                {place.name}
              </button>
            ))}
          </div>
          <div className="example-buttons">
            <button type="button" aria-pressed={look === 'relief'} onClick={() => setLook('relief')}>
              Colour relief
            </button>
            <button type="button" aria-pressed={look === 'map'} onClick={() => setLook('map')}>
              Map and hillshade
            </button>
          </div>
          <label className="example-field">
            Exaggeration
            <input type="range" min={1} max={3} step={0.1} value={exaggeration} onChange={event => setExaggeration(Number(event.target.value))} />
            <output>{exaggeration.toFixed(1)}×</output>
          </label>
        </>
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}
