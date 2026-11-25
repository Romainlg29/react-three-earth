import { Color, Group, type Camera, type Material, type Object3D, type RenderTarget, type Scene } from 'three'
import type { NodeMaterial, WebGPURenderer } from 'three/webgpu'

import type { DrapedLayerRegistry } from '../plugins/drapedLayers.js'
import type { StyleLayerTypeRegistry } from '../plugins/styleLayerTypes.js'
import type { SymbolEffectRegistry } from '../plugins/symbolEffects.js'
import type { TerrainShadingRegistry } from '../plugins/terrainShadings.js'
import { EarthTilesRenderer } from '../tiles/EarthTilesRenderer.js'
import { FlatMapPlugin } from '../tiles/FlatMapPlugin.js'
import { ImageOverlayPlugin } from '../tiles/ImageOverlayPlugin.js'
import { MAXIMUM_TERRAIN_LAYERS } from '../tiles/wrapOverlaysNodeMaterial.js'
import { TileMaterialReplacementPlugin, type MaterialFactory } from '../tiles/TileMaterialReplacementPlugin.js'
import { TilesFadePlugin } from '../tiles/TilesFadePlugin.js'
import { recomposeTerrainMaterial, TerrainShadingSet } from '../tiles/terrainMaterialSlots.js'
import { sampleTerrainHeight } from '../tiles/terrainHeights.js'
import type { ImageryFrameStatistics } from '../tiles/imagery/ImageryStatistics.js'
import type { ViewMorph } from '../view/ViewMorph.js'
import type { ExtrusionFrame, Extrusions, ExtrusionsInspection } from '../vector/extrusions/Extrusions.js'
import type { ScreenLabelInspection, ScreenSymbols, ScreenSymbolsInspection, SymbolFrame } from '../vector/symbols/ScreenSymbols.js'
import type { AttributionProvider } from './attribution.js'
import type { Imagery } from './Imagery.js'
import type { TerrainSource } from './sources.js'

export interface TerrainOptions {
  /** The terrain source. Only the first one is used for now. */
  sources: TerrainSource[]
  /** Screen-space error target in pixels: lower is sharper and loads more. Default: 2 (QuantizedMeshPlugin's recommended setting). */
  errorTargetPixels?: number
  /** GPU memory budget for terrain geometry and imagery, in bytes. Default: 300 MB, sized for phones. */
  memoryBudgetBytes?: number
  /** Cross-fade tiles as they swap level of detail. Default: true. */
  fade?: boolean
  /** Builds each tile's material. Default: an untextured `MeshStandardNodeMaterial`. */
  createMaterial?: MaterialFactory
  /**
   * Main-thread time per frame for composing imagery onto terrain tiles on the GPU, in milliseconds. At
   * least one terrain tile is composed per frame regardless. Default: 2.
   */
  imageryCompositionBudgetMilliseconds?: number
  /**
   * Scales the terrain's heights, as MapLibre's terrain `exaggeration`: 1.5 draws mountains half again as high. Applied
   * in the vertex shader, so changing it costs no reload. Controls, `queryTerrainElevation`, `unproject`, labels and
   * markers read the heights as drawn. Default: 1.
   */
  exaggeration?: number
}

const MEGABYTE_BYTES = 2 ** 20
/** 3DTilesRenderer's `rootLoadingState` values (its `UNLOADED` and `LOADING` constants). */
const ROOT_UNLOADED = 0
const ROOT_LOADING = 2

/** 3DTilesRenderer events asking for another `update` or render. */
const FRAME_REQUEST_EVENTS = ['needs-update', 'needs-render', 'load-error'] as const

interface FrameRequestDispatcher {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** The layer every terrain tile mesh is on (besides layer 0): `Terrain.renderTiles` draws it alone. */
export const TERRAIN_LAYER = 29

/** The ground: a terrain tile pyramid with imagery layers draped on it. */
export class Terrain implements AttributionProvider {
  readonly tiles: EarthTilesRenderer
  readonly overlays: ImageOverlayPlugin
  /** Lays the tiles on the flat map and morphs them (see `setView`). */
  readonly flatMap: FlatMapPlugin
  /** Labels of its map style sources that face the viewer, drawn over the tiles. `Earth.setTerrain` adds it to the earth. */
  readonly symbols = new Group()
  /** Buildings (`fill-extrusion` layers) of its map style sources standing in 3D. `Earth.setTerrain` adds it to the earth. */
  readonly extrusions = new Group()
  protected readonly imagery = new Set<Imagery>()
  protected readonly source: TerrainSource
  /** Set when the tiles ask for another `update` (a tile finished loading), cleared by `update`. */
  protected updateRequested = false
  protected visibleTilesVersionValue = 0
  /** The plugins' terrain shadings its tile materials run, from the earth's registry (`setTerrainShadings`). */
  protected readonly shadings = new TerrainShadingSet()
  protected unsubscribeShadings: (() => void) | null = null

  constructor({
    sources,
    errorTargetPixels,
    memoryBudgetBytes = 300 * MEGABYTE_BYTES,
    fade = true,
    createMaterial,
    imageryCompositionBudgetMilliseconds,
    exaggeration = 1,
  }: TerrainOptions) {
    const [source, ...ignored] = sources
    if (source === undefined) throw new Error('Terrain: needs one source, for example new QuantizedMeshSource({ url }).')
    if (ignored.length > 0) console.warn('Terrain: only the first source is used for now; stacking terrain sources is planned.')

    this.source = source
    this.tiles = new EarthTilesRenderer(source.url)
    for (const plugin of source.createPlugins()) this.tiles.registerPlugin(plugin)
    this.tiles.registerPlugin(new TileMaterialReplacementPlugin(createMaterial, this.shadings))
    this.overlays = new ImageOverlayPlugin({ compositionBudgetMilliseconds: imageryCompositionBudgetMilliseconds, shadings: this.shadings })
    this.tiles.registerPlugin(this.overlays)
    if (fade) this.tiles.registerPlugin(new TilesFadePlugin())
    this.flatMap = new FlatMapPlugin()
    this.tiles.registerPlugin(this.flatMap)

    // A tile whose plugins were still processing it when the shadings changed was not listed as loaded then: catch it up.
    ;(this.tiles as unknown as { addEventListener(type: 'load-model', listener: (event: { scene: Object3D }) => void): void }).addEventListener(
      'load-model',
      ({ scene }) => {
        recomposeScene(scene)
        scene.traverse(object => object.layers.enable(TERRAIN_LAYER))
      },
    )
    ;(this.tiles as unknown as FrameRequestDispatcher).addEventListener('tile-visibility-change', () => {
      this.visibleTilesVersionValue++
    })
    // A failed load needs an update too, to see that nothing is loading any more.
    for (const type of ['needs-update', 'load-error']) {
      ;(this.tiles as unknown as FrameRequestDispatcher).addEventListener(type, () => {
        this.updateRequested = true
      })
    }

    if (errorTargetPixels !== undefined) this.tiles.errorTarget = errorTargetPixels
    this.tiles.lruCache.maxBytesSize = memoryBudgetBytes
    this.tiles.lruCache.minBytesSize = memoryBudgetBytes * 0.75
    this.exaggeration = exaggeration
  }

  /** How much heights are scaled when drawn (see `TerrainOptions.exaggeration`). */
  get exaggeration(): number {
    return this.flatMap.exaggeration
  }

  set exaggeration(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Terrain: exaggeration must be a finite number of 0 or more (1 draws heights as they are), got ${value}.`)
    }
    if (value === this.flatMap.exaggeration) return
    this.flatMap.exaggeration = value
    this.tiles.exaggeration = value
    this.visibleTilesVersionValue++
    this.updateRequested = true
    ;(this.tiles as unknown as { dispatchEvent(event: { type: string }): void }).dispatchEvent({ type: 'needs-update' })
  }

  /** The credits of the terrain source. */
  getAttributions(): readonly string[] {
    return this.source.getAttributions?.() ?? []
  }

  /** Calls `listener` when `getAttributions()` changes. Returns a function that removes it. */
  addAttributionListener(listener: () => void): () => void {
    return this.source.addAttributionListener?.(listener) ?? (() => {})
  }

  /** The object to add to the scene. */
  get object(): Object3D {
    return this.tiles.group
  }

  /** Follows a globe-to-map morph: tiles are selected and drawn for it. `Earth.setTerrain` calls it. */
  setView(view: ViewMorph | null): void {
    this.tiles.view = view
    this.flatMap.view = view
  }

  /** The custom style layer types (plugins) its map style sources draw. `Earth.setTerrain` calls it. */
  setStyleLayerTypes(registry: StyleLayerTypeRegistry | null): void {
    this.overlays.setStyleLayerTypes(registry)
  }

  /** The symbol effects (plugins) its map style sources draw labels with. `Earth.setTerrain` calls it. */
  setSymbolEffects(registry: SymbolEffectRegistry | null): void {
    this.overlays.setSymbolEffects(registry)
  }

  /**
   * The terrain shadings (plugins) its tile materials run over their own nodes and the imagery. `Earth.setTerrain`
   * calls it. A change rebuilds the loaded tiles' shaders, without reloading them.
   */
  setTerrainShadings(registry: TerrainShadingRegistry | null): void {
    this.unsubscribeShadings?.()
    this.unsubscribeShadings = null
    const apply = (): void => {
      this.shadings.setDefinitions(registry?.ordered() ?? [])
      this.tiles.forEachLoadedModel((scene: Object3D) => recomposeScene(scene))
      ;(this.tiles as unknown as { dispatchEvent(event: { type: string }): void }).dispatchEvent({ type: 'needs-render' })
    }
    if (registry !== null) this.unsubscribeShadings = registry.subscribe(apply)
    if (registry !== null || this.shadings.definitions.length > 0) apply()
  }

  /** The draped layers (plugins) it draws above its imagery. `Earth.setTerrain` calls it. */
  setDrapedLayers(registry: DrapedLayerRegistry | null): void {
    this.overlays.setDrapedLayers(registry)
  }

  /** Throws, stating the fix, when the layer's sources do not fit the terrain's layer slots (shared with draped layers). */
  addImagery(imagery: Imagery): void {
    if (this.imagery.has(imagery)) return
    if (imagery.overlays.length > this.overlays.freeLayerSlots) {
      throw new Error(
        `Terrain: this imagery layer has ${imagery.overlays.length} sources but only ${this.overlays.freeLayerSlots} terrain layer slots are left ` +
          `(imagery sources and draped layers share ${MAXIMUM_TERRAIN_LAYERS}). Remove an imagery layer or a plugin's draped layer first.`,
      )
    }
    this.imagery.add(imagery)
    for (const overlay of imagery.overlays) {
      this.overlays.addOverlay(overlay as never)
      const symbols = screenSymbolsOf(overlay)
      if (symbols !== null) this.symbols.add(symbols.object)
      const extrusions = extrusionsOf(overlay)
      if (extrusions !== null) this.extrusions.add(extrusions.object)
    }
  }

  removeImagery(imagery: Imagery): void {
    if (!this.imagery.delete(imagery)) return
    for (const overlay of imagery.overlays) {
      this.overlays.deleteOverlay(overlay as never)
      const symbols = screenSymbolsOf(overlay)
      if (symbols !== null) this.symbols.remove(symbols.object)
      const extrusions = extrusionsOf(overlay)
      if (extrusions !== null) this.extrusions.remove(extrusions.object)
    }
  }

  /**
   * Draws the terrain's tiles alone, as they stand this frame, from `camera` into `target`, every tile with `material`:
   * a node material reading the terrain's nodes (`terrainElevationMeters`, `terrainWaterMask`, …) in its `outputNode`.
   * The tiles keep their own vertex positions (morph, exaggeration). For a plugin's own view of the ground, as a sea's
   * map of the water and the seafloor around the camera. Returns false, drawing nothing, while the tiles are in no scene.
   */
  renderTiles(renderer: WebGPURenderer, camera: Camera, target: RenderTarget, material: NodeMaterial, clearColor: Color, clearAlpha = 1): boolean {
    let root: Object3D = this.tiles.group
    while (root.parent !== null) root = root.parent
    if ((root as Scene).isScene !== true) return false
    const scene = root as Scene & { backgroundNode?: unknown; fogNode?: unknown }
    const saved = {
      overrideMaterial: scene.overrideMaterial,
      background: scene.background,
      backgroundNode: scene.backgroundNode,
      fog: scene.fog,
      fogNode: scene.fogNode,
      layers: camera.layers.mask,
      target: renderer.getRenderTarget(),
      mrt: renderer.getMRT(),
      autoClear: renderer.autoClear,
      clearAlpha: renderer.getClearAlpha(),
    }
    renderer.getClearColor(scratchClearColor)
    scene.overrideMaterial = material
    scene.background = null
    scene.backgroundNode = null
    scene.fog = null
    scene.fogNode = null
    camera.layers.set(TERRAIN_LAYER)
    try {
      renderer.setMRT(null)
      renderer.setRenderTarget(target)
      renderer.setClearColor(clearColor, clearAlpha)
      renderer.clear()
      renderer.autoClear = false
      renderer.render(scene, camera)
    } finally {
      scene.overrideMaterial = saved.overrideMaterial
      scene.background = saved.background
      scene.backgroundNode = saved.backgroundNode
      scene.fog = saved.fog
      scene.fogNode = saved.fogNode
      camera.layers.mask = saved.layers
      renderer.setRenderTarget(saved.target)
      renderer.setMRT(saved.mrt)
      renderer.autoClear = saved.autoClear
      renderer.setClearColor(scratchClearColor, saved.clearAlpha)
    }
    return true
  }

  /** Goes up whenever a terrain tile is shown or hidden or the exaggeration changes: heights read before may have changed. */
  get visibleTilesVersion(): number {
    return this.visibleTilesVersionValue
  }

  /**
   * Height of the terrain as drawn (exaggerated) at a position (radians), in metres above the ellipsoid, from the deepest visible
   * tile there; null where no visible tile covers it. Cheaper than a raycast: for many reads per frame (labels).
   */
  sampleElevation(longitudeRadians: number, latitudeRadians: number): number | null {
    return sampleTerrainHeight(this.tiles.visibleTiles, longitudeRadians, latitudeRadians, this.flatMap.exaggeration)
  }

  /** True when a map style source draws labels that face the viewer. */
  get hasScreenSymbols(): boolean {
    return this.symbols.children.length > 0
  }

  /**
   * Places the labels that face the viewer for this frame (after `update`, so terrain heights are current). Returns
   * true while they need another frame. `Earth.update` calls it.
   */
  updateSymbols(frame: SymbolFrame): boolean {
    let needsFrame = false
    for (const symbols of this.screenSymbols()) needsFrame = symbols.update(frame) || needsFrame
    return needsFrame
  }

  /** True when a map style source draws `fill-extrusion` layers in 3D. */
  get hasExtrusions(): boolean {
    return this.extrusions.children.length > 0
  }

  /** Sets the buildings standing in 3D for this frame (after `update`, so terrain heights are current). Returns true while they need another frame. */
  updateExtrusions(frame: ExtrusionFrame): boolean {
    let needsFrame = false
    for (const extrusions of this.allExtrusions()) needsFrame = extrusions.update(frame) || needsFrame
    return needsFrame
  }

  /** Buildings standing in 3D, summed over the map style sources. Null when none draws them. */
  inspectExtrusions(): ExtrusionsInspection | null {
    let total: ExtrusionsInspection | null = null
    for (const extrusions of this.allExtrusions()) {
      const inspection = extrusions.inspect()
      if (total === null) total = inspection
      else for (const key of Object.keys(total) as Array<keyof ExtrusionsInspection>) total[key] += inspection[key]
    }
    return total
  }

  protected *allExtrusions(): Iterable<Extrusions> {
    for (const imagery of this.imagery) {
      for (const overlay of imagery.overlays) {
        const extrusions = extrusionsOf(overlay)
        if (extrusions !== null) yield extrusions
      }
    }
  }

  /** Labels facing the viewer, summed over the map style sources. Null when none draws them. */
  inspectSymbols(): ScreenSymbolsInspection | null {
    let total: ScreenSymbolsInspection | null = null
    for (const symbols of this.screenSymbols()) {
      const inspection = symbols.inspect()
      if (total === null) total = inspection
      else for (const key of Object.keys(total) as Array<keyof ScreenSymbolsInspection>) total[key] += inspection[key]
    }
    return total
  }

  /** The labels facing the viewer on the screen as of the last frame, over every map style source. For tests and devtools. */
  getScreenLabels(): ScreenLabelInspection[] {
    return [...this.screenSymbols()].flatMap(symbols => symbols.getScreenLabels())
  }

  protected *screenSymbols(): Iterable<ScreenSymbols> {
    for (const imagery of this.imagery) {
      for (const overlay of imagery.overlays) {
        const symbols = screenSymbolsOf(overlay)
        if (symbols !== null) yield symbols
      }
    }
  }

  /**
   * Main-thread imagery work over the last frame: terrain tiles composed and milliseconds spent, with a
   * breakdown. For on-device profiling; `Earth.inspect()` reports the main figures. The object is reused
   * every frame: copy it to keep it.
   */
  get imageryStatistics(): ImageryFrameStatistics {
    return this.overlays.statistics.lastFrame
  }

  /** Imagery compositions waiting for a later frame's budget. */
  get imageryCompositionsPending(): number {
    return this.overlays.compositor.pendingCount
  }

  /** Imagery textures waiting to be redrawn after an `invalidate` (vector map styles, draped layers), or being redrawn. */
  get imageryRecompositionsPending(): number {
    let count = 0
    for (const imagery of this.imagery) {
      for (const overlay of imagery.overlays) {
        const pending = (overlay as { recompositionsPending?: unknown }).recompositionsPending
        if (typeof pending === 'number') count += pending
      }
    }
    count += this.overlays.drapedRecompositionsPending
    return count
  }

  /**
   * True while the tileset's root or terrain tiles are queued, downloading or parsing, a loaded tile still waits for the next
   * `update` to be shown, or imagery waits to be composed or redrawn after `invalidate`. `Earth` reads it for the `idle` event.
   */
  get loading(): boolean {
    const { stats, rootLoadingState, isLoading } = this.tiles as unknown as {
      stats: { queued: number; downloading: number; parsing: number }
      rootLoadingState: number
      /** Download, parse or child-preparation tasks still running (3DTilesRenderer's own `tiles-load-end` test). */
      isLoading: boolean
    }
    if (rootLoadingState === ROOT_UNLOADED || rootLoadingState === ROOT_LOADING || isLoading) return true
    for (const symbols of this.screenSymbols()) if (symbols.loading) return true
    for (const extrusions of this.allExtrusions()) if (extrusions.loading) return true
    const { queued, downloading, parsing } = stats
    return this.updateRequested || queued + downloading + parsing > 0 || this.imageryCompositionsPending > 0 || this.imageryRecompositionsPending > 0
  }

  /**
   * Calls `listener` whenever the terrain needs another frame: tiles finished loading, or imagery is still
   * waiting to be composed. Hosts that render on demand (R3F `frameloop="demand"`) forward it to their
   * invalidate. Returns a function that removes the listener.
   */
  addFrameRequestListener(listener: () => void): () => void {
    const tiles = this.tiles as unknown as FrameRequestDispatcher
    for (const type of FRAME_REQUEST_EVENTS) tiles.addEventListener(type, listener)
    return () => {
      for (const type of FRAME_REQUEST_EVENTS) tiles.removeEventListener(type, listener)
    }
  }

  /**
   * Selects and loads tiles for this camera, and composes imagery that finished loading. Call once per
   * frame before rendering.
   */
  update(camera: Camera, renderer: WebGPURenderer): void {
    this.updateRequested = false
    this.tiles.setCamera(camera)
    this.tiles.setResolutionFromRenderer(camera, renderer as never)
    this.tiles.update()
    this.overlays.composeImagery(renderer)
  }

  dispose(): void {
    this.unsubscribeShadings?.()
    this.unsubscribeShadings = null
    this.tiles.dispose()
  }
}

/** Rebuilds the terrain materials of a tile's meshes for the terrain's current shadings (cached: cheap when unchanged). */
function recomposeScene(scene: Object3D): void {
  scene.traverse(object => {
    const { material } = object as { material?: Material | Material[] }
    if (material !== undefined && !Array.isArray(material)) recomposeTerrainMaterial(material)
  })
}

function extrusionsOf(overlay: unknown): Extrusions | null {
  return (overlay as { extrusions?: Extrusions | null }).extrusions ?? null
}

function screenSymbolsOf(overlay: unknown): ScreenSymbols | null {
  return (overlay as { screenSymbols?: ScreenSymbols | null }).screenSymbols ?? null
}

const scratchClearColor = new Color()
