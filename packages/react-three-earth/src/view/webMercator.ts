/**
 * Web Mercator (EPSG:3857) and WGS84 helpers for the flat map, in double precision.
 *
 * The flat map uses spherical Web Mercator on geodetic latitudes, the projection XYZ raster servers use, so
 * a tile of OpenStreetMap is a square on the map. Heights are scaled by the projection's local scale
 * factor, `1 / cos(latitude)`, like horizontal distances: the map is conformal in three dimensions and
 * mountains keep their shape at every latitude.
 */

/** Radius of the Web Mercator sphere: WGS84's semi-major axis. */
export const WEB_MERCATOR_RADIUS_METERS = 6_378_137

/** The latitude where the Web Mercator square ends, about 85.0511°. */
export const WEB_MERCATOR_MAX_LATITUDE_RADIANS = 2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2

/** Half the width of the Web Mercator square: about 20,037 km. */
export const WEB_MERCATOR_HALF_EXTENT_METERS = Math.PI * WEB_MERCATOR_RADIUS_METERS

const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137
const WGS84_FLATTENING = 1 / 298.257223563
const WGS84_SEMI_MINOR_AXIS_METERS = WGS84_SEMI_MAJOR_AXIS_METERS * (1 - WGS84_FLATTENING)
const WGS84_FIRST_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING)
const WGS84_SECOND_ECCENTRICITY_SQUARED = WGS84_FIRST_ECCENTRICITY_SQUARED / (1 - WGS84_FIRST_ECCENTRICITY_SQUARED)

/** A geodetic position: longitude and latitude in radians, height above the WGS84 ellipsoid in metres. */
export interface GeodeticRadians {
  longitude: number
  latitude: number
  heightMeters: number
}

export function clampLatitudeToWebMercator(latitudeRadians: number): number {
  return Math.min(Math.max(latitudeRadians, -WEB_MERCATOR_MAX_LATITUDE_RADIANS), WEB_MERCATOR_MAX_LATITUDE_RADIANS)
}

/** Web Mercator y in metres. Latitudes beyond about ±85.05° are clamped to the edge of the square. */
export function latitudeToMercatorY(latitudeRadians: number): number {
  const latitude = clampLatitudeToWebMercator(latitudeRadians)
  return WEB_MERCATOR_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + latitude / 2))
}

export function mercatorYToLatitude(yMeters: number): number {
  return 2 * Math.atan(Math.exp(yMeters / WEB_MERCATOR_RADIUS_METERS)) - Math.PI / 2
}

export function longitudeToMercatorX(longitudeRadians: number): number {
  return WEB_MERCATOR_RADIUS_METERS * longitudeRadians
}

export function mercatorXToLongitude(xMeters: number): number {
  return xMeters / WEB_MERCATOR_RADIUS_METERS
}

/**
 * How much Web Mercator enlarges lengths at a latitude: `1 / cos(latitude)`, clamped at the edge of the
 * square.
 */
export function mercatorScaleFactor(latitudeRadians: number): number {
  return 1 / Math.cos(clampLatitudeToWebMercator(latitudeRadians))
}

/**
 * ECEF metres to geodetic coordinates on WGS84, with Bowring's closed form (one iteration): within 0.1 mm
 * up to 100 km of height, 1.5 mm at 400 km and 25 cm at 20,000 km, and several times faster than an
 * iterative solver, which matters when every vertex of every terrain tile is converted.
 */
export function ecefToGeodetic(x: number, y: number, z: number, target: GeodeticRadians): GeodeticRadians {
  const a = WGS84_SEMI_MAJOR_AXIS_METERS
  const b = WGS84_SEMI_MINOR_AXIS_METERS
  const p = Math.hypot(x, y)
  const longitude = Math.atan2(y, x)
  if (p < 1e-9) {
    target.longitude = 0
    target.latitude = z >= 0 ? Math.PI / 2 : -Math.PI / 2
    target.heightMeters = Math.abs(z) - b
    return target
  }
  const theta = Math.atan2(z * a, p * b)
  const sinTheta = Math.sin(theta)
  const cosTheta = Math.cos(theta)
  const latitude = Math.atan2(
    z + WGS84_SECOND_ECCENTRICITY_SQUARED * b * sinTheta * sinTheta * sinTheta,
    p - WGS84_FIRST_ECCENTRICITY_SQUARED * a * cosTheta * cosTheta * cosTheta,
  )
  const sinLatitude = Math.sin(latitude)
  const cosLatitude = Math.cos(latitude)
  const primeVerticalRadius = a / Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  // Away from the poles divide by cos; near them by sin, which stays well conditioned.
  const height =
    Math.abs(cosLatitude) > 1e-3
      ? p / cosLatitude - primeVerticalRadius
      : z / sinLatitude - primeVerticalRadius * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED)
  target.longitude = longitude
  target.latitude = latitude
  target.heightMeters = height
  return target
}

/** Brings a longitude within half a turn of a reference longitude, so a tile never straddles ±180° on the map. */
export function unwrapLongitude(longitudeRadians: number, referenceRadians: number): number {
  let longitude = longitudeRadians
  while (longitude - referenceRadians > Math.PI) longitude -= 2 * Math.PI
  while (longitude - referenceRadians < -Math.PI) longitude += 2 * Math.PI
  return longitude
}

const WEB_MERCATOR_WORLD_WIDTH_METERS = 2 * WEB_MERCATOR_HALF_EXTENT_METERS

/** Shifts a Web Mercator x by whole world widths to within half a world of a reference x. */
export function wrapMercatorXNear(xMeters: number, referenceXMeters: number): number {
  return xMeters - Math.round((xMeters - referenceXMeters) / WEB_MERCATOR_WORLD_WIDTH_METERS) * WEB_MERCATOR_WORLD_WIDTH_METERS
}
