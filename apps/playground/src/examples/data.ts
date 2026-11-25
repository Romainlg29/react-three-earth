import { prefersWebGLBackend, type CameraView } from '@earthkit/globe'

/**
 * Where the examples read their data. The live pages stream free public services (no key): Re:Earth terrain,
 * OpenStreetMap raster tiles, OpenFreeMap vector tiles (OpenMapTiles schema) and Terrarium elevation on AWS.
 * `?fixtures` swaps every URL for the playground's synthetic tiles, for the browser checks (the sandbox reaches
 * no tile host). Override the live hosts in apps/playground/.env.
 */
export const params = new URLSearchParams(location.search)
export const useFixtures = params.has('fixtures')
const base = import.meta.env.BASE_URL

export const terrainUrl = useFixtures ? `${base}fixtures/terrain/` : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
export const terrainAttribution = useFixtures ? 'Synthetic test terrain' : 'Terrain: Re:Earth Terrain, Mapterhorn'
export const rasterTilesUrl = useFixtures ? `${base}fixtures/imagery/{z}/{x}/{y}.png` : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
export const rasterAttribution = useFixtures ? 'Fixture imagery' : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
export const elevationTilesUrl = useFixtures
  ? `${base}fixtures/dem/{z}/{x}/{y}.png`
  : (import.meta.env.VITE_DEM_URL ?? 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png')
export const elevationAttribution = useFixtures ? 'Synthetic test elevation' : 'Elevation: Mapzen, AWS Terrain Tiles'

/** WebGL 2 where WebGPU is slow (Safari); `?webgl` forces it, `?webgpu` forces WebGPU. */
export const forceWebGL = params.has('webgl') || (!params.has('webgpu') && prefersWebGLBackend())
export const withAtmosphere = params.get('atmosphere') !== '0'

/**
 * The vector tile layers the examples' styles read. OpenMapTiles names live (OpenFreeMap); the fixture tiles name
 * theirs differently and carry a few of each, so the same style functions draw both.
 */
export interface VectorSchema {
  source: Record<string, unknown>
  water: string
  roads: string
  /** Line features with a `name`, for road labels. */
  roadNames: string
  /** Road class values that count as major roads. */
  majorRoadClasses: string[]
  places: string
  buildings: string
  buildingHeight: unknown
  buildingBase: unknown
}

export const vectorSchema: VectorSchema = useFixtures
  ? {
      source: { type: 'vector', tiles: [`${base}fixtures/vector/{z}/{x}/{y}.pbf`], maxzoom: 14, attribution: 'Fixture map data' },
      water: 'water',
      roads: 'roads',
      roadNames: 'roads',
      majorRoadClasses: ['primary'],
      places: 'scripts',
      buildings: 'buildings',
      buildingHeight: ['get', 'height'],
      buildingBase: ['get', 'base'],
    }
  : {
      source: { type: 'vector', url: import.meta.env.VITE_OPENMAPTILES_URL ?? 'https://tiles.openfreemap.org/planet' },
      water: 'water',
      roads: 'transportation',
      roadNames: 'transportation_name',
      majorRoadClasses: ['motorway', 'trunk', 'primary'],
      places: 'place',
      buildings: 'building',
      buildingHeight: ['coalesce', ['get', 'render_height'], 8],
      buildingBase: ['coalesce', ['get', 'render_min_height'], 0],
    }

/** A raster basemap as a one-layer style, so GeoJSON layers can sit on it. `paint` tints it. */
export function rasterBasemapStyle(paint: Record<string, unknown> = {}): object {
  return {
    version: 8,
    sources: { basemap: { type: 'raster', tiles: [rasterTilesUrl], tileSize: 256, maxzoom: useFixtures ? 18 : 19, attribution: rasterAttribution } },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap', paint }],
  }
}

/** A camera view from `?camera=longitude,latitude,height,distance,heading,pitch`, else `fallback`. */
export function cameraFromParams(fallback: CameraView): CameraView {
  const given = params.get('camera')?.split(',') ?? []
  const keys = ['longitudeDegrees', 'latitudeDegrees', 'heightMeters', 'distanceMeters', 'headingDegrees', 'pitchDegrees'] as const
  const view = { ...fallback }
  keys.forEach((key, index) => {
    const value = Number.parseFloat(given[index] ?? '')
    if (Number.isFinite(value)) view[key] = value
  })
  return view
}
