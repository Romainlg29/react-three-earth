import { use, useMemo } from 'react'

import {
  QuantizedMeshSource as QuantizedMeshSourceImpl,
  RasterTileSource as RasterTileSourceImpl,
  type QuantizedMeshSourceOptions,
  type RasterTileSourceOptions,
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
