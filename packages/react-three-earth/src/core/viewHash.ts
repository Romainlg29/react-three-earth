import type { MapView, MapViewChange } from './EarthCamera.js'

/**
 * The view as a URL hash, in MapLibre's format: `#zoom/latitude/longitude/bearing/pitch`, so links open the
 * same view in MapLibre and here. Bearing is the heading; pitch is MapLibre's (0 looks straight down, so
 * `pitchDegrees + 90`). Bearing and pitch are left out when both are 0, pitch alone when it is 0.
 * @example earth.addEventListener('moveend', () => history.replaceState(null, '', formatViewHash(earth.camera.getView())))
 */
export function formatViewHash(view: Pick<MapView, 'zoom' | 'latitudeDegrees' | 'longitudeDegrees' | 'headingDegrees' | 'pitchDegrees'>): string {
  // Precision as MapLibre: enough decimals for a pixel at this zoom.
  const decimals = Math.ceil((view.zoom * Math.LN2 + Math.log(512 / 360 / 0.5)) / Math.LN10)
  const round = (value: number, places: number) => {
    const factor = 10 ** Math.max(0, places)
    return String(Math.round(value * factor) / factor)
  }
  const bearing = Math.round(view.headingDegrees * 10) / 10
  const pitch = Math.round((view.pitchDegrees + 90) * 10) / 10
  let hash = `#${round(view.zoom, 2)}/${round(view.latitudeDegrees, decimals)}/${round(view.longitudeDegrees, decimals)}`
  if (bearing !== 0 || pitch !== 0) hash += `/${bearing === 0 ? 0 : bearing}`
  if (pitch !== 0) hash += `/${pitch}`
  return hash
}

/**
 * Reads a hash written by `formatViewHash` (or MapLibre's `hash` option) back into a view for `jumpTo` or
 * `<Earth initialView>`. Null when it is not one.
 * @example const initialView = parseViewHash(location.hash) ?? { longitudeDegrees: 0, latitudeDegrees: 20, zoom: 2 }
 */
export function parseViewHash(hash: string): MapViewChange | null {
  const parts = hash.replace(/^#/, '').split('/')
  if (parts.length < 3 || parts.length > 5) return null
  const numbers = parts.map(Number)
  if (numbers.some(value => !Number.isFinite(value))) return null
  const [zoom, latitudeDegrees, longitudeDegrees, bearing = 0, pitch = 0] = numbers as [number, number, number, number?, number?]
  if (Math.abs(latitudeDegrees) > 90) return null
  return { zoom, latitudeDegrees, longitudeDegrees, headingDegrees: bearing, pitchDegrees: pitch - 90 }
}
