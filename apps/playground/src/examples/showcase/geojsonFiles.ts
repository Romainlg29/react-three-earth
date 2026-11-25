import type { GeographicBounds } from '@earthkit/globe'
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'

/** A GeoJSON file the user dropped or opened, ready for a `<GeoJsonSource>`. */
export interface LoadedGeoJsonFile {
  /** The source id, and the prefix of its layer ids. */
  id: string
  name: string
  data: FeatureCollection
  /** Null when no feature has coordinates. */
  bounds: GeographicBounds | null
  /** The colour its layers draw with. */
  color: string
  /** The property its labels read (`name`, `title`…), or null for no labels. */
  labelProperty: string | null
  counts: { points: number; lines: number; polygons: number }
  visible: boolean
  /** Set for the one commit between leaving the list and leaving the map. */
  removed?: boolean
}

/** Colours for successive files: distinct on both streets and satellite imagery. */
const FILE_COLORS = ['#e8590c', '#7048e8', '#0ca678', '#d6336c', '#1c7ed6', '#f59f00', '#2b8a3e', '#c2255c']

/** Files above this size are refused: parsing them blocks the page for seconds. */
export const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024

const LABEL_PROPERTIES = ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'Label', 'name_en', 'NAME_EN']

const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'])

let nextFileNumber = 1

/** Any GeoJSON object (a collection, a feature, a bare geometry, or an array of features) as a feature collection. */
export function toFeatureCollection(input: unknown): FeatureCollection {
  if (Array.isArray(input)) return { type: 'FeatureCollection', features: input.map(toFeature) }
  if (typeof input !== 'object' || input === null || !('type' in input)) throw new Error('The file is not GeoJSON: it has no "type".')
  const object = input as { type: string; features?: unknown }
  if (object.type === 'FeatureCollection') {
    if (!Array.isArray(object.features)) throw new Error('The FeatureCollection has no "features" array.')
    return { type: 'FeatureCollection', features: object.features.map(toFeature) }
  }
  return { type: 'FeatureCollection', features: [toFeature(input)] }
}

function toFeature(input: unknown): Feature {
  const object = input as { type?: string }
  if (object?.type === 'Feature') return input as Feature
  if (object?.type !== undefined && GEOMETRY_TYPES.has(object.type)) return { type: 'Feature', properties: {}, geometry: input as Geometry }
  throw new Error(`Unexpected GeoJSON object of type "${String(object?.type)}": expected features or geometries.`)
}

/** The longitude-latitude box around every coordinate, or null when there is none. */
export function boundsOf(collection: FeatureCollection): GeographicBounds | null {
  const box = { westDegrees: Infinity, southDegrees: Infinity, eastDegrees: -Infinity, northDegrees: -Infinity }
  const visit = (position: Position) => {
    const [longitude, latitude] = position
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
    box.westDegrees = Math.min(box.westDegrees, longitude!)
    box.eastDegrees = Math.max(box.eastDegrees, longitude!)
    box.southDegrees = Math.min(box.southDegrees, latitude!)
    box.northDegrees = Math.max(box.northDegrees, latitude!)
  }
  for (const feature of collection.features) forEachPosition(feature.geometry, visit)
  return box.westDegrees <= box.eastDegrees ? box : null
}

function forEachPosition(geometry: Geometry | null, visit: (position: Position) => void): void {
  if (geometry === null || geometry === undefined) return
  switch (geometry.type) {
    case 'Point':
      visit(geometry.coordinates)
      return
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(visit)
      return
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach(line => line.forEach(visit))
      return
    case 'MultiPolygon':
      geometry.coordinates.forEach(polygon => polygon.forEach(ring => ring.forEach(visit)))
      return
    case 'GeometryCollection':
      geometry.geometries.forEach(part => forEachPosition(part, visit))
  }
}

/** How many features of each kind, which decides the layers a file gets. */
export function countGeometries(collection: FeatureCollection): LoadedGeoJsonFile['counts'] {
  const counts = { points: 0, lines: 0, polygons: 0 }
  const count = (geometry: Geometry | null) => {
    if (geometry === null || geometry === undefined) return
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') counts.points++
    else if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') counts.lines++
    else if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') counts.polygons++
    else geometry.geometries.forEach(count)
  }
  collection.features.forEach(feature => count(feature.geometry))
  return counts
}

/** The first common name-like property most features carry, for labels. */
export function guessLabelProperty(collection: FeatureCollection): string | null {
  const sample = collection.features.slice(0, 200)
  for (const key of LABEL_PROPERTIES) {
    const named = sample.filter(feature => typeof feature.properties?.[key] === 'string' && feature.properties[key] !== '').length
    if (named > 0 && named >= sample.length / 2) return key
  }
  return null
}

/** A file's text parsed and measured. Throws with a readable message when it is not GeoJSON. */
export function loadGeoJsonText(name: string, text: string): LoadedGeoJsonFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${name} is not valid JSON.`)
  }
  const data = toFeatureCollection(parsed)
  const number = nextFileNumber++
  return {
    id: `file-${number}`,
    name,
    data,
    bounds: boundsOf(data),
    color: FILE_COLORS[(number - 1) % FILE_COLORS.length]!,
    labelProperty: guessLabelProperty(data),
    counts: countGeometries(data),
    visible: true,
  }
}

/** Whether a dropped file looks like GeoJSON by its name or type. */
export function isGeoJsonFile(file: File): boolean {
  return /\.(geo)?json$/i.test(file.name) || file.type === 'application/geo+json' || file.type === 'application/json'
}

/** Reads and parses files, collecting the ones that failed with why. */
export async function readGeoJsonFiles(files: Iterable<File>): Promise<{ loaded: LoadedGeoJsonFile[]; errors: string[] }> {
  const loaded: LoadedGeoJsonFile[] = []
  const errors: string[] = []
  for (const file of files) {
    if (!isGeoJsonFile(file)) {
      errors.push(`${file.name}: only .geojson and .json files are read.`)
      continue
    }
    if (file.size > MAXIMUM_FILE_BYTES) {
      errors.push(`${file.name}: larger than ${MAXIMUM_FILE_BYTES / 1024 / 1024} MB. Simplify it first.`)
      continue
    }
    try {
      loaded.push(loadGeoJsonText(file.name, await file.text()))
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  return { loaded, errors }
}

/** The file's layer ids, the ones a click or hover reads. */
export function fileLayerIds(file: LoadedGeoJsonFile): string[] {
  return [`${file.id}-fill`, `${file.id}-line`, `${file.id}-circle`]
}

/** A small sample in the Alps, for trying the file layers without a file at hand. */
export function sampleGeoJsonText(): string {
  const collection: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Mont Blanc massif', kind: 'Massif', highestMeters: 4806 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[6.78, 45.78], [6.95, 45.83], [7.09, 45.9], [7.05, 45.98], [6.93, 45.95], [6.8, 45.88], [6.78, 45.78]]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'Haute Route', kind: 'Trek', lengthKilometers: 180 },
        geometry: {
          type: 'LineString',
          coordinates: [[6.8696, 45.9237], [6.9876, 46.0199], [7.0727, 46.1], [7.2289, 46.0959], [7.3601, 46.0255], [7.4956, 46.0089], [7.7491, 46.0207]],
        },
      },
      { type: 'Feature', properties: { name: 'Chamonix', kind: 'Town' }, geometry: { type: 'Point', coordinates: [6.8696, 45.9237] } },
      { type: 'Feature', properties: { name: 'Verbier', kind: 'Village' }, geometry: { type: 'Point', coordinates: [7.2289, 46.0959] } },
      { type: 'Feature', properties: { name: 'Arolla', kind: 'Village' }, geometry: { type: 'Point', coordinates: [7.4956, 46.0089] } },
      { type: 'Feature', properties: { name: 'Zermatt', kind: 'Town' }, geometry: { type: 'Point', coordinates: [7.7491, 46.0207] } },
    ],
  }
  return JSON.stringify(collection)
}
