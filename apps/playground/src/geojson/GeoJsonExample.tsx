import type { Feature, FeatureCollection } from 'geojson'
import type { GeoJsonSource as GeoJsonSourceImpl } from 'react-three-earth'
import { GeoJsonSource, StyleLayer } from 'react-three-earth/react'
import { useState } from 'react'

declare global {
  interface Window {
    /** The `?geojson` example's sources, for the browser check (`setData`, `updateData`, cluster queries). */
    geoJsonSources?: Record<string, GeoJsonSourceImpl | null>
    /** Moves the magenta area east by `longitudeDegrees` through a new `data` prop (React state). */
    moveGeoJsonArea?: (longitudeDegrees: number) => void
  }
}

/** A magenta area west of Mount Fuji, `offset` degrees east of its start. */
function area(offsetDegrees: number): FeatureCollection {
  const [west, south, east, north] = [138.58 + offsetDegrees, 35.29, 138.66 + offsetDegrees, 35.35]
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'area', properties: { name: 'Area' }, geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } }],
  }
}

/** A route across the map, coloured red to cyan along its length (`line-gradient`). */
const route: FeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', id: 'route', properties: {}, geometry: { type: 'LineString', coordinates: [[138.5, 35.22], [138.75, 35.45], [139.0, 35.58]] } }],
}

/** Twelve stations close together south-east of Fuji (one cluster), and three far apart (single points). */
const stations: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: 12 }, (_, index): Feature => ({
      type: 'Feature',
      id: index + 1,
      properties: { seats: 10 },
      geometry: { type: 'Point', coordinates: [138.92 + (index % 4) * 0.004, 35.24 + Math.floor(index / 4) * 0.004] },
    })),
    { type: 'Feature', id: 13, properties: { seats: 4 }, geometry: { type: 'Point', coordinates: [138.52, 35.5] } },
    { type: 'Feature', id: 14, properties: { seats: 4 }, geometry: { type: 'Point', coordinates: [138.98, 35.45] } },
    { type: 'Feature', id: 15, properties: { seats: 4 }, geometry: { type: 'Point', coordinates: [138.6, 35.15] } },
  ],
}

/**
 * `?geojson` (with `?fixtures&map=vector`): app data drawn by the fixture style. A magenta area (its `data` prop moves
 * it), a route with a red-to-cyan `line-gradient` (`lineMetrics`), and clustered stations: green circles labelled with
 * `point_count`, the lone stations as small dark circles.
 */
export function GeoJsonExample() {
  const [offsetDegrees, setOffsetDegrees] = useState(0)
  const sources = (window.geoJsonSources ??= {})
  window.moveGeoJsonArea = setOffsetDegrees
  const [areaData] = useState(() => new Map<number, FeatureCollection>())
  if (!areaData.has(offsetDegrees)) areaData.set(offsetDegrees, area(offsetDegrees)) // memoised: one object per position
  return (
    <>
      <GeoJsonSource id="area" data={areaData.get(offsetDegrees)!} ref={source => void (sources.area = source)}>
        <StyleLayer id="area-fill" type="fill" paint={{ 'fill-color': '#d020d0', 'fill-opacity': 0.85 }} />
      </GeoJsonSource>
      <GeoJsonSource id="route" data={route} lineMetrics ref={source => void (sources.route = source)}>
        <StyleLayer
          id="route-line"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-width': 8, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#00e0ff'] }}
        />
      </GeoJsonSource>
      <GeoJsonSource id="stations" data={stations} cluster clusterRadiusPixels={40} clusterProperties={{ seats: ['+', ['get', 'seats']] }} ref={source => void (sources.stations = source)}>
        <StyleLayer id="station-clusters" type="circle" filter={['has', 'point_count']} paint={{ 'circle-color': '#20c040', 'circle-radius': 16, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }} />
        <StyleLayer id="station-counts" type="symbol" filter={['has', 'point_count']} layout={{ 'text-field': '{point_count_abbreviated}', 'text-size': 14 }} paint={{ 'text-color': '#ffffff' }} />
        <StyleLayer id="station-points" type="circle" filter={['!', ['has', 'point_count']]} paint={{ 'circle-color': '#202040', 'circle-radius': 5 }} />
      </GeoJsonSource>
    </>
  )
}
