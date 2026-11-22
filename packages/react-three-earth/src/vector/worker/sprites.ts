import { ImageAtlas } from './imageAtlas.js'
import { resolveTemplate } from './tileSources.js'
import type { PatternRectangle, StyleImage } from './types.js'

/** Decoded RGBA pixels, straight alpha, rows from the top. */
export interface DecodedImage {
  width: number
  height: number
  data: Uint8Array
}

/** Decodes PNG (or any browser image) bytes. Replaced in tests: Node has no `createImageBitmap`. */
export type ImageDecoder = (bytes: ArrayBuffer) => Promise<DecodedImage>

/** One image of a sprite sheet, as the sprite JSON describes it. */
export interface SpriteImageMetrics {
  x: number
  y: number
  width: number
  height: number
  pixelRatio: number
  sdf: boolean
  stretchX?: Array<[number, number]>
  stretchY?: Array<[number, number]>
  content?: [number, number, number, number]
}

/** A style's `sprite`: one URL (sprite id `default`) or MapLibre 3's array of `{ id, url }`. */
export type SpriteSpecification = string | Array<{ id: string; url: string }>

/** The style's sprites as `{ id, url }`; a single URL is the sprite `default`, whose images take no prefix. */
export function normalizeSprites(sprite: unknown): Array<{ id: string; url: string }> {
  if (sprite === undefined || sprite === null || sprite === '') return []
  if (typeof sprite === 'string') return [{ id: 'default', url: sprite }]
  if (Array.isArray(sprite)) {
    return sprite.filter((entry): entry is { id: string; url: string } => typeof entry?.id === 'string' && typeof entry?.url === 'string')
  }
  console.warn('MapStyleSource: the style\'s `sprite` must be a URL or an array of { id, url }; sprites are skipped.')
  return []
}

/**
 * The JSON and image URLs of a sprite at a pixel ratio: `@2x` goes before the extension, and before any query
 * string (`https://host/sprite?key=1` → `https://host/sprite@2x.json?key=1`).
 */
export function spriteUrls(url: string, pixelRatio: number, baseUrl: string): { json: string; image: string } {
  const suffix = pixelRatio > 1 ? '@2x' : ''
  const resolved = resolveTemplate(url, baseUrl)
  const queryStart = resolved.search(/[?#]/)
  const path = queryStart === -1 ? resolved : resolved.slice(0, queryStart)
  const query = queryStart === -1 ? '' : resolved.slice(queryStart)
  return { json: `${path}${suffix}.json${query}`, image: `${path}${suffix}.png${query}` }
}

/** Reads a sprite index (the sprite JSON). Entries without a valid box are skipped. */
export function parseSpriteIndex(json: unknown): Map<string, SpriteImageMetrics> {
  const images = new Map<string, SpriteImageMetrics>()
  if (typeof json !== 'object' || json === null) return images
  for (const [name, value] of Object.entries(json as Record<string, Record<string, unknown>>)) {
    if (typeof value !== 'object' || value === null) continue
    const { x, y, width, height } = value
    if (![x, y, width, height].every(number => typeof number === 'number' && Number.isInteger(number) && number >= 0) || width === 0 || height === 0) continue
    images.set(name, {
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
      pixelRatio: typeof value.pixelRatio === 'number' && value.pixelRatio > 0 ? value.pixelRatio : 1,
      sdf: value.sdf === true,
      ...(Array.isArray(value.stretchX) ? { stretchX: value.stretchX as Array<[number, number]> } : {}),
      ...(Array.isArray(value.stretchY) ? { stretchY: value.stretchY as Array<[number, number]> } : {}),
      ...(Array.isArray(value.content) && value.content.length === 4 ? { content: value.content as [number, number, number, number] } : {}),
    })
  }
  return images
}

/** Copies a rectangle out of a decoded sheet; null when it reaches past the sheet. */
export function cropImage(sheet: DecodedImage, metrics: SpriteImageMetrics): StyleImage | null {
  const { x, y, width, height } = metrics
  if (x + width > sheet.width || y + height > sheet.height) return null
  const data = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * sheet.width + x) * 4
    data.set(sheet.data.subarray(start, start + width * 4), row * width * 4)
  }
  const { pixelRatio, sdf, stretchX, stretchY, content } = metrics
  return { width, height, data, pixelRatio, sdf, ...(stretchX ? { stretchX } : {}), ...(stretchY ? { stretchY } : {}), ...(content ? { content } : {}) }
}

/** Decodes with `createImageBitmap` and reads the pixels back from an `OffscreenCanvas` (workers and pages). */
export const decodeImageInBrowser: ImageDecoder = async bytes => {
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('no OffscreenCanvas 2D context to decode sprite images; this browser cannot load sprites in a worker, pass createWorker: null to decode on the main thread')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
  } finally {
    bitmap.close()
  }
}

interface LoadedSprite {
  id: string
  sheet: DecodedImage
  index: Map<string, SpriteImageMetrics>
}

export interface StyleImagesOptions {
  sprite: unknown
  baseUrl: string
  pixelRatio: number
  requestHeaders: Record<string, string>
  fetch: typeof fetch
  decodeImage?: ImageDecoder
  /** Runtime images known when the style loads. */
  images?: Iterable<[string, StyleImage]>
}

/**
 * A style's images: its sprite sheets and the images added at runtime (`addImage`, which win over a sprite
 * image of the same id). Images are packed into the atlas the first time a tile or the background uses them,
 * not the whole sheet.
 */
export class StyleImages {
  readonly atlas = new ImageAtlas()
  protected readonly sprites: LoadedSprite[]
  protected readonly runtime = new Map<string, StyleImage>()
  /** Ids looked up and found in neither the sprite nor the runtime images. */
  protected readonly missing = new Set<string>()

  protected constructor(sprites: LoadedSprite[], images: Iterable<[string, StyleImage]>) {
    this.sprites = sprites
    for (const [id, image] of images) this.runtime.set(id, image)
  }

  /** Loads every sprite sheet of the style. A sheet that fails is skipped with a warning. */
  static async load({ sprite, baseUrl, pixelRatio, requestHeaders, fetch, decodeImage = decodeImageInBrowser, images = [] }: StyleImagesOptions): Promise<StyleImages> {
    const loaded = await Promise.all(
      normalizeSprites(sprite).map(async ({ id, url }): Promise<LoadedSprite | null> => {
        try {
          return { id, ...(await loadSprite(url, pixelRatio, baseUrl, requestHeaders, fetch, decodeImage)) }
        } catch (error) {
          console.warn(`MapStyleSource: sprite "${id}" (${url}) could not load, its images are missing. ${(error as Error).message}`)
          return null
        }
      }),
    )
    return new StyleImages(
      loaded.filter(entry => entry !== null),
      images,
    )
  }

  /** Ids of the sprites' images. */
  spriteImageIds(): string[] {
    return this.sprites.flatMap(({ id, index }) => [...index.keys()].map(name => prefixedId(id, name)))
  }

  /** Whether an image of this id exists (sprite or runtime). */
  has(id: string): boolean {
    return this.runtime.has(id) || this.findSpriteImage(id) !== null
  }

  /** The image's pixels and metadata, or null when it does not exist. */
  get(id: string): StyleImage | null {
    const runtime = this.runtime.get(id)
    if (runtime !== undefined) return runtime
    const found = this.findSpriteImage(id)
    return found === null ? null : cropImage(found.sprite.sheet, found.metrics)
  }

  /**
   * The image's place in the atlas, packing it on first use; null when it does not exist (recorded as missing)
   * or the atlas is full.
   */
  getPattern(id: string): PatternRectangle | null {
    const packed = this.atlas.get(id)
    if (packed !== null) return { ...packed, pixelRatio: this.pixelRatioOf(id) }
    const image = this.get(id)
    if (image === null) {
      this.missing.add(id)
      return null
    }
    const rectangle = this.atlas.add(id, image)
    return rectangle === null ? null : { ...rectangle, pixelRatio: image.pixelRatio }
  }

  /** Whether the last lookup of `id` found nothing. */
  isMissing(id: string): boolean {
    return this.missing.has(id)
  }

  /**
   * Adds, replaces (`image`) or removes (`null`) a runtime image. Returns whether meshes using it must be
   * rebuilt (false when it was rewritten in place in the atlas, at the same size).
   */
  set(id: string, image: StyleImage | null): boolean {
    const packed = this.atlas.get(id)
    const previousPixelRatio = this.pixelRatioOf(id)
    if (image === null) this.runtime.delete(id)
    else this.runtime.set(id, image)
    this.missing.delete(id)
    if (packed === null) return true
    // Removing a runtime image may uncover a sprite image of the same id.
    const next = image ?? this.get(id)
    if (next === null) {
      this.atlas.remove(id)
      return true
    }
    if (next.width === packed.width && next.height === packed.height && next.pixelRatio === previousPixelRatio) {
      this.atlas.add(id, next)
      return false
    }
    this.atlas.remove(id)
    return true
  }

  protected pixelRatioOf(id: string): number {
    return this.runtime.get(id)?.pixelRatio ?? this.findSpriteImage(id)?.metrics.pixelRatio ?? 1
  }

  protected findSpriteImage(id: string): { sprite: LoadedSprite; metrics: SpriteImageMetrics } | null {
    for (const sprite of this.sprites) {
      const prefix = sprite.id === 'default' ? '' : `${sprite.id}:`
      if (!id.startsWith(prefix)) continue
      const metrics = sprite.index.get(id.slice(prefix.length))
      if (metrics !== undefined) return { sprite, metrics }
    }
    return null
  }
}

function prefixedId(spriteId: string, name: string): string {
  return spriteId === 'default' ? name : `${spriteId}:${name}`
}

async function loadSprite(
  url: string,
  pixelRatio: number,
  baseUrl: string,
  requestHeaders: Record<string, string>,
  fetchFunction: typeof fetch,
  decodeImage: ImageDecoder,
): Promise<{ sheet: DecodedImage; index: Map<string, SpriteImageMetrics> }> {
  const load = async (ratio: number) => {
    const urls = spriteUrls(url, ratio, baseUrl)
    const [jsonResponse, imageResponse] = await Promise.all([fetchFunction(urls.json, { headers: requestHeaders }), fetchFunction(urls.image, { headers: requestHeaders })])
    if (!jsonResponse.ok) throw new Error(`${urls.json} answered ${jsonResponse.status}`)
    if (!imageResponse.ok) throw new Error(`${urls.image} answered ${imageResponse.status}`)
    const [json, bytes] = await Promise.all([jsonResponse.json() as Promise<unknown>, imageResponse.arrayBuffer()])
    return { index: parseSpriteIndex(json), sheet: await decodeImage(bytes) }
  }
  if (pixelRatio <= 1) return load(1)
  try {
    return await load(pixelRatio)
  } catch {
    return load(1) // not every host serves @2x sheets
  }
}
