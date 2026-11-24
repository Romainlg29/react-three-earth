import { unwrapLongitudeNear } from './geometry.js'

const DEGREES = Math.PI / 180
const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137
const WGS84_FLATTENING = 1 / 298.257223563
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING)

/** A point in a local east-north-up frame, in metres. */
export type LocalPoint = [east: number, north: number, up: number]

/**
 * Converts positions to and from the east-north-up frame of an origin (x east, y north, z up, metres), on the WGS84
 * ellipsoid: the frame of a `GeographicAnchor` at that origin. Exact on the globe, both ways. On the flat map the anchor
 * keeps this curved geometry, so solids hundreds of kilometres wide droop at their edges there.
 */
export class LocalFrame {
  protected readonly origin: [number, number, number]
  protected readonly east: [number, number, number]
  protected readonly north: [number, number, number]
  protected readonly up: [number, number, number]
  readonly longitudeDegrees: number

  constructor(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number) {
    this.longitudeDegrees = longitudeDegrees
    const longitude = longitudeDegrees * DEGREES
    const latitude = latitudeDegrees * DEGREES
    this.origin = earthCentered(longitude, latitude, heightMeters)
    const sinLongitude = Math.sin(longitude)
    const cosLongitude = Math.cos(longitude)
    const sinLatitude = Math.sin(latitude)
    const cosLatitude = Math.cos(latitude)
    this.east = [-sinLongitude, cosLongitude, 0]
    this.north = [-sinLatitude * cosLongitude, -sinLatitude * sinLongitude, cosLatitude]
    this.up = [cosLatitude * cosLongitude, cosLatitude * sinLongitude, sinLatitude]
  }

  /** A position (degrees, metres above the ellipsoid) in the frame. */
  toLocal(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number): LocalPoint {
    const longitude = unwrapLongitudeNear(longitudeDegrees, this.longitudeDegrees) * DEGREES
    const point = earthCentered(longitude, latitudeDegrees * DEGREES, heightMeters)
    const dx = point[0] - this.origin[0]
    const dy = point[1] - this.origin[1]
    const dz = point[2] - this.origin[2]
    const { east, north, up } = this
    return [dx * east[0] + dy * east[1] + dz * east[2], dx * north[0] + dy * north[1] + dz * north[2], dx * up[0] + dy * up[1] + dz * up[2]]
  }

  /**
   * The position of a point of the frame: longitude and latitude in degrees (the longitude within 180° of the
   * origin's), height in metres above the ellipsoid.
   */
  toGeographic(east: number, north: number, up: number): [longitudeDegrees: number, latitudeDegrees: number, heightMeters: number] {
    const x = this.origin[0] + east * this.east[0] + north * this.north[0] + up * this.up[0]
    const y = this.origin[1] + east * this.east[1] + north * this.north[1] + up * this.up[1]
    const z = this.origin[2] + east * this.east[2] + north * this.north[2] + up * this.up[2]
    const [longitude, latitude, height] = geodetic(x, y, z)
    return [unwrapLongitudeNear(longitude / DEGREES, this.longitudeDegrees), latitude / DEGREES, height]
  }
}

function earthCentered(longitude: number, latitude: number, heightMeters: number): [number, number, number] {
  const sinLatitude = Math.sin(latitude)
  const radius = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  const cosLatitude = Math.cos(latitude)
  return [(radius + heightMeters) * cosLatitude * Math.cos(longitude), (radius + heightMeters) * cosLatitude * Math.sin(longitude), (radius * (1 - WGS84_ECCENTRICITY_SQUARED) + heightMeters) * sinLatitude]
}

/** Longitude, latitude (radians) and height of an earth-centred point, by fixed-point iteration (sub-millimetre in 4 steps). */
function geodetic(x: number, y: number, z: number): [number, number, number] {
  const longitude = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  let latitude = Math.atan2(z, p * (1 - WGS84_ECCENTRICITY_SQUARED))
  let height = 0
  for (let iteration = 0; iteration < 6; iteration++) {
    const sinLatitude = Math.sin(latitude)
    const radius = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
    // Stable at the poles too, unlike p / cos(latitude).
    height = p * Math.cos(latitude) + (z + WGS84_ECCENTRICITY_SQUARED * radius * sinLatitude) * sinLatitude - radius
    latitude = Math.atan2(z, p * (1 - (WGS84_ECCENTRICITY_SQUARED * radius) / (radius + height)))
  }
  return [longitude, latitude, height]
}
