import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Vector3, type BufferGeometry, type Matrix4, type Mesh, type Object3D } from 'three'

/** What the sampler reads from a terrain tile (3DTilesRenderer's tile objects). */
interface TerrainTile {
  boundingVolume?: { region?: number[] }
  engineData?: { scene?: Object3D | null }
  __depth?: number
}

/**
 * Triangles of a tile mesh bucketed in a grid over longitude and latitude, with each vertex's longitude and latitude,
 * built once per geometry. Skirt triangles (vertical walls) have no area there and are left out.
 */
interface TriangleGrid {
  longitudes: Float64Array
  latitudes: Float64Array
  west: number
  south: number
  cellWidth: number
  cellHeight: number
  /** Triangles with less area than this (twice their area, in radians squared) are skirt walls. */
  minimumDeterminant: number
  /** Triangle indices (first index of three in the index buffer) per cell, row by row. */
  cells: Int32Array[]
}

const GRID_SIZE = 16
/** How far outside a triangle (in barycentric weight) a point may lie and still read it, when no triangle holds it. */
const NEAREST_TRIANGLE_TOLERANCE = 1e-4
const grids = new WeakMap<BufferGeometry, TriangleGrid | null>()
const vertex = new Vector3()
const a = new Vector3()
const b = new Vector3()
const c = new Vector3()
const cartographic = { lat: 0, lon: 0, height: 0 }

/**
 * Height of the terrain as drawn at a position, in metres above the ellipsoid: the deepest visible tile there, its
 * triangle under the point, interpolated in ECEF (so the chord a coarse tile cuts below the curved Earth counts).
 * Null where no visible tile covers the point. Much cheaper than a raycast through the tiles: a tile's triangle grid
 * is built once, then each read tests a few triangles.
 */
export function sampleTerrainHeight(visibleTiles: Iterable<unknown>, longitudeRadians: number, latitudeRadians: number): number | null {
  let best: TerrainTile | null = null
  let bestArea = Infinity
  for (const candidate of visibleTiles as Iterable<TerrainTile>) {
    const region = candidate.boundingVolume?.region
    if (region === undefined || candidate.engineData?.scene == null) continue
    const [west = 0, south = 0, east = 0, north = 0] = region
    if (longitudeRadians < west || longitudeRadians > east || latitudeRadians < south || latitudeRadians > north) continue
    // The smallest tile is the deepest (tiles fading out keep their parent visible for a moment).
    const area = (east - west) * (north - south)
    if (area < bestArea) {
      best = candidate
      bestArea = area
    }
  }
  if (best === null) return null
  const mesh = findMesh(best.engineData!.scene!)
  if (mesh === null) return null
  const region = best.boundingVolume!.region!
  return sampleMesh(mesh, region[0]!, region[2]!, longitudeRadians, latitudeRadians)
}

function findMesh(scene: Object3D): Mesh | null {
  if ((scene as Mesh).isMesh === true) return scene as Mesh
  for (const child of scene.children) {
    const mesh = findMesh(child)
    if (mesh !== null) return mesh
  }
  return null
}

function sampleMesh(mesh: Mesh, west: number, east: number, longitude: number, latitude: number): number | null {
  const geometry = mesh.geometry
  // A tile added this frame has not been through a render's matrix update yet.
  mesh.updateWorldMatrix(true, false)
  let grid = grids.get(geometry)
  if (grid === undefined) {
    grid = buildGrid(geometry, mesh.matrixWorld, west, east)
    grids.set(geometry, grid)
  }
  if (grid === null) return null
  const column = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((longitude - grid.west) / grid.cellWidth)))
  const row = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((latitude - grid.south) / grid.cellHeight)))
  const index = geometry.index!
  const { longitudes, latitudes } = grid
  // On a tile's edge, float32 vertices can leave the point a hair outside every triangle: take the nearest one then.
  let nearestFirst = -1
  let nearestWeight = -NEAREST_TRIANGLE_TOLERANCE
  const nearestWeights = [0, 0, 0]
  for (const first of grid.cells[row * GRID_SIZE + column]!) {
    const i0 = index.getX(first)
    const i1 = index.getX(first + 1)
    const i2 = index.getX(first + 2)
    const x0 = longitudes[i0]!
    const y0 = latitudes[i0]!
    const x1 = longitudes[i1]!
    const y1 = latitudes[i1]!
    const x2 = longitudes[i2]!
    const y2 = latitudes[i2]!
    const determinant = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (Math.abs(determinant) <= grid.minimumDeterminant) continue
    const w0 = ((y1 - y2) * (longitude - x2) + (x2 - x1) * (latitude - y2)) / determinant
    const w1 = ((y2 - y0) * (longitude - x2) + (x0 - x2) * (latitude - y2)) / determinant
    const w2 = 1 - w0 - w1
    const tolerance = -1e-9
    const smallestWeight = Math.min(w0, w1, w2)
    if (smallestWeight < tolerance) {
      if (smallestWeight > nearestWeight) {
        nearestWeight = smallestWeight
        nearestFirst = first
        nearestWeights[0] = w0
        nearestWeights[1] = w1
        nearestWeights[2] = w2
      }
      continue
    }
    return interpolateHeight(mesh, index.getX(first), index.getX(first + 1), index.getX(first + 2), w0, w1, w2)
  }
  if (nearestFirst === -1) return null
  const [w0, w1, w2] = nearestWeights as [number, number, number]
  return interpolateHeight(mesh, index.getX(nearestFirst), index.getX(nearestFirst + 1), index.getX(nearestFirst + 2), w0, w1, w2)
}

function interpolateHeight(mesh: Mesh, i0: number, i1: number, i2: number, w0: number, w1: number, w2: number): number {
  const positions = mesh.geometry.getAttribute('position')
  a.fromBufferAttribute(positions, i0)
  b.fromBufferAttribute(positions, i1)
  c.fromBufferAttribute(positions, i2)
  vertex
    .set(0, 0, 0)
    .addScaledVector(a, w0)
    .addScaledVector(b, w1)
    .addScaledVector(c, w2)
    .applyMatrix4(mesh.matrixWorld)
  WGS84_ELLIPSOID.getPositionToCartographic(vertex, cartographic)
  return cartographic.height
}

function buildGrid(geometry: BufferGeometry, matrixWorld: Matrix4, west: number, east: number): TriangleGrid | null {
  const index = geometry.index
  const positions = geometry.getAttribute('position')
  if (index === null || positions === undefined) return null
  const count = positions.count
  const longitudes = new Float64Array(count)
  const latitudes = new Float64Array(count)
  let minimumX = Infinity
  let minimumY = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  for (let i = 0; i < count; i++) {
    vertex.fromBufferAttribute(positions, i).applyMatrix4(matrixWorld)
    WGS84_ELLIPSOID.getPositionToCartographic(vertex, cartographic)
    let longitude = cartographic.lon
    // A vertex on the antimeridian may come back on the other side of it.
    if (longitude < west - Math.PI) longitude += 2 * Math.PI
    else if (longitude > east + Math.PI) longitude -= 2 * Math.PI
    longitudes[i] = longitude
    latitudes[i] = cartographic.lat
    minimumX = Math.min(minimumX, longitude)
    maximumX = Math.max(maximumX, longitude)
    minimumY = Math.min(minimumY, cartographic.lat)
    maximumY = Math.max(maximumY, cartographic.lat)
  }
  const cellWidth = Math.max((maximumX - minimumX) / GRID_SIZE, 1e-12)
  const cellHeight = Math.max((maximumY - minimumY) / GRID_SIZE, 1e-12)
  const minimumDeterminant = cellWidth * cellHeight * 1e-9
  const lists: number[][] = Array.from({ length: GRID_SIZE * GRID_SIZE }, () => [])
  for (let first = 0; first + 2 < index.count; first += 3) {
    const i0 = index.getX(first)
    const i1 = index.getX(first + 1)
    const i2 = index.getX(first + 2)
    const x0 = longitudes[i0]!
    const x1 = longitudes[i1]!
    const x2 = longitudes[i2]!
    const y0 = latitudes[i0]!
    const y1 = latitudes[i1]!
    const y2 = latitudes[i2]!
    if (Math.abs((y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)) <= minimumDeterminant) continue // a skirt wall
    // On a mesh a whole turn wide (zoom 0 raster-dem terrain, polar caps), a vertex on the antimeridian can come back on
    // either side: a triangle spanning over half a turn is one of those, and would answer for points across the globe.
    if (Math.max(x0, x1, x2) - Math.min(x0, x1, x2) > Math.PI) continue
    const fromColumn = Math.max(0, Math.floor((Math.min(x0, x1, x2) - minimumX) / cellWidth))
    const toColumn = Math.min(GRID_SIZE - 1, Math.floor((Math.max(x0, x1, x2) - minimumX) / cellWidth))
    const fromRow = Math.max(0, Math.floor((Math.min(y0, y1, y2) - minimumY) / cellHeight))
    const toRow = Math.min(GRID_SIZE - 1, Math.floor((Math.max(y0, y1, y2) - minimumY) / cellHeight))
    for (let row = fromRow; row <= toRow; row++) for (let column = fromColumn; column <= toColumn; column++) lists[row * GRID_SIZE + column]!.push(first)
  }
  return { longitudes, latitudes, west: minimumX, south: minimumY, cellWidth, cellHeight, minimumDeterminant, cells: lists.map(list => Int32Array.from(list)) }
}
