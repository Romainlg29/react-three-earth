// Worker side of raster style sources: decoding raster and elevation (raster-dem) tiles. Runs in the vector tile
// worker, or on the main thread when the worker cannot start; pure enough for Node with a decoder hook.
import type { DecodedImage } from '../worker/sprites.js'
import type { RasterTileData } from '../worker/types.js'

/** How a `raster-dem` source packs elevation into a tile's red, green and blue bytes. */
export type DemEncoding = 'terrarium' | 'mapbox' | 'custom'

/**
 * Elevation in meters from a pixel: `red × red + green × green + blue × blue − baseShift` (the bytes 0 to 255),
 * as MapLibre's `DEMData`. Exported for terrain from raster-dem (W8).
 */
export interface DemUnpackFactors {
  red: number
  green: number
  blue: number
  baseShift: number
}

/** The parts of a style's `raster-dem` source the decoder reads. */
export interface DemSourceSpecification {
  encoding?: DemEncoding
  redFactor?: number
  greenFactor?: number
  blueFactor?: number
  baseShift?: number
}

/**
 * The unpack factors of a source's encoding: Terrarium (`R × 256 + G + B / 256 − 32768`), Mapbox Terrain-RGB
 * (`(R × 65536 + G × 256 + B) × 0.1 − 10000`, the style specification's default) or `custom`, from the source's
 * `redFactor`, `greenFactor`, `blueFactor` and `baseShift`.
 */
export function demUnpackFactors(source: DemSourceSpecification): DemUnpackFactors {
  switch (source.encoding ?? 'mapbox') {
    case 'terrarium':
      return { red: 256, green: 1, blue: 1 / 256, baseShift: 32768 }
    case 'mapbox':
      return { red: 6553.6, green: 25.6, blue: 0.1, baseShift: 10000 }
    case 'custom':
      return { red: source.redFactor ?? 1, green: source.greenFactor ?? 1, blue: source.blueFactor ?? 1, baseShift: source.baseShift ?? 0 }
    default:
      throw new Error(`raster-dem source: unknown encoding "${String(source.encoding)}"; use "terrarium", "mapbox" or "custom".`)
  }
}

/** Decodes RGBA pixels (rows from the top) into elevations in meters, one per pixel. */
export function decodeDemPixels(rgba: ArrayLike<number>, width: number, height: number, factors: DemUnpackFactors): Float32Array {
  const elevations = new Float32Array(width * height)
  const { red, green, blue, baseShift } = factors
  for (let index = 0; index < elevations.length; index++) {
    const offset = index * 4
    elevations[index] = rgba[offset]! * red + rgba[offset + 1]! * green + rgba[offset + 2]! * blue - baseShift
  }
  return elevations
}

/** Decodes a raster tile's bytes into an `ImageBitmap`. Replaced in tests: Node has no `createImageBitmap`. */
export type RasterImageDecoder = (bytes: Uint8Array) => Promise<ImageBitmap>

/**
 * Decodes as 3DTilesRenderer decodes its raster tiles (straight alpha, no colour conversion, flipped), so the
 * region pass samples them like the imagery compositor does.
 */
export const decodeRasterImageInBrowser: RasterImageDecoder = bytes =>
  createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY' })

export interface RasterTileDecoders {
  decodeImage: RasterImageDecoder
  /** Decodes a DEM tile's bytes to RGBA pixels (exact bytes: no premultiplication, no colour conversion). */
  decodePixels: (bytes: ArrayBuffer) => Promise<DecodedImage>
}

/** Decodes a tile of a `raster` source (an image) or a `raster-dem` source (elevations, decoded here). */
export async function decodeRasterTile(
  bytes: Uint8Array,
  source: { type: string } & DemSourceSpecification,
  decoders: RasterTileDecoders,
): Promise<RasterTileData> {
  if (source.type === 'raster-dem') {
    const factors = demUnpackFactors(source)
    const copy = bytes.slice().buffer
    const { width, height, data } = await decoders.decodePixels(copy)
    return { kind: 'dem', width, height, elevations: decodeDemPixels(data, width, height, factors) }
  }
  const image = await decoders.decodeImage(bytes)
  return { kind: 'image', width: image.width, height: image.height, image }
}

/** Bytes a raster tile holds on the main thread: its pixels, twice (the decoded copy and the GPU copy). */
export function rasterTileByteLength(raster: RasterTileData): number {
  return raster.width * raster.height * 4 * 2
}
