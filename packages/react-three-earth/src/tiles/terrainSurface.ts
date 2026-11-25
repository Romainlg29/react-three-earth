import { atan, attribute, float, max, PI, sqrt, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Name of the vertex attribute holding what terrain shading reads of the ground under each vertex: its elevation (metres
 * above the ellipsoid, as loaded, not exaggerated) in x, and its normal's east and north components (in the local
 * east-north-up frame) in y and z. The up component is left out: terrain normals never point down, so it is
 * `sqrt(1 - east² - north²)`. `FlatMapPlugin` writes it on every terrain tile mesh.
 */
export const TERRAIN_SURFACE_ATTRIBUTE = 'terrainSurface'

/**
 * Name of an optional vertex attribute holding each vertex's true elevation, metres, where the drawn ground differs (a
 * seafloor drawn at sea level, `RasterDemSource.flattenBelowSeaLevel`). `FlatMapPlugin` reads it into
 * `TERRAIN_SURFACE_ATTRIBUTE` instead of the drawn height.
 */
export const TERRAIN_ELEVATION_ATTRIBUTE = 'terrainElevation'

const surface = attribute(TERRAIN_SURFACE_ATTRIBUTE, 'vec3')

/** The tile's elevation at the fragment, in metres above the WGS84 ellipsoid, as loaded (the terrain's exaggeration does not scale it). */
export const terrainElevationMeters: Node<'float'> = surface.x as unknown as Node<'float'>

const east = surface.y
const north = surface.z
/** Interpolated between vertices, so it can fall short of unit length: renormalised. */
const up = sqrt(max(float(1).sub(east.mul(east)).sub(north.mul(north)), 0))
/**
 * The ground's normal at the fragment in its local east-north-up frame (x east, y north, z up), from the terrain
 * source's normals (smooth per vertex), unit length. Use it for custom terrain shading that depends on the ground's
 * orientation rather than on the light.
 */
export const terrainNormalEastNorthUp: Node<'vec3'> = vec3(east, north, up).normalize() as unknown as Node<'vec3'>

const horizontal = terrainNormalEastNorthUp.xy.length()
/** The ground's slope at the fragment: 0 flat, π/2 vertical. From the terrain as loaded, not exaggerated. */
export const terrainSlopeRadians: Node<'float'> = atan(horizontal, terrainNormalEastNorthUp.z) as unknown as Node<'float'>
/** The ground's slope at the fragment, in degrees: 0 flat, 90 vertical. */
export const terrainSlopeDegrees: Node<'float'> = terrainSlopeRadians.mul(180 / Math.PI) as unknown as Node<'float'>
/** The ground's slope at the fragment as a grade: 100 rises one metre per metre (45°). Grows without bound towards vertical. */
export const terrainSlopePercent: Node<'float'> = horizontal.div(max(terrainNormalEastNorthUp.z, 1e-6)).mul(100) as unknown as Node<'float'>

/**
 * The compass direction the ground faces at the fragment (its downhill direction), clockwise from north: 0 north,
 * π/2 east, π south, 3π/2 west. 0 on flat ground, where it has no meaning: weigh it by the slope.
 */
export const terrainAspectRadians: Node<'float'> = (() => {
  const angle = atan(terrainNormalEastNorthUp.x, terrainNormalEastNorthUp.y)
  // atan2 gives (-π, π]: west-facing ground comes out negative.
  return angle.add(angle.lessThan(0).select(PI.mul(2), float(0)))
})() as unknown as Node<'float'>
/** The compass direction the ground faces at the fragment, in degrees clockwise from north (0 to 360). 0 on flat ground. */
export const terrainAspectDegrees: Node<'float'> = terrainAspectRadians.mul(180 / Math.PI) as unknown as Node<'float'>

/**
 * Writes one vertex of `TERRAIN_SURFACE_ATTRIBUTE` into `target` at `index`: the elevation, and the normal (`normalX`…,
 * in ECEF, any length) projected on the east and north axes at the vertex's geodetic position. A zero normal (a mesh
 * without normals) is taken as flat ground.
 */
export function writeTerrainSurface(
  target: Float32Array,
  index: number,
  longitudeRadians: number,
  latitudeRadians: number,
  heightMeters: number,
  normalX: number,
  normalY: number,
  normalZ: number,
): void {
  const length = Math.hypot(normalX, normalY, normalZ)
  target[index * 3] = heightMeters
  if (length === 0) {
    target[index * 3 + 1] = 0
    target[index * 3 + 2] = 0
    return
  }
  const sinLongitude = Math.sin(longitudeRadians)
  const cosLongitude = Math.cos(longitudeRadians)
  const sinLatitude = Math.sin(latitudeRadians)
  const cosLatitude = Math.cos(latitudeRadians)
  // East (-sin λ, cos λ, 0), north (-sin φ cos λ, -sin φ sin λ, cos φ).
  target[index * 3 + 1] = (-sinLongitude * normalX + cosLongitude * normalY) / length
  target[index * 3 + 2] = (-sinLatitude * cosLongitude * normalX - sinLatitude * sinLongitude * normalY + cosLatitude * normalZ) / length
}
