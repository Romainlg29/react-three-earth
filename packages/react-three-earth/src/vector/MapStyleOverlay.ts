import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { LinearFilter, Mesh, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, Vector4, type Texture } from 'three'
import type { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu'

import type { GeographicBounds } from '../core/camera.js'
import type { ImageryCompositor } from '../tiles/imagery/ImageryCompositor.js'
import type { GpuComposedOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import { createVectorTileWorker, InlineMapStyleBackend, WorkerMapStyleBackend, type MapStyleBackend } from './MapStyleBackend.js'
import { RefCountedCache, type Lease } from './RefCountedCache.js'
import { BucketMeshes, createBackgroundMaterial, createShapeMaterial, createTextMaterial, GlyphAtlasTexture } from './VectorTileMeshes.js'
import { boundsToMercatorRectangles, tileOverlaps, type MercatorRectangle } from './worker/rectangles.js'
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
  /** Starts the worker. Default: the worker shipped with the library. Pass `null` to process on the main thread. Keep it stable (not an inline arrow in JSX), or the source reloads. */
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

/** A region load or redraw in flight. An invalidation that reaches it marks it stale: it redraws once more after. */
interface RegionWork {
  stale: boolean
}

interface Recomposition extends RegionWork {
  target: RenderTarget
  controller: AbortController
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
 * `invalidate` redraws regions whose content changed, in place: each keeps showing its previous texture until
 * the new one is drawn over it in one pass, so there is no flicker and no hole.
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
  /** First loads in flight, by region key. */
  protected readonly loadingRegions = new Map<string, RegionWork>()
  /** Redraws in flight, by region key. */
  protected readonly recompositions = new Map<string, Recomposition>()
  /** Loaded regions to redraw at the start of the next compositor frame. */
  protected readonly staleRegions = new Set<string>()
  protected readonly startRecompositions = (): void => this.recomposeStaleRegions()
  protected disposed = false

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
      dispose: (target, key) => {
        const recomposition = this.recompositions.get(key)
        if (recomposition?.target === target) {
          recomposition.controller.abort(new DOMException('MapStyleSource: region released', 'AbortError'))
          this.recompositions.delete(key)
        }
        this.staleRegions.delete(key)
        target.dispose()
      },
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
    return (summary.backgroundByZoom[Math.min(level, summary.backgroundByZoom.length - 1)] ?? null) !== null || summary.sources.some(source => level >= source.minimumZoom)
  }

  lockTexture(range: number[]): Promise<Texture> {
    return this.regions.lock(regionKey(range, this.calculateLevel(range))).then(target => target.texture)
  }

  // 3DTilesRenderer calls this when it starts waiting for the texture: draw it before preloads.
  getTexture(range: number[]): Promise<Texture | null> {
    const key = regionKey(range, this.calculateLevel(range))
    const target = this.queuedTargets.get(key)
    const region = this.regions.peek(key)
    if (target !== undefined) this.compositor?.prioritize(target)
    else if (region !== null && this.regions.get(key) === null) this.waitedRegions.add(key) // still loading its tiles
    return region === null ? Promise.resolve(null) : region.then(result => result.texture)
  }

  releaseTexture(range: number[]): void {
    const key = regionKey(range, this.calculateLevel(range))
    this.regions.release(key)
    if (this.regions.peek(key) === null) this.waitedRegions.delete(key)
  }

  shouldSplit(range: number[]): boolean {
    return this.calculateLevel(range) < this.options.maximumZoom
  }

  setResolution(resolution: number): void {
    this.resolution = resolution
  }

  /**
   * Redraws the regions whose content may have changed within `bounds` (no argument: everywhere), for tiles
   * whose data changed on the server, for example. Cached tiles there are fetched and processed again, and
   * regions whose labels reach into the bounds redraw too. Each region keeps its current texture until the
   * new one replaces it. Calls within a frame are coalesced; redraws share the compositor's per-frame budget,
   * after first textures of visible tiles.
   */
  invalidate(bounds?: GeographicBounds): void {
    if (this.disposed) return
    const rectangles = bounds === undefined ? null : boundsToMercatorRectangles(bounds)
    this.backend?.invalidate(rectangles)
    for (const key of [...this.buckets.keys()]) {
      const { x, y, z } = parseBucketKey(key)
      if (tileOverlaps(x, y, z, rectangles)) this.buckets.discard(key)
    }
    for (const key of this.regions.keys()) {
      if (!this.regionReaches(key, rectangles)) continue
      const work = this.loadingRegions.get(key) ?? this.recompositions.get(key)
      if (work !== undefined) work.stale = true
      // Loaded, or between the end of its load and the cache marking it loaded: redraw next frame.
      else if (this.regions.get(key) !== null || this.regions.isLoading(key)) this.staleRegions.add(key)
    }
    if (this.staleRegions.size > 0) this.compositor?.runBeforeNextRender(this.startRecompositions)
  }

  /** Regions waiting to be redrawn after `invalidate`, or being redrawn. `Earth.inspect()` reports the sum. */
  get recompositionsPending(): number {
    let staleLoads = 0
    for (const work of this.loadingRegions.values()) if (work.stale) staleLoads++
    return this.staleRegions.size + this.recompositions.size + staleLoads
  }

  /** Whether `dispose` was called. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Stops the worker and frees every texture and mesh. Call after removing the layer. */
  dispose(): void {
    this.disposed = true
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
      // Labels reach up to about 256 px beyond their tile: half a tile, less when overzoomed. Ring tiles
      // further from the region are skipped.
      const reach = 0.5 / 2 ** (level - z)
      const regionLeft = minimumX * count
      const regionRight = maximumX * count
      const regionTop = (1 - maximumY) * count
      const regionBottom = (1 - minimumY) * count
      for (const textOnly of [false, true]) {
        const ring = textOnly ? 1 : 0
        for (let column = fromColumn - ring; column <= toColumn + ring; column++) {
          for (let row = Math.max(0, fromRow - ring); row <= Math.min(count - 1, toRow + ring); row++) {
            const isInside = column >= fromColumn && column <= toColumn && row >= fromRow && row <= toRow
            if (textOnly && isInside) continue
            if (textOnly) {
              const gapX = Math.max(column - regionRight, regionLeft - (column + 1), 0)
              const gapY = Math.max(row - regionBottom, regionTop - (row + 1), 0)
              if (gapX > reach || gapY > reach) continue
            }
            // Columns wrap at the antimeridian: the same tile can be placed at several columns (low zooms).
            const x = ((column % count) + count) % count
            const request: TileRequest = { sourceId: source.id, x, y: row, z, zoom: level }
            tiles.push({ key: bucketKey(request), request, column, textOnly })
          }
        }
      }
    }
    return tiles
  }

  protected async loadRegion(key: string, signal: AbortSignal): Promise<RenderTarget> {
    const { range, level } = parseRegionKey(key)
    const tiles = this.getRegionTiles(range, level)
    const work: RegionWork = { stale: false }
    this.loadingRegions.set(key, work)
    const leases = this.acquireBuckets(tiles)
    try {
      const buckets = await abortable(Promise.all(tiles.map(tile => leases.get(tile.key)!.promise)), signal)
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
          this.waitedRegions.has(key) ? 'waited' : 'preload',
        )
      } catch (error) {
        target.dispose()
        throw error
      } finally {
        this.queuedTargets.delete(key)
      }
      // Invalidated while loading: show what was drawn now, and redraw it next frame.
      if (work.stale) {
        this.staleRegions.add(key)
        compositor.runBeforeNextRender(this.startRecompositions)
      }
      return target
    } finally {
      if (this.loadingRegions.get(key) === work) this.loadingRegions.delete(key)
      this.waitedRegions.delete(key)
      for (const lease of leases.values()) lease.release()
    }
  }

  /**
   * Locks the region's buckets, one lease per distinct tile. A missing tile (404) is an empty bucket. Any
   * other failure fails the region, so 3DTilesRenderer reports a load error and retries it, rather than
   * caching a hole. Leases, not keys, so an `invalidate` meanwhile cannot make a release hit the new entry.
   */
  protected acquireBuckets(tiles: readonly RegionTile[]): Map<string, Lease<LoadedBucket>> {
    const leases = new Map<string, Lease<LoadedBucket>>()
    for (const tile of tiles) if (!leases.has(tile.key)) leases.set(tile.key, this.buckets.acquire(tile.key))
    return leases
  }

  /** Whether any tile a region draws (labels of its ring included) overlaps the rectangles; `null`: everywhere. */
  protected regionReaches(key: string, rectangles: readonly MercatorRectangle[] | null): boolean {
    if (rectangles === null) return true
    const { range, level } = parseRegionKey(key)
    return this.getRegionTiles(range, level).some(({ request }) => tileOverlaps(request.x, request.y, request.z, rectangles))
  }

  protected recomposeStaleRegions(): void {
    const compositor = this.compositor
    const keys = [...this.staleRegions]
    this.staleRegions.clear()
    if (compositor === null || this.disposed) return
    for (const key of keys) {
      const target = this.regions.get(key)
      if (target === null) {
        // Its load just ended and the cache marks it loaded within microtasks: try again next frame.
        if (this.regions.isLoading(key) && !this.loadingRegions.has(key)) {
          this.staleRegions.add(key)
          compositor.runBeforeNextRender(this.startRecompositions)
        }
        continue // otherwise released meanwhile
      }
      void this.recomposeRegion(key, target, compositor)
    }
  }

  /** Redraws a loaded region into its own target, in place, with freshly processed tiles. */
  protected async recomposeRegion(key: string, target: RenderTarget, compositor: ImageryCompositor): Promise<void> {
    const work: Recomposition = { stale: false, target, controller: new AbortController() }
    this.recompositions.set(key, work)
    const { signal } = work.controller
    const { range, level } = parseRegionKey(key)
    const tiles = this.getRegionTiles(range, level)
    const leases = this.acquireBuckets(tiles)
    try {
      const buckets = await abortable(Promise.all(tiles.map(tile => leases.get(tile.key)!.promise)), signal)
      await compositor.enqueueRender(
        target,
        (renderer, output) => this.drawRegion(renderer, compositor, output, range, level, tiles, buckets),
        signal,
        'recomposition',
      )
    } catch (error) {
      if (!signal.aborted) {
        console.warn(`MapStyleSource: a region could not be redrawn after invalidate() and keeps its previous content; call invalidate() again to retry. ${(error as Error).message}`)
      }
    } finally {
      for (const lease of leases.values()) lease.release()
      if (this.recompositions.get(key) === work) this.recompositions.delete(key)
      if (work.stale && !signal.aborted && !this.disposed) {
        this.staleRegions.add(key)
        compositor.runBeforeNextRender(this.startRecompositions)
      } else if (this.recompositionsPending === 0) {
        // The last redraw settled after its frame: ask for one more, so `loading` turns false (and `idle` fires) on demand-driven hosts.
        compositor.onQueued?.()
      }
    }
  }

  protected drawRegion(
    renderer: WebGPURenderer,
    compositor: ImageryCompositor,
    output: RenderTarget,
    range: readonly number[],
    level: number,
    tiles: readonly RegionTile[],
    buckets: readonly LoadedBucket[],
  ): void {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const width = maximumX - minimumX
    const height = maximumY - minimumY
    const scene = this.scene
    this.atlas.upload()
    const backgrounds = this.summary?.backgroundByZoom ?? []
    const background = backgrounds[Math.min(level, backgrounds.length - 1)] ?? null
    if (background !== null) {
      this.backgroundColor.set(background[0] / 255, background[1] / 255, background[2] / 255, background[3] / 255)
      scene.add(this.background)
    }
    const placements = new Map<LoadedBucket, number>()
    tiles.forEach((tile, order) => {
      const loaded = buckets[order]
      if (loaded === null || loaded === undefined) return
      loaded.meshes ??= new BucketMeshes(loaded.bucket, this.shapeMaterial, this.textMaterial)
      // Tile units (y down from the tile's north edge) to the region's 0 to 1 space (y up), in 64-bit here.
      const { z, y } = tile.request
      const tileSize = 1 / 2 ** z
      // Near the antimeridian at low zooms, one bucket is placed at several columns: each needs its own Mesh.
      const placement = placements.get(loaded) ?? 0
      placements.set(loaded, placement + 1)
      const place = (source: Mesh, renderOrder: number) => {
        const mesh = loaded.meshes!.placement(source, placement)
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
