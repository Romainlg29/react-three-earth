import { GeoJsonSource, Imagery, MapStyleSource, StyleLayer } from '@earthkit/globe/react'
import { useMemo, useState } from 'react'

import { rasterBasemapStyle } from './data'
import { ExampleShell } from './ExampleShell'
import { cities } from './cities'

/** Ramps from transparent through deep blue and magenta to a white-hot core. */
const RAMPS = {
  ember: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(20, 0, 60, 0)', 0.15, '#3b1c8c', 0.4, '#c2257a', 0.7, '#ff7a2f', 1, '#fff3c4'],
  ice: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0, 30, 60, 0)', 0.2, '#0b4f8a', 0.5, '#1fa2c4', 0.8, '#8ef0e0', 1, '#ffffff'],
}

/**
 * `?example=heatmap`: the world's largest urban areas as a heatmap weighted by population, on a darkened
 * OpenStreetMap; the heat turns into circles sized by population as you zoom in.
 */
export function HeatmapExample() {
  const [ramp, setRamp] = useState<keyof typeof RAMPS>('ember')
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -1, 'raster-brightness-max': 0.35, 'raster-contrast': 0.1 }), [])
  return (
    <ExampleShell
      title="Heatmap"
      description="Nearly 90 of the largest urban areas, weighted by population. The heat stays smooth across tile edges and turns into circles as you zoom in."
      camera={{ longitudeDegrees: 80, latitudeDegrees: 25, heightMeters: 0, distanceMeters: 14_000_000, headingDegrees: 0, pitchDegrees: -90 }}
      panel={
        <div className="example-buttons">
          {(Object.keys(RAMPS) as Array<keyof typeof RAMPS>).map(name => (
            <button key={name} type="button" aria-pressed={name === ramp} onClick={() => setRamp(name)}>
              {name === 'ember' ? 'Ember ramp' : 'Ice ramp'}
            </button>
          ))}
        </div>
      }
    >
      <Imagery>
        <MapStyleSource style={style}>
          <GeoJsonSource id="cities" data={cities}>
            <StyleLayer
              id="city-heat"
              type="heatmap"
              maximumZoom={7}
              paint={{
                'heatmap-weight': ['interpolate', ['linear'], ['get', 'populationMillions'], 1, 0.1, 37, 1],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 4, 40, 8, 80],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 2.5],
                'heatmap-color': RAMPS[ramp],
                'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 7, 0],
              }}
            />
            <StyleLayer
              id="city-circles"
              type="circle"
              minimumZoom={5}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['get', 'populationMillions'], 1, 6, 37, 30],
                'circle-color': ramp === 'ember' ? '#ff7a2f' : '#1fa2c4',
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 7, 0.85],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1,
              }}
            />
            <StyleLayer
              id="city-names"
              type="symbol"
              minimumZoom={6}
              layout={{ 'text-field': ['concat', ['get', 'name'], '\n', ['to-string', ['get', 'populationMillions']], ' M'], 'text-size': 13 }}
              paint={{ 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.8)', 'text-halo-width': 1.5 }}
            />
          </GeoJsonSource>
        </MapStyleSource>
      </Imagery>
    </ExampleShell>
  )
}
