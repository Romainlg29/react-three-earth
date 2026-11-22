import { use, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from 'react'

import {
  MapStyleSource as MapStyleSourceImpl,
  QuantizedMeshSource as QuantizedMeshSourceImpl,
  RasterTileSource as RasterTileSourceImpl,
  type QuantizedMeshSourceOptions,
  type RasterTileSourceOptions,
  type MapStyleSourceOptions,
} from '../core/sources.js'
import type { AttributionTracker } from '../core/attribution.js'
import { ImagerySourceContext, TerrainSourceContext, useRegisterSource } from './context.js'

/** Applies a changed `attribution` prop to the source without rebuilding it (which would reload tiles). */
function useAttribution(source: AttributionTracker, attribution: string | readonly string[] | undefined): void {
  const key = typeof attribution === 'string' ? attribution : attribution?.join('\0')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => source.setAttribution(attribution), [source, key])
}

export type QuantizedMeshSourceProps = QuantizedMeshSourceOptions

/** Quantized-mesh terrain (Re:Earth Terrain, Cesium World Terrain). Goes inside `<Terrain>`. */
export function QuantizedMeshSource({ url, skirtLengthMeters, smoothSkirtNormals, attribution }: QuantizedMeshSourceProps) {
  const source = useMemo(
    // attribution changes are applied below, without reloading tiles
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => new QuantizedMeshSourceImpl({ url, skirtLengthMeters, smoothSkirtNormals, attribution }),
    [url, skirtLengthMeters, smoothSkirtNormals],
  )
  useAttribution(source, attribution)
  useRegisterSource(use(TerrainSourceContext), source, 'QuantizedMeshSource', 'Terrain')
  return null
}

export type RasterTileSourceProps = RasterTileSourceOptions

/** XYZ raster tiles. Goes inside `<Imagery>`. */
export function RasterTileSource({ url, levels, tileDimensionPixels, projection, attribution }: RasterTileSourceProps) {
  const source = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => new RasterTileSourceImpl({ url, levels, tileDimensionPixels, projection, attribution }),
    [url, levels, tileDimensionPixels, projection],
  )
  useAttribution(source, attribution)
  useRegisterSource(use(ImagerySourceContext), source, 'RasterTileSource', 'Imagery')
  return null
}

export interface MapStyleSourceProps extends MapStyleSourceOptions {
  /** Receives the vanilla `MapStyleSource`: `invalidate(bounds)` when tile data changed, `addImage` for patterns. */
  ref?: Ref<MapStyleSourceImpl>
}

/**
 * A MapLibre style (roads, water, labels…) from vector tiles or PMTiles, drawn on the terrain. Goes inside
 * `<Imagery>`. Changing `url` or `style` reloads it; keep a `style` object or `requestHeaders` stable
 * (memoised) to avoid reloads. To redraw after tile data changed, call `invalidate` on its `ref`.
 */
export function MapStyleSource({
  ref,
  url,
  style,
  baseUrl,
  requestHeaders,
  localFontFamily,
  maximumZoom,
  createWorker,
  attribution,
  spritePixelRatio,
  onStyleImageMissing,
}: MapStyleSourceProps) {
  // The latest handler, without reloading the source when an inline arrow changes.
  const onStyleImageMissingRef = useRef(onStyleImageMissing)
  useLayoutEffect(() => void (onStyleImageMissingRef.current = onStyleImageMissing))
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
        ...(attribution !== undefined ? { attribution } : {}),
        ...(spritePixelRatio !== undefined ? { spritePixelRatio } : {}),
        onStyleImageMissing: imageId => onStyleImageMissingRef.current?.(imageId),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, style, baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker, spritePixelRatio],
  )
  useAttribution(source, attribution)
  useImperativeHandle(ref, () => source, [source])
  useRegisterSource(use(ImagerySourceContext), source, 'MapStyleSource', 'Imagery')
  return null
}
