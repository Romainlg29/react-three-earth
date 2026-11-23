import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Frustum, Matrix4, Sphere, Vector3, Vector4, type Camera } from 'three'

import type { ViewMorph } from '../view/ViewMorph.js'
import { longitudeToMercatorX, wrapMercatorXNear } from '../view/webMercator.js'

/** A Web Mercator tile (XYZ, y down from the north). */
export interface PyramidTile {
  x: number
  y: number
  z: number
}

export interface CameraTilePyramidInput {
  camera: Camera
  widthPixels: number
  heightPixels: number
  /**
   * Scene position of a point on the surface (height 0), on the globe or the flat map. Writes `target`. On the flat
   * map, place every point of a tile on the world copy of `tileCenterLongitudeRadians`, so a tile never spans two copies.
   */
  toScenePosition: (longitudeRadians: number, latitudeRadians: number, target: Vector3, tileCenterLongitudeRadians: number) => Vector3
  /**
   * On the globe, the part of the Earth the camera can see: a cap around the point under the camera, out to the
   * horizon (`horizonCap`). Null on the flat map, where tile bounds also lose the Earth's bulge.
   */
  visibleCap: VisibleCap | null
  /** Height of the camera above the ground, in scene metres: no tile is nearer than this. */
  cameraHeightMeters: number
  /** Deepest tile zoom. */
  maximumZoom: number
  /** Most tiles returned; past it, tiles stop splitting. Default: 128. */
  maximumTiles?: number
  /**
   * A tile splits when its half-edge spans more than this on the screen, in CSS pixels. Default: 512, as MapLibre:
   * a 512-pixel tile of zoom z is drawn while the camera's zoom is between z and z + 1.
   */
  splitPixels?: number
}

/** The ground seen from a camera above the globe: every point within `angleRadians` (along the surface) of the point below it. */
export interface VisibleCap {
  longitudeRadians: number
  latitudeRadians: number
  angleRadians: number
}

/**
 * The cap of the globe a camera at this ECEF position can see, out to the horizon and a little past it, where
 * mountains still rise above it.
 */
export function horizonCap(cameraPosition: Vector3): VisibleCap {
  const distance = cameraPosition.length()
  const heightMeters = Math.max(1, distance - EARTH_RADIUS_METERS)
  const toHorizon = Math.acos(EARTH_RADIUS_METERS / (EARTH_RADIUS_METERS + heightMeters))
  const pastHorizon = Math.acos(EARTH_RADIUS_METERS / (EARTH_RADIUS_METERS + MAXIMUM_TERRAIN_HEIGHT_METERS))
  return {
    longitudeRadians: Math.atan2(cameraPosition.y, cameraPosition.x),
    latitudeRadians: Math.asin(Math.max(-1, Math.min(1, cameraPosition.z / Math.max(distance, 1)))),
    // Geocentric rather than geodetic latitude and a spherical Earth: a degree of slack covers the difference.
    angleRadians: Math.min(Math.PI, toHorizon + pastHorizon + Math.PI / 180),
  }
}

/** Angle along a sphere between two points, in radians (haversine). */
function angleBetween(longitudeA: number, latitudeA: number, longitudeB: number, latitudeB: number): number {
  const sinLatitude = Math.sin((latitudeB - latitudeA) / 2)
  const sinLongitude = Math.sin((longitudeB - longitudeA) / 2)
  const h = sinLatitude * sinLatitude + Math.cos(latitudeA) * Math.cos(latitudeB) * sinLongitude * sinLongitude
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** True when no point of the tile lies in the cap: the tile is behind the horizon. */
function isOutsideCap(cap: VisibleCap, west: number, south: number, east: number, north: number): boolean {
  // The tile's point nearest the cap's centre: its longitude and latitude clamped into the tile.
  const eastOfWest = (((cap.longitudeRadians - west) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const inside = eastOfWest <= east - west
  if (inside) return angleBetween(cap.longitudeRadians, cap.latitudeRadians, cap.longitudeRadians, Math.min(north, Math.max(south, cap.latitudeRadians))) > cap.angleRadians
  // Outside its longitudes: the nearest point lies on one of its two meridian edges, where the great circle from the
  // centre meets the meridian at a right angle (clamped to the tile's latitudes).
  let nearest = Infinity
  for (const edge of [west, east]) {
    const difference = wrapAngle(cap.longitudeRadians - edge)
    const cosine = Math.cos(difference)
    const foot = cosine > 1e-9 ? Math.atan(Math.tan(cap.latitudeRadians) / cosine) : cap.latitudeRadians >= 0 ? Math.PI / 2 : -Math.PI / 2
    const latitude = Math.min(north, Math.max(south, foot))
    nearest = Math.min(nearest, angleBetween(cap.longitudeRadians, cap.latitudeRadians, edge, latitude))
  }
  return nearest > cap.angleRadians
}

function wrapAngle(radians: number): number {
  return radians - 2 * Math.PI * Math.round(radians / (2 * Math.PI))
}

/** Terrain can rise this far above the ellipsoid: tile bounds include it. */
const MAXIMUM_TERRAIN_HEIGHT_METERS = 9000
const EARTH_RADIUS_METERS = 6_378_137
/** Below this zoom tiles are too large for nine samples to bound them: they always split. */
const ALWAYS_SPLIT_BELOW_ZOOM = 2
const SAMPLES_PER_SIDE = 3

const frustum = new Frustum()
const viewProjection = new Matrix4()
const sphere = new Sphere()
const clip = new Vector4()
const cameraPosition = new Vector3()
const samples = Array.from({ length: SAMPLES_PER_SIDE * SAMPLES_PER_SIDE }, () => new Vector3())
const screen = Array.from({ length: SAMPLES_PER_SIDE * SAMPLES_PER_SIDE }, () => ({ x: 0, y: 0 }))

/** Latitude of a Web Mercator row edge (`row` from 0 at the north to 2^z at the south), in radians. */
export function tileRowToLatitude(row: number, z: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / 2 ** z)))
}

/**
 * The tiles symbols are laid out from, chosen from the camera rather than from terrain regions (whose levels vary
 * across the screen and would repeat or drop labels at their seams). Like MapLibre's source cache: one zoom per area
 * of the screen, deeper where the ground is close. A quadtree descends from zoom 0, dropping tiles outside the view
 * or behind the horizon, and splits a tile while it covers more than `splitPixels` per half-edge on the screen. The
 * returned tiles do not overlap. Shared with 3D extrusions (W12).
 */
export function computeCameraTilePyramid(input: CameraTilePyramidInput): PyramidTile[] {
  const { camera, widthPixels, heightPixels, maximumZoom, maximumTiles = 128, splitPixels = 512 } = input
  camera.updateMatrixWorld()
  cameraPosition.setFromMatrixPosition(camera.matrixWorld)
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem, (camera as { reversedDepth?: boolean }).reversedDepth ?? false)
  const result: PyramidTile[] = []
  let queue: PyramidTile[] = [{ x: 0, y: 0, z: 0 }]
  while (queue.length > 0) {
    const next: PyramidTile[] = []
    for (let index = 0; index < queue.length; index++) {
      const tile = queue[index]!
      const decision = classify(tile, input, splitPixels, widthPixels, heightPixels)
      if (decision === 'cull') continue
      // Leaves already kept plus everything still queued: splitting must not pass the limit.
      const committed = result.length + next.length + (queue.length - index)
      if (decision === 'split' && tile.z < maximumZoom && committed + 3 <= maximumTiles) {
        const { x, y, z } = tile
        next.push({ x: x * 2, y: y * 2, z: z + 1 }, { x: x * 2 + 1, y: y * 2, z: z + 1 }, { x: x * 2, y: y * 2 + 1, z: z + 1 }, { x: x * 2 + 1, y: y * 2 + 1, z: z + 1 })
      } else result.push(tile)
    }
    queue = next
  }
  return result
}

function classify(tile: PyramidTile, input: CameraTilePyramidInput, splitPixels: number, widthPixels: number, heightPixels: number): 'cull' | 'split' | 'keep' {
  const { x, y, z } = tile
  const count = 2 ** z
  const west = (x / count) * 2 * Math.PI - Math.PI
  const east = ((x + 1) / count) * 2 * Math.PI - Math.PI
  const north = tileRowToLatitude(y, z)
  const south = tileRowToLatitude(y + 1, z)
  const cap = input.visibleCap
  if (cap !== null && isOutsideCap(cap, west, south, east, north)) return 'cull'
  if (z < ALWAYS_SPLIT_BELOW_ZOOM) return 'split'
  const centerLongitude = (west + east) / 2
  for (let row = 0; row < SAMPLES_PER_SIDE; row++) {
    const latitude = tileRowToLatitude(y + row / (SAMPLES_PER_SIDE - 1), z)
    for (let column = 0; column < SAMPLES_PER_SIDE; column++) {
      const longitude = ((x + column / (SAMPLES_PER_SIDE - 1)) / count) * 2 * Math.PI - Math.PI
      input.toScenePosition(longitude, latitude, samples[row * SAMPLES_PER_SIDE + column]!, centerLongitude)
    }
  }
  sphere.setFromPoints(samples)
  // The ground bulges between samples on the globe, and terrain rises above the ellipsoid.
  const halfAngle = Math.min(Math.PI / 2, Math.PI / count)
  // Terrain margin: up to the highest summit, but no more than the tile's own size, so small tiles near the camera
  // are not kept (and split) far outside the view.
  let tileSize = 0
  forEachEdge((a, b) => (tileSize = Math.max(tileSize, samples[a]!.distanceTo(samples[b]!) * 2)))
  sphere.radius += Math.min(MAXIMUM_TERRAIN_HEIGHT_METERS, tileSize) + (cap !== null ? EARTH_RADIUS_METERS * (1 - Math.cos(halfAngle / 2)) : 0)
  if (!frustum.intersectsSphere(sphere)) return 'cull'
  let behindCamera = false
  for (let index = 0; index < samples.length; index++) {
    clip.set(samples[index]!.x, samples[index]!.y, samples[index]!.z, 1).applyMatrix4(viewProjection)
    if (clip.w <= 1e-6) {
      behindCamera = true
      break
    }
    screen[index]!.x = ((clip.x / clip.w + 1) / 2) * widthPixels
    screen[index]!.y = ((1 - clip.y / clip.w) / 2) * heightPixels
  }
  if (behindCamera) {
    // The tile reaches behind the camera, where projected sizes mean nothing: estimate its size from its distance,
    // never nearer than the camera's height.
    let halfEdge = 0
    let nearest = Infinity
    forEachEdge((a, b) => (halfEdge = Math.max(halfEdge, samples[a]!.distanceTo(samples[b]!))))
    for (const sample of samples) nearest = Math.min(nearest, sample.distanceTo(cameraPosition))
    const focalLengthPixels = (input.camera.projectionMatrix.elements[5]! * heightPixels) / 2
    const pixels = (halfEdge * focalLengthPixels) / Math.max(nearest - halfEdge, input.cameraHeightMeters, 1)
    return pixels > splitPixels ? 'split' : 'keep'
  }
  let longest = 0
  forEachEdge((a, b) => (longest = Math.max(longest, distance(screen[a]!, screen[b]!))))
  return longest > splitPixels ? 'split' : 'keep'
}

/** Calls `visit` with the sample indices of each edge of the sample grid (half a tile edge long). */
function forEachEdge(visit: (a: number, b: number) => void): void {
  for (let row = 0; row < SAMPLES_PER_SIDE; row++) {
    for (let column = 0; column < SAMPLES_PER_SIDE; column++) {
      const here = row * SAMPLES_PER_SIDE + column
      if (column + 1 < SAMPLES_PER_SIDE) visit(here, here + 1)
      if (row + 1 < SAMPLES_PER_SIDE) visit(here, here + SAMPLES_PER_SIDE)
    }
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * The camera's tiles on the globe (`view.morph` 0) or on the flat map (1), for labels facing the viewer and 3D
 * extrusions, with the ground taken at `groundHeightMeters` (the terrain at the screen centre): on a plateau tiles are
 * nearer than the ellipsoid, so deeper. Not meant for frames inside the morph, where the ground is between the two.
 */
export function computeViewTilePyramid(camera: Camera, widthPixels: number, heightPixels: number, view: ViewMorph, maximumZoom: number, groundHeightMeters = 0): PyramidTile[] {
  const flat = view.morph === 1
  camera.updateMatrixWorld()
  const position = new Vector3().setFromMatrixPosition(camera.matrixWorld)
  return computeCameraTilePyramid({
    camera,
    widthPixels,
    heightPixels,
    toScenePosition: (longitude, latitude, target, centerLongitude) => toScenePosition(view, flat, longitude, latitude, groundHeightMeters, target, centerLongitude),
    visibleCap: flat ? null : horizonCap(position),
    cameraHeightMeters: Math.max(1, cameraHeightAboveSurface(view, flat, position) - groundHeightMeters),
    maximumZoom,
  })
}

/**
 * Scene position of a geographic point: on the globe, or on the flat map's world copy nearest the camera (the copy of
 * `referenceLongitudeRadians`, when given, so points of one tile stay together).
 */
export function toScenePosition(view: ViewMorph, flat: boolean, longitudeRadians: number, latitudeRadians: number, heightMeters: number, target: Vector3, referenceLongitudeRadians = longitudeRadians): Vector3 {
  if (!flat) return WGS84_ELLIPSOID.getCartographicToPosition(latitudeRadians, longitudeRadians, heightMeters, target) as Vector3
  const flatPoint = view.geodeticToFlat(longitudeRadians, latitudeRadians, heightMeters, target)
  const referenceX = longitudeToMercatorX(referenceLongitudeRadians)
  flatPoint.x += wrapMercatorXNear(referenceX, view.worldCopyReferenceXMeters) - referenceX
  return flatPoint.applyMatrix4(view.flatToEarth)
}

const surfacePoint = new Vector3()
const cartographic = { lat: 0, lon: 0, height: 0 }

/** The camera's height above the ellipsoid (the map's plane on the flat map), in scene metres. */
export function cameraHeightAboveSurface(view: ViewMorph, flat: boolean, cameraPosition: Vector3): number {
  if (flat) return surfacePoint.copy(cameraPosition).applyMatrix4(view.earthToFlat).z * view.scale
  WGS84_ELLIPSOID.getPositionToCartographic(cameraPosition, cartographic)
  return cartographic.height
}
