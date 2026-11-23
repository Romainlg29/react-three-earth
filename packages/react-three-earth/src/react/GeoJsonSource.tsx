import { use, useImperativeHandle, useLayoutEffect, useMemo, useState, type ReactNode, type Ref } from 'react'

import type { MapStyleSource } from '../core/sources.js'
import { GeoJsonSource as GeoJsonSourceImpl, type GeoJsonSourceOptions } from '../vector/GeoJsonSource.js'
import { GeoJsonSourceContext, MapStyleSourceContext } from './context.js'

export interface GeoJsonSourceProps extends GeoJsonSourceOptions {
  /** Receives the vanilla `GeoJsonSource`: `updateData` (changes by id) and the cluster queries. */
  ref?: Ref<GeoJsonSourceImpl>
  /** `<StyleLayer>` elements drawing the data; their `source` defaults to this source. */
  children?: ReactNode
}

/**
 * GeoJSON data drawn by the style of the enclosing `<MapStyleSource>`: routes, points, user data, tiled in the
 * worker, points optionally clustered. Holds the `<StyleLayer>`s that draw it. A new `data` object is sent with
 * `setData` (only the regions where the data changed are redrawn); other prop changes cut the tiles again. Keep
 * `data` memoised, and change features by id through the ref's `updateData` when only a few move. Wraps the vanilla
 * `GeoJsonSource`.
 * @example
 * <GeoJsonSource id="stations" data={stations} cluster clusterRadiusPixels={40}>
 *   <StyleLayer id="clusters" type="circle" filter={['has', 'point_count']} paint={{ 'circle-radius': 18 }} />
 * </GeoJsonSource>
 */
export function GeoJsonSource({ ref, children, ...options }: GeoJsonSourceProps) {
  const mapStyleSource = use(MapStyleSourceContext)
  if (mapStyleSource === null) throw new Error('<GeoJsonSource> must sit inside <MapStyleSource>.')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => new GeoJsonSourceImpl(options), [options.id])
  // Layers inside mount once the source is in the style, so their `addLayer` finds it.
  const [added, setAdded] = useState<{ source: GeoJsonSourceImpl; host: MapStyleSource } | null>(null)
  const report = (error: unknown) => mapStyleSource.getMapStyle().reportError(error as Error)
  useLayoutEffect(() => {
    try {
      source.addTo(mapStyleSource)
    } catch (error) {
      report(error)
    }
    setAdded({ source, host: mapStyleSource })
    return () => source.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mapStyleSource])
  useLayoutEffect(() => {
    try {
      source.update(options)
    } catch (error) {
      report(error)
    }
  })
  useImperativeHandle(ref, () => source, [source])
  const ready = added?.source === source && added.host === mapStyleSource
  return <GeoJsonSourceContext value={options.id}>{ready ? children : null}</GeoJsonSourceContext>
}
