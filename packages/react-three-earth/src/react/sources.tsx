import { use, useImperativeHandle, useMemo, type Ref } from 'react'

import {
  MapStyleSource as MapStyleSourceImpl,
  QuantizedMeshSource as QuantizedMeshSourceImpl,
  RasterTileSource as RasterTileSourceImpl,
  type QuantizedMeshSourceOptions,
  type RasterTileSourceOptions,
  type MapStyleSourceOptions,
} from '../core/sources.js'
import { ImagerySourceContext, TerrainSourceContext, useRegisterSource } from './context.js'

export type QuantizedMeshSourceProps = QuantizedMeshSourceOptions

/** Quantized-mesh terrain (Re:Earth Terrain, Cesium World Terrain). Goes inside `<Terrain>`. */
export function QuantizedMeshSource({ url, skirtLengthMeters, smoothSkirtNormals }: QuantizedMeshSourceProps) {
  const source = useMemo(
    () => new QuantizedMeshSourceImpl({ url, skirtLengthMeters, smoothSkirtNormals }),
    [url, skirtLengthMeters, smoothSkirtNormals],
  )
  useRegisterSource(use(TerrainSourceContext), source, 'QuantizedMeshSource', 'Terrain')
  return null
}

export type RasterTileSourceProps = RasterTileSourceOptions

/** XYZ raster tiles. Goes inside `<Imagery>`. */
export function RasterTileSource({ url, levels, tileDimensionPixels, projection }: RasterTileSourceProps) {
  const source = useMemo(
    () => new RasterTileSourceImpl({ url, levels, tileDimensionPixels, projection }),
    [url, levels, tileDimensionPixels, projection],
  )
  useRegisterSource(use(ImagerySourceContext), source, 'RasterTileSource', 'Imagery')
  return null
}

export interface MapStyleSourceProps extends MapStyleSourceOptions {
  /** Receives the vanilla `MapStyleSource`, for `invalidate(bounds)` when tile data changed. */
  ref?: Ref<MapStyleSourceImpl>
}

/**
 * A MapLibre style (roads, water, labels…) from vector tiles or PMTiles, drawn on the terrain. Goes inside
 * `<Imagery>`. Changing `url` or `style` reloads it; keep a `style` object or `requestHeaders` stable
 * (memoised) to avoid reloads. To redraw after tile data changed, call `invalidate` on its `ref`.
 */
export function MapStyleSource({ ref, url, style, baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker }: MapStyleSourceProps) {
  const source = useMemo(
    () =>
      new MapStyleSourceImpl({
        ...(url !== undefined ? { url } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(requestHeaders !== undefined ? { requestHeaders } : {}),
        ...(localFontFamily !== undefined ? { localFontFamily } : {}),
        ...(maximumZoom !== undefined ? { maximumZoom } : {}),
        ...(createWorker !== undefined ? { createWorker } : {}),
      }),
    [url, style, baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker],
  )
  useImperativeHandle(ref, () => source, [source])
  useRegisterSource(use(ImagerySourceContext), source, 'MapStyleSource', 'Imagery')
  return null
}
