import type { StyleImage } from './worker/types.js'

/** Raw RGBA pixels: straight alpha, sRGB, rows from the top, `width × height × 4` bytes. */
export interface RawImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** What `addImage` and `updateImage` take, as MapLibre's `addImage` does. */
export type StyleImageInput = RawImage | ImageData | ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas

/** MapLibre's image options. */
export interface StyleImageOptions {
  /** Image pixels per map pixel: 2 for an image drawn for high-density screens. Default: 1. */
  pixelRatio?: number
  /** Whether the image is a signed distance field (recoloured by `icon-color`, for icons). Default: false. */
  sdf?: boolean
  /** Stretchable horizontal ranges in image pixels, for `icon-text-fit`. */
  stretchX?: Array<[number, number]>
  /** Stretchable vertical ranges in image pixels, for `icon-text-fit`. */
  stretchY?: Array<[number, number]>
  /** Where text goes inside the image, in image pixels: left, top, right, bottom. */
  content?: [number, number, number, number]
}

/**
 * Reads an `addImage` input into RGBA bytes (a copy), with its options. Throws with the fix when the input
 * cannot be read: an image element that has not loaded, or pixels that do not match the size.
 */
export function toStyleImage(id: string, input: StyleImageInput, options: StyleImageOptions = {}): StyleImage {
  const { width, height, data } = readPixels(id, input)
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error(`addImage("${id}"): the image is ${width} × ${height}; pass an image with a positive width and height.`)
  }
  if (data.length !== width * height * 4) {
    throw new Error(`addImage("${id}"): ${data.length} bytes for a ${width} × ${height} image; RGBA needs width × height × 4 = ${width * height * 4}.`)
  }
  if (width > 1022 || height > 4094) {
    throw new Error(`addImage("${id}"): ${width} × ${height} does not fit the image atlas (at most 1022 × 4094); pass a smaller image.`)
  }
  const pixelRatio = options.pixelRatio ?? 1
  if (!(pixelRatio > 0)) throw new Error(`addImage("${id}"): pixelRatio is ${pixelRatio}; pass a positive number (1, or 2 for a high-density image).`)
  return {
    width,
    height,
    data: new Uint8Array(data), // a copy: the caller may reuse its buffer
    pixelRatio,
    sdf: options.sdf ?? false,
    ...(options.stretchX !== undefined ? { stretchX: options.stretchX } : {}),
    ...(options.stretchY !== undefined ? { stretchY: options.stretchY } : {}),
    ...(options.content !== undefined ? { content: options.content } : {}),
  }
}

function readPixels(id: string, input: StyleImageInput): RawImage {
  if ('data' in input) return input
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement && (!input.complete || input.naturalWidth === 0)) {
    throw new Error(`addImage("${id}"): the image element has not loaded; call addImage after \`await image.decode()\`.`)
  }
  const width = 'naturalWidth' in input ? input.naturalWidth : input.width
  const height = 'naturalHeight' in input ? input.naturalHeight : input.height
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (context === null) throw new Error(`addImage("${id}"): no 2D canvas to read the image; pass its pixels as { width, height, data }.`)
  context.drawImage(input as CanvasImageSource, 0, 0)
  return context.getImageData(0, 0, width, height)
}
