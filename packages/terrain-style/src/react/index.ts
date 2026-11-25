import type { MaterialFactory } from '@earthkit/globe'
import { useMemo } from 'react'

import { TerrainStyle, type TerrainStyleOptions } from '../TerrainStyle.js'

/**
 * A stable `createMaterial` for `<Terrain>` from a terrain style: the same function while the style is the same
 * (compared by value, so an inline object is fine), a new one, which reloads the tiles, when it changes.
 *
 * ```tsx
 * const createMaterial = useTerrainStyle({ color: 'alpine' })
 * return <Terrain createMaterial={createMaterial}><RasterDemSource url={url} /></Terrain>
 * ```
 */
export function useTerrainStyle(options: TerrainStyleOptions): MaterialFactory {
  const key = JSON.stringify(options)
  return useMemo(() => new TerrainStyle(options).createMaterial, [key])
}
