import { encodeVectorTile, type EncodedFeature } from '../../../packages/react-three-earth/test/helpers/encodeVectorTile.ts'
import { encodePngRgba } from './png.ts'

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

/** A grid of towns around the mountain, 0.025° apart (about 2.5 km): dense enough that labels collide below zoom 12. */
const TOWNS = Array.from({ length: 12 * 10 }, (_, index) => {
  const column = index % 12
  const row = Math.floor(index / 12)
  return { name: `Town ${String.fromCharCode(65 + row)}${column + 1}`, position: [138.6 + column * 0.025, 35.25 + row * 0.025] as const, rank: (column % 3) + (row % 2) * 3 }
})

/**
 * Place names in other scripts (`?map=scripts`), in a column west of the mountain, for the right-to-left and
 * complex script check: Arabic (joined letters, a lam-alef), Hebrew, Arabic with digits, and Latin mixed with Hebrew.
 */
export const SCRIPT_PLACES = [
  { name: 'القاهرة', position: [138.62, 35.42] },
  { name: 'תל אביב', position: [138.62, 35.39] },
  { name: 'شارع السلام 12', position: [138.62, 35.36] },
  { name: 'Haifa (חיפה)', position: [138.62, 35.33] },
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

/** Where the fixture buildings stand: the fixture terrain's peak plateau (3900 m), on the corner of four tiles at every zoom. */
export const BUILDINGS_CENTER = [-90, 0] as const
const METERS_PER_DEGREE = 111_320

interface FixtureBuilding {
  /** Outer ring then holes, each as [east, north] metres from `BUILDINGS_CENTER`, counter-clockwise. */
  rings: Array<Array<[number, number]>>
  properties: { height: number; base: number; color: string; kind: string }
}

function rectangle(east: number, north: number, width: number, depth: number): Array<[number, number]> {
  return [
    [east - width / 2, north - depth / 2],
    [east + width / 2, north - depth / 2],
    [east + width / 2, north + depth / 2],
    [east - width / 2, north + depth / 2],
  ]
}

/**
 * A block of buildings: a 5 × 5 grid of 40 m squares 100 m apart, 20 to 120 m tall (the 100 m and taller ones red);
 * in the middle, across the corner of four tiles, a red courtyard building (80 m square, 30 m hole, 100 m); a blue
 * glass tower east (layer `building-glass`, translucent) and a raised block west (base 40 m, roof 60 m).
 */
const BUILDINGS: FixtureBuilding[] = [
  ...Array.from({ length: 25 }, (_, index): FixtureBuilding | null => {
    const column = index % 5
    const row = Math.floor(index / 5)
    if (column === 2 && row === 2) return null
    const height = 20 + ((column * 7 + row * 13) % 6) * 20
    return { rings: [rectangle((column - 2) * 100, (row - 2) * 100, 40, 40)], properties: { height, base: 0, color: height >= 100 ? '#d03030' : '#c8b89a', kind: 'block' } }
  }).filter(building => building !== null),
  { rings: [rectangle(0, 0, 80, 80), rectangle(0, 0, 30, 30).reverse()], properties: { height: 100, base: 0, color: '#d03030', kind: 'courtyard' } },
  { rings: [rectangle(320, 0, 60, 40)], properties: { height: 150, base: 0, color: '#2050e0', kind: 'glass' } },
  { rings: [rectangle(-320, 0, 60, 40)], properties: { height: 60, base: 40, color: '#c8b89a', kind: 'raised' } },
]

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
  const towns: EncodedFeature[] = []
  if (z >= 8) {
    for (const town of TOWNS) {
      const point = project(town.position[0], town.position[1], z, x, y)
      if (point[0] >= 0 && point[0] < 4096 && point[1] >= 0 && point[1] < 4096) towns.push({ type: 'Point', geometry: [[point]], properties: { name: town.name, rank: town.rank } })
    }
  }
  const scripts: EncodedFeature[] = []
  for (const place of SCRIPT_PLACES) {
    const point = project(place.position[0], place.position[1], z, x, y)
    if (point[0] >= 0 && point[0] < 4096 && point[1] >= 0 && point[1] < 4096) scripts.push({ type: 'Point', geometry: [[point]], properties: { name: place.name } })
  }
  const buildings: EncodedFeature[] = []
  if (z >= 13) {
    for (const [index, building] of BUILDINGS.entries()) {
      // Tile rows run south: counter-clockwise rings in east-north turn clockwise in tile units, as MVT outer rings.
      const rings = building.rings.map(ring => {
        const points = ring.map(([east, north]) => project(BUILDINGS_CENTER[0] + east / METERS_PER_DEGREE, BUILDINGS_CENTER[1] + north / METERS_PER_DEGREE, z, x, y))
        return [...points, points[0]!]
      })
      if (inTile(rings[0]!)) buildings.push({ type: 'Polygon', id: index + 1, geometry: rings, properties: building.properties })
    }
  }
  return encodeVectorTile([
    { name: 'buildings', features: buildings },
    { name: 'water', features: water },
    { name: 'roads', features: roadFeatures },
    { name: 'places', features: places },
    { name: 'towns', features: towns },
    { name: 'scripts', features: scripts },
  ])
}

type Rgba = [number, number, number, number]

/** Fixture sprite images at pixel ratio 1, as functions of the pixel: placed side by side in the sheet. */
const SPRITE_IMAGES: Array<{ name: string; width: number; height: number; sdf?: boolean; pixel: (x: number, y: number) => Rgba }> = [
  // Green checks for the background
  { name: 'meadow', width: 8, height: 8, pixel: (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? [80, 170, 60, 255] : [170, 225, 120, 255] },
  // Dark and light blue stripes for the lakes
  { name: 'waves', width: 8, height: 8, pixel: (_x, y) => (y < 4 ? [20, 70, 200, 255] : [140, 200, 255, 255]) },
  // Red and white dashes along the primary roads, transparent at the edges
  { name: 'arrows', width: 16, height: 8, pixel: (x, y) => (y === 0 || y === 7 ? [0, 0, 0, 0] : x < 8 ? [225, 30, 30, 255] : [255, 255, 255, 255]) },
  // A red disc with a white rim, transparent around: the place icon
  { name: 'pin', width: 16, height: 16, pixel: (x, y) => { const distance = Math.hypot(x - 7.5, y - 7.5); return distance > 7 ? [0, 0, 0, 0] : distance > 5 ? [255, 255, 255, 255] : [230, 30, 30, 255] } },
  // A disc as a signed distance field in alpha (192 at its edge, 24 a pixel), tinted by icon-color: the summit icon
  { name: 'peak', width: 16, height: 16, sdf: true, pixel: (x, y) => [0, 0, 0, Math.max(0, Math.min(255, Math.round(192 + (5 - Math.hypot(x - 7.5, y - 7.5)) * 24)))] },
]

/** The fixture sprite sheet and index at a pixel ratio (1 or 2; the @2x images are the 1x ones doubled). */
export function fixtureSprite(pixelRatio: 1 | 2): { json: object; png: Uint8Array } {
  const json: Record<string, object> = {}
  let x = 0
  for (const image of SPRITE_IMAGES) {
    json[image.name] = { x: x * pixelRatio, y: 0, width: image.width * pixelRatio, height: image.height * pixelRatio, pixelRatio, ...(image.sdf === true ? { sdf: true } : {}) }
    x += image.width
  }
  const width = x * pixelRatio
  const height = Math.max(...SPRITE_IMAGES.map(image => image.height)) * pixelRatio
  const png = encodePngRgba(width, height, (px, py) => {
    let left = 0
    for (const image of SPRITE_IMAGES) {
      const localX = Math.floor(px / pixelRatio) - left
      if (localX < image.width) return Math.floor(py / pixelRatio) < image.height ? image.pixel(localX, Math.floor(py / pixelRatio)) : [0, 0, 0, 0]
      left += image.width
    }
    return [0, 0, 0, 0]
  })
  return { json, png }
}

/**
 * The fixture style with patterns: a `background-pattern`, lakes and primary roads drawn with sprite images,
 * and Lake Motosu with an image (`hatch`) the sprite lacks, for `addImage` and `onStyleImageMissing`.
 */
export function fixturePatternStyle(): object {
  const base = fixtureStyle() as { layers: Array<Record<string, unknown>> } & Record<string, unknown>
  const layers = base.layers.flatMap(layer => {
    if (layer.id === 'background') return [{ id: 'background', type: 'background', paint: { 'background-pattern': 'meadow' } }]
    if (layer.id === 'water') {
      return [
        { id: 'water', type: 'fill', source: 'fixture', 'source-layer': 'water', filter: ['!=', ['get', 'name'], 'Lake Motosu'], paint: { 'fill-pattern': 'waves' } },
        { id: 'water-runtime', type: 'fill', source: 'fixture', 'source-layer': 'water', filter: ['==', ['get', 'name'], 'Lake Motosu'], paint: { 'fill-pattern': 'hatch' } },
      ]
    }
    if (layer.id === 'road') {
      return [
        layer,
        {
          id: 'road-pattern',
          type: 'line',
          source: 'fixture',
          'source-layer': 'roads',
          filter: ['==', ['get', 'class'], 'primary'],
          layout: { 'line-join': 'round' },
          paint: { 'line-pattern': 'arrows', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 4, 16, 24] },
        },
      ]
    }
    return [layer]
  })
  return { ...base, sprite: '/fixtures/sprite', layers }
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

/**
 * The fixture style with a dense grid of town labels under the place labels: they collide with each other and with
 * the places, sort by rank, grow with zoom (12 px at zoom 9 to 16 px at zoom 13) and try five anchors. Places
 * have icons from the fixture sprite: a red pin, and Mount Fuji a blue SDF disc with a white halo, text below.
 */
export function fixtureLabelStyle({ symbolEffect }: { symbolEffect?: string | null } = {}): object {
  const base = fixtureStyle() as { layers: Array<Record<string, unknown>> } & Record<string, unknown>
  const placeIndex = base.layers.findIndex(layer => layer.id === 'place-label')
  const towns = {
    id: 'town-label',
    type: 'symbol',
    source: 'fixture',
    'source-layer': 'towns',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 13, 16],
      'text-font': ['Noto Sans Regular'],
      'symbol-sort-key': ['get', 'rank'],
      'text-padding': 2,
      // Placement tries each in turn: a town crowded at its centre moves beside its point.
      'text-variable-anchor': ['center', 'left', 'right', 'top', 'bottom'],
    },
    paint: { 'text-color': '#4a3b22', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    // A symbol effect from a plugin (`?neon` in the playground), named in the layer's metadata.
    ...(symbolEffect ? { metadata: { 'react-three-earth:symbol-effect': symbolEffect } } : {}),
  }
  const places = base.layers[placeIndex] as { layout: Record<string, unknown>; paint: Record<string, unknown> }
  const placesWithIcons = {
    ...places,
    layout: { ...places.layout, 'icon-image': ['match', ['get', 'name'], 'Mount Fuji', 'peak', 'pin'], 'icon-size': 1.25, 'text-anchor': 'top', 'text-offset': [0, 0.8] },
    paint: { ...places.paint, 'icon-color': '#1040e0', 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.5 },
  }
  return { ...base, sprite: '/fixtures/sprite', layers: [...base.layers.slice(0, placeIndex), towns, placesWithIcons, ...base.layers.slice(placeIndex + 1)] }
}

/** The fixture style with the place names in other scripts (layer `script-label`), large and never hidden by collisions. */
export function fixtureScriptStyle(): object {
  const base = fixtureStyle() as { layers: Array<Record<string, unknown>> } & Record<string, unknown>
  const scripts = {
    id: 'script-label',
    type: 'symbol',
    source: 'fixture',
    'source-layer': 'scripts',
    layout: { 'text-field': ['get', 'name'], 'text-size': 22, 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#4a3b22', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  }
  return { ...base, layers: [...base.layers, scripts] }
}

/**
 * The relief style (`/fixtures/style-relief.json`): fixture imagery as a `raster` layer, colour relief and
 * hillshade from a Terrarium `raster-dem` source of the fixture heights (`/fixtures/dem/{z}/{x}/{y}.png`), with
 * the fixture's lakes, roads and labels on top. `only=hillshade` keeps a mid-grey background and the hillshade.
 */
export function fixtureReliefStyle({ only }: { only?: string | null } = {}): object {
  const vector = fixtureStyle() as { sources: Record<string, unknown>; layers: Array<{ id: string }> }
  const relief = [
    { id: 'satellite', type: 'raster', source: 'imagery', paint: { 'raster-saturation': -0.3 } },
    {
      id: 'relief',
      type: 'color-relief',
      source: 'dem',
      paint: {
        'color-relief-opacity': 0.55,
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#3f8f4f', 1000, '#e8d77a', 2500, '#9c6b3f', 3800, '#ffffff'],
      },
    },
    { id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.6 } },
  ]
  const sources = {
    ...vector.sources,
    imagery: { type: 'raster', tiles: ['/fixtures/imagery/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18, attribution: 'Fixture imagery' },
    dem: { type: 'raster-dem', tiles: ['/fixtures/dem/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 12, encoding: 'terrarium', attribution: 'Fixture elevation' },
  }
  if (only === 'hillshade') {
    return {
      version: 8,
      sources: { dem: sources.dem },
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#808080' } }, relief[2]],
    }
  }
  const [background, ...rest] = vector.layers
  return { version: 8, sources, layers: [background, ...relief, ...rest] }
}

/** The fixture style with the buildings standing in 3D (`fill-extrusion`), from zoom 13. */
export function fixtureBuildingStyle(): object {
  const base = fixtureStyle() as { layers: Array<Record<string, unknown>> } & Record<string, unknown>
  const roadLabel = base.layers.findIndex(layer => layer.id === 'road-label')
  const buildings = [
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'fixture',
      'source-layer': 'buildings',
      minzoom: 13,
      filter: ['!=', ['get', 'kind'], 'glass'],
      paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'base'] },
    },
    {
      id: 'building-glass',
      type: 'fill-extrusion',
      source: 'fixture',
      'source-layer': 'buildings',
      minzoom: 13,
      filter: ['==', ['get', 'kind'], 'glass'],
      paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.6 },
    },
  ]
  return { ...base, layers: [...base.layers.slice(0, roadLabel), ...buildings, ...base.layers.slice(roadLabel)] }
}
