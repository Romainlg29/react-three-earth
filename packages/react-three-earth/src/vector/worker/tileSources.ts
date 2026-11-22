import { PMTiles, TileType } from 'pmtiles'

/** Fetches the raw (decompressed) bytes of vector tiles of one style source. */
export interface VectorTileFetcher {
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
}

export interface FetcherContext {
  baseUrl: string
  requestHeaders: Record<string, string>
  fetch: typeof fetch
}

/** Resolves a style source (`pmtiles://`, TileJSON `url`, or inline `tiles`) into a tile fetcher. */
export async function createVectorTileFetcher(source: VectorSourceSpecification, context: FetcherContext): Promise<VectorTileFetcher> {
  if (source.url?.startsWith('pmtiles://') === true) {
    return PMTilesFetcher.create(resolveUrl(source.url.slice('pmtiles://'.length), context.baseUrl), context)
  }
  let specification = source
  let baseUrl = context.baseUrl
  if (source.tiles === undefined && source.url !== undefined) {
    // TileJSON: its own `tiles` resolve against its URL.
    const tileJsonUrl = resolveUrl(source.url, context.baseUrl)
    const response = await context.fetch(tileJsonUrl, { headers: context.requestHeaders })
    if (!response.ok) throw new Error(`MapStyleSource: TileJSON ${tileJsonUrl} answered ${response.status}.`)
    specification = { ...(await response.json()), ...withoutUndefined({ minzoom: source.minzoom, maxzoom: source.maxzoom, scheme: source.scheme }) }
    baseUrl = tileJsonUrl
  }
  const templates = specification.tiles
  if (templates === undefined || templates.length === 0) throw new Error('MapStyleSource: a vector source needs `tiles`, a TileJSON `url` or a `pmtiles://` url.')
  return new XYZFetcher(
    templates.map(template => resolveTemplate(template, baseUrl)),
    specification.minzoom ?? 0,
    specification.maxzoom ?? 22,
    specification.scheme === 'tms',
    context,
  )
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
  constructor(
    protected readonly templates: string[],
    readonly minimumZoom: number,
    readonly maximumZoom: number,
    protected readonly tms: boolean,
    protected readonly context: FetcherContext,
  ) {}

  getUrl(x: number, y: number, z: number): string {
    const template = this.templates[Math.abs(x + y) % this.templates.length]!
    const row = this.tms ? 2 ** z - 1 - y : y
    return template.replace(/{z}/g, String(z)).replace(/{x}/g, String(x)).replace(/{y}/g, String(row))
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal, revalidate = false): Promise<Uint8Array | null> {
    const init: RequestInit = { headers: this.context.requestHeaders, signal, ...(revalidate ? { cache: 'no-cache' as const } : {}) }
    const response = await this.context.fetch(this.getUrl(x, y, z), init)
    if (response.status === 404 || response.status === 204) return null
    if (!response.ok) throw new Error(`MapStyleSource: tile ${z}/${x}/${y} answered ${response.status}.`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length === 0 ? null : decompressIfGzipped(bytes)
  }
}

/** Some servers send gzipped tiles without a Content-Encoding header, so fetch does not unzip them. */
export async function decompressIfGzipped(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A PMTiles v3 archive read with HTTP range requests. */
export class PMTilesFetcher implements VectorTileFetcher {
  /** Pending re-read of the header after `invalidate`; tiles wait for it. */
  protected invalidation: Promise<void> | null = null

  protected constructor(
    protected readonly archive: PMTiles,
    readonly minimumZoom: number,
    readonly maximumZoom: number,
    protected readonly options: { revalidate: boolean },
  ) {}

  static async create(url: string, context: FetcherContext): Promise<PMTilesFetcher> {
    // Once invalidated, the archive may have been replaced: range requests skip the HTTP cache's freshness.
    const options = { revalidate: false }
    const archive = new PMTiles({
      getKey: () => url,
      // No If-Match: it is not a CORS-safelisted header, so it would add a preflight to every request.
      getBytes: async (offset: number, length: number, signal?: AbortSignal) => {
        const headers: Record<string, string> = { ...context.requestHeaders, range: `bytes=${offset}-${offset + length - 1}` }
        const response = await context.fetch(url, { headers, signal, ...(options.revalidate ? { cache: 'no-cache' as const } : {}) })
        if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
          throw new Error(`MapStyleSource: PMTiles ${url} answered ${response.status}; the server must support range requests.`)
        }
        return {
          data: await response.arrayBuffer(),
          etag: response.headers.get('ETag') ?? undefined,
          cacheControl: response.headers.get('Cache-Control') ?? undefined,
          expires: response.headers.get('Expires') ?? undefined,
        }
      },
    })
    const header = await archive.getHeader()
    if (header.tileType !== TileType.Mvt) throw new Error(`MapStyleSource: ${url} holds raster tiles; use it as a raster source.`)
    return new PMTilesFetcher(archive, header.minZoom, header.maxZoom, options)
  }

  /** The archive file may have been replaced: its header and directories are read again. */
  invalidate(): void {
    this.options.revalidate = true
    const previous = this.invalidation ?? Promise.resolve()
    const invalidation = previous.then(() => this.archive.cache.invalidate(this.archive.source)).catch(() => {})
    this.invalidation = invalidation
    void invalidation.finally(() => {
      if (this.invalidation === invalidation) this.invalidation = null
    })
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (this.invalidation !== null) await this.invalidation
    const response = await this.archive.getZxy(z, x, y, signal)
    if (response === undefined || response.data.byteLength === 0) return null
    return new Uint8Array(response.data)
  }
}
