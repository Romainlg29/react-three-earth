import { useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import type { TerrainSource } from '../core/sources.js'
import { Terrain as TerrainImpl, type TerrainOptions } from '../core/Terrain.js'
import { TerrainSourceContext, useEarth, useSourceRegistry } from './context.js'

export interface TerrainProps extends Omit<TerrainOptions, 'sources'> {
  /** One terrain source component, for example `<QuantizedMeshSource url="…" />`. */
  children?: ReactNode
}

/** The ground. Put one terrain source component inside it. `exaggeration` changes apply without a reload. */
export function Terrain({ children, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds, exaggeration = 1 }: TerrainProps) {
  const earth = useEarth()
  const [sources, setSources] = useState<TerrainSource[]>([])
  const registry = useSourceRegistry(setSources)
  const [terrain, setTerrain] = useState<TerrainImpl | null>(null)
  const invalidate = useThree(state => state.invalidate)
  // Read when the terrain is built, so a new exaggeration never rebuilds it (applied below instead).
  const exaggerationRef = useRef(exaggeration)
  useLayoutEffect(() => {
    exaggerationRef.current = exaggeration
  }, [exaggeration])
  // Read through a ref, so a new invalidate function never rebuilds the terrain
  const invalidateRef = useRef(invalidate)
  useLayoutEffect(() => {
    invalidateRef.current = invalidate
  }, [invalidate])

  useLayoutEffect(() => {
    if (sources.length === 0) return
    const terrain = new TerrainImpl({ sources, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds, exaggeration: exaggerationRef.current })
    earth.setTerrain(terrain)
    setTerrain(terrain)
    // With frameloop="demand", tile loads and queued imagery compositions still get their frames.
    const removeFrameRequestListener = terrain.addFrameRequestListener(() => invalidateRef.current())
    return () => {
      removeFrameRequestListener()
      earth.setTerrain(null)
      setTerrain(null)
      terrain.dispose()
    }
  }, [earth, sources, errorTargetPixels, memoryBudgetBytes, fade, createMaterial, imageryCompositionBudgetMilliseconds])

  useLayoutEffect(() => {
    if (terrain === null) return
    terrain.exaggeration = exaggeration
    invalidateRef.current()
  }, [terrain, exaggeration])

  return <TerrainSourceContext value={registry}>{children}</TerrainSourceContext>
}
