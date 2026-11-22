import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { LinearFilter, Mesh, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, Vector4, type Texture } from 'three'
import type { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu'

import type { ImageryCompositor } from '../tiles/imagery/ImageryCompositor.js'
import type { GpuComposedOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import { createVectorTileWorker, InlineMapStyleBackend, WorkerMapStyleBackend, type MapStyleBackend } from './MapStyleBackend.js'
import { RefCountedCache } from './RefCountedCache.js'
import { BucketMeshes, createBackgroundMaterial, createShapeMaterial, createTextMaterial, GlyphAtlasTexture } from './VectorTileMeshes.js'
import { TILE_EXTENT, TILE_SIZE_PIXELS, type MapStyleSummary, type TileBucket, type TileRequest } from './worker/types.js'

export interface MapStyleOverlayOptions {
  /** A style URL, or the style document itself. */
  style: string | object
  /** Base URL for relative URLs inside a style passed as an object. Default: the page's URL. */
  baseUrl?: string
  /** 0 to 1. Default: 1. */
  opacity?: number
  /** Headers for every request (style, TileJSON, tiles, glyphs). Default: none. */
  requestHeaders?: Record<string, string>
  /** CSS font family for glyphs drawn locally (no `glyphs` URL, or the server lacks a glyph). Default: 'sans-serif'. */
  localFontFamily?: string
  /** Deepest zoom terrain tiles are textured at; past the data's maximum zoom, tiles are overzoomed. Default: 20. */
  maximumZoom?: number
  /** Starts the worker. Default: the worker shipped with the library. Pass `null` to process on the main thread. */
  createWorker?: (() => Worker) | null
  /** Unused processed tiles kept for reuse, in bytes. Default: 32 MB. */
  retainedTileBytes?: number
}

/** One vector tile a region draws. */
interface RegionTile {
  key: string
  request: TileRequest
  /** Unwrapped column (may be outside 0 to 2^z - 1 next to the antimeridian), for placement. */
  column: number
  /** Ring tiles around the covered ones only contribute labels that reach into the region. */
  textOnly: boolean
}

interface LoadedBucket {
  bucket: TileBucket
  meshes: BucketMeshes | null
}

const MEGABYTE_BYTES = 2 ** 20

/**
 * Renders a MapLibre style (vector tiles from XYZ, TileJSON or PMTiles) onto terrain tiles, on the GPU.
 *
 * Tiles are fetched, decoded and tessellated in a worker (fills, lines, circles, and SDF text labels). For
 * each terrain tile's region, the covering vector tiles are drawn straight into the region's texture, at the
 * region's own resolution (so text stays sharp), with 4× multisampling, through the shared
 * `ImageryCompositor`, under its per-frame budget.
 *
 * Extends 3DTilesRenderer's `XYZTilesOverlay` only for its Web Mercator tiling; its image source is never
 * fetched from.
 */
export class MapStyleOverlay extends XYZTilesOverlay implements GpuComposedOverlay {
  /** Set by `ImageOverlayPlugin` when the overlay is added to it. */
  compositor: ImageryCompositor | null = null
  /** The style's summary once loaded: sources, zoom ranges, background. */
  summary: MapStyleSummary | null = null

  declare imageSource: { init(): Promise<void>; tiling: unknown }
  /** Upstream `ImageOverlay.fetch`: goes through 3DTilesRenderer's download queue and `preprocessURL`. */
  declare fetch: (url: string, options?: RequestInit) => Promise<Response>
  protected readonly options: Required<Omit<MapStyleOverlayOptions, 'baseUrl' | 'opacity'>> & { baseUrl: string | undefined }
  protected backend: MapStyleBackend | null = null
  protected resolution = 256
  protected readonly atlas = new GlyphAtlasTexture()
  protected readonly shapeMaterial = createShapeMaterial()
  protected readonly textMaterial: MeshBasicNodeMaterial
  protected readonly backgroundColor: Vector4
  protected readonly backgroundMaterial: MeshBasicNodeMaterial
  protected readonly background: Mesh
  protected readonly scene = new Scene()
  protected readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1)
  protected scratch: RenderTarget | null = null
  protected readonly buckets: RefCountedCache<LoadedBucket>
  protected readonly regions: RefCountedCache<RenderTarget>
  protected readonly queuedTargets = new Map<string, RenderTarget>()
  protected readonly waitedRegions = new Set<string>()

  constructor({
    style,
    baseUrl,
    opacity = 1,
    requestHeaders = {},
    localFontFamily = 'sans-serif',
    maximumZoom = 20,
    createWorker = createVectorTileWorker,
    retainedTileBytes = 32 * MEGABYTE_BYTES,
  }: MapStyleOverlayOptions) {
    super({ url: 'map-style://{z}/{x}/{y}', levels: maximumZoom + 1, tileDimension: TILE_SIZE_PIXELS, projection: 'EPSG:3857', opacity })
    this.options = { style, baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker, retainedTileBytes }
    this.textMaterial = createTextMaterial(this.atlas)
    const background = createBackgroundMaterial()
    this.backgroundMaterial = background.material
    this.backgroundColor = background.color
    this.background = new Mesh(new PlaneGeometry(1, 1), this.backgroundMaterial)
    this.background.position.set(0.5, 0.5, 0)
    this.background.renderOrder = -1
    this.background.frustumCulled = false
    this.scene.matrixWorldAutoUpdate = true

    this.buckets = new RefCountedCache<LoadedBucket>({
      load: async (key, signal) => {
        const bucket = await this.requireBackend().processTile(parseBucketKey(key), signal)
        return { bucket, meshes: null }
      },
      dispose: loaded => loaded.meshes?.dispose(),
      getByteLength: loaded => loaded.bucket.byteLength,
      retainedBytes: retainedTileBytes,
    })
    this.regions = new RefCountedCache<RenderTarget>({
      load: (key, signal) => this.loadRegion(key, signal),
      dispose: target => target.dispose(),
    })
  }

  // Upstream `TiledImageOverlay._init` would create a region source over the (unused) XYZ image source.
  async _init(): Promise<void> {
    const { style, baseUrl } = await this.resolveStyle()
    const processorOptions = { style, baseUrl, requestHeaders: this.options.requestHeaders, localFontFamily: this.options.localFontFamily }
    const onAtlasUpdate = this.atlas.apply.bind(this.atlas)
    const { createWorker } = this.options
    if (createWorker !== null && typeof Worker !== 'undefined') {
      try {
        const backend = new WorkerMapStyleBackend(createWorker(), onAtlasUpdate)
        this.backend = backend
        this.summary = await backend.init(processorOptions)
      } catch (error) {
        console.warn(`MapStyleSource: the vector tile worker did not start, tiles are processed on the main thread. ${(error as Error).message}`)
        this.backend?.dispose()
        this.backend = null
      }
    }
    if (this.backend === null || this.summary === null) {
      const backend = new InlineMapStyleBackend(onAtlasUpdate)
      this.backend = backend
      this.summary = await backend.init(processorOptions)
    }
    if (this.summary.skippedLayers.length > 0) {
      console.warn(`MapStyleSource: ${this.summary.skippedLayers.length} style layers are not supported yet and are skipped: ${this.summary.skippedLayers.join(', ')}`)
    }
    await this.imageSource.init()
  }

  /** Smallest zoom whose 512-pixel tiles have at least `resolution` pixels across the range. */
  calculateLevel(range: number[]): number {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const size = Math.max(maximumX - minimumX, maximumY - minimumY)
    const level = Math.ceil(Math.log2(this.resolution / (TILE_SIZE_PIXELS * size)) - 1e-6)
    return Math.min(Math.max(level, 0), this.options.maximumZoom)
  }

  hasContent(range: number[]): boolean {
    const summary = this.summary
    if (summary === null) return false
    const level = this.calculateLevel(range)
    return summary.backgroundByZoom[level] !== null || summary.sources.some(source => level >= source.minimumZoom)
  }

  lockTexture(range: number[]): Promise<Texture> {
    return this.regions.lock(regionKey(range, this.calculateLevel(range))).then(target => target.texture)
  }

  // 3DTilesRenderer calls this when it starts waiting for the texture: draw it before preloads.
  getTexture(range: number[]): Promise<Texture | null> {
    const key = regionKey(range, this.calculateLevel(range))
    const target = this.queuedTargets.get(key)
    if (target !== undefined) this.compositor?.prioritize(target)
    else this.waitedRegions.add(key)
    const region = this.regions.peek(key)
    return region === null ? Promise.resolve(null) : region.then(result => result.texture)
  }

  releaseTexture(range: number[]): void {
    this.regions.release(regionKey(range, this.calculateLevel(range)))
  }

  shouldSplit(range: number[]): boolean {
    return this.calculateLevel(range) < this.options.maximumZoom
  }

  setResolution(resolution: number): void {
    this.resolution = resolution
  }

  /** Stops the worker and frees every texture and mesh. Call after removing the layer. */
  dispose(): void {
    this.regions.dispose()
    this.buckets.dispose()
    this.backend?.dispose()
    this.backend = null
    this.scratch?.dispose()
    this.atlas.dispose()
    this.shapeMaterial.dispose()
    this.textMaterial.dispose()
    this.backgroundMaterial.dispose()
    this.background.geometry.dispose()
  }

  protected requireBackend(): MapStyleBackend {
    if (this.backend === null) throw new DOMException('MapStyleSource: disposed', 'AbortError')
    return this.backend
  }

  protected async resolveStyle(): Promise<{ style: unknown; baseUrl: string }> {
    const pageUrl = typeof location === 'undefined' ? undefined : location.href
    const { style } = this.options
    if (typeof style !== 'string') {
      const baseUrl = this.options.baseUrl ?? pageUrl
      if (baseUrl === undefined) throw new Error('MapStyleSource: pass `baseUrl` with a style object outside a browser page.')
      return { style, baseUrl }
    }
    const url = new URL(style, pageUrl).href
    const response = await this.fetch(url, { headers: this.options.requestHeaders })
    if (!response.ok) throw new Error(`MapStyleSource: style ${url} answered ${response.status}.`)
    return { style: await response.json(), baseUrl: url }
  }

  /** Vector tiles under a region at its zoom, plus a ring of neighbours for labels crossing its edges. */
  protected getRegionTiles(range: readonly number[], level: number): RegionTile[] {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const tiles: RegionTile[] = []
    for (const source of this.summary?.sources ?? []) {
      if (level < source.minimumZoom) continue
      const z = Math.min(level, source.maximumZoom)
      const count = 2 ** z
      const epsilon = 1e-9
      const fromColumn = Math.floor(minimumX * count + epsilon)
      const toColumn = Math.floor(maximumX * count - epsilon)
      // Rows count from the north; normalised y grows to the north.
      const fromRow = Math.max(0, Math.floor((1 - maximumY) * count + epsilon))
      const toRow = Math.min(count - 1, Math.floor((1 - minimumY) * count - epsilon))
      if (fromRow > toRow) continue
      const seen = new Set<string>()
      for (const textOnly of [false, true]) {
        const ring = textOnly ? 1 : 0
        for (let column = fromColumn - ring; column <= toColumn + ring; column++) {
          for (let row = Math.max(0, fromRow - ring); row <= Math.min(count - 1, toRow + ring); row++) {
            const isInside = column >= fromColumn && column <= toColumn && row >= fromRow && row <= toRow
            if (textOnly && isInside) continue
            const x = ((column % count) + count) % count
            const request: TileRequest = { sourceId: source.id, x, y: row, z, zoom: level }
            const key = bucketKey(request)
            if (seen.has(key)) continue
            seen.add(key)
            tiles.push({ key, request, column, textOnly })
          }
        }
      }
    }
    return tiles
  }

  protected async loadRegion(key: string, signal: AbortSignal): Promise<RenderTarget> {
    const { range, level } = parseRegionKey(key)
    const tiles = this.getRegionTiles(range, level)
    // A tile that fails to load (network, decode) draws as empty rather than failing the whole region.
    const loads = tiles.map(tile => this.buckets.lock(tile.key).catch(() => null))
    try {
      const buckets = await abortable(Promise.all(loads), signal)
      const compositor = this.compositor
      if (compositor === null) throw new Error('MapStyleSource: needs the GPU compositor of ImageOverlayPlugin (add it through Terrain).')
      const target = compositor.createTarget(this.resolution)
      target.texture.name = 'MapStyleComposite'
      this.queuedTargets.set(key, target)
      try {
        await compositor.enqueueRender(
          target,
          (renderer, output) => this.drawRegion(renderer, compositor, output, range, level, tiles, buckets),
          signal,
          this.waitedRegions.has(key),
        )
        return target
      } catch (error) {
        target.dispose()
        throw error
      } finally {
        this.queuedTargets.delete(key)
      }
    } finally {
      this.waitedRegions.delete(key)
      for (const tile of tiles) this.buckets.release(tile.key)
    }
  }

  protected drawRegion(
    renderer: WebGPURenderer,
    compositor: ImageryCompositor,
    output: RenderTarget,
    range: readonly number[],
    level: number,
    tiles: readonly RegionTile[],
    buckets: ReadonlyArray<LoadedBucket | null>,
  ): void {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const width = maximumX - minimumX
    const height = maximumY - minimumY
    const scene = this.scene
    const background = this.summary?.backgroundByZoom[level] ?? null
    if (background !== null) {
      this.backgroundColor.set(background[0] / 255, background[1] / 255, background[2] / 255, background[3] / 255)
      scene.add(this.background)
    }
    tiles.forEach((tile, order) => {
      const loaded = buckets[order]
      if (loaded === null || loaded === undefined) return
      loaded.meshes ??= new BucketMeshes(loaded.bucket, this.shapeMaterial, this.textMaterial)
      // Tile units (y down from the tile's north edge) to the region's 0 to 1 space (y up), in 64-bit here.
      const { z, y } = tile.request
      const tileSize = 1 / 2 ** z
      const place = (mesh: Mesh, renderOrder: number) => {
        mesh.position.set((tile.column * tileSize - minimumX) / width, (1 - y * tileSize - minimumY) / height, 0)
        mesh.scale.set(tileSize / width / TILE_EXTENT, -tileSize / height / TILE_EXTENT, 1)
        mesh.renderOrder = renderOrder
        scene.add(mesh)
      }
      if (!tile.textOnly) for (const { group, mesh } of loaded.meshes.shapes) place(mesh, group * 10_000 + order)
      if (loaded.meshes.text !== null) place(loaded.meshes.text, 100_000_000 + order)
    })
    try {
      if (scene.children.length > 0) {
        const scratch = this.getScratch(output.width)
        renderer.setRenderTarget(scratch)
        renderer.render(scene, this.camera)
        compositor.copyTexture(renderer, scratch.texture, output)
      } else {
        renderer.setRenderTarget(output)
        renderer.clear()
      }
    } finally {
      scene.clear()
    }
  }

  /** The multisampled target regions are drawn into, then resolved into their own single-sample texture. */
  protected getScratch(resolution: number): RenderTarget {
    if (this.scratch !== null && this.scratch.width === resolution) return this.scratch
    this.scratch?.dispose()
    this.scratch = new RenderTarget(resolution, resolution, {
      samples: 4,
      colorSpace: SRGBColorSpace,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    })
    this.scratch.texture.name = 'MapStyleScratch'
    return this.scratch
  }
}

function regionKey(range: readonly number[], level: number): string {
  return `${range.join('_')}_${level}`
}

function parseRegionKey(key: string): { range: number[]; level: number } {
  const values = key.split('_').map(Number)
  return { range: values.slice(0, 4), level: values[4] ?? 0 }
}

export function bucketKey({ sourceId, x, y, z, zoom }: TileRequest): string {
  return `${zoom}/${z}/${x}/${y}/${sourceId}`
}

function parseBucketKey(key: string): TileRequest {
  const [zoom, z, x, y, ...source] = key.split('/')
  return { sourceId: source.join('/'), x: Number(x), y: Number(y), z: Number(z), zoom: Number(zoom) }
}

/** Rejects with the signal's reason as soon as it aborts, without waiting for the promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
