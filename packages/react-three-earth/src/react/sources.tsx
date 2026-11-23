import { use, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'

import {
  MapStyleSource as MapStyleSourceImpl,
  QuantizedMeshSource as QuantizedMeshSourceImpl,
  RasterTileSource as RasterTileSourceImpl,
  type QuantizedMeshSourceOptions,
  type RasterTileSourceOptions,
  type MapStyleSourceOptions,
} from '../core/sources.js'
import type { AttributionTracker } from '../core/attribution.js'
import type { TransformRequest } from '../vector/MapStyle.js'
import { StyleLayer as StyleLayerImpl, type StyleLayerOptions } from '../vector/StyleLayer.js'
import { ImagerySourceContext, MapStyleSourceContext, TerrainSourceContext, useRegisterSource } from './context.js'

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
  /** Receives the vanilla `MapStyleSource`: the runtime style API (`setFeatureState`, `setPaintProperty`…), `addImage` for patterns and `invalidate(bounds)`. */
  ref?: Ref<MapStyleSourceImpl>
  /** `<StyleLayer>` elements: layers the app adds to the style. */
  children?: ReactNode
}

/**
 * A MapLibre style (roads, water, labels…) from vector tiles or PMTiles, drawn on the terrain. Goes inside
 * `<Imagery>`. A new `url` or `style` is applied with `setStyle` (diffed: only what changed is processed again).
 * Keep `requestHeaders`, `protocols` and `createWorker` stable (memoised): changing them reloads the source.
 * Holds `<StyleLayer>` children. The runtime style API is on its `ref`.
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
  symbols,
  symbolFadeDurationSeconds,
  onStyleImageMissing,
  transformRequest,
  protocols,
  children,
}: MapStyleSourceProps) {
  const styleInput = url ?? style
  const [retries, setRetries] = useState(0)
  // The latest transformRequest, read when a request is made: a new function does not reload the source.
  const latestTransform = useRef(transformRequest)
  useLayoutEffect(() => {
    latestTransform.current = transformRequest
  })
  const hasTransform = transformRequest !== undefined
  // The latest handler, without reloading the source when an inline arrow changes.
  const onStyleImageMissingRef = useRef(onStyleImageMissing)
  useLayoutEffect(() => void (onStyleImageMissingRef.current = onStyleImageMissing))
  const source = useMemo(
    () => {
      const stableTransform: TransformRequest = (requestUrl, kind) => latestTransform.current?.(requestUrl, kind)
      return new MapStyleSourceImpl({
        ...(url !== undefined ? { url } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(requestHeaders !== undefined ? { requestHeaders } : {}),
        ...(localFontFamily !== undefined ? { localFontFamily } : {}),
        ...(maximumZoom !== undefined ? { maximumZoom } : {}),
        ...(createWorker !== undefined ? { createWorker } : {}),
        ...(attribution !== undefined ? { attribution } : {}),
        ...(hasTransform ? { transformRequest: stableTransform } : {}),
        ...(protocols !== undefined ? { protocols } : {}),
        ...(spritePixelRatio !== undefined ? { spritePixelRatio } : {}),
        ...(symbols !== undefined ? { symbols } : {}),
        ...(symbolFadeDurationSeconds !== undefined ? { symbolFadeDurationSeconds } : {}),
        onStyleImageMissing: imageId => onStyleImageMissingRef.current?.(imageId),
      })
    },
    // url and style are applied below with setStyle; attribution by useAttribution
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker, hasTransform, protocols, spritePixelRatio, symbols, symbolFadeDurationSeconds, retries],
  )
  const applied = useRef<{ source: MapStyleSourceImpl; style: unknown } | null>(null)
  useEffect(() => {
    const previous = applied.current
    applied.current = { source, style: styleInput }
    if (previous === null || previous.source !== source || previous.style === styleInput || styleInput === undefined) return
    // The first style never loaded (a wrong URL, say): start over with the new one.
    if (source.getMapStyle().loadFailed) {
      setRetries(count => count + 1)
      return
    }
    source.setStyle(styleInput).catch((error: unknown) => {
      if (applied.current?.source !== source) return // a newer source took over meanwhile
      // The first style failed while this one waited for it: start over with this one.
      if (source.getMapStyle().loadFailed) {
        setRetries(count => count + 1)
        return
      }
      console.warn(`MapStyleSource: the new style could not be applied. ${(error as Error).message}`)
    })
  }, [source, styleInput])
  useAttribution(source, attribution)
  useImperativeHandle(ref, () => source, [source])
  useRegisterSource(use(ImagerySourceContext), source, 'MapStyleSource', 'Imagery')
  return <MapStyleSourceContext value={source}>{children}</MapStyleSourceContext>
}

export type StyleLayerProps = StyleLayerOptions

/**
 * A style layer the app adds to its `<MapStyleSource>`, MapLibre style: `<StyleLayer id="hover" type="fill"
 * source="base" sourceLayer="buildings" paint={{ 'fill-color': '#f80' }} />`. Prop changes send only what changed;
 * `beforeId` places it below another layer. Wraps the vanilla `StyleLayer`.
 */
export function StyleLayer(props: StyleLayerProps) {
  const source = use(MapStyleSourceContext)
  if (source === null) throw new Error('<StyleLayer> must sit inside <MapStyleSource>.')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layer = useMemo(() => new StyleLayerImpl(props), [props.id])
  // A change that does not apply (a `beforeId` naming no layer, for example) is reported as an `error` event
  // on the source rather than thrown, so it cannot take the React tree down.
  const report = (error: unknown) => source.getMapStyle().reportError(error as Error)
  useLayoutEffect(() => {
    try {
      layer.addTo(source)
    } catch (error) {
      report(error)
    }
    return () => layer.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, source])
  useLayoutEffect(() => {
    try {
      layer.update(props)
    } catch (error) {
      report(error)
    }
  })
  return null
}
