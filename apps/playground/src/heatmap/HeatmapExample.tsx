import type { Feature, FeatureCollection } from 'geojson'
import { GeoJsonSource, StyleLayer } from 'react-three-earth/react'

/** A z8 tile column edge (227 / 256 of the way round), so an edge of every finer tile and region too: the quake cloud straddles it. */
export const HEATMAP_TILE_EDGE_LONGITUDE = (227 / 256) * 360 - 180

/** A deterministic pseudo-random sequence (no Math.random: the browser check compares screenshots). */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

/** Points in a Gaussian cloud. */
function cloud(centerLongitude: number, centerLatitude: number, count: number, spreadDegrees: number, seed: number): FeatureCollection {
  const random = sequence(seed)
  const features: Feature[] = []
  for (let index = 0; index < count; index++) {
    // Box–Muller
    const radius = Math.sqrt(-2 * Math.log(1 - random())) * spreadDegrees
    const angle = 2 * Math.PI * random()
    const magnitude = 1 + Math.floor(random() * 5)
    features.push({ type: 'Feature', properties: { magnitude }, geometry: { type: 'Point', coordinates: [centerLongitude + radius * Math.cos(angle), centerLatitude + radius * Math.sin(angle)] } })
  }
  return { type: 'FeatureCollection', features }
}

// Mostly west of the edge: a tile drawing only its own points would cut the heat off along it.
const quakes = cloud(HEATMAP_TILE_EDGE_LONGITUDE - 0.03, 35.3, 300, 0.035, 7)
const sensors = cloud(139.05, 35.45, 40, 0.015, 11)

/**
 * `?heatmap` (with `?fixtures&map=vector`): two heatmap layers from GeoJSON points. Quakes in MapLibre's default ramp,
 * weighted by magnitude and straddling tile edges; sensors in a magenta ramp of their own, half transparent.
 */
export function HeatmapExample() {
  return (
    <>
      <GeoJsonSource id="quakes" data={quakes}>
        <StyleLayer
          id="quake-heat"
          type="heatmap"
          paint={{
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'magnitude'], 1, 0.2, 5, 1],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 40],
            'heatmap-intensity': 0.8,
          }}
        />
      </GeoJsonSource>
      <GeoJsonSource id="sensors" data={sensors}>
        <StyleLayer
          id="sensor-heat"
          type="heatmap"
          paint={{
            'heatmap-radius': 25,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255, 0, 255, 0)', 0.2, 'rgba(255, 0, 255, 0.6)', 1, '#ff00ff'],
            'heatmap-opacity': 0.8,
          }}
        />
      </GeoJsonSource>
    </>
  )
}
