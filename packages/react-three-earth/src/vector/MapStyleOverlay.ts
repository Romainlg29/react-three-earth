import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { Color, HalfFloatType, LinearFilter, LinearSRGBColorSpace, Mesh, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, Vector4, type Texture } from 'three'
import { texture } from 'three/tsl'
import type { MeshBasicNodeMaterial, NodeMaterial, WebGPURenderer } from 'three/webgpu'

import type { GeographicBounds } from '../core/camera.js'
import type { ImageryCompositor } from '../tiles/imagery/ImageryCompositor.js'
import type { StyleLayerTypeDefinition, StyleLayerTypeRegistry } from '../plugins/styleLayerTypes.js'
import type { SymbolEffectRegistry } from '../plugins/symbolEffects.js'
import type { GpuComposedOverlay } from '../tiles/imagery/XYZImageryOverlay.js'
import { createCompositeMaterial, createCustomLayerMaterial, setCustomLayerDrawValues } from './customLayerMaterials.js'
import { HeatmapLayers } from './heatmap/HeatmapLayers.js'
import { HEATMAP_LAYER_TYPE } from './heatmap/heatmapWorker.js'
import { MapStyle, type SequencedStyleChange } from './MapStyle.js'
import { createVectorTileWorker, InlineMapStyleBackend, WorkerMapStyleBackend, type MapStyleBackend, type MapStyleBackendHost } from './MapStyleBackend.js'
import { RefCountedCache, type Lease } from './RefCountedCache.js'
import { Extrusions, extrusionTileKey, type ExtrusionsHost } from './extrusions/Extrusions.js'
import { ScreenSymbols, symbolTileKey, type ScreenSymbolsHost } from './symbols/ScreenSymbols.js'
import {
  BucketMeshes,
  createBackgroundMaterial,
  createBackgroundPatternMaterial,
  createPatternShapeMaterial,
  createShapeMaterial,
  createTextMaterial,
  FeatureColorTexture,
  GlyphAtlasTexture,
  ImageAtlasTexture,
  type ShapeMaterials,
} from './VectorTileMeshes.js'
import { RasterLayerRenderer, type RasterRegionTile } from './raster/RasterLayerRenderer.js'
import { boundsToMercatorRectangles, tileOverlaps, tileOverlapsWithMargin, type MercatorRectangle } from './worker/rectangles.js'
import {
  TILE_EXTENT,
  TILE_SIZE_PIXELS,
  type BackgroundPattern,
  type FeatureState,
  type ImageChange,
  type MapStyleProcessorOptions,
  type MapStyleSourceSummary,
  type MapStyleSummary,
  type MercatorPoint,
  type QueryTile,
  type RenderedSourceFeature,
  type SourceFeature,
  type StyleCommand,
  type StyleImage,
  type StyleUpdateResult,
  type TileBucket,
  type TileRequest,
} from './worker/types.js'

export interface MapStyleOverlayOptions {
  /** A style URL, the style document itself, or a `MapStyle` shared with other overlays (`MapStyleSource` passes its own). */
  style: string | object | MapStyle
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
  /** Sprite sheet to load: 2 for the `@2x` sheet. Default: 2 on high-density screens (`devicePixelRatio` > 1), else 1. */
  spritePixelRatio?: number
  /** Runtime images (`addImage`) known before the style loads. Later changes go through `setImage`. */
  images?: ReadonlyMap<string, StyleImage>
  /**
   * Where point-placed labels go. `'screen'`: they face the viewer at a constant size, collide across the whole screen
   * and fade, as in MapLibre (line-placed labels stay draped for now). `'draped'`: every label is drawn into the
   * terrain's textures, lying on the ground. Default: 'screen'.
   */
  symbols?: 'screen' | 'draped'
  /** Seconds labels facing the viewer take to fade in or out (MapLibre's `fadeDuration`). Default: 0.3. */
  symbolFadeDurationSeconds?: number
  /**
   * How `fill-extrusion` layers draw. `'3d'`: as buildings standing on the terrain, lit by the sun, as in MapLibre.
   * `'draped'`: their footprints drawn flat into the terrain's textures. Default: '3d'.
   */
  extrusions?: '3d' | 'draped'
  /** Called once the style is loaded and `summary` is set. */
  onLoad?: (summary: MapStyleSummary) => void
  /**
   * Called once per id when a tile asks for an image (a pattern) that neither the sprite nor the runtime
   * images have. Adding it then redraws the tiles that asked for it.
   */
  onStyleImageMissing?: (imageId: string) => void
  /** Called after the style loaded and each time a style change gave a new summary (sources, attributions…). */
  onSummaryChange?: (summary: MapStyleSummary) => void
}

/** Options of `queryRenderedFeatures`. */
export interface RenderedFeatureQueryOptions {
  /** Only features of these style layers. Default: every layer. */
  layers?: readonly string[]
  /** A MapLibre filter expression the features must also pass, as in a layer's `filter`. Default: none. */
  filter?: unknown
  /**
   * Extra distance within which a feature counts as under the pointer, in map pixels at the zoom the terrain is
   * textured at there (about screen pixels). Helps on touch screens. Default: 0, as MapLibre.
   */
  tolerancePixels?: number
}

/** Options of `querySourceFeatures`. */
export interface SourceFeatureQueryOptions {
  /** The source layer to read (MapLibre requires it for vector sources). Default: every source layer. */
  sourceLayer?: string
  /** A MapLibre filter expression the features must pass. Default: none. */
  filter?: unknown
}

/** One vector tile a region draws. */
interface RegionTile {
  key: string
  request: TileRequest
  /** Unwrapped column (may be outside 0 to 2^z - 1 next to the antimeridian), for placement. */
  column: number
  /** Ring tiles around the covered ones only contribute labels and custom layers with reach into the region. */
  textOnly: boolean
}

interface LoadedBucket {
  key: string
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
 * How far around a region elevation tiles are read, in tiles: the slopes at the region's edge need two of the
 * source's pixels beyond it (at most two strides of 256-pixel tiles).
 */
const ELEVATION_RING_REACH_TILES = 0.02

/** A custom layer type's GPU side in this overlay, built on first use. */
interface CustomLayerType {
  definition: StyleLayerTypeDefinition
  /** Null when `createMaterial` failed: its layers are skipped. */
  material: NodeMaterial | null
  composite: Mesh | null
  /** Built-in types only (`heatmap`): sets per-layer values on a placed mesh, then on the composite, before they draw. */
  prepareDraw?: (object: Mesh, layerId: string, zoom: number) => void
  prepareComposite?: (object: Mesh, layerId: string, zoom: number) => void
}

/** Meshes placed in a region scene, with what the offscreen passes need to sort them. */
interface PlacedMesh {
  mesh: Mesh
  renderOrder: number
  /** The offscreen layer type it draws into, if any. */
  offscreen: CustomLayerType | null
  /** The style layer of an offscreen mesh. */
  layerId?: string
}

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
export class MapStyleOverlay extends XYZTilesOverlay implements GpuComposedOverlay, ScreenSymbolsHost, ExtrusionsHost {
  /** Set by `ImageOverlayPlugin` when the overlay is added to it. */
  compositor: ImageryCompositor | null = null
  /** The style's summary once loaded: sources, zoom ranges, background. */
  summary: MapStyleSummary | null = null

  declare imageSource: { init(): Promise<void>; tiling: unknown }
  /** Upstream `ImageOverlay.fetch`: goes through 3DTilesRenderer's download queue and `preprocessURL`. */
  declare fetch: (url: string, options?: RequestInit) => Promise<Response>
  /** The style this overlay draws; its changes reach the overlay as they are made. */
  readonly mapStyle: MapStyle
  /** Labels that face the viewer (`symbols: 'screen'`), or null when every label is draped. `Terrain` adds its object to the scene and updates it. */
  readonly screenSymbols: ScreenSymbols | null
  /** `fill-extrusion` layers standing in 3D (`extrusions: '3d'`), or null when they are draped. `Terrain` adds its object to the scene and updates it. */
  readonly extrusions: Extrusions | null
  protected readonly options: Required<Omit<MapStyleOverlayOptions, 'baseUrl' | 'opacity' | 'onLoad' | 'onSummaryChange' | 'style' | 'images' | 'onStyleImageMissing' | 'symbols' | 'symbolFadeDurationSeconds' | 'extrusions'>> & {
    baseUrl: string | undefined
  }
  protected readonly onLoad: ((summary: MapStyleSummary) => void) | undefined
  protected readonly onStyleImageMissing: ((imageId: string) => void) | undefined
  /** Runtime images as last set; the worker's copy follows through `setImage`. */
  protected readonly images: Map<string, StyleImage>
  /** Whether a snapshot handed `images` to the backend: later changes are sent as messages. */
  protected imagesSent = false
  /** Settles when the backend is ready (or failed): image changes queue behind it, in order. */
  protected imageQueue: Promise<unknown>
  protected resolveBackendReady: () => void = () => {}
  /**
   * Bucket keys that used each image id, recorded when buckets load and kept after they leave the cache, so
   * an image change still finds regions whose buckets were evicted. Pruned to tiles of held regions.
   */
  protected readonly imageUsers = new Map<string, Set<string>>()
  /** Missing image ids already reported, so each is reported once until it is added. */
  protected readonly reportedMissingImages = new Set<string>()
  /** The main thread copy of the worker's image atlas (patterns now, icons later), for custom layers that sample style images. */
  readonly imageAtlas = new ImageAtlasTexture()
  /** Shape materials by bucket kind: with or without patterns, with or without colour slots. */
  protected readonly shapeMaterials: ShapeMaterials
  protected readonly backgroundPattern: ReturnType<typeof createBackgroundPatternMaterial>
  protected readonly backgroundPatternMesh: Mesh
  protected readonly onSummaryChange: ((summary: MapStyleSummary) => void) | undefined
  protected readonly featureColors = new FeatureColorTexture()
  /** Loaded buckets drawing each feature with colour slots (redraw on a state change) or baked (process again). */
  protected readonly featureBuckets = { colors: new Map<string, Set<LoadedBucket>>(), rebuild: new Map<string, Set<LoadedBucket>>() }
  /** Feature-state messages sent to the backend so far, and when each feature last changed (in that count). */
  protected featureStateVersion = 0
  protected readonly featureStateChangedAt = new Map<string, number>()
  /** Tile requests in flight, by the feature-state version they were sent at (to prune `featureStateChangedAt`). */
  protected readonly inFlightVersions = new Map<number, number>()
  /** The style change sequence the backend's snapshot covers: later changes are sent; −1 before the first. */
  protected snapshotSequence = -1
  /** Backend answers to style changes, applied in the order the changes were sent. */
  protected styleWork: Promise<void> = Promise.resolve()
  protected unsubscribe: (() => void) | null = null
  /** Stops answering source queries (clusters) for the style. */
  protected detachSourceQueries: (() => void) | null = null
  protected backend: MapStyleBackend | null = null
  protected resolution = 256
  protected readonly atlas = new GlyphAtlasTexture()
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
  /** Custom style layer types from plugins (`earth.styleLayerTypes`), handed over by `ImageOverlayPlugin`. */
  protected styleLayerTypes: StyleLayerTypeRegistry | null = null
  protected removeStyleDataListener: (() => void) | null = null
  protected unsubscribeLayerTypes: (() => void) | null = null
  protected layerTypesScheduled = false
  protected readonly customLayerTypes = new Map<string, CustomLayerType>()
  /** The built-in `heatmap` type: drawn like a plugin's offscreen layer, coloured per layer. */
  protected readonly heatmap = new HeatmapLayers()
  protected readonly warnedLayerTypes = new Set<string>()
  /** Where offscreen custom layers draw before they are composited (one per overlay, region-sized). */
  protected layerTarget: RenderTarget | null = null
  protected readonly placeholderLayerTarget = new RenderTarget(1, 1)
  protected readonly layerTexture = texture(this.placeholderLayerTarget.texture)
  protected readonly layerScene = new Scene()
  protected readonly compositeScene = new Scene()
  protected readonly clearColor = new Color()
  /** Ranges of regions on visible terrain tiles, with how many visible tiles show each (`setRegionVisible`). */
  protected readonly visibleRegions = new Map<string, { range: number[]; count: number }>()
  /** Raster, hillshade and colour relief layers. */
  protected readonly rasterLayers = new RasterLayerRenderer()
  /** Each raster source's bounds in normalised Web Mercator, by its summary. */
  protected readonly sourceRectangles = new WeakMap<MapStyleSourceSummary, MercatorRectangle[] | null>()

  constructor({
    style,
    baseUrl,
    opacity = 1,
    requestHeaders = {},
    localFontFamily = 'sans-serif',
    maximumZoom = 20,
    createWorker = createVectorTileWorker,
    retainedTileBytes = 32 * MEGABYTE_BYTES,
    spritePixelRatio = defaultSpritePixelRatio(),
    images,
    symbols = 'screen',
    symbolFadeDurationSeconds,
    extrusions = '3d',
    onLoad,
    onSummaryChange,
    onStyleImageMissing,
  }: MapStyleOverlayOptions) {
    super({ url: 'map-style://{z}/{x}/{y}', levels: maximumZoom + 1, tileDimension: TILE_SIZE_PIXELS, projection: 'EPSG:3857', opacity })
    this.onLoad = onLoad
    this.onSummaryChange = onSummaryChange
    this.onStyleImageMissing = onStyleImageMissing
    this.options = { baseUrl, requestHeaders, localFontFamily, maximumZoom, createWorker, retainedTileBytes, spritePixelRatio }
    this.images = new Map(images)
    this.imageQueue = new Promise<void>(resolve => (this.resolveBackendReady = resolve))
    this.mapStyle = style instanceof MapStyle ? style : new MapStyle({ style, requestHeaders, ...(baseUrl !== undefined ? { baseUrl } : {}) })
    this.textMaterial = createTextMaterial(this.atlas)
    this.shapeMaterials = {
      plain: createShapeMaterial(),
      slotted: createShapeMaterial(this.featureColors),
      patterned: createPatternShapeMaterial(this.imageAtlas),
      slottedPatterned: createPatternShapeMaterial(this.imageAtlas, this.featureColors),
      blurred: {
        plain: createShapeMaterial(undefined, { blurred: true }),
        slotted: createShapeMaterial(this.featureColors, { blurred: true }),
        patterned: createPatternShapeMaterial(this.imageAtlas, undefined, { blurred: true }),
        slottedPatterned: createPatternShapeMaterial(this.imageAtlas, this.featureColors, { blurred: true }),
      },
    }
    this.backgroundPattern = createBackgroundPatternMaterial(this.imageAtlas)
    this.backgroundPatternMesh = new Mesh(new PlaneGeometry(1, 1), this.backgroundPattern.material)
    this.backgroundPatternMesh.position.set(0.5, 0.5, 0)
    this.backgroundPatternMesh.renderOrder = -1
    this.backgroundPatternMesh.frustumCulled = false
    const background = createBackgroundMaterial()
    this.backgroundMaterial = background.material
    this.backgroundColor = background.color
    this.background = new Mesh(new PlaneGeometry(1, 1), this.backgroundMaterial)
    this.background.position.set(0.5, 0.5, 0)
    this.background.renderOrder = -2
    this.background.frustumCulled = false
    this.scene.matrixWorldAutoUpdate = true
    this.screenSymbols = symbols === 'screen' ? new ScreenSymbols(this, symbolFadeDurationSeconds === undefined ? {} : { fadeDurationSeconds: symbolFadeDurationSeconds }) : null
    this.extrusions = extrusions === '3d' ? new Extrusions(this) : null

    this.buckets = new RefCountedCache<LoadedBucket>({
      load: async (key, signal) => {
        for (let attempt = 1; ; attempt++) {
          const sentVersion = this.featureStateVersion
          this.countInFlight(sentVersion, 1)
          let bucket: TileBucket
          try {
            bucket = await this.requireBackend().processTile(parseBucketKey(key), signal)
          } finally {
            this.countInFlight(sentVersion, -1)
          }
          // Started before a state change of a feature it bakes: process it again (the request now follows the change).
          const stale = bucket.rebuildFeatureKeys.some(feature => (this.featureStateChangedAt.get(feature) ?? 0) > bucket.featureStateVersion)
          if (stale && attempt < 3) continue
          // Still stale after three tries (states change faster than the tile processes): keep it, and process it
          // once more after the current changes settle.
          if (stale) queueMicrotask(() => this.rebuildTiles(request => bucketKey(request) === key))
          const loaded: LoadedBucket = { key, bucket, meshes: null }
          this.indexFeatures(loaded, true)
          this.recordImageUsers(key, bucket.images)
          this.reportMissingImages(bucket.missingImages)
          return loaded
        }
      },
      dispose: loaded => {
        this.indexFeatures(loaded, false)
        loaded.meshes?.dispose()
        this.rasterLayers.releaseTile(loaded.bucket.raster)
      },
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
    try {
      await this.initBackend()
    } finally {
      this.resolveBackendReady()
    }
    if (this.disposed || this.summary === null) return
    await this.imageSource.init()
    if (this.disposed) return
    this.reportMissingImages(this.summary.missingBackgroundImages)
    this.reportMissingLayerTypes(this.summary)
    this.onLoad?.(this.summary)
    this.onSummaryChange?.(this.summary)
    this.screenSymbols?.summaryChanged()
    this.extrusions?.summaryChanged()
  }

  protected async initBackend(): Promise<void> {
    await this.mapStyle.load(typeof this.fetch === 'function' ? (url, init) => this.fetch(String(url), init) : undefined)
    if (this.disposed) return
    this.unsubscribe = this.mapStyle.subscribe(this.receiveStyleChanges)
    // A layer's metadata can name another symbol effect (after `setStyle`): the labels drawn pick it up.
    const onStyleData = () => this.screenSymbols?.styleChanged()
    this.mapStyle.addEventListener('styledata', onStyleData)
    this.removeStyleDataListener = () => this.mapStyle.removeEventListener('styledata', onStyleData)
    const host: MapStyleBackendHost = {
      onAtlasUpdate: update => this.atlas.apply(update),
      onFeatureColorUpdate: update => this.featureColors.apply(update),
      onImageAtlasUpdate: update => this.imageAtlas.apply(update),
      resolveResource: (request, signal) => this.mapStyle.resolveResource(request, signal),
    }
    const { createWorker } = this.options
    if (createWorker !== null && typeof Worker !== 'undefined') {
      try {
        const backend = new WorkerMapStyleBackend(createWorker(), host)
        this.backend = backend
        this.summary = await backend.init(this.takeSnapshot())
      } catch (error) {
        if (this.disposed) return
        console.warn(`MapStyleSource: the vector tile worker did not start, tiles are processed on the main thread. ${(error as Error).message}`)
        this.backend?.dispose()
        this.backend = null
      }
    }
    if (this.backend === null || this.summary === null) {
      const backend = new InlineMapStyleBackend(host)
      this.backend = backend
      // A fresh snapshot: changes sent to a worker that failed are in it
      this.summary = await backend.init(this.takeSnapshot())
    }
    if (this.disposed) return
    this.detachSourceQueries = this.mapStyle.attachSourceQueryHandler((sourceId, query) => this.requireBackend().querySource(sourceId, query))
    if (this.summary.skippedLayers.length > 0) {
      console.warn(
        `MapStyleSource: ${this.summary.skippedLayers.length} style layers are skipped: ${this.summary.skippedLayers.join(', ')}. ` +
          'An expression did not compile, or they read a source of the wrong kind (a hillshade needs a raster-dem source, a raster layer a raster source, the others a vector or GeoJSON source).',
      )
    }
  }

  /** The style as it is now, for the backend; changes made after it are sent as they come. */
  protected takeSnapshot(): MapStyleProcessorOptions {
    const snapshot = this.mapStyle.snapshot()
    this.snapshotSequence = this.mapStyle.sequence
    this.imagesSent = true
    return {
      style: snapshot.style,
      baseUrl: snapshot.baseUrl,
      requestHeaders: this.options.requestHeaders,
      localFontFamily: this.options.localFontFamily,
      featureStates: snapshot.featureStates,
      featureStateVersion: this.featureStateVersion,
      globalState: snapshot.globalState,
      transformsRequests: snapshot.transformsRequests,
      spritePixelRatio: this.options.spritePixelRatio,
      images: [...this.images],
      layerTypes: this.styleLayerTypes?.describe() ?? [],
      screenSymbols: this.screenSymbols !== null,
      extrusions: this.extrusions !== null,
    }
  }

  /** The glyph atlas the labels read (`ScreenSymbolsHost`). */
  get glyphAtlas(): GlyphAtlasTexture {
    return this.atlas
  }

  /** Deepest zoom tiles are laid out at (`ScreenSymbolsHost`). */
  get maximumZoom(): number {
    return this.options.maximumZoom
  }

  /** Locks a tile of labels facing the viewer in the tile cache (`ScreenSymbolsHost`). */
  acquireSymbolTile(request: TileRequest): Lease<LoadedBucket> {
    return this.buckets.acquire(bucketKey({ ...request, symbols: true }))
  }

  /** Locks a tile of 3D buildings in the tile cache (`ExtrusionsHost`). */
  acquireExtrusionTile(request: TileRequest): Lease<LoadedBucket> {
    return this.buckets.acquire(bucketKey({ ...request, extrusions: true }))
  }

  /**
   * The custom style layer types (plugins) to draw, or null for none. `ImageOverlayPlugin` calls it with
   * `earth.styleLayerTypes`. Changes reach the worker as they are made: layers of a new type appear, and
   * those of a removed one disappear, without fetching tiles again.
   */
  setStyleLayerTypes(registry: StyleLayerTypeRegistry | null): void {
    if (registry === this.styleLayerTypes) return
    this.unsubscribeLayerTypes?.()
    this.unsubscribeLayerTypes = null
    this.styleLayerTypes = registry
    if (registry !== null) this.unsubscribeLayerTypes = registry.subscribe(() => this.scheduleLayerTypes())
    this.scheduleLayerTypes()
  }

  /**
   * The symbol effects (plugins) labels facing the viewer are drawn with, or null for none. `ImageOverlayPlugin`
   * calls it with `earth.symbolEffects`. Draped labels (`symbols: 'draped'`) keep the standard look.
   */
  setSymbolEffects(registry: SymbolEffectRegistry | null): void {
    this.screenSymbols?.setSymbolEffects(registry)
  }

  /** Sends the layer types once per task: plugins installed together cost one recompile. */
  protected scheduleLayerTypes(): void {
    if (this.layerTypesScheduled) return
    this.layerTypesScheduled = true
    queueMicrotask(() => {
      this.layerTypesScheduled = false
      this.sendLayerTypes()
    })
  }

  /** Sends the current layer types to the backend; before it started, its snapshot carries them. */
  protected sendLayerTypes(): void {
    this.pruneCustomLayerTypes()
    if (this.disposed || this.backend === null || this.snapshotSequence < 0) return
    const layerTypes = this.styleLayerTypes?.describe() ?? []
    this.enqueueStyleWork(backend => backend.setLayerTypes(layerTypes), result => {
      const drawnBefore = this.summary?.customLayerTypes.join('\u0000')
      this.applyStyleResult(result)
      // Reach and offscreen passes change only with the types the style draws.
      if (result.rebuiltSources.length > 0 || result.summary.customLayerTypes.join('\u0000') !== drawnBefore) this.markRegionsStale(() => true)
    })
  }

  /** Frees the GPU side of types that were removed or registered again. */
  protected pruneCustomLayerTypes(): void {
    for (const [type, entry] of this.customLayerTypes) {
      if (this.layerTypeDefinition(type) === entry.definition && !this.disposed) continue
      entry.material?.dispose()
      ;(entry.composite?.material as MeshBasicNodeMaterial | undefined)?.dispose()
      this.customLayerTypes.delete(type)
    }
  }

  /** A registered layer type's material (and composite), built on first use; null when it cannot draw. */
  protected getCustomLayerType(type: string): CustomLayerType | null {
    const definition = this.layerTypeDefinition(type)
    if (definition === undefined) return null
    let entry = this.customLayerTypes.get(type)
    if (entry?.definition === definition) return entry.material === null ? null : entry
    if (entry !== undefined) {
      entry.material?.dispose()
      ;(entry.composite?.material as MeshBasicNodeMaterial | undefined)?.dispose()
    }
    entry = { definition, material: null, composite: null }
    if (definition === this.heatmap.definition) {
      entry.prepareDraw = (object, layerId, zoom) => this.heatmap.prepareDraw(object, layerId, zoom)
      entry.prepareComposite = (object, layerId, zoom) => this.heatmap.prepareComposite(object, layerId, zoom)
    }
    try {
      entry.material = createCustomLayerMaterial(definition)
      if (definition.offscreen !== undefined) {
        entry.composite = new Mesh(this.background.geometry, createCompositeMaterial(definition, this.layerTexture))
        entry.composite.position.set(0.5, 0.5, 0)
        entry.composite.frustumCulled = false
      }
    } catch (error) {
      entry.material = null
      console.error(`MapStyleSource: layer type "${type}" could not build its material, its layers are skipped. Fix its createMaterial.`, error)
    }
    this.customLayerTypes.set(type, entry)
    return entry.material === null ? null : entry
  }

  /** Warns once per type about style layers whose type no installed plugin provides. */
  protected reportMissingLayerTypes(summary: MapStyleSummary): void {
    const byType = new Map<string, string[]>()
    for (const [layerId, type] of summary.missingLayerTypes) byType.set(type, [...(byType.get(type) ?? []), layerId])
    for (const [type, layerIds] of byType) {
      if (this.warnedLayerTypes.has(type)) continue
      this.warnedLayerTypes.add(type)
      console.warn(`MapStyleSource: style layer "${layerIds[0]}"${layerIds.length > 1 ? ` (and ${layerIds.length - 1} more)` : ''} has type "${type}", which no installed plugin provides: install the plugin that registers it.`)
    }
  }

  /** A plugin's layer type, or a built-in one (`heatmap`). */
  protected layerTypeDefinition(type: string): StyleLayerTypeDefinition | undefined {
    return type === HEATMAP_LAYER_TYPE ? this.heatmap.definition : this.styleLayerTypes?.get(type)
  }

  /** The largest reach of the custom layers the style draws at a zoom, in pixels. */
  protected maximumReachPixelsAt(level: number): number {
    this.heatmap.setLayers(this.summary?.heatmapLayers)
    let reach = 0
    for (const type of this.summary?.customLayerTypes ?? []) {
      reach = Math.max(reach, type === HEATMAP_LAYER_TYPE ? this.heatmap.reachPixelsAt(level) : (this.styleLayerTypes?.get(type)?.maximumReachPixels ?? 0))
    }
    return reach
  }

  protected readonly receiveStyleChanges = (changes: SequencedStyleChange[]): void => {
    if (this.disposed || this.backend === null || this.snapshotSequence < 0) return
    const fresh = changes.filter(change => change.sequence > this.snapshotSequence)
    if (fresh.length === 0) return
    if (fresh.some(({ change }) => change.type === 'reload')) {
      this.reloadStyle()
      return
    }
    const commands: StyleCommand[] = []
    const states = new Map<string, FeatureState | null>()
    for (const { change } of fresh) {
      if (change.type === 'command') commands.push(change.command)
      else if (change.type === 'featureState') states.set(change.key, change.state)
    }
    if (commands.length > 0) this.sendStyleCommands(commands)
    if (states.size > 0) this.sendFeatureStates(states)
  }

  /** Runs `apply` with the backend's answer once the answers to earlier changes were applied. */
  protected enqueueStyleWork<T>(send: (backend: MapStyleBackend) => Promise<T>, apply: (value: T) => void): void {
    const backend = this.requireBackend()
    const answer = send(backend)
    answer.catch(() => {}) // a rejection is handled below, in order
    // A backend replaced meanwhile (the worker failed during init, and the main thread took over from a fresh
    // snapshot that holds this change) answers nothing that matters.
    const current = () => !this.disposed && this.backend === backend
    this.styleWork = this.styleWork
      .then(async () => {
        const value = await answer
        if (current()) apply(value)
      })
      .catch((error: unknown) => {
        if (current() && (error as Error)?.name !== 'AbortError') this.mapStyle.reportError(error as Error)
      })
  }

  protected sendStyleCommands(commands: StyleCommand[]): void {
    this.enqueueStyleWork(backend => backend.updateStyle(commands), result => this.applyStyleResult(result))
  }

  /** Redraws what a style change touched: tiles of the rebuilt sources, every region when the background or sources changed. */
  protected applyStyleResult(result: StyleUpdateResult): void {
    const previous = this.summary
    this.summary = result.summary
    for (const message of result.errors) this.mapStyle.reportError(new Error(message))
    // A raster tile does not depend on the style's layers: their changes redraw it. It is fetched again only when
    // its source changed (`setStyle`, or removed and added back).
    const rasterSource = (id: string, summary: MapStyleSummary | null) => summary?.sources.find(source => source.id === id && (source.type ?? 'vector') !== 'vector')
    const sources = new Set(result.rebuiltSources.filter(id => {
      const before = rasterSource(id, previous)
      const after = rasterSource(id, result.summary)
      return (before === undefined && after === undefined) || JSON.stringify(before) !== JSON.stringify(after)
    }))
    if (sources.size > 0) this.rebuildTiles(request => sources.has(request.sourceId))
    // GeoJSON data changes: only the tiles around what changed
    for (const { sourceId, rectangles, marginTiles } of result.rebuiltAreas ?? []) {
      if (rectangles !== null && rectangles.length === 0) continue
      this.rebuildTiles(({ sourceId: tileSource, x, y, z }) => tileSource === sourceId && tileOverlapsWithMargin(x, y, z, rectangles, marginTiles))
    }
    const redrawn = new Set(result.rebuiltSources.filter(id => !sources.has(id)))
    // A raster layer added, removed, moved, hidden or repainted redraws only the regions drawing its source, before
    // or after the change.
    const rasterLayersBefore = new Map((previous?.rasterLayers ?? []).map(layer => [layer.id, layer]))
    const rasterLayersAfter = new Map((result.summary.rasterLayers ?? []).map(layer => [layer.id, layer]))
    for (const [id, layer] of [...rasterLayersBefore, ...rasterLayersAfter]) {
      if (JSON.stringify(rasterLayersBefore.get(id)) !== JSON.stringify(rasterLayersAfter.get(id))) redrawn.add(layer.source)
    }
    const changed = (pick: (summary: MapStyleSummary) => unknown) => previous === null || JSON.stringify(pick(previous)) !== JSON.stringify(pick(result.summary))
    if (changed(summary => summary.backgroundByZoom) || changed(summary => summary.backgroundPatternByZoom) || changed(summary => summary.sources)) this.markRegionsStale(() => true)
    else if (redrawn.size > 0) this.markRegionsStale(key => this.regionDrawsSource(key, redrawn) || (previous !== null && this.regionDrawsSource(key, redrawn, previous)))
    this.rasterLayers.pruneLayers(new Set((result.summary.rasterLayers ?? []).map(layer => layer.id)))
    this.reportMissingImages(result.summary.missingBackgroundImages)
    this.reportMissingLayerTypes(result.summary)
    this.screenSymbols?.summaryChanged()
    this.extrusions?.summaryChanged()
    this.onSummaryChange?.(result.summary)
  }

  protected sendFeatureStates(states: Map<string, FeatureState | null>): void {
    const version = ++this.featureStateVersion
    for (const key of states.keys()) this.featureStateChangedAt.set(key, version)
    this.pruneFeatureStateChanges()
    const changes = [...states].map(([key, state]) => ({ key, state }))
    this.enqueueStyleWork(backend => backend.updateFeatureStates(changes), () => {
      // The slot colours arrived with the answer: redraw the regions using them. Baked features process their tiles again.
      const redraw = new Set<string>()
      const rebuild = new Set<string>()
      for (const key of states.keys()) {
        for (const loaded of this.featureBuckets.colors.get(key) ?? []) redraw.add(loaded.key)
        for (const loaded of this.featureBuckets.rebuild.get(key) ?? []) rebuild.add(loaded.key)
      }
      if (rebuild.size > 0) this.rebuildTiles(request => rebuild.has(bucketKey(request)))
      if (redraw.size > 0) this.redrawRegions(redraw, true)
    })
  }

  /** Starts the backend again from a snapshot (a style change no command expresses), then redraws everything. */
  protected reloadStyle(): void {
    const snapshot = this.takeSnapshot()
    this.enqueueStyleWork(backend => backend.reload(snapshot), summary => {
      this.summary = summary
      this.rebuildTiles(() => true)
      this.markRegionsStale(() => true)
      this.screenSymbols?.summaryChanged()
      this.extrusions?.summaryChanged()
      this.onSummaryChange?.(summary)
    })
  }

  protected countInFlight(version: number, change: 1 | -1): void {
    const count = (this.inFlightVersions.get(version) ?? 0) + change
    if (count === 0) this.inFlightVersions.delete(version)
    else this.inFlightVersions.set(version, count)
  }

  /**
   * Forgets changes no tile in flight can have missed: a bucket is stale only for changes made after its request
   * was sent, and later requests reach the backend after the change.
   */
  protected pruneFeatureStateChanges(): void {
    let oldest = this.featureStateVersion
    for (const version of this.inFlightVersions.keys()) oldest = Math.min(oldest, version)
    for (const [key, version] of this.featureStateChangedAt) if (version <= oldest) this.featureStateChangedAt.delete(key)
  }

  protected indexFeatures(loaded: LoadedBucket, add: boolean): void {
    const { featureStateKeys, rebuildFeatureKeys } = loaded.bucket
    for (const [keys, index] of [
      [featureStateKeys, this.featureBuckets.colors],
      [rebuildFeatureKeys, this.featureBuckets.rebuild],
    ] as const) {
      for (const key of keys) {
        let set = index.get(key)
        if (add) {
          if (set === undefined) index.set(key, (set = new Set()))
          set.add(loaded)
        } else if (set !== undefined) {
          set.delete(loaded)
          if (set.size === 0) index.delete(key)
        }
      }
    }
  }

  /** Whether a held region draws tiles of any of these sources, with the current summary or an earlier one. */
  protected regionDrawsSource(key: string, sources: ReadonlySet<string>, summary: MapStyleSummary | null = this.summary): boolean {
    const { range, level } = parseRegionKey(key)
    const current = this.summary
    this.summary = summary
    try {
      return this.getRegionTiles(range, level).some(tile => sources.has(tile.request.sourceId))
    } finally {
      this.summary = current
    }
  }

  /**
   * The zoom of a source's tiles drawn into a region at `level`: raster tiles of `tileSize` 256 come from one zoom
   * deeper than the 512-pixel map tiles, as in MapLibre. Not clamped to the source's zoom range.
   */
  protected sourceTileZoom(source: MapStyleSourceSummary, level: number): number {
    return Math.round(level + Math.log2(TILE_SIZE_PIXELS / (source.tileSizePixels ?? TILE_SIZE_PIXELS)))
  }

  /** Whether a source has tiles to draw at a region level: in its zoom range and, for raster sources, a layer drawn there. */
  protected sourceDrawnAt(source: MapStyleSourceSummary, level: number): boolean {
    if (this.sourceTileZoom(source, level) < source.minimumZoom) return false
    if ((source.type ?? 'vector') === 'vector') return true
    const zoom = Math.min(level, 24)
    return (this.summary?.rasterLayers ?? []).some(layer => layer.source === source.id && layer.paintByZoom[zoom] != null)
  }

  /** A raster source's bounds in normalised Web Mercator; null for the whole world. */
  protected getSourceRectangles(source: MapStyleSourceSummary): MercatorRectangle[] | null {
    if (source.bounds == null) return null
    let rectangles = this.sourceRectangles.get(source)
    if (rectangles === undefined) {
      const [westDegrees, southDegrees, eastDegrees, northDegrees] = source.bounds
      rectangles = boundsToMercatorRectangles({ westDegrees, southDegrees, eastDegrees, northDegrees })
      this.sourceRectangles.set(source, rectangles)
    }
    return rectangles
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
    const zoom = Math.min(level, summary.backgroundByZoom.length - 1)
    return (
      (summary.backgroundByZoom[zoom] ?? null) !== null ||
      (summary.backgroundPatternByZoom[zoom] ?? null) !== null ||
      summary.sources.some(source => this.sourceDrawnAt(source, level))
    )
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
    this.rebuildTiles(({ x, y, z }) => tileOverlaps(x, y, z, rectangles))
  }

  /**
   * The features drawn under a point or polygon (normalised Web Mercator), top-most first: labels, which draw above
   * every shape, then shapes from the top style layer down. Hits are tested against the tiles drawn there, at the
   * zoom the terrain is textured at, with line widths, circle radii and placed label boxes as drawn. Resolves to no
   * features before the style has loaded or where no texture is drawn yet. `screenBox` (CSS pixels: left, top,
   * right, bottom) is where the query lies on the screen, to hit the labels facing the viewer.
   */
  async queryRenderedFeatures(geometry: readonly MercatorPoint[], options: RenderedFeatureQueryOptions = {}, screenBox?: readonly [number, number, number, number]): Promise<RenderedSourceFeature[]> {
    const backend = this.backend
    if (this.disposed || backend === null || this.summary === null || geometry.length === 0) return []
    const tiles = this.getQueryTiles(geometry)
    const screenLabels = screenBox === undefined || this.screenSymbols === null || this.opacity <= 0 ? [] : this.screenSymbols.hitScreenLabels(screenBox, Math.max(0, options.tolerancePixels ?? 0))
    if (tiles.length === 0 && screenLabels.length === 0) return []
    return backend.queryRenderedFeatures({
      screenLabels,
      geometry: geometry.map(({ x, y }) => ({ x, y })),
      tiles,
      layers: options.layers === undefined ? null : [...options.layers],
      filter: options.filter ?? null,
      tolerancePixels: Math.max(0, options.tolerancePixels ?? 0),
    })
  }

  /**
   * Every feature of a style source in the tiles drawn now (MapLibre's `querySourceFeatures`), drawn by a layer or
   * not. A feature crossing tiles is listed once per tile, its geometry clipped to each.
   */
  async querySourceFeatures(sourceId: string, options: SourceFeatureQueryOptions = {}): Promise<SourceFeature[]> {
    const backend = this.backend
    if (this.disposed || backend === null || this.summary === null) return []
    if (this.mapStyle.getSource(sourceId) === undefined) throw new Error(`MapStyleSource.querySourceFeatures: the style has no source "${sourceId}"; pass one of ${JSON.stringify(Object.keys(this.mapStyle.getStyle()?.sources ?? {}))}.`)
    const tiles = new Map<string, { x: number; y: number; z: number }>()
    for (const key of this.regions.keys()) {
      if (this.regions.get(key) === null) continue
      const { range, level } = parseRegionKey(key)
      for (const tile of this.getRegionTiles(range, level)) {
        if (tile.textOnly || tile.request.sourceId !== sourceId) continue
        const { x, y, z } = tile.request
        tiles.set(`${z}/${x}/${y}`, { x, y, z })
      }
    }
    if (tiles.size === 0) return []
    return backend.querySourceFeatures({ sourceId, sourceLayer: options.sourceLayer ?? null, filter: options.filter ?? null, tiles: [...tiles.values()] })
  }

  // 3DTilesRenderer tells which regions the visible terrain tiles show; a region stays locked (and loaded) while its
  // tile is only cached, so being loaded does not mean being drawn.
  setRegionVisible(range: number[], visible: boolean): void {
    ;(XYZTilesOverlay.prototype as unknown as { setRegionVisible?: (range: number[], visible: boolean) => void }).setRegionVisible?.call(this, range, visible)
    const key = range.join('_')
    const count = (this.visibleRegions.get(key)?.count ?? 0) + (visible ? 1 : -1)
    if (count <= 0) this.visibleRegions.delete(key)
    else this.visibleRegions.set(key, { range: [...range], count })
  }

  /**
   * Loaded region textures on visible terrain tiles, with their keys. Without visibility reports (an overlay not
   * driven by `ImageOverlayPlugin`, as in tests), every loaded region.
   */
  protected getDrawnRegions(): Array<{ key: string; range: number[]; level: number }> {
    const drawn: Array<{ key: string; range: number[]; level: number }> = []
    if (this.visibleRegions.size === 0) {
      for (const key of this.regions.keys()) if (this.regions.get(key) !== null) drawn.push({ key, ...parseRegionKey(key) })
      return drawn
    }
    for (const { range } of this.visibleRegions.values()) {
      const level = this.calculateLevel(range)
      const key = regionKey(range, level)
      if (this.regions.get(key) !== null) drawn.push({ key, range, level })
    }
    return drawn
  }

  /**
   * The tiles a query reads: those the drawn regions under it draw, with the label ring each region reads, at the
   * zoom each region was drawn at. A point reads only the finest region under it (a parent still fading out does
   * not answer). Columns are unwrapped to sit next to the geometry across the antimeridian.
   */
  protected getQueryTiles(geometry: readonly MercatorPoint[]): QueryTile[] {
    let minimumX = Infinity
    let minimumY = Infinity
    let maximumX = -Infinity
    let maximumY = -Infinity
    for (const { x, y } of geometry) {
      minimumX = Math.min(minimumX, x)
      minimumY = Math.min(minimumY, y)
      maximumX = Math.max(maximumX, x)
      maximumY = Math.max(maximumY, y)
    }
    // Regions lie within 0 to 1: also try them one world east and west, for geometry unwrapped past the antimeridian.
    let matches: Array<{ range: number[]; level: number; shift: number }> = []
    for (const region of this.getDrawnRegions()) {
      const [regionMinimumX = 0, regionMinimumY = 0, regionMaximumX = 0, regionMaximumY = 0] = region.range
      if (regionMaximumY < minimumY || regionMinimumY > maximumY) continue
      for (const shift of [0, 1, -1]) {
        if (regionMaximumX + shift < minimumX || regionMinimumX + shift > maximumX) continue
        matches.push({ range: region.range, level: region.level, shift })
      }
    }
    if (geometry.length === 1 && matches.length > 0) {
      const finest = Math.max(...matches.map(match => match.level))
      matches = matches.filter(match => match.level === finest)
    }
    const tiles = new Map<string, QueryTile>()
    for (const { range, level, shift } of matches) {
      for (const tile of this.getRegionTiles(range, level)) {
        const column = tile.column + shift * 2 ** tile.request.z
        const key = `${tile.key}/${column}`
        const known = tiles.get(key)
        if (known === undefined) tiles.set(key, { ...tile.request, column, labelsOnly: tile.textOnly })
        else if (!tile.textOnly) known.labelsOnly = false // covered by one region, in another's ring
      }
    }
    return [...tiles.values()]
  }

  /**
   * Discards the processed tiles that `matches` selects (in flight included), so they are processed again (from the
   * worker's raw tiles: nothing is fetched unless the worker forgot them), and redraws the regions drawing them.
   */
  protected rebuildTiles(matches: (request: TileRequest) => boolean, shapesOnly = false): void {
    if (this.disposed) return
    for (const key of [...this.buckets.keys()]) if (matches(parseBucketKey(key))) this.buckets.discard(key)
    this.screenSymbols?.refresh(matches)
    this.extrusions?.refresh(matches)
    this.markRegionsStale(key => {
      const { range, level } = parseRegionKey(key)
      return this.getRegionTiles(range, level).some(tile => matches(tile.request) && !(shapesOnly && tile.textOnly))
    })
  }

  /**
   * Redraws, with no processing, the regions that draw any of these buckets. `shapesOnly`: the change is in the
   * buckets' shapes (feature colours, images), so regions that draw them for labels only (their outer ring) are
   * skipped.
   */
  protected redrawRegions(bucketKeys: ReadonlySet<string>, shapesOnly = false): void {
    if (this.disposed || bucketKeys.size === 0) return
    this.markRegionsStale(key => {
      const { range, level } = parseRegionKey(key)
      return this.getRegionTiles(range, level).some(tile => bucketKeys.has(tile.key) && !(shapesOnly && tile.textOnly))
    })
  }

  /** Marks regions for a redraw in place next frame; loads and redraws in flight redraw once more when they end. */
  protected markRegionsStale(selects: (regionKey: string) => boolean): void {
    for (const key of this.regions.keys()) {
      if (!selects(key)) continue
      const work = this.loadingRegions.get(key) ?? this.recompositions.get(key)
      if (work !== undefined) work.stale = true
      // Loaded, or between the end of its load and the cache marking it loaded: redraw next frame.
      else if (this.regions.get(key) !== null || this.regions.isLoading(key)) this.staleRegions.add(key)
    }
    if (this.staleRegions.size > 0) this.compositor?.runBeforeNextRender(this.startRecompositions)
  }

  /** Whether an image of this id exists: added at runtime, or in the style's sprites once loaded. */
  hasImage(id: string): boolean {
    return this.images.has(id) || (this.summary?.spriteImageIds.includes(id) ?? false)
  }

  /**
   * Adds, replaces (`image`) or removes (`null`) a runtime image, and redraws what uses it: regions whose tiles
   * use it (rebuilt when it appeared, disappeared or changed size, only redrawn otherwise), or every region when
   * the background pattern does. Resolves once the change is applied in the worker.
   */
  setImage(id: string, image: StyleImage | null): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (image === null) this.images.delete(id)
    else this.images.set(id, image)
    this.reportedMissingImages.delete(id)
    if (!this.imagesSent) return Promise.resolve() // the first snapshot sends the current images
    const run = this.imageQueue.then(async () => {
      const backend = this.backend
      if (backend === null || this.disposed || this.summary === null) return
      const backgroundBefore = this.summary.backgroundPatternByZoom
      const change = await backend.setImage(id, image)
      if (this.disposed) return
      this.applyImageChange(id, change, backgroundBefore)
    })
    this.imageQueue = run.catch(() => {})
    return run
  }

  protected applyImageChange(id: string, change: ImageChange, backgroundBefore: ReadonlyArray<BackgroundPattern | null>): void {
    if (this.summary !== null) {
      this.summary.backgroundPatternByZoom = change.backgroundPatternByZoom
      this.summary.missingBackgroundImages = change.missingBackgroundImages
    }
    this.reportMissingImages(change.missingBackgroundImages)
    const usesId = (patterns: ReadonlyArray<BackgroundPattern | null>) => patterns.some(pattern => pattern?.imageId === id)
    if (usesId(backgroundBefore) || usesId(change.backgroundPatternByZoom)) {
      this.markRegionsStale(() => true)
      if (!change.rebuild) return
    }
    this.pruneImageUsers()
    // Every bucket that used the image, cached or evicted, and buckets still processing: they may have read
    // the image before the change.
    const affected = new Set(this.imageUsers.get(id))
    for (const key of this.buckets.keys()) if (this.buckets.isPending(key)) affected.add(key)
    if (change.rebuild) {
      for (const key of affected) this.buckets.discard(key)
      // Labels facing the viewer hold their tiles' meshes: process them again for the icon's new place.
      this.screenSymbols?.refresh(request => affected.has(bucketKey({ ...request, symbols: true })))
    }
    // Patterns are shapes: regions that draw these tiles for their labels only are unaffected.
    this.redrawRegions(affected, true)
  }

  protected recordImageUsers(bucketKey: string, images: readonly string[]): void {
    for (const users of this.imageUsers.values()) users.delete(bucketKey)
    for (const id of images) {
      let users = this.imageUsers.get(id)
      if (users === undefined) this.imageUsers.set(id, (users = new Set()))
      users.add(bucketKey)
    }
  }

  /**
   * Forgets users that no held region draws and the bucket cache no longer holds, so the record stays the size
   * of the view. Cached buckets stay: a region can take one back without loading it (and recording it) again.
   */
  protected pruneImageUsers(): void {
    const drawn = new Set<string>(this.buckets.keys())
    for (const key of this.regions.keys()) {
      const { range, level } = parseRegionKey(key)
      for (const tile of this.getRegionTiles(range, level)) drawn.add(tile.key)
    }
    for (const [id, users] of this.imageUsers) {
      for (const key of users) if (!drawn.has(key)) users.delete(key)
      if (users.size === 0) this.imageUsers.delete(id)
    }
  }

  /** Reports image ids not reported since they were last added. */
  protected reportMissingImages(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.reportedMissingImages.has(id) || this.images.has(id)) continue
      this.reportedMissingImages.add(id)
      try {
        this.onStyleImageMissing?.(id)
      } catch (error) {
        console.error(error)
      }
    }
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
    this.screenSymbols?.dispose()
    this.extrusions?.dispose()
    this.unsubscribe?.()
    this.removeStyleDataListener?.()
    this.removeStyleDataListener = null
    this.unsubscribe = null
    this.detachSourceQueries?.()
    this.detachSourceQueries = null
    this.unsubscribeLayerTypes?.()
    this.unsubscribeLayerTypes = null
    this.styleLayerTypes = null
    this.pruneCustomLayerTypes()
    this.heatmap.dispose()
    this.layerTarget?.dispose()
    this.placeholderLayerTarget.dispose()
    this.regions.dispose()
    this.buckets.dispose()
    this.backend?.dispose()
    this.backend = null
    this.scratch?.dispose()
    this.atlas.dispose()
    this.imageAtlas.dispose()
    const { blurred, ...sharp } = this.shapeMaterials
    for (const material of [...Object.values(sharp), ...Object.values(blurred ?? {})]) material?.dispose()
    this.backgroundPattern.material.dispose()
    this.backgroundPatternMesh.geometry.dispose()
    this.featureColors.dispose()
    this.rasterLayers.dispose()
    this.textMaterial.dispose()
    this.backgroundMaterial.dispose()
    this.background.geometry.dispose()
  }

  protected requireBackend(): MapStyleBackend {
    if (this.backend === null) throw new DOMException('MapStyleSource: disposed', 'AbortError')
    return this.backend
  }

  /** Vector tiles under a region at its zoom, plus a ring of neighbours for labels crossing its edges. */
  protected getRegionTiles(range: readonly number[], level: number): RegionTile[] {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const tiles: RegionTile[] = []
    for (const source of this.summary?.sources ?? []) {
      if (!this.sourceDrawnAt(source, level)) continue
      const type = source.type ?? 'vector'
      const tileZoom = this.sourceTileZoom(source, level)
      const z = Math.max(0, Math.min(tileZoom, source.maximumZoom))
      const bounds = this.getSourceRectangles(source)
      const count = 2 ** z
      const epsilon = 1e-9
      const fromColumn = Math.floor(minimumX * count + epsilon)
      const toColumn = Math.floor(maximumX * count - epsilon)
      // Rows count from the north; normalised y grows to the north.
      const fromRow = Math.max(0, Math.floor((1 - maximumY) * count + epsilon))
      const toRow = Math.min(count - 1, Math.floor((1 - minimumY) * count - epsilon))
      if (fromRow > toRow) continue
      // Labels reach up to about 256 px beyond their tile, half a tile, and custom layers up to their reach
      // (at most a tile); less when overzoomed. Ring tiles further from the region are skipped.
      // Raster tiles have no ring; elevation tiles a thin one, for the slopes at the region's edge.
      const reach = type === 'vector' ? Math.max(0.5, this.maximumReachPixelsAt(level) / TILE_SIZE_PIXELS) / 2 ** (level - z) : type === 'raster-dem' ? ELEVATION_RING_REACH_TILES : -1
      const regionLeft = minimumX * count
      const regionRight = maximumX * count
      const regionTop = (1 - maximumY) * count
      const regionBottom = (1 - minimumY) * count
      for (const textOnly of [false, true]) {
        if (textOnly && reach < 0) continue
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
            if (bounds !== null && !tileOverlaps(x, row, z, bounds)) continue
            // A raster tile is the same image at every zoom it is drawn at: one bucket for all of them.
            const request: TileRequest = { sourceId: source.id, x, y: row, z, zoom: type === 'vector' ? level : z }
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
    this.heatmap.setLayers(this.summary?.heatmapLayers)
    this.atlas.upload()
    this.featureColors.upload()
    this.imageAtlas.upload()
    const backgrounds = this.summary?.backgroundByZoom ?? []
    const background = backgrounds[Math.min(level, backgrounds.length - 1)] ?? null
    const patterns = this.summary?.backgroundPatternByZoom ?? []
    const pattern = patterns[Math.min(level, patterns.length - 1)] ?? null
    if (background !== null) {
      this.backgroundColor.set(background[0] / 255, background[1] / 255, background[2] / 255, background[3] / 255)
      scene.add(this.background)
    }
    if (pattern !== null) {
      this.setBackgroundPattern(pattern, range, level)
      scene.add(this.backgroundPatternMesh)
    }
    const placements = new Map<LoadedBucket, number>()
    const placed: PlacedMesh[] = []
    tiles.forEach((tile, order) => {
      const loaded = buckets[order]
      if (loaded === null || loaded === undefined) return
      loaded.meshes ??= new BucketMeshes(loaded.bucket, this.shapeMaterials, this.textMaterial)
      // Tile units (y down from the tile's north edge) to the region's 0 to 1 space (y up), in 64-bit here.
      const { z, y } = tile.request
      const tileSize = 1 / 2 ** z
      // Near the antimeridian at low zooms, one bucket is placed at several columns: each needs its own Mesh.
      const placement = placements.get(loaded) ?? 0
      placements.set(loaded, placement + 1)
      const place = (source: Mesh, renderOrder: number, offscreen: CustomLayerType | null = null, layerId?: string) => {
        const mesh = loaded.meshes!.placement(source, placement)
        mesh.position.set((tile.column * tileSize - minimumX) / width, (1 - y * tileSize - minimumY) / height, 0)
        mesh.scale.set(tileSize / width / TILE_EXTENT, -tileSize / height / TILE_EXTENT, 1)
        mesh.renderOrder = renderOrder
        placed.push({ mesh, renderOrder, offscreen, ...(layerId !== undefined ? { layerId } : {}) })
        return mesh
      }
      if (!tile.textOnly) for (const { group, mesh } of loaded.meshes.shapes) place(mesh, group * 10_000 + order)
      for (const { layerId, layerType, group, mesh } of loaded.meshes.custom) {
        const type = this.getCustomLayerType(layerType)
        // Ring tiles only draw the layers that reach past their tile.
        if (type === null || (tile.textOnly && (type.definition.maximumReachPixels ?? 0) === 0)) continue
        const drawn = place(mesh, group * 10_000 + order, type.definition.offscreen === undefined ? null : type, layerId)
        drawn.material = type.material!
        setCustomLayerDrawValues(drawn, z, level)
        type.prepareDraw?.(drawn, layerId, level)
      }
      if (loaded.meshes.text !== null) place(loaded.meshes.text, 100_000_000 + order)
    })
    const rasterTiles: RasterRegionTile[] = []
    tiles.forEach((tile, order) => {
      const raster = buckets[order]?.bucket.raster
      if (raster != null) rasterTiles.push({ request: tile.request, column: tile.column, textOnly: tile.textOnly, order, raster })
    })
    const rasterLayers = this.summary?.rasterLayers ?? []
    if (rasterLayers.length > 0 && rasterTiles.length > 0) {
      // Elevation fields render into their own targets now, before the region pass.
      for (const { mesh, renderOrder } of this.rasterLayers.prepareRegion(renderer, { range, level, resolution: output.width, layers: rasterLayers, tiles: rasterTiles })) {
        mesh.renderOrder = renderOrder
        placed.push({ mesh, renderOrder, offscreen: null })
      }
    }
    for (const { mesh, offscreen } of placed) if (offscreen === null) scene.add(mesh)
    try {
      if (scene.children.length > 0 || placed.length > 0) {
        const scratch = this.getScratch(output.width)
        renderer.setRenderTarget(scratch)
        if (placed.some(entry => entry.offscreen !== null)) this.renderWithOffscreenLayers(renderer, scratch, placed, level)
        else renderer.render(scene, this.camera)
        compositor.copyTexture(renderer, scratch.texture, output)
      } else {
        renderer.setRenderTarget(output)
        renderer.clear()
      }
    } finally {
      scene.clear()
      this.layerScene.clear()
      this.compositeScene.clear()
    }
  }

  /**
   * Draws the region in passes split at each offscreen layer: what is below it into the scratch, the layer into
   * the layer target (maximum or additive blending), then the target composited over the scratch; and so on.
   */
  protected renderWithOffscreenLayers(renderer: WebGPURenderer, scratch: RenderTarget, placed: readonly PlacedMesh[], level: number): void {
    const scene = this.scene
    // One pass per offscreen layer group (its render orders share `group * 10_000`; a custom layer has a group of its own).
    const passes = new Map<number, { type: CustomLayerType; layerId: string; meshes: Mesh[] }>()
    for (const { mesh, renderOrder, offscreen, layerId = '' } of placed) {
      if (offscreen === null) continue
      const group = Math.floor(renderOrder / 10_000)
      let pass = passes.get(group)
      if (pass === undefined) passes.set(group, (pass = { type: offscreen, layerId, meshes: [] }))
      pass.meshes.push(mesh)
    }
    const layerTarget = this.getLayerTarget(scratch.width)
    const autoClear = renderer.autoClear
    renderer.getClearColor(this.clearColor)
    const clearAlpha = renderer.getClearAlpha()
    const below = (limit: number) => {
      for (const child of scene.children) child.visible = child.renderOrder < limit && child.userData.drawn !== true
      renderer.setRenderTarget(scratch)
      renderer.render(scene, this.camera)
      for (const child of scene.children) if (child.visible) child.userData.drawn = true
      renderer.autoClear = false // later passes draw over the first
    }
    try {
      renderer.autoClear = true
      for (const [group, { type, layerId, meshes }] of [...passes].sort(([a], [b]) => a - b)) {
        below(group * 10_000)
        this.layerScene.clear()
        for (const mesh of meshes) this.layerScene.add(mesh)
        renderer.setRenderTarget(layerTarget)
        renderer.setClearColor(0x000000, 0)
        renderer.clear()
        renderer.render(this.layerScene, this.camera)
        renderer.setClearColor(this.clearColor, clearAlpha)
        this.compositeScene.clear()
        type.prepareComposite?.(type.composite!, layerId, level)
        this.compositeScene.add(type.composite!)
        renderer.setRenderTarget(scratch)
        renderer.render(this.compositeScene, this.camera)
      }
      below(Infinity)
    } finally {
      renderer.autoClear = autoClear
      renderer.setClearColor(this.clearColor, clearAlpha)
      for (const child of scene.children) {
        child.visible = true
        delete child.userData.drawn
      }
    }
  }

  /** The offscreen layers' target: linear, half float (sums and maxima above 1 stay exact), no multisampling. */
  protected getLayerTarget(resolution: number): RenderTarget {
    if (this.layerTarget !== null && this.layerTarget.width === resolution) return this.layerTarget
    this.layerTarget?.dispose()
    this.placeholderLayerTarget.dispose()
    this.layerTarget = new RenderTarget(resolution, resolution, { type: HalfFloatType, colorSpace: LinearSRGBColorSpace, depthBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter })
    this.layerTarget.texture.name = 'MapStyleLayerTarget'
    this.layerTexture.value = this.layerTarget.texture
    return this.layerTarget
  }

  /**
   * Points the background pattern at a region: `pixelRatio` image pixels per map pixel at the region's zoom,
   * anchored to the world's top-left corner like fill patterns. The offset is reduced in 64-bit here.
   */
  protected setBackgroundPattern({ rectangle, opacity }: BackgroundPattern, range: readonly number[], level: number): void {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const imagePixelsAcrossWorld = TILE_SIZE_PIXELS * 2 ** level * rectangle.pixelRatio
    const modulo = (value: number, modulus: number) => ((value % modulus) + modulus) % modulus
    this.backgroundPattern.rectangle.set(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    this.backgroundPattern.origin.set(modulo(minimumX * imagePixelsAcrossWorld, rectangle.width), modulo((1 - maximumY) * imagePixelsAcrossWorld, rectangle.height))
    this.backgroundPattern.span.set((maximumX - minimumX) * imagePixelsAcrossWorld, (maximumY - minimumY) * imagePixelsAcrossWorld)
    this.backgroundPattern.opacity.value = opacity
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

/** `@2x` sprites on high-density screens, as MapLibre does. */
function defaultSpritePixelRatio(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? 2 : 1
}

function regionKey(range: readonly number[], level: number): string {
  return `${range.join('_')}_${level}`
}

function parseRegionKey(key: string): { range: number[]; level: number } {
  const values = key.split('_').map(Number)
  return { range: values.slice(0, 4), level: values[4] ?? 0 }
}

export function bucketKey(request: TileRequest): string {
  const { sourceId, x, y, z, zoom } = request
  if (request.symbols === true) return symbolTileKey(request)
  if (request.extrusions === true) return extrusionTileKey(request)
  return `${zoom}/${z}/${x}/${y}/${sourceId}`
}

function parseBucketKey(key: string): TileRequest {
  const symbols = key.startsWith('s:')
  const extrusions = key.startsWith('e:')
  const [zoom, z, x, y, ...source] = (symbols || extrusions ? key.slice(2) : key).split('/')
  return { sourceId: source.join('/'), x: Number(x), y: Number(y), z: Number(z), zoom: Number(zoom), ...(symbols ? { symbols } : {}), ...(extrusions ? { extrusions } : {}) }
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
