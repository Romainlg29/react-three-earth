// The terrain worker's protocol: a raster-dem tile's bytes in, a terrain mesh out. Shared by the worker and the
// main-thread fallback.
import { decodeDemPixels, type DemUnpackFactors } from '../../vector/raster/rasterTiles.js'
import { buildDemTileSurface, buildPolarCapSurface, type DemTileRequest, type PolarCapRequest, type TerrainSurface } from './demSurface.js'

export type DemTask = ({ kind: 'tile' } & DemTileRequest) | ({ kind: 'cap' } & PolarCapRequest)

export interface DemTaskRequest {
  id: number
  /** The encoded image (PNG, WebP). Transferred to the worker. */
  bytes: ArrayBuffer
  factors: DemUnpackFactors
  task: DemTask
}

export interface DemTaskResult {
  surface: TerrainSurface
  /** The raster's width in pixels: how many levels deeper than the data its pixels still add detail. */
  rasterWidth: number
}

export type DemTaskResponse = { id: number; result: DemTaskResult } | { id: number; error: string }

/** Decoded RGBA pixels, straight alpha, rows from the top. */
export interface DemPixels {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** Decodes image bytes to exact RGBA bytes. Replaced in tests: Node has no `createImageBitmap`. */
export type DemImageDecoder = (bytes: ArrayBuffer) => Promise<DemPixels>

/** Decodes with the browser's image decoder, keeping the bytes exact (no premultiplication, no colour conversion). */
export const decodeDemImageInBrowser: DemImageDecoder = async bytes => {
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('no OffscreenCanvas 2D context to decode elevation tiles; pass createWorker: null to RasterDemSource to decode on the main thread')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { width: bitmap.width, height: bitmap.height, data }
  } finally {
    bitmap.close()
  }
}

export async function runDemTask({ bytes, factors, task }: Omit<DemTaskRequest, 'id'>, decode: DemImageDecoder = decodeDemImageInBrowser): Promise<DemTaskResult> {
  const { width, height, data } = await decode(bytes)
  const raster = { width, height, elevations: decodeDemPixels(data, width, height, factors) }
  const surface = task.kind === 'tile' ? buildDemTileSurface(raster, task) : buildPolarCapSurface(raster, task)
  return { surface, rasterWidth: width }
}

/** The arrays of a surface, to transfer instead of copy. */
export function surfaceTransferables({ surface }: DemTaskResult): ArrayBuffer[] {
  return [surface.positions.buffer, surface.normals.buffer, surface.uvs.buffer, surface.indices.buffer] as ArrayBuffer[]
}
