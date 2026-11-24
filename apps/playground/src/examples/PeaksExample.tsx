import type { Earth as EarthImpl, GeoJsonSource as GeoJsonSourceImpl } from 'react-three-earth'
import { GeoJsonSource, Imagery, MapStyleSource, Popup, StyleLayer, useEarthEvent, useHoverFeatureState, useLayerCursor } from 'react-three-earth/react'
import { useMemo, useRef, useState, type RefObject } from 'react'

import { rasterBasemapStyle } from './data'
import { ExampleShell } from './ExampleShell'
import { peaks, type PeakProperties } from './peaks'

interface SelectedPeak extends PeakProperties {
  longitudeDegrees: number
  latitudeDegrees: number
}

/** Elevation colour ramp: green hills to white eight-thousanders. */
const ELEVATION_COLOR = ['interpolate', ['linear'], ['get', 'elevationMeters'], 1000, '#3aa267', 3500, '#e6b33c', 6000, '#e0603a', 8000, '#f4f1ff']

/**
 * The clicks: a cluster flies in to where it splits (`getClusterExpansionZoom`), a peak opens its popup.
 * Inside `<Earth>`: layer events come from the earth.
 */
function PeakInteractions({ source, onSelect }: { source: RefObject<GeoJsonSourceImpl | null>; onSelect: (peak: SelectedPeak) => void }) {
  useHoverFeatureState(['peak-points'])
  useLayerCursor(['peak-points', 'peak-clusters'])
  useEarthEvent(
    'click',
    event => {
      const feature = event.features[0]
      if (feature?.geometry.type !== 'Point') return
      const [longitudeDegrees, latitudeDegrees] = feature.geometry.coordinates as [number, number]
      if (feature.layer.id === 'peak-clusters') {
        void source.current?.getClusterExpansionZoom(feature.properties.cluster_id as number).then(zoom => event.target.camera.flyTo({ longitudeDegrees, latitudeDegrees, zoom: zoom + 0.5 }))
        return
      }
      onSelect({ ...(feature.properties as unknown as PeakProperties), longitudeDegrees, latitudeDegrees })
    },
    { layers: ['peak-clusters', 'peak-points'], tolerancePixels: 12 },
  )
  return null
}

/**
 * `?example=geojson`: the world's notable summits from app data (`<GeoJsonSource cluster>`) over OpenStreetMap.
 * Clusters count their peaks and keep the highest; hovering a peak highlights it through feature-state.
 */
export function PeaksExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [selected, setSelected] = useState<SelectedPeak | null>(null)
  const source = useRef<GeoJsonSourceImpl | null>(null)
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.5, 'raster-brightness-max': 0.9 }), [])
  return (
    <ExampleShell
      title="GeoJSON, clusters and popups"
      description="Sixty summits from app data, clustered by distance on screen. Tap a cluster to zoom in, tap a peak for its details. With a mouse, hovering highlights it."
      camera={{ longitudeDegrees: 60, latitudeDegrees: 25, heightMeters: 0, distanceMeters: 16_000_000, headingDegrees: 0, pitchDegrees: -90 }}
      onEarth={setEarth}
      panel={
        <div className="example-buttons">
          <button type="button" onClick={() => void earth?.camera.flyTo({ longitudeDegrees: 86.93, latitudeDegrees: 27.99, zoom: 9, pitchDegrees: -40, headingDegrees: 20 })}>
            Fly to Everest
          </button>
          <button type="button" onClick={() => void earth?.camera.flyTo({ longitudeDegrees: 60, latitudeDegrees: 25, distanceMeters: 16_000_000, pitchDegrees: -90, headingDegrees: 0 })}>
            Whole world
          </button>
        </div>
      }
    >
      <Imagery>
        <MapStyleSource style={style}>
          <GeoJsonSource id="peaks" data={peaks} cluster clusterRadiusPixels={50} clusterProperties={{ highestMeters: ['max', ['get', 'elevationMeters']] }} ref={source}>
            <StyleLayer
              id="peak-clusters"
              type="circle"
              filter={['has', 'point_count']}
              paint={{
                'circle-color': ['interpolate', ['linear'], ['get', 'highestMeters'], 3000, '#3aa267', 6000, '#e0603a', 8000, '#8f5cf6'],
                'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 14, 20, 26],
                'circle-opacity': 0.9,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
              }}
            />
            <StyleLayer id="peak-counts" type="symbol" filter={['has', 'point_count']} layout={{ 'text-field': '{point_count_abbreviated}', 'text-size': 14 }} paint={{ 'text-color': '#ffffff' }} />
            <StyleLayer
              id="peak-points"
              type="circle"
              filter={['!', ['has', 'point_count']]}
              paint={{
                'circle-color': ELEVATION_COLOR,
                'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 11, 7],
                'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffd43b', '#1d2333'],
                'circle-stroke-width': 2,
              }}
            />
            <StyleLayer
              id="peak-names"
              type="symbol"
              filter={['!', ['has', 'point_count']]}
              layout={{ 'text-field': '{name}', 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 0.9] }}
              paint={{ 'text-color': '#1d2333', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
            />
          </GeoJsonSource>
        </MapStyleSource>
      </Imagery>
      <PeakInteractions source={source} onSelect={setSelected} />
      {selected ? (
        <Popup key={selected.name} longitudeDegrees={selected.longitudeDegrees} latitudeDegrees={selected.latitudeDegrees} open onClose={() => setSelected(null)} label={selected.name} offsetPixels={10}>
          <div className="example-popup">
            <strong>{selected.name}</strong>
            {selected.elevationMeters.toLocaleString('en')} m · {selected.country}
          </div>
        </Popup>
      ) : null}
    </ExampleShell>
  )
}
