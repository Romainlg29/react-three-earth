import earcut from 'earcut'

import { latitudeToMercatorY, longitudeToMercatorX, mercatorScaleFactor } from '../../view/webMercator.js'
import type { Rgba } from './styleLayers.js'
import { TILE_EXTENT, type ExtrusionMesh } from './types.js'

/** A point in tile units (0 to `TILE_EXTENT`, y down from the north edge). */
export interface ExtrusionPoint {
  x: number
  y: number
}

/** What one feature of a `fill-extrusion` layer stands at, from its paint properties. */
export interface ExtrusionStyle {
  /** `fill-extrusion-base` and `fill-extrusion-height` at the tile's zoom, in metres. */
  baseMeters: number
  heightMeters: number
  /** The same one zoom deeper: the main thread interpolates by the camera's zoom. */
  nextZoomBaseMeters: number
  nextZoomHeightMeters: number
  /** `fill-extrusion-color`, straight sRGB bytes. */
  color: Rgba
  /** `fill-extrusion-vertical-gradient`: walls darken towards their foot. */
  verticalGradient: boolean
}

const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137
const WGS84_FIRST_ECCENTRICITY_SQUARED = 6.69437999014e-3
/** Normal components are stored as signed bytes. */
const NORMAL_SCALE = 127

/** Draw ranges of one style layer in the mesh. */
interface LayerRange {
  layerId: string
  layerIndex: number
  opacity: number
  nextZoomOpacity: number
  start: number
}

/**
 * Tessellates the buildings of one tile (`fill-extrusion`): walls and flat roofs, in the tile centre's
 * east-north-up frame (metres, double precision until the final subtraction) and in Web Mercator for the flat map.
 * Polygons are clipped to the tile square first, so a building cut by a tile edge has no wall along the cut and
 * neighbouring tiles never draw the same roof twice. Vertices are at elevation 0: the main thread lifts each
 * building onto the terrain.
 */
export class ExtrusionBuilder {
  protected readonly positions: number[] = []
  protected readonly flatPositions: number[] = []
  protected readonly normals: number[] = []
  protected readonly colors: number[] = []
  protected readonly heightDeltas: number[] = []
  protected readonly indices: number[] = []
  protected readonly buildingVertexStarts: number[] = []
  protected readonly buildingBounds: number[] = []
  protected readonly layers: LayerRange[] = []
  protected readonly ranges: ExtrusionMesh['layers'] = []
  /** Tile centre, the frame's origin. */
  protected readonly originLongitudeRadians: number
  protected readonly originLatitudeRadians: number
  protected readonly origin: [number, number, number]
  protected readonly east: [number, number, number]
  protected readonly north: [number, number, number]
  protected readonly up: [number, number, number]
  protected readonly originMercatorXMeters: number
  protected readonly originMercatorYMeters: number
  protected readonly tile: { x: number; y: number; z: number }
  /** Per vertex: longitude and latitude, cached by tile point for the walls and roof of one building. */
  protected readonly geographic = new Map<number, [number, number]>()

  constructor(tile: { x: number; y: number; z: number }) {
    this.tile = tile
    const { longitude, latitude } = tileToGeographic(tile, TILE_EXTENT / 2, TILE_EXTENT / 2)
    this.originLongitudeRadians = longitude
    this.originLatitudeRadians = latitude
    this.origin = geodeticToEcef(longitude, latitude, 0)
    const sinLongitude = Math.sin(longitude)
    const cosLongitude = Math.cos(longitude)
    const sinLatitude = Math.sin(latitude)
    const cosLatitude = Math.cos(latitude)
    this.east = [-sinLongitude, cosLongitude, 0]
    this.north = [-sinLatitude * cosLongitude, -sinLatitude * sinLongitude, cosLatitude]
    this.up = [cosLatitude * cosLongitude, cosLatitude * sinLongitude, sinLatitude]
    this.originMercatorXMeters = longitudeToMercatorX(longitude)
    this.originMercatorYMeters = latitudeToMercatorY(latitude)
  }

  get buildingCount(): number {
    return this.buildingVertexStarts.length
  }

  /** Starts the draw range of a style layer; buildings added next belong to it. */
  beginLayer(layerId: string, layerIndex: number, opacity: number, nextZoomOpacity: number): void {
    this.closeLayer()
    this.layers.push({ layerId, layerIndex, opacity, nextZoomOpacity, start: this.indices.length })
  }

  /**
   * Adds one building: polygons (an outer ring followed by its holes, rings closed or not) in tile units. Returns
   * false when nothing of it lies in the tile.
   */
  addBuilding(polygons: readonly (readonly (readonly ExtrusionPoint[])[])[], style: ExtrusionStyle): boolean {
    // Bounds of the footprint as clipped to the tile: the terrain under it is read there, so the parts of a building
    // cut by a tile edge each stand on the ground under their own part.
    let minimumX = Infinity
    let minimumY = Infinity
    let maximumX = -Infinity
    let maximumY = -Infinity
    const clipped: ExtrusionPoint[][][] = []
    for (const polygon of polygons) {
      const rings: ExtrusionPoint[][] = []
      for (const [ringIndex, ring] of polygon.entries()) {
        const open = openRing(ring)
        if (open.length < 3) continue
        const inside = clipRingToSquare(open, 0, TILE_EXTENT)
        // An outer ring outside the tile drops its holes with it.
        if (inside.length < 3) {
          if (ringIndex === 0) break
          continue
        }
        for (const point of inside) {
          minimumX = Math.min(minimumX, point.x)
          minimumY = Math.min(minimumY, point.y)
          maximumX = Math.max(maximumX, point.x)
          maximumY = Math.max(maximumY, point.y)
        }
        rings.push(inside)
      }
      if (rings.length > 0) clipped.push(rings)
    }
    if (clipped.length === 0) return false
    this.buildingVertexStarts.push(this.positions.length / 3)
    this.buildingBounds.push(minimumX, minimumY, maximumX, maximumY)
    this.geographic.clear()
    const { baseMeters, heightMeters, nextZoomBaseMeters, nextZoomHeightMeters, color, verticalGradient } = style
    const topDelta = nextZoomHeightMeters - heightMeters
    const baseDelta = nextZoomBaseMeters - baseMeters
    for (const rings of clipped) {
      // Roof: one vertex per ring point, triangulated with its holes.
      const coordinates: number[] = []
      const holes: number[] = []
      const first = this.positions.length / 3
      for (const ring of rings) {
        if (coordinates.length > 0) holes.push(coordinates.length / 2)
        for (const point of ring) {
          coordinates.push(point.x, point.y)
          this.addVertex(point, heightMeters, 0, 0, NORMAL_SCALE, color, 1, topDelta)
        }
      }
      const triangles = earcut(coordinates, holes)
      for (let index = 0; index < triangles.length; index += 3) {
        const a = triangles[index]!
        let b = triangles[index + 1]!
        let c = triangles[index + 2]!
        // Facing up: counter-clockwise in east and north, so clockwise in tile units (y down).
        const cross = (coordinates[b * 2]! - coordinates[a * 2]!) * (coordinates[c * 2 + 1]! - coordinates[a * 2 + 1]!) - (coordinates[b * 2 + 1]! - coordinates[a * 2 + 1]!) * (coordinates[c * 2]! - coordinates[a * 2]!)
        if (cross > 0) [b, c] = [c, b]
        this.indices.push(first + a, first + b, first + c)
      }

      // Walls: a quad per edge, outward (rings wind one way, holes the other, so one rule fits both).
      const outerArea = signedArea(rings[0]!)
      const orientation = outerArea >= 0 ? 1 : -1
      for (const ring of rings) {
        for (let index = 0; index < ring.length; index++) {
          const a = ring[index]!
          const b = ring[(index + 1) % ring.length]!
          if (isTileEdge(a, b)) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const length = Math.hypot(dx, dy)
          if (length === 0) continue
          // Outward in tile units (y down), then east and north.
          const normalEast = Math.round(((orientation * dy) / length) * NORMAL_SCALE)
          const normalNorth = Math.round(((orientation * dx) / length) * NORMAL_SCALE)
          const bottomShade = verticalGradient ? wallShade(0, baseMeters, heightMeters - baseMeters) : 1
          const topShade = verticalGradient ? wallShade(1, baseMeters, heightMeters - baseMeters) : 1
          const corner = this.positions.length / 3
          this.addVertex(a, baseMeters, normalEast, normalNorth, 0, color, bottomShade, baseDelta)
          this.addVertex(b, baseMeters, normalEast, normalNorth, 0, color, bottomShade, baseDelta)
          this.addVertex(a, heightMeters, normalEast, normalNorth, 0, color, topShade, topDelta)
          this.addVertex(b, heightMeters, normalEast, normalNorth, 0, color, topShade, topDelta)
          // Counter-clockwise seen from outside.
          if (orientation > 0) this.indices.push(corner, corner + 3, corner + 1, corner, corner + 2, corner + 3)
          else this.indices.push(corner, corner + 1, corner + 3, corner, corner + 3, corner + 2)
        }
      }
    }
    return true
  }

  /** The tile's mesh, or null when it has no building. */
  build(): ExtrusionMesh | null {
    this.closeLayer()
    if (this.indices.length === 0) return null
    const vertexCount = this.positions.length / 3
    return {
      originLongitudeRadians: this.originLongitudeRadians,
      originLatitudeRadians: this.originLatitudeRadians,
      originMercatorXMeters: this.originMercatorXMeters,
      originMercatorYMeters: this.originMercatorYMeters,
      positions: new Float32Array(this.positions),
      flatPositions: new Float32Array(this.flatPositions),
      normals: new Int8Array(this.normals),
      colors: new Uint8Array(this.colors),
      heightDeltas: new Float32Array(this.heightDeltas),
      indices: vertexCount > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
      buildingVertexStarts: new Uint32Array([...this.buildingVertexStarts, vertexCount]),
      buildingBounds: new Float32Array(this.buildingBounds),
      layers: this.ranges,
    }
  }

  protected closeLayer(): void {
    const layer = this.layers.pop()
    if (layer === undefined) return
    const count = this.indices.length - layer.start
    if (count > 0) this.ranges.push({ ...layer, count })
  }

  protected addVertex(point: ExtrusionPoint, heightMeters: number, normalEast: number, normalNorth: number, normalUp: number, color: Rgba, shade: number, heightDeltaMeters: number): void {
    const key = point.x * 65536 + point.y
    let geographic = this.geographic.get(key)
    if (geographic === undefined) {
      const { longitude, latitude } = tileToGeographic(this.tile, point.x, point.y)
      geographic = [longitude, latitude]
      this.geographic.set(key, geographic)
    }
    const [longitude, latitude] = geographic
    const position = geodeticToEcef(longitude, latitude, heightMeters)
    const dx = position[0] - this.origin[0]
    const dy = position[1] - this.origin[1]
    const dz = position[2] - this.origin[2]
    this.positions.push(dot(this.east, dx, dy, dz), dot(this.north, dx, dy, dz), dot(this.up, dx, dy, dz))
    this.flatPositions.push(
      longitudeToMercatorX(longitude) - this.originMercatorXMeters,
      latitudeToMercatorY(latitude) - this.originMercatorYMeters,
      heightMeters * mercatorScaleFactor(latitude),
    )
    this.normals.push(normalEast, normalNorth, normalUp)
    this.colors.push(Math.round(color[0] * shade), Math.round(color[1] * shade), Math.round(color[2] * shade), color[3])
    this.heightDeltas.push(heightDeltaMeters)
  }
}

/**
 * MapLibre's `fill-extrusion-vertical-gradient` factor on a wall: `top` 0 at its foot, 1 at its top. Walls
 * darken towards their foot, more on tall buildings (MapLibre's shader, with its default light intensity of 0.5).
 */
export function wallShade(top: 0 | 1, baseMeters: number, heightMeters: number): number {
  const minimum = 0.7 + (0.98 - 0.7) * 0.5
  return Math.min(1, Math.max(minimum, (top + baseMeters) * Math.sqrt(Math.max(0, heightMeters) / 150)))
}

/** The ring without its closing point. */
function openRing(ring: readonly ExtrusionPoint[]): ExtrusionPoint[] {
  const last = ring[ring.length - 1]
  const first = ring[0]
  return ring.length > 1 && first !== undefined && last !== undefined && first.x === last.x && first.y === last.y ? ring.slice(0, -1) : [...ring]
}

/** Sutherland-Hodgman against the square [minimum, maximum]². A concave ring may gain edges along the square's sides. */
export function clipRingToSquare(ring: readonly ExtrusionPoint[], minimum: number, maximum: number): ExtrusionPoint[] {
  let output: ExtrusionPoint[] = [...ring]
  const planes: Array<[axis: 'x' | 'y', bound: number, keepAbove: boolean]> = [
    ['x', minimum, true],
    ['x', maximum, false],
    ['y', minimum, true],
    ['y', maximum, false],
  ]
  for (const [axis, bound, keepAbove] of planes) {
    // Nothing outside this side: keep the ring as it is (most rings).
    if (output.every(point => (keepAbove ? point[axis] >= bound : point[axis] <= bound))) continue
    const input = output
    output = []
    for (let index = 0; index < input.length; index++) {
      const current = input[index]!
      const previous = input[(index + input.length - 1) % input.length]!
      const currentInside = keepAbove ? current[axis] >= bound : current[axis] <= bound
      const previousInside = keepAbove ? previous[axis] >= bound : previous[axis] <= bound
      if (currentInside !== previousInside) {
        const t = (bound - previous[axis]) / (current[axis] - previous[axis])
        output.push(axis === 'x' ? { x: bound, y: previous.y + (current.y - previous.y) * t } : { x: previous.x + (current.x - previous.x) * t, y: bound })
      }
      if (currentInside) output.push(current)
    }
    if (output.length < 3) return []
  }
  return output
}

/** True for an edge along a side of the tile square: a cut made by clipping, not a wall. */
function isTileEdge(a: ExtrusionPoint, b: ExtrusionPoint): boolean {
  return (a.x === b.x && (a.x <= 0 || a.x >= TILE_EXTENT)) || (a.y === b.y && (a.y <= 0 || a.y >= TILE_EXTENT))
}

/** Shoelace sum in tile units (y down): positive for rings clockwise on the screen. */
function signedArea(ring: readonly ExtrusionPoint[]): number {
  let sum = 0
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return sum
}

function dot(axis: readonly [number, number, number], x: number, y: number, z: number): number {
  return axis[0] * x + axis[1] * y + axis[2] * z
}

/** Longitude and latitude (radians) of a point of a Web Mercator tile, in tile units. */
function tileToGeographic(tile: { x: number; y: number; z: number }, unitsX: number, unitsY: number): { longitude: number; latitude: number } {
  const count = 2 ** tile.z
  const longitude = ((tile.x + unitsX / TILE_EXTENT) / count) * 2 * Math.PI - Math.PI
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + unitsY / TILE_EXTENT)) / count)))
  return { longitude, latitude }
}

/** WGS84 geodetic to ECEF, in metres. */
function geodeticToEcef(longitude: number, latitude: number, heightMeters: number): [number, number, number] {
  const sinLatitude = Math.sin(latitude)
  const cosLatitude = Math.cos(latitude)
  const radius = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  return [
    (radius + heightMeters) * cosLatitude * Math.cos(longitude),
    (radius + heightMeters) * cosLatitude * Math.sin(longitude),
    (radius * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED) + heightMeters) * sinLatitude,
  ]
}

/** Bytes held by the mesh's arrays. */
export function extrusionMeshByteLength(mesh: ExtrusionMesh | null | undefined): number {
  if (mesh == null) return 0
  return extrusionMeshBuffers(mesh).reduce((sum, buffer) => sum + buffer.byteLength, 0)
}

/** The mesh's array buffers, to transfer. */
export function extrusionMeshBuffers(mesh: ExtrusionMesh | null | undefined): ArrayBufferLike[] {
  if (mesh == null) return []
  return [mesh.positions, mesh.flatPositions, mesh.normals, mesh.colors, mesh.heightDeltas, mesh.indices, mesh.buildingVertexStarts, mesh.buildingBounds].map(array => array.buffer)
}
