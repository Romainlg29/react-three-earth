// Synthetic terrain and imagery tiles for tests and offline work: no network needed.
// Terrain: quantized-mesh-1.0, TMS geographic tiling (2 x 1 tiles at level 0), ellipsoidal heights.
// https://github.com/CesiumGS/quantized-mesh

const WGS84_A = 6378137
const WGS84_E2 = 6.69437999014e-3
const GRID = 33
const MAX = 32767

export const FIXTURE_MAX_LEVEL = 14

/** A deterministic landscape: ridges up to about 4 km, sea level floor. */
export function fixtureHeightMeters(longitudeDegrees: number, latitudeDegrees: number): number {
  const lon = (longitudeDegrees * Math.PI) / 180
  const lat = (latitudeDegrees * Math.PI) / 180
  const ridges = Math.sin(lon * 7) * Math.cos(lat * 9) + 0.5 * Math.sin(lon * 31 + lat * 17)
  return Math.max(0, ridges) * 2600
}

/**
 * The water fixture: the same ridges with the sea left in, down to about −3900 m. Water is wherever it is below 0 m
 * (the tiles' water mask says so too).
 */
export function fixtureWaterHeightMeters(longitudeDegrees: number, latitudeDegrees: number): number {
  const lon = (longitudeDegrees * Math.PI) / 180
  const lat = (latitudeDegrees * Math.PI) / 180
  return (Math.sin(lon * 7) * Math.cos(lat * 9) + 0.5 * Math.sin(lon * 31 + lat * 17)) * 2600
}

const WATER_MASK_SIZE = 256

/**
 * The quantized-mesh `watermask` extension of a tile: 255 water, 0 land, sampled at pixel centres, rows from the north
 * and columns from the west; one byte when the tile is all one or the other.
 */
function waterMaskExtension(west: number, south: number, span: number): Uint8Array {
  const mask = new Uint8Array(WATER_MASK_SIZE * WATER_MASK_SIZE)
  for (let row = 0; row < WATER_MASK_SIZE; row++) {
    const latitude = south + span - ((row + 0.5) / WATER_MASK_SIZE) * span
    for (let column = 0; column < WATER_MASK_SIZE; column++) {
      const longitude = west + ((column + 0.5) / WATER_MASK_SIZE) * span
      mask[row * WATER_MASK_SIZE + column] = fixtureWaterHeightMeters(longitude, latitude) < 0 ? 255 : 0
    }
  }
  const uniform = mask.every(value => value === mask[0])
  const body = uniform ? mask.subarray(0, 1) : mask
  const extension = new Uint8Array(5 + body.length)
  const view = new DataView(extension.buffer)
  view.setUint8(0, 2) // extension id: water mask
  view.setUint32(1, body.length, true)
  extension.set(body, 5)
  return extension
}

function toECEF(lonDeg: number, latDeg: number, h: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2)
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - WGS84_E2) + h) * Math.sin(lat)]
}

const zigZag = (v: number) => ((v << 1) ^ (v >> 31)) & 0xffff

/** A tile of the fixture terrain; `water`: of the water fixture, with its water mask. */
export function encodeQuantizedMeshTile(level: number, x: number, y: number, { water = false }: { water?: boolean } = {}): Uint8Array {
  const heightMeters = water ? fixtureWaterHeightMeters : fixtureHeightMeters
  const span = 180 / 2 ** level
  const west = -180 + x * span
  const south = -90 + y * span

  const us: number[] = []
  const vs: number[] = []
  const heights: number[] = []
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      us.push(Math.round((i / (GRID - 1)) * MAX))
      vs.push(Math.round((j / (GRID - 1)) * MAX))
      heights.push(heightMeters(west + (i / (GRID - 1)) * span, south + (j / (GRID - 1)) * span))
    }
  }
  const minHeight = Math.min(...heights)
  const maxHeight = Math.max(...heights, minHeight + 1)
  const hs = heights.map(h => Math.round(((h - minHeight) / (maxHeight - minHeight)) * MAX))

  const center = toECEF(west + span / 2, south + span / 2, (minHeight + maxHeight) / 2)
  let radius = 0
  for (let k = 0; k < us.length; k++) {
    const p = toECEF(west + ((us[k] ?? 0) / MAX) * span, south + ((vs[k] ?? 0) / MAX) * span, heights[k] ?? 0)
    radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]))
  }

  const triangles: number[] = []
  for (let j = 0; j < GRID - 1; j++) {
    for (let i = 0; i < GRID - 1; i++) {
      const a = j * GRID + i
      const b = a + 1
      const c = a + GRID
      const d = c + 1
      triangles.push(a, b, d, a, d, c)
    }
  }
  // High-water-mark encoding expects indices to appear in increasing first-use order.
  const remap = new Map<number, number>()
  const order: number[] = []
  for (const t of triangles) if (!remap.has(t)) { remap.set(t, order.length); order.push(t) }
  const vertexCount = order.length
  const indices = triangles.map(t => remap.get(t) ?? 0)

  const west_ = [] as number[], south_ = [] as number[], east_ = [] as number[], north_ = [] as number[]
  for (let k = 0; k < GRID; k++) {
    west_.push(remap.get(k * GRID) ?? 0)
    east_.push(remap.get(k * GRID + GRID - 1) ?? 0)
    south_.push(remap.get(k) ?? 0)
    north_.push(remap.get((GRID - 1) * GRID + k) ?? 0)
  }

  const size = 88 + 4 + vertexCount * 6 + 2 + 4 + indices.length * 2 + 4 * 4 + GRID * 4 * 2 + 8
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  let p = 0
  const f64 = (v: number) => { view.setFloat64(p, v, true); p += 8 }
  const f32 = (v: number) => { view.setFloat32(p, v, true); p += 4 }
  const u32 = (v: number) => { view.setUint32(p, v, true); p += 4 }
  const u16 = (v: number) => { view.setUint16(p, v, true); p += 2 }

  center.forEach(f64)
  f32(minHeight)
  f32(maxHeight)
  center.forEach(f64)
  f64(radius)
  center.forEach(f64) // horizon occlusion point: unused by 3DTilesRenderer

  u32(vertexCount)
  for (const channel of [us, vs, hs]) {
    let previous = 0
    for (const original of order) {
      const value = channel[original] ?? 0
      u16(zigZag(value - previous))
      previous = value
    }
  }
  if (p % 2 !== 0) p += 1
  u32(indices.length / 3)
  let highest = 0
  for (const index of indices) {
    u16(highest - index)
    if (index === highest) highest++
  }
  for (const edge of [west_, south_, east_, north_]) {
    u32(edge.length)
    edge.forEach(u16)
  }
  const tile = new Uint8Array(buffer, 0, p)
  if (!water) return tile
  const extension = waterMaskExtension(west, south, span)
  const withMask = new Uint8Array(tile.length + extension.length)
  withMask.set(tile)
  withMask.set(extension, tile.length)
  return withMask
}

export function layerJson({ water = false }: { water?: boolean } = {}): object {
  const available = Array.from({ length: FIXTURE_MAX_LEVEL + 1 }, (_, level) => [
    { startX: 0, startY: 0, endX: 2 ** (level + 1) - 1, endY: 2 ** level - 1 },
  ])
  return {
    tilejson: '2.1.0',
    name: 'react-three-earth fixture terrain',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    projection: 'EPSG:4326',
    bounds: [-180, -90, 180, 90],
    tiles: ['{z}/{x}/{y}.terrain'],
    maxzoom: FIXTURE_MAX_LEVEL,
    available,
    ...(water ? { extensions: ['watermask'] } : {}),
  }
}
