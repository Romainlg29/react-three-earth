import { useLayoutEffect, useState, type ReactNode } from 'react'

import type { TerrainSource } from '../core/sources.js'
import { Terrain as TerrainImpl, type TerrainOptions } from '../core/Terrain.js'
import { TerrainSourceContext, useEarth, useSourceRegistry } from './context.js'

export interface TerrainProps extends Omit<TerrainOptions, 'sources'> {
  /** One terrain source component, for example `<QuantizedMeshSource url="…" />`. */
  children?: ReactNode
}

/** The ground. Put one terrain source component inside it. */
export function Terrain({ children, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds }: TerrainProps) {
  const earth = useEarth()
  const [sources, setSources] = useState<TerrainSource[]>([])
  const registry = useSourceRegistry(setSources)

  useLayoutEffect(() => {
    if (sources.length === 0) return
    const terrain = new TerrainImpl({ sources, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds })
    earth.setTerrain(terrain)
    return () => {
      earth.setTerrain(null)
      terrain.dispose()
    }
  }, [earth, sources, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds])

  return <TerrainSourceContext value={registry}>{children}</TerrainSourceContext>
}
