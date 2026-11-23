import { PMTiles, TileType } from 'pmtiles'

import type { ResourceKind } from './types.js'

/** Fetches the raw (decompressed) bytes of the tiles of one style source: vector tiles, or raster images. */
export interface VectorTileFetcher {
  /** The attribution in the source's TileJSON or PMTiles metadata, when it has one. */
  attribution?: string
  /** Where the source has tiles (west, south, east, north, in degrees), from the style or its TileJSON. */
  bounds?: [number, number, number, number]
  /** A raster source's `tileSize`, from the style or its TileJSON. */
  tileSize?: number
  /** A raster-dem source's `encoding`, from the style or its TileJSON. */
  encoding?: string
  readonly minimumZoom: number
  readonly maximumZoom: number
  /**
   * Null for a tile that does not exist (404, or empty). `revalidate` bypasses the browser's HTTP cache
   * freshness (`cache: 'no-cache'`): the server is asked again, and answers 304 if the tile did not change.
   */
  fetchTile(x: number, y: number, z: number, signal?: AbortSignal, revalidate?: boolean): Promise<Uint8Array | null>
  /** Forgets what the fetcher caches itself (a PMTiles archive's header and directories). */
  invalidate?(): void
}

/** The parts of a style's vector source read here. */
export interface VectorSourceSpecification {
  type: string
  url?: string
  tiles?: string[]
  minzoom?: number
  maxzoom?: number
  scheme?: 'xyz' | 'tms'
  attribution?: string
  /** A property to use as the feature id (feature-state), for every source layer or per source layer. */
  promoteId?: string | Record<string, string>
  /** Raster sources: map pixels per tile. Default: 512. */
  tileSize?: number
  /** Where the source has tiles, in degrees: west, south, east, north. */
  bounds?: [number, number, number, number]
  /** Raster-dem sources: how elevation is packed into pixels. */
  encoding?: string
}

/** `fetch`, told what the request is for (for `transformRequest` and protocol loaders on the main thread). */
export type ResourceFetch = (url: string, init: RequestInit, kind: ResourceKind) => Promise<Response>

export interface FetcherContext {
  baseUrl: string
  requestHeaders: Record<string, string>
  fetch: ResourceFetch
}

/**
 * Resolves a style source (`pmtiles://`, TileJSON `url`, or inline `tiles`) into a tile fetcher. Vector sources
 * fetch vector tiles; `raster` and `raster-dem` sources fetch images.
 */
export async function createVectorTileFetcher(source: VectorSourceSpecification, context: FetcherContext): Promise<VectorTileFetcher> {
  const raster = source.type === 'raster' || source.type === 'raster-dem'
  if (source.url?.startsWith('pmtiles://') === true) {
    // The style's own attribution wins, so the archive's metadata is only read when the style has none
    const archive = await PMTilesFetcher.create(resolveUrl(source.url.slice('pmtiles://'.length), context.baseUrl), context, typeof source.attribution !== 'string', raster)
    if (typeof source.attribution === 'string') archive.attribution = source.attribution
    copySourceMetadata(archive, source, {})
    return archive
  }
  let specification = source
  let baseUrl = context.baseUrl
  if (source.tiles === undefined && source.url !== undefined) {
    // TileJSON: its own `tiles` resolve against its URL.
    const tileJsonUrl = resolveUrl(source.url, context.baseUrl)
    const response = await context.fetch(tileJsonUrl, { headers: context.requestHeaders }, 'Source')
    if (!response.ok) throw new Error(`MapStyleSource: TileJSON ${tileJsonUrl} answered ${response.status}.`)
    specification = { ...(await response.json()), ...withoutUndefined({ minzoom: source.minzoom, maxzoom: source.maxzoom, scheme: source.scheme }) }
    baseUrl = tileJsonUrl
  }
  const templates = specification.tiles
  if (templates === undefined || templates.length === 0) throw new Error(`MapStyleSource: a ${source.type} source needs \`tiles\`, a TileJSON \`url\` or a \`pmtiles://\` url.`)
  const fetcher = new XYZFetcher(
    templates.map(template => resolveTemplate(template, baseUrl)),
    specification.minzoom ?? 0,
    specification.maxzoom ?? 22,
    specification.scheme === 'tms',
    context,
  )
  // The style's own `attribution` on the source wins over the TileJSON's
  const attribution = source.attribution ?? specification.attribution
  if (typeof attribution === 'string') fetcher.attribution = attribution
  copySourceMetadata(fetcher, source, specification)
  return fetcher
}

/** Bounds, tile size and encoding: the style's source wins over its TileJSON, as in MapLibre. */
function copySourceMetadata(fetcher: VectorTileFetcher, source: VectorSourceSpecification, tileJson: Partial<VectorSourceSpecification>): void {
  const bounds = source.bounds ?? tileJson.bounds
  if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)) fetcher.bounds = [...bounds]
  const tileSize = source.tileSize ?? tileJson.tileSize
  if (typeof tileSize === 'number' && tileSize > 0) fetcher.tileSize = tileSize
  const encoding = source.encoding ?? tileJson.encoding
  if (typeof encoding === 'string') fetcher.encoding = encoding
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

/** Resolves a URL against a base, keeping `{z}`-style placeholders intact. */
export function resolveTemplate(template: string, baseUrl: string): string {
  // `new URL` percent-encodes braces; protect them through the resolution.
  const protectedTemplate = template.replace(/{/g, '__open__').replace(/}/g, '__close__')
  return resolveUrl(protectedTemplate, baseUrl).replace(/__open__/g, '{').replace(/__close__/g, '}')
}

export function resolveUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).href
}

/** XYZ (or TMS) URL templates, served in turn across `tiles` entries. */
export class XYZFetcher implements VectorTileFetcher {
  attribution?: string

  constructor(
    protected readonly templates: string[],
    readonly minimumZoom: number,
    readonly maximumZoom: number,
    protected readonly tms: boolean,
    protected readonly context: FetcherContext,
  ) {}

  /** Fills `{z}`, `{x}`, `{y}`, `{-y}` (the TMS row), `{quadkey}` and `{bbox-epsg-3857}` (WMS), as MapLibre does. */
  getUrl(x: number, y: number, z: number): string {
    const template = this.templates[Math.abs(x + y) % this.templates.length]!
    const row = this.tms ? 2 ** z - 1 - y : y
    return template
      .replace(/{z}/g, String(z))
      .replace(/{x}/g, String(x))
      .replace(/{y}/g, String(row))
      .replace(/{-y}/g, String(2 ** z - 1 - y))
      .replace(/{quadkey}/g, () => quadkey(x, y, z))
      .replace(/{bbox-epsg-3857}/g, () => mercatorBoundingBox(x, y, z).join(','))
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal, revalidate = false): Promise<Uint8Array | null> {
    const init: RequestInit = { headers: this.context.requestHeaders, signal, ...(revalidate ? { cache: 'no-cache' as const } : {}) }
    const response = await this.context.fetch(this.getUrl(x, y, z), init, 'Tile')
    if (response.status === 404 || response.status === 204) return null
    if (!response.ok) throw new Error(`MapStyleSource: tile ${z}/${x}/${y} answered ${response.status}.`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length === 0 ? null : decompressIfGzipped(bytes)
  }
}

/** Bing's tile key: one base-4 digit per zoom level. */
export function quadkey(x: number, y: number, z: number): string {
  let key = ''
  for (let level = z; level > 0; level--) {
    const mask = 1 << (level - 1)
    key += ((x & mask) !== 0 ? 1 : 0) + ((y & mask) !== 0 ? 2 : 0)
  }
  return key
}

/** A tile's bounds in EPSG:3857 meters: west, south, east, north. */
export function mercatorBoundingBox(x: number, y: number, z: number): [number, number, number, number] {
  const half = 20037508.342789244
  const size = (2 * half) / 2 ** z
  return [-half + x * size, half - (y + 1) * size, -half + (x + 1) * size, half - y * size]
}

/** Some servers send gzipped tiles without a Content-Encoding header, so fetch does not unzip them. */
export async function decompressIfGzipped(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** What a `PMTilesFetcher` shares with its archive's byte reader. */
interface PMTilesFetcherState {
  /** Set by `invalidate`: range requests skip the HTTP cache's freshness from then on. */
  revalidate: boolean
  /** The first read's bytes (offset 0), which answer later ranges inside them; cleared by `invalidate`. */
  firstBytes: { data: ArrayBuffer; etag?: string; cacheControl?: string; expires?: string } | undefined
  /** Incremented by `invalidate`: a read started before it must not store its (stale) bytes as `firstBytes`. */
  generation: number
}

/** A PMTiles v3 archive read with HTTP range requests. */
export class PMTilesFetcher implements VectorTileFetcher {
  attribution?: string

  protected constructor(
    protected archive: PMTiles,
    readonly minimumZoom: number,
    readonly maximumZoom: number,
    protected readonly options: PMTilesFetcherState,
  ) {}

  /** `raster`: the archive must hold images (PNG, JPEG, WebP or AVIF) instead of vector tiles. */
  static async create(url: string, context: FetcherContext, readAttribution = false, raster = false): Promise<PMTilesFetcher> {
    // Once invalidated, the archive may have been replaced: range requests skip the HTTP cache's freshness.
    // pmtiles caches the header and directories but not the JSON metadata. The first read (offset 0, 16 KiB) almost
    // always holds the metadata too, so later ranges inside it are answered from these bytes (`firstBytes`) instead of
    // the network. `invalidate` forgets them.
    const options: PMTilesFetcherState = { revalidate: false, firstBytes: undefined, generation: 0 }
    const archive = new PMTiles({
      getKey: () => url,
      // No If-Match: it is not a CORS-safelisted header, so it would add a preflight to every request.
      getBytes: async (offset: number, length: number, signal?: AbortSignal) => {
        const firstBytes = options.firstBytes
        if (firstBytes !== undefined && offset + length <= firstBytes.data.byteLength) {
          const { data, etag, cacheControl, expires } = firstBytes
          return { data: data.slice(offset, offset + length), etag, cacheControl, expires }
        }
        const generation = options.generation
        const headers: Record<string, string> = { ...context.requestHeaders, range: `bytes=${offset}-${offset + length - 1}` }
        const response = await context.fetch(url, { headers, signal, ...(options.revalidate ? { cache: 'no-cache' as const } : {}) }, 'Tile')
        if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
          throw new Error(`MapStyleSource: PMTiles ${url} answered ${response.status}; the server must support range requests.`)
        }
        const data = await response.arrayBuffer()
        const result = {
          data,
          etag: response.headers.get('ETag') ?? undefined,
          cacheControl: response.headers.get('Cache-Control') ?? undefined,
          expires: response.headers.get('Expires') ?? undefined,
        }
        if (offset === 0 && options.firstBytes === undefined && generation === options.generation) options.firstBytes = { ...result, data: data.slice(0) }
        return result
      },
    })
    // The metadata read waits for the header (it needs its offset) and is then served from the first bytes kept above,
    // so it costs no extra request unless the metadata lies past the first 16 KiB. An unreadable block must not take
    // the tiles down: attribution is optional.
    const metadata = readAttribution ? archive.getMetadata().catch(() => null) : Promise.resolve(null)
    const [header, loaded] = await Promise.all([archive.getHeader(), metadata])
    const holdsImages = header.tileType === TileType.Png || header.tileType === TileType.Jpeg || header.tileType === TileType.Webp || header.tileType === TileType.Avif
    if (!raster && header.tileType !== TileType.Mvt) throw new Error(`MapStyleSource: ${url} holds raster tiles; use it as a raster source.`)
    if (raster && !holdsImages) throw new Error(`MapStyleSource: ${url} holds no images (PNG, JPEG, WebP or AVIF); use it as a vector source.`)
    const fetcher = new PMTilesFetcher(archive, header.minZoom, header.maxZoom, options)
    const attribution = (loaded as { attribution?: unknown } | null)?.attribution
    if (typeof attribution === 'string') fetcher.attribution = attribution
    return fetcher
  }

  /**
   * The archive file may have been replaced: a fresh reader (and cache) reads its header and every directory
   * again. From then on, range requests revalidate with the server (`cache: 'no-cache'`).
   */
  invalidate(): void {
    this.options.revalidate = true
    this.options.firstBytes = undefined
    this.options.generation++
    this.archive = new PMTiles(this.archive.source)
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.archive.getZxy(z, x, y, signal)
    if (response === undefined || response.data.byteLength === 0) return null
    return new Uint8Array(response.data)
  }
}
