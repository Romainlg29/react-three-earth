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

/** The vanilla `Marker` of the nearest `<Marker>`, for a `<Popup>` or content inside it. */
export const MarkerContext = createContext<import('../core/Marker.js').Marker | null>(null)
