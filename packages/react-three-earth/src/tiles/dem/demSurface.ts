// Terrain meshes from elevation rasters (raster-dem tiles): a grid in Web Mercator with skirts, and the polar caps
// Web Mercator leaves out. Pure maths, run in the terrain worker (or on the main thread without one) and in Node tests.
import { WEB_MERCATOR_MAX_LATITUDE_RADIANS } from '../../view/webMercator.js'

const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137
const WGS84_FLATTENING = 1 / 298.257223563
const WGS84_FIRST_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING)

/** A terrain tile's geometry, ready for a `BufferGeometry`: positions relative to `center` (ECEF metres). */
export interface TerrainSurface {
  /** ECEF metres, relative to `center`. Skirt vertices come after the grid's. */
  positions: Float32Array
  normals: Float32Array
  /** East and north across the grid, 0 to 1. */
  uvs: Float32Array
  indices: Uint16Array | Uint32Array
  /** The mesh's origin, ECEF metres, in double precision. */
  center: [number, number, number]
  /** Of the surface as drawn (after `floorHeightMeters`). */
  minimumHeightMeters: number
  maximumHeightMeters: number
  /** The true heights, metres, one per vertex, when `floorHeightMeters` lifted some: skirts take their top's. */
  elevations?: Float32Array
}

/** Which edges of a grid get a skirt: a wall hanging below the edge that hides cracks against coarser neighbours. */
export interface SkirtEdges {
  west: boolean
  south: boolean
  east: boolean
  north: boolean
}

export interface SurfaceGrid {
  /** Column longitudes, radians, west to east. */
  longitudes: ArrayLike<number>
  /** Row latitudes, radians, south to north. */
  latitudes: ArrayLike<number>
  /** Heights above the ellipsoid, metres, row by row from the south. */
  heights: ArrayLike<number>
  skirtLengthMeters: number
  skirtEdges: SkirtEdges
  /** Heights below it are drawn at it (a flat sea over bathymetry); `elevations` keeps the true ones. Default: none. */
  floorHeightMeters?: number | null
}

/** Geodetic radians and metres to ECEF metres on WGS84, written at `offset` in `target`. */
export function geodeticToEcef(longitude: number, latitude: number, heightMeters: number, target: Float64Array | number[], offset = 0): void {
  const sinLatitude = Math.sin(latitude)
  const cosLatitude = Math.cos(latitude)
  const primeVerticalRadius = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  target[offset] = (primeVerticalRadius + heightMeters) * cosLatitude * Math.cos(longitude)
  target[offset + 1] = (primeVerticalRadius + heightMeters) * cosLatitude * Math.sin(longitude)
  target[offset + 2] = (primeVerticalRadius * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED) + heightMeters) * sinLatitude
}

/**
 * Builds a grid surface: one vertex per longitude and latitude, two triangles per cell (counter-clockwise seen from
 * above), skirts on the chosen edges and smooth normals from the neighbouring vertices.
 */
export function buildSurface({ longitudes, latitudes, heights, skirtLengthMeters, skirtEdges, floorHeightMeters = null }: SurfaceGrid): TerrainSurface {
  const columns = longitudes.length
  const rows = latitudes.length
  const gridCount = columns * rows
  const edges = (['south', 'east', 'north', 'west'] as const).filter(edge => skirtEdges[edge] && skirtLengthMeters > 0)
  const edgeLength = (edge: 'south' | 'east' | 'north' | 'west') => (edge === 'south' || edge === 'north' ? columns : rows)
  const vertexCount = gridCount + edges.reduce((sum, edge) => sum + edgeLength(edge), 0)

  const ecef = new Float64Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const elevations = floorHeightMeters === null ? undefined : new Float32Array(vertexCount)
  let minimumHeightMeters = Infinity
  let maximumHeightMeters = -Infinity
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const vertex = row * columns + column
      const trueHeight = heights[vertex]!
      const height = floorHeightMeters === null ? trueHeight : Math.max(trueHeight, floorHeightMeters)
      if (elevations !== undefined) elevations[vertex] = trueHeight
      geodeticToEcef(longitudes[column]!, latitudes[row]!, height, ecef, vertex * 3)
      uvs[vertex * 2] = columns > 1 ? column / (columns - 1) : 0
      uvs[vertex * 2 + 1] = rows > 1 ? row / (rows - 1) : 0
      if (height < minimumHeightMeters) minimumHeightMeters = height
      if (height > maximumHeightMeters) maximumHeightMeters = height
    }
  }

  // Normals: the cross product of the east and north differences, falling back to the ellipsoid's up where the grid
  // degenerates (a cap's pole row).
  const gridNormals = new Float64Array(gridCount * 3)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const east = (row * columns + Math.min(column + 1, columns - 1)) * 3
      const west = (row * columns + Math.max(column - 1, 0)) * 3
      const north = (Math.min(row + 1, rows - 1) * columns + column) * 3
      const south = (Math.max(row - 1, 0) * columns + column) * 3
      const ex = ecef[east]! - ecef[west]!
      const ey = ecef[east + 1]! - ecef[west + 1]!
      const ez = ecef[east + 2]! - ecef[west + 2]!
      const nx = ecef[north]! - ecef[south]!
      const ny = ecef[north + 1]! - ecef[south + 1]!
      const nz = ecef[north + 2]! - ecef[south + 2]!
      let x = ey * nz - ez * ny
      let y = ez * nx - ex * nz
      let z = ex * ny - ey * nx
      let length = Math.hypot(x, y, z)
      if (length < 1e-6 * (Math.hypot(ex, ey, ez) * Math.hypot(nx, ny, nz) + 1e-30)) {
        const longitude = longitudes[column]!
        const latitude = latitudes[row]!
        x = Math.cos(latitude) * Math.cos(longitude)
        y = Math.cos(latitude) * Math.sin(longitude)
        z = Math.sin(latitude)
        length = 1
      }
      const offset = (row * columns + column) * 3
      gridNormals[offset] = x / length
      gridNormals[offset + 1] = y / length
      gridNormals[offset + 2] = z / length
    }
  }

  const normals = new Float32Array(vertexCount * 3)
  normals.set(gridNormals)
  const triangles: number[] = []
  for (let row = 0; row + 1 < rows; row++) {
    for (let column = 0; column + 1 < columns; column++) {
      const a = row * columns + column
      const b = a + 1
      const c = a + columns
      const d = c + 1
      triangles.push(a, b, d, a, d, c)
    }
  }

  // Skirts: each edge walked so that its direction crossed with up points outwards, then walled down.
  let next = gridCount
  for (const edge of edges) {
    const top = edgeVertices(edge, columns, rows)
    for (let k = 0; k < top.length; k++) {
      const source = top[k]!
      const skirt = next + k
      const nx = gridNormals[source * 3]!
      const ny = gridNormals[source * 3 + 1]!
      const nz = gridNormals[source * 3 + 2]!
      // Down along the ellipsoid normal, so the wall hangs straight whatever the slope.
      const row = Math.floor(source / columns)
      const column = source % columns
      const longitude = longitudes[column]!
      const latitude = latitudes[row]!
      ecef[skirt * 3] = ecef[source * 3]! - Math.cos(latitude) * Math.cos(longitude) * skirtLengthMeters
      ecef[skirt * 3 + 1] = ecef[source * 3 + 1]! - Math.cos(latitude) * Math.sin(longitude) * skirtLengthMeters
      ecef[skirt * 3 + 2] = ecef[source * 3 + 2]! - Math.sin(latitude) * skirtLengthMeters
      normals[skirt * 3] = nx
      normals[skirt * 3 + 1] = ny
      normals[skirt * 3 + 2] = nz
      if (elevations !== undefined) elevations[skirt] = elevations[source]!
      uvs[skirt * 2] = uvs[source * 2]!
      uvs[skirt * 2 + 1] = uvs[source * 2 + 1]!
      if (k + 1 < top.length) {
        const t0 = source
        const t1 = top[k + 1]!
        const s0 = skirt
        const s1 = skirt + 1
        triangles.push(s0, s1, t1, s0, t1, t0)
      }
    }
    next += top.length
  }

  let minimumX = Infinity
  let minimumY = Infinity
  let minimumZ = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  let maximumZ = -Infinity
  for (let vertex = 0; vertex < gridCount; vertex++) {
    const x = ecef[vertex * 3]!
    const y = ecef[vertex * 3 + 1]!
    const z = ecef[vertex * 3 + 2]!
    if (x < minimumX) minimumX = x
    if (y < minimumY) minimumY = y
    if (z < minimumZ) minimumZ = z
    if (x > maximumX) maximumX = x
    if (y > maximumY) maximumY = y
    if (z > maximumZ) maximumZ = z
  }
  const center: [number, number, number] = [(minimumX + maximumX) / 2, (minimumY + maximumY) / 2, (minimumZ + maximumZ) / 2]
  const positions = new Float32Array(vertexCount * 3)
  for (let index = 0; index < vertexCount * 3; index++) positions[index] = ecef[index]! - center[index % 3]!
  const indices = vertexCount > 65535 ? Uint32Array.from(triangles) : Uint16Array.from(triangles)
  return { positions, normals, uvs, indices, center, minimumHeightMeters, maximumHeightMeters, ...(elevations !== undefined ? { elevations } : {}) }
}

/** The grid vertices along an edge, walked so that the walk direction crossed with up points out of the grid. */
function edgeVertices(edge: 'south' | 'east' | 'north' | 'west', columns: number, rows: number): number[] {
  const vertices: number[] = []
  switch (edge) {
    case 'south': // west to east
      for (let column = 0; column < columns; column++) vertices.push(column)
      break
    case 'east': // south to north
      for (let row = 0; row < rows; row++) vertices.push(row * columns + columns - 1)
      break
    case 'north': // east to west
      for (let column = columns - 1; column >= 0; column--) vertices.push((rows - 1) * columns + column)
      break
    case 'west': // north to south
      for (let row = rows - 1; row >= 0; row--) vertices.push(row * columns)
      break
  }
  return vertices
}

/** Elevations of a raster tile, metres, one per pixel, rows from the top (north). */
export interface ElevationRaster {
  width: number
  height: number
  elevations: Float32Array
}

/**
 * Bilinear elevation at a point of the raster, `u` east and `v` down from the top-left corner, 0 to 1. Pixels are
 * sampled at their centres; points within half a pixel of the edge take the edge pixels' values.
 */
export function sampleRaster({ width, height, elevations }: ElevationRaster, u: number, v: number): number {
  const fx = Math.min(Math.max(u * width - 0.5, 0), width - 1)
  const fy = Math.min(Math.max(v * height - 0.5, 0), height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const top = elevations[y0 * width + x0]! * (1 - tx) + elevations[y0 * width + x1]! * tx
  const bottom = elevations[y1 * width + x0]! * (1 - tx) + elevations[y1 * width + x1]! * tx
  return top * (1 - ty) + bottom * ty
}

/** The bounds of an XYZ tile (Web Mercator, rows from the north), radians. */
export function webMercatorTileBounds(x: number, y: number, z: number): { west: number; south: number; east: number; north: number } {
  const count = 2 ** z
  return {
    west: (x / count) * 2 * Math.PI - Math.PI,
    east: ((x + 1) / count) * 2 * Math.PI - Math.PI,
    north: mercatorRowToLatitude(y / count),
    south: mercatorRowToLatitude((y + 1) / count),
  }
}

/** Latitude, radians, of a point a fraction of the way down the Web Mercator square (0 at the top). */
export function mercatorRowToLatitude(fraction: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * fraction)))
}

export interface DemTileRequest {
  x: number
  y: number
  z: number
  /**
   * The part of the raster this tile covers, `[west, top, east, bottom]` as fractions of the raster (`[0, 0, 1, 1]`
   * for the whole raster). Smaller for tiles deeper than the data, which read their ancestor's raster.
   */
  subview: readonly [number, number, number, number]
  /** Grid cells along each side. */
  segments: number
  skirtLengthMeters: number
  /** See `SurfaceGrid.floorHeightMeters`. */
  floorHeightMeters?: number | null
}

/** A terrain tile from an elevation raster: a grid uniform in Web Mercator, skirts on every edge. */
export function buildDemTileSurface(raster: ElevationRaster, { x, y, z, subview, segments, skirtLengthMeters, floorHeightMeters = null }: DemTileRequest): TerrainSurface {
  const count = 2 ** z
  const size = segments + 1
  const longitudes = new Float64Array(size)
  const latitudes = new Float64Array(size)
  const heights = new Float32Array(size * size)
  const [subviewWest, subviewTop, subviewEast, subviewBottom] = subview
  for (let index = 0; index < size; index++) {
    longitudes[index] = ((x + index / segments) / count) * 2 * Math.PI - Math.PI
    // Rows run south to north; row 0 is the bottom of the tile.
    latitudes[index] = mercatorRowToLatitude((y + 1 - index / segments) / count)
  }
  for (let row = 0; row < size; row++) {
    const v = subviewBottom + (subviewTop - subviewBottom) * (row / segments)
    for (let column = 0; column < size; column++) {
      const u = subviewWest + (subviewEast - subviewWest) * (column / segments)
      heights[row * size + column] = sampleRaster(raster, u, v)
    }
  }
  // Neighbours sample their own edge pixels, so a shared edge can differ by about a pixel's step: the skirt reaches
  // at least three times the steepest half-pixel step across this tile's edges.
  const skirt = Math.max(skirtLengthMeters, 3 * edgePixelStepMeters(raster, subview, segments))
  return buildSurface({ longitudes, latitudes, heights, skirtLengthMeters: skirt, skirtEdges: { west: true, south: true, east: true, north: true }, floorHeightMeters })
}

/** The largest height change from a subview's edges to half a pixel inwards (the first pixel centre on), metres. */
export function edgePixelStepMeters(raster: ElevationRaster, subview: readonly [number, number, number, number], segments: number): number {
  const [west, top, east, bottom] = subview
  const pixelU = 1 / raster.width
  const pixelV = 1 / raster.height
  let step = 0
  for (let index = 0; index <= segments; index++) {
    const u = west + ((east - west) * index) / segments
    const v = top + ((bottom - top) * index) / segments
    step = Math.max(
      step,
      Math.abs(sampleRaster(raster, u, top) - sampleRaster(raster, u, top + pixelV)),
      Math.abs(sampleRaster(raster, u, bottom) - sampleRaster(raster, u, bottom - pixelV)),
      Math.abs(sampleRaster(raster, west, v) - sampleRaster(raster, west + pixelU, v)),
      Math.abs(sampleRaster(raster, east, v) - sampleRaster(raster, east - pixelU, v)),
    )
  }
  return step
}

export interface PolarCapRequest {
  /** The north cap (from about 85.05°N to the pole), or the south one. */
  north: boolean
  /** Rings from the edge of Web Mercator to the pole. */
  rings: number
  /** Columns around the pole. */
  segments: number
  /** The skirt along the cap's edge, where it meets the Web Mercator tiles. */
  skirtLengthMeters: number
  /** See `SurfaceGrid.floorHeightMeters`. */
  floorHeightMeters?: number | null
}

/**
 * A polar cap from a zoom 0 raster (the whole Web Mercator square): its edge follows the raster's top or bottom row,
 * and it rises or falls evenly to the pole at the mean of that row.
 */
export function buildPolarCapSurface(raster: ElevationRaster, { north, rings, segments, skirtLengthMeters, floorHeightMeters = null }: PolarCapRequest): TerrainSurface {
  const columns = segments + 1
  const rows = rings + 1
  const longitudes = new Float64Array(columns)
  const edgeHeights = new Float64Array(columns)
  const edgeV = north ? 0 : 1
  let sum = 0
  for (let column = 0; column < columns; column++) {
    const u = column / segments
    longitudes[column] = u * 2 * Math.PI - Math.PI
    edgeHeights[column] = sampleRaster(raster, u, edgeV)
    if (column < segments) sum += edgeHeights[column]!
  }
  const poleHeight = sum / segments
  const latitudes = new Float64Array(rows)
  const heights = new Float32Array(rows * columns)
  for (let row = 0; row < rows; row++) {
    // Rows run south to north: the north cap starts at its edge, the south one at the pole.
    const towardsPole = north ? row / rings : 1 - row / rings
    const edgeLatitude = north ? WEB_MERCATOR_MAX_LATITUDE_RADIANS : -WEB_MERCATOR_MAX_LATITUDE_RADIANS
    const poleLatitude = north ? Math.PI / 2 : -Math.PI / 2
    latitudes[row] = edgeLatitude + (poleLatitude - edgeLatitude) * towardsPole
    for (let column = 0; column < columns; column++) heights[row * columns + column] = edgeHeights[column]! + (poleHeight - edgeHeights[column]!) * towardsPole
  }
  return buildSurface({ longitudes, latitudes, heights, skirtLengthMeters, skirtEdges: { west: false, east: false, south: north, north: !north }, floorHeightMeters })
}

/**
 * Geometric error of a Web Mercator terrain tile: Cesium's heightmap error (a quarter of the tile's width over its
 * samples), the width taken at the tile's latitude nearest the equator. A tile at zoom `z` matches quantized-mesh
 * level `z − 1`, which is as wide.
 */
export function demTileGeometricError(x: number, y: number, z: number, segments: number): number {
  const { south, north } = webMercatorTileBounds(x, y, z)
  const nearestEquator = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north))
  const widthMeters = ((2 * Math.PI * WGS84_SEMI_MAJOR_AXIS_METERS) / 2 ** z) * Math.cos(nearestEquator)
  return (widthMeters * 0.25) / (segments + 1)
}
