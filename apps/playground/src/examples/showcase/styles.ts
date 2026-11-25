import { rasterAttribution, rasterTilesUrl, useFixtures, vectorSchema } from '../data'

/** The basemaps the showcase switches between. `stylised` has no imagery: the terrain material colours the ground. */
export type Basemap = 'streets' | 'satellite' | 'stylised'

/** EOX's Sentinel-2 cloudless mosaic (s2maps.eu); `VITE_SATELLITE_URL` overrides it, `?fixtures` uses the fixture imagery. */
const satellite = useFixtures
  ? { tiles: [rasterTilesUrl], maxzoom: 18, attribution: rasterAttribution }
  : {
      tiles: [import.meta.env.VITE_SATELLITE_URL ?? 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
      maxzoom: 15,
      attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data)',
    }

export interface StreetsOptions {
  buildings: boolean
  labels: boolean
}

/** A light street map from OpenMapTiles vector tiles: water, roads, optional 3D buildings and place names. */
export function streetsStyle({ buildings, labels }: StreetsOptions): object {
  const { source, water, roads, majorRoadClasses, places, buildings: buildingLayer, buildingHeight, buildingBase } = vectorSchema
  return {
    version: 8,
    sources: { map: source },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ece7de' } },
      { id: 'water', type: 'fill', source: 'map', 'source-layer': water, paint: { 'fill-color': '#9fc4e4' } },
      {
        id: 'roads',
        type: 'line',
        source: 'map',
        'source-layer': roads,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], majorRoadClasses, '#f6cf7e', '#ffffff'],
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.5, 18, 20],
        },
      },
      ...(buildings
        ? [
            {
              id: 'buildings-3d',
              type: 'fill-extrusion',
              source: 'map',
              'source-layer': buildingLayer,
              minzoom: 13,
              paint: {
                'fill-extrusion-color': ['interpolate', ['linear'], buildingHeight, 0, '#e3dacb', 40, '#d2c1a6', 120, '#9fb0c8', 300, '#5f83bb'],
                'fill-extrusion-height': buildingHeight,
                'fill-extrusion-base': buildingBase,
                'fill-extrusion-opacity': 0.95,
              },
            },
          ]
        : []),
      ...(labels
        ? [
            {
              id: 'places',
              type: 'symbol',
              source: 'map',
              'source-layer': places,
              layout: {
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-size': ['match', ['get', 'class'], 'city', 17, 'town', 14, 12],
                'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
              },
              paint: { 'text-color': '#2b2b33', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
            },
          ]
        : []),
    ],
  }
}

/** Satellite pictures, with place names on top when asked. */
export function satelliteStyle({ labels }: Pick<StreetsOptions, 'labels'>): object {
  const { source, places } = vectorSchema
  return {
    version: 8,
    sources: { satellite: { type: 'raster', tileSize: 256, ...satellite }, map: source },
    layers: [
      { id: 'satellite', type: 'raster', source: 'satellite' },
      ...(labels
        ? [
            {
              id: 'places',
              type: 'symbol',
              source: 'map',
              'source-layer': places,
              layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-size': ['match', ['get', 'class'], 'city', 17, 'town', 14, 12] },
              paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.75)', 'text-halo-width': 1.5 },
            },
          ]
        : []),
    ],
  }
}

/** No basemap layers at all: the data layers draw straight on the stylised terrain. */
export const EMPTY_STYLE: object = { version: 8, sources: {}, layers: [] }

export function basemapStyle(basemap: Basemap, options: StreetsOptions): object {
  if (basemap === 'streets') return streetsStyle(options)
  if (basemap === 'satellite') return satelliteStyle(options)
  return EMPTY_STYLE
}

/** What the compare slider shows on its other side: the basemap the main one is not. */
export function comparedStyle(basemap: Basemap): object {
  return basemap === 'satellite' ? streetsStyle({ buildings: true, labels: false }) : satelliteStyle({ labels: false })
}
