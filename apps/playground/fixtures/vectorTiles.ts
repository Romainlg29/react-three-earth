import { encodeVectorTile, type EncodedFeature } from '../../../packages/react-three-earth/test/helpers/encodeVectorTile.ts'

/** Synthetic map data around Mount Fuji, in longitude and latitude degrees. */
const LAKES = [
  { name: 'Lake Kawaguchi', center: [138.76, 35.515], radius: 0.03 },
  { name: 'Lake Yamanaka', center: [138.87, 35.415], radius: 0.025 },
  { name: 'Lake Motosu', center: [138.585, 35.465], radius: 0.02 },
] as const

const PLACES = [
  { name: 'Mount Fuji', position: [138.7274, 35.3606], rank: 1 },
  { name: 'Fujinomiya', position: [138.6156, 35.2222], rank: 2 },
  { name: 'Gotemba', position: [138.9346, 35.3087], rank: 2 },
  { name: 'Fujiyoshida', position: [138.8077, 35.4875], rank: 2 },
] as const

/** A road grid every 0.05 degrees; every other road is a primary. */
function roads(): Array<{ name: string; kind: string; line: Array<[number, number]> }> {
  const result: Array<{ name: string; kind: string; line: Array<[number, number]> }> = []
  for (let index = 0; index <= 12; index++) {
    const longitude = 138.45 + index * 0.05
    const latitude = 35.1 + index * 0.05
    const kind = index % 2 === 0 ? 'primary' : 'minor'
    result.push({ name: `North Road ${index + 1}`, kind, line: [[longitude, 35.1], [longitude + 0.02, 35.35], [longitude, 35.7]] })
    result.push({ name: `East Road ${index + 1}`, kind, line: [[138.45, latitude], [138.75, latitude + 0.015], [139.05, latitude]] })
  }
  return result
}

function project(longitude: number, latitude: number, z: number, x: number, y: number): [number, number] {
  const scale = 2 ** z
  const latitudeRadians = (latitude * Math.PI) / 180
  const worldX = ((longitude + 180) / 360) * scale
  const worldY = ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * scale
  return [(worldX - x) * 4096, (worldY - y) * 4096]
}

const inTile = (points: Array<[number, number]>) => {
  const margin = 512
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  return Math.max(...xs) > -margin && Math.min(...xs) < 4096 + margin && Math.max(...ys) > -margin && Math.min(...ys) < 4096 + margin
}

/** One vector tile of the synthetic data: layers `water`, `roads` and `places`. `waterColor` tags the lakes. */
export function vectorTile(z: number, x: number, y: number, waterColor?: string): Uint8Array {
  const water: EncodedFeature[] = []
  for (const [index, lake] of LAKES.entries()) {
    const ring: Array<[number, number]> = []
    for (let step = 0; step <= 48; step++) {
      const angle = (-step / 48) * Math.PI * 2 // clockwise once y points down
      ring.push(project(lake.center[0] + Math.cos(angle) * lake.radius * 1.4, lake.center[1] + Math.sin(angle) * lake.radius, z, x, y))
    }
    if (inTile(ring)) water.push({ type: 'Polygon', id: index + 1, geometry: [ring], properties: { name: lake.name, ...(waterColor === undefined ? {} : { color: waterColor }) } })
  }
  const roadFeatures: EncodedFeature[] = []
  if (z >= 8) {
    for (const road of roads()) {
      const line = road.line.map(([longitude, latitude]) => project(longitude, latitude, z, x, y))
      if (inTile(line)) roadFeatures.push({ type: 'LineString', geometry: [line], properties: { name: road.name, class: road.kind } })
    }
  }
  const places: EncodedFeature[] = []
  for (const place of PLACES) {
    const point = project(place.position[0], place.position[1], z, x, y)
    if (point[0] >= 0 && point[0] < 4096 && point[1] >= 0 && point[1] < 4096) places.push({ type: 'Point', geometry: [[point]], properties: { name: place.name, rank: place.rank } })
  }
  return encodeVectorTile([
    { name: 'water', features: water },
    { name: 'roads', features: roadFeatures },
    { name: 'places', features: places },
  ])
}

/**
 * A MapLibre style over the synthetic tiles. No `glyphs`: labels use the local font. `live` reads the tiles
 * whose lake colour the invalidate check changes (`/fixtures/vector-live/`), and colours lakes from their data.
 */
export function fixtureStyle({ live = false }: { live?: boolean } = {}): object {
  return {
    version: 8,
    sources: { fixture: { type: 'vector', tiles: [live ? '/fixtures/vector-live/{z}/{x}/{y}.pbf' : '/fixtures/vector/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: '© <a href="https://example.com/fixture-map">Fixture map</a> data' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#efe9dc' } },
      { id: 'water', type: 'fill', source: 'fixture', 'source-layer': 'water', paint: { 'fill-color': ['to-color', ['get', 'color'], '#5fa8e8'] } },
      {
        id: 'road-casing',
        type: 'line',
        source: 'fixture',
        'source-layer': 'roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#9a8a70', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 2, 16, 18] },
      },
      {
        id: 'road',
        type: 'line',
        source: 'fixture',
        'source-layer': 'roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], 'primary', '#f2b33d', '#ffffff'],
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 1, 16, 14],
        },
      },
      {
        id: 'road-label',
        type: 'symbol',
        source: 'fixture',
        'source-layer': 'roads',
        minzoom: 11,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: 'fixture',
        'source-layer': 'places',
        layout: { 'text-field': '{name}', 'text-size': ['match', ['get', 'rank'], 1, 18, 15], 'text-font': ['Noto Sans Bold'] },
        paint: { 'text-color': '#1d1d1d', 'text-halo-color': 'rgba(255, 255, 255, 0.9)', 'text-halo-width': 2 },
      },
    ],
  }
}
