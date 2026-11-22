import type { Camera, PerspectiveCamera } from 'three'

import { WEB_MERCATOR_RADIUS_METERS } from '../view/webMercator.js'

/**
 * Zoom levels as MapLibre GL JS counts them: at zoom `z` the Web Mercator world is `512 × 2^z` pixels
 * wide, so one Web Mercator metre spans `512 × 2^z / (2π × 6,378,137)` pixels. Zoom is continuous, and
 * on the ground a pixel covers that many metres times `cos(latitude)`.
 */
export const MAP_TILE_SIZE_PIXELS = 512

const EQUATOR_LENGTH_METERS = 2 * Math.PI * WEB_MERCATOR_RADIUS_METERS

/** Web Mercator metres per pixel at a zoom level. */
export function zoomToMercatorMetersPerPixel(zoom: number): number {
  return EQUATOR_LENGTH_METERS / (MAP_TILE_SIZE_PIXELS * 2 ** zoom)
}

/** The zoom level at which a pixel spans this many Web Mercator metres. */
export function mercatorMetersPerPixelToZoom(metersPerPixel: number): number {
  return Math.log2(EQUATOR_LENGTH_METERS / (MAP_TILE_SIZE_PIXELS * metersPerPixel))
}

/** Ground metres per pixel at a zoom level and latitude. */
export function zoomToGroundMetersPerPixel(zoom: number, latitudeDegrees: number): number {
  return zoomToMercatorMetersPerPixel(zoom) * Math.cos((latitudeDegrees * Math.PI) / 180)
}

/** The zoom level at which a pixel spans this many ground metres at this latitude. */
export function groundMetersPerPixelToZoom(metersPerPixel: number, latitudeDegrees: number): number {
  return mercatorMetersPerPixelToZoom(metersPerPixel / Math.cos((latitudeDegrees * Math.PI) / 180))
}

/**
 * Distance, in pixels, from a perspective camera to the screen plane where one pixel is one unit: the
 * camera's focal length for a viewport this many CSS pixels high. A point `d` metres from the camera, on
 * its axis, sees `d / focalLength` metres per pixel.
 */
export function focalLengthPixels(camera: Camera, viewportHeightPixels: number): number {
  if (!(camera as PerspectiveCamera).isPerspectiveCamera) {
    throw new Error('react-three-earth: zoom needs a PerspectiveCamera (the <Canvas> default); orthographic cameras are not supported yet.')
  }
  const fieldOfViewRadians = ((camera as PerspectiveCamera).getEffectiveFOV() * Math.PI) / 180
  return viewportHeightPixels / 2 / Math.tan(fieldOfViewRadians / 2)
}
