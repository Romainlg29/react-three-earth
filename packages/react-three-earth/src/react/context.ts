import { createContext, use, useLayoutEffect, useMemo, useRef } from 'react'

import type { Earth } from '../core/Earth.js'

export const EarthContext = createContext<Earth | null>(null)

/** The vanilla `Earth` of the nearest `<Earth>`. Reading it never causes a React render. */
export function useEarth(): Earth {
  const earth = use(EarthContext)
  if (earth === null) throw new Error('useEarth: call it inside <Earth>, which itself sits inside <Canvas>.')
  return earth
}

/** Lets a layer component collect the source components rendered inside it. */
export interface SourceRegistry<T> {
  register(source: T): () => void
}

export const TerrainSourceContext = createContext<SourceRegistry<import('../core/sources.js').TerrainSource> | null>(null)
export const ImagerySourceContext = createContext<SourceRegistry<import('../core/sources.js').ImagerySource> | null>(null)
/** The vanilla `MapStyleSource` of the nearest `<MapStyleSource>`, for `<StyleLayer>`. */
export const MapStyleSourceContext = createContext<import('../core/sources.js').MapStyleSource | null>(null)
/** The id of the nearest `<GeoJsonSource>`: the default `source` of the `<StyleLayer>`s inside it. */
export const GeoJsonSourceContext = createContext<string | null>(null)

/** A registry whose `onChange` receives the sources in mount order. */
export function useSourceRegistry<T>(onChange: (sources: T[]) => void): SourceRegistry<T> {
  const callback = useRef(onChange)
  useLayoutEffect(() => {
    callback.current = onChange
  })
  return useMemo(() => {
    const sources: T[] = []
    return {
      register(source: T) {
        sources.push(source)
        callback.current([...sources])
        return () => {
          sources.splice(sources.indexOf(source), 1)
          callback.current([...sources])
        }
      },
    }
  }, [])
}

/** Registers a source with the layer component around it. */
export function useRegisterSource<T>(registry: SourceRegistry<T> | null, source: T, componentName: string, layerName: string): void {
  if (registry === null) throw new Error(`<${componentName}> must sit inside <${layerName}>.`)
  useLayoutEffect(() => registry.register(source), [registry, source])
}

/**
 * Registers a third-party terrain source with the `<Terrain>` around the calling component, for packages that
 * ship their own `<MySource>`. Pass a stable instance (memoise it on the props that change its tiles): a new
 * instance rebuilds the terrain, its tiles and their draped imagery. `componentName` names the component in the error thrown outside one:
 * `<componentName> must sit inside <Terrain>`.
 */
export function useRegisterTerrainSource(source: import('../core/sources.js').TerrainSource, componentName: string): void {
  useRegisterSource(use(TerrainSourceContext), source, componentName, 'Terrain')
}

/**
 * Registers a third-party imagery source with the `<Imagery>` around the calling component, stacked with the
 * built-in sources in the order they register (a source mounted later, or a new instance, goes on top). Pass a
 * stable instance (memoise it on the props that change its tiles): a new instance rebuilds the layer. `componentName` names the component in the error thrown outside one:
 * `<componentName> must sit inside <Imagery>`.
 */
export function useRegisterImagerySource(source: import('../core/sources.js').ImagerySource, componentName: string): void {
  useRegisterSource(use(ImagerySourceContext), source, componentName, 'Imagery')
}

/** The vanilla `Marker` of the nearest `<Marker>`, for a `<Popup>` or content inside it. */
export const MarkerContext = createContext<import('../core/Marker.js').Marker | null>(null)

/** The vanilla `Controls` of the nearest `<Controls>`. */
export const ControlsContext = createContext<import('../controls/Controls.js').Controls | null>(null)
