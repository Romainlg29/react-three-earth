import { PMTiles, TileType } from 'pmtiles'

/** Fetches the raw (decompressed) bytes of vector tiles of one style source. */
export interface VectorTileFetcher {
  /** The attribution in the source's TileJSON or PMTiles metadata, when it has one. */
  attribution?: string
  readonly minimumZoom: number
  readonly maximumZoom: number
  /** Null for a tile that does not exist (404, or empty). */
  fetchTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<Uint8Array | null>
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
}

export interface FetcherContext {
  baseUrl: string
  requestHeaders: Record<string, string>
  fetch: typeof fetch
}

/** Resolves a style source (`pmtiles://`, TileJSON `url`, or inline `tiles`) into a tile fetcher. */
export async function createVectorTileFetcher(source: VectorSourceSpecification, context: FetcherContext): Promise<VectorTileFetcher> {
  if (source.url?.startsWith('pmtiles://') === true) {
    // The style's own attribution wins, so the archive's metadata is only read when the style has none
    const archive = await PMTilesFetcher.create(resolveUrl(source.url.slice('pmtiles://'.length), context.baseUrl), context, typeof source.attribution !== 'string')
    if (typeof source.attribution === 'string') archive.attribution = source.attribution
    return archive
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
  return fetcher
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

  getUrl(x: number, y: number, z: number): string {
    const template = this.templates[Math.abs(x + y) % this.templates.length]!
    const row = this.tms ? 2 ** z - 1 - y : y
    return template.replace(/{z}/g, String(z)).replace(/{x}/g, String(x)).replace(/{y}/g, String(row))
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.context.fetch(this.getUrl(x, y, z), { headers: this.context.requestHeaders, signal })
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
  attribution?: string

  protected constructor(
    protected readonly archive: PMTiles,
    readonly minimumZoom: number,
    readonly maximumZoom: number,
  ) {}

  static async create(url: string, context: FetcherContext, readAttribution = false): Promise<PMTilesFetcher> {
    const archive = new PMTiles({
      getKey: () => url,
      // No If-Match: it is not a CORS-safelisted header, so it would add a preflight to every request.
      getBytes: async (offset: number, length: number, signal?: AbortSignal) => {
        const headers: Record<string, string> = { ...context.requestHeaders, range: `bytes=${offset}-${offset + length - 1}` }
        const response = await context.fetch(url, { headers, signal })
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
    // The metadata is a separate range request (pmtiles does not cache it): start it alongside the header, so it
    // adds no round trip. An unreadable block must not take the tiles down: attribution is optional.
    const metadata = readAttribution ? archive.getMetadata().catch(() => null) : Promise.resolve(null)
    const [header, loaded] = await Promise.all([archive.getHeader(), metadata])
    if (header.tileType !== TileType.Mvt) throw new Error(`MapStyleSource: ${url} holds raster tiles; use it as a raster source.`)
    const fetcher = new PMTilesFetcher(archive, header.minZoom, header.maxZoom)
    const attribution = (loaded as { attribution?: unknown } | null)?.attribution
    if (typeof attribution === 'string') fetcher.attribution = attribution
    return fetcher
  }

  async fetchTile(x: number, y: number, z: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.archive.getZxy(z, x, y, signal)
    if (response === undefined || response.data.byteLength === 0) return null
    return new Uint8Array(response.data)
  }
}
