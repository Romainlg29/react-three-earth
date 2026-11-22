import { useLayoutEffect, useState, type ReactNode } from 'react'

import { Imagery as ImageryImpl } from '../core/Imagery.js'
import type { ImagerySource } from '../core/sources.js'
import { ImagerySourceContext, useEarth, useSourceRegistry } from './context.js'

export interface ImageryProps {
  /** 0 to 1. Changing it costs nothing: no reload, no shader rebuild. Default: 1. */
  opacity?: number
  /** Imagery source components, stacked bottom to top. */
  children?: ReactNode
}

/** A raster layer draped on the terrain. Several `<Imagery>` stack in the order they mount. */
export function Imagery({ opacity = 1, children }: ImageryProps) {
  const earth = useEarth()
  const [sources, setSources] = useState<ImagerySource[]>([])
  const registry = useSourceRegistry(setSources)
  const [imagery, setImagery] = useState<ImageryImpl | null>(null)

  useLayoutEffect(() => {
    if (sources.length === 0) return
    const next = new ImageryImpl({ sources, opacity })
    earth.addImagery(next)
    setImagery(next)
    return () => {
      earth.removeImagery(next)
      next.dispose()
      setImagery(null)
    }
    // opacity is applied below without rebuilding the layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earth, sources])

  useLayoutEffect(() => {
    if (imagery !== null) imagery.opacity = opacity
  }, [imagery, opacity])

  return <ImagerySourceContext value={registry}>{children}</ImagerySourceContext>
}
