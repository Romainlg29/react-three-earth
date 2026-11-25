import type { Earth as EarthImpl } from '@earthkit/globe'
import { Imagery, MapStyleSource } from '@earthkit/globe/react'
import { useMemo, useState } from 'react'

import { vectorSchema } from './data'
import { ExampleShell } from './ExampleShell'
import { FIXTURE_PEAK, flyToPlace, placesFor, type Place } from './places'

const CITIES = placesFor(
  [
    { name: 'New York', view: { longitudeDegrees: -74.0115, latitudeDegrees: 40.7075, heightMeters: 10, distanceMeters: 2400, headingDegrees: 25, pitchDegrees: -28 } },
    { name: 'Hong Kong', view: { longitudeDegrees: 114.1615, latitudeDegrees: 22.2835, heightMeters: 20, distanceMeters: 3200, headingDegrees: 165, pitchDegrees: -22 } },
    { name: 'Tokyo', view: { longitudeDegrees: 139.6935, latitudeDegrees: 35.6905, heightMeters: 40, distanceMeters: 2600, headingDegrees: -35, pitchDegrees: -32 } },
    { name: 'Chicago', view: { longitudeDegrees: -87.627, latitudeDegrees: 41.8815, heightMeters: 180, distanceMeters: 2600, headingDegrees: -70, pitchDegrees: -28 } },
  ],
  [FIXTURE_PEAK],
)

/**
 * A light map with buildings standing in 3D (`fill-extrusion`), tinted from warm stone to blue glass with their
 * height. Built from the OpenMapTiles `building` layer: `render_height` and `render_min_height`.
 */
function cityStyle(): object {
  const { source, water, roads, majorRoadClasses, buildings, buildingHeight, buildingBase } = vectorSchema
  return {
    version: 8,
    sources: { map: source },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ece7de' } },
      { id: 'water', type: 'fill', source: 'map', 'source-layer': water, paint: { 'fill-color': '#9fc4e4' } },
      {
        id: 'roads',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], majorRoadClasses, '#f6cf7e', '#ffffff'],
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.5, 18, 22],
        },
      },
      {
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'map',
        'source-layer': buildings,
        minzoom: 13,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], buildingHeight, 0, '#e3dacb', 40, '#d2c1a6', 120, '#9fb0c8', 300, '#5f83bb'],
          'fill-extrusion-height': buildingHeight,
          'fill-extrusion-base': buildingBase,
          'fill-extrusion-opacity': 0.95,
        },
      },
    ],
  }
}

/** `?example=city`: 3D buildings in four skylines, flown between with `earth.camera.flyTo`. */
export function CityExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [city, setCity] = useState<Place>(CITIES[0]!)
  const style = useMemo(cityStyle, [])
  return (
    <ExampleShell
      title="3D buildings"
      description="Buildings from OpenStreetMap stand on the terrain, lit by the sun, tinted by height. Drag to orbit, pinch or scroll to zoom."
      camera={CITIES[0]!.view}
      onEarth={setEarth}
      panel={
        CITIES.length > 1 ? (
          <div className="example-buttons">
            {CITIES.map(place => (
              <button key={place.name} type="button" aria-pressed={place === city} onClick={() => (setCity(place), flyToPlace(earth, place))}>
                {place.name}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}
