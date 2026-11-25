import { Group, Vector2, type Camera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { ViewMorph, type ViewMode, type ViewTransitionOptions } from '../view/ViewMorph.js'
import { collectAttributions, type AttributionProvider } from './attribution.js'
import type { Atmosphere } from './Atmosphere.js'
import type { GeographicPosition } from './camera.js'
import type { CameraLimits } from './cameraLimits.js'
import { EarthCamera, type MapView, type MapViewChange } from './EarthCamera.js'
import { CameraMotionDetector, EarthEventTracker, type EarthEventMap, type EarthPointerEvent, type ViewSample } from './events.js'
import type { Imagery } from './Imagery.js'
import { screenClipKeeps } from './screenClip.js'
import { screenToMercatorQuery, type RenderedFeature, type RenderedFeatureQueryOptions, type ScreenQueryGeometry } from './featureQuery.js'
import { LayerEvents } from './LayerEvents.js'
import { RasterDemSource, type MapStyleSource } from './sources.js'
import type { MercatorPoint, RenderedSourceFeature } from '../vector/worker/types.js'
import type { ProjectedPosition, ScreenPosition } from './projection.js'
import { Terrain } from './Terrain.js'
import type { StyleRoot } from '../vector/styleRoot.js'
import type { ExtrusionsInspection } from '../vector/extrusions/Extrusions.js'
import type { ScreenSymbolsInspection, SymbolFrame } from '../vector/symbols/ScreenSymbols.js'
import { GeographicAnchor, type GeographicAnchorOptions } from './GeographicAnchor.js'
import type { EarthPlugin } from '../plugins/plugin.js'
import { PluginManager, type PluginInspection } from '../plugins/PluginManager.js'
import { StyleLayerTypeRegistry } from '../plugins/styleLayerTypes.js'
import { SymbolEffectRegistry } from '../plugins/symbolEffects.js'
import { TerrainShadingRegistry } from '../plugins/terrainShadings.js'
import { DrapedLayerRegistry, type DrapedLayerInspection } from '../plugins/drapedLayers.js'
import { RenderPassRegistry, type RenderPassInspection } from '../plugins/renderPasses.js'
import { PointerInteractions } from './PointerInteractions.js'

/** Terrain height reads for labels per frame, and the time they may take. */
const SYMBOL_ELEVATION_READS_PER_FRAME = 512
const SYMBOL_ELEVATION_MILLISECONDS_PER_FRAME = 1
/** The centre ray's sine against the ground is taken as at least this, so a view along the ground keeps a sane zoom. */
const MINIMUM_CENTER_RAY_SINE = 0.2
/** How many zoom levels the ground under the screen centre may add to the ellipsoid's zoom. */
const MAXIMUM_GROUND_ZOOM_GAIN = 4
/** Terrain height reads under 3D buildings per frame, and milliseconds of reading. */
const EXTRUSION_ELEVATION_READS_PER_FRAME = 1024
/**
 * A camera this close to the Earth's centre has not been placed: a fresh three.js camera starts near the origin,
 * deep inside the planet (the polar radius is 6357 km).
 */
const UNPLACED_CAMERA_DISTANCE_METERS = 6_000_000
const EXTRUSION_ELEVATION_MILLISECONDS_PER_FRAME = 1

/** An imagery overlay that can answer feature queries (`MapStyleOverlay`). */
interface QueryableOverlay {
  queryRenderedFeatures(geometry: readonly MercatorPoint[], options: RenderedFeatureQueryOptions, screenBox?: readonly [number, number, number, number]): Promise<RenderedSourceFeature[]>
}

/** Pointer travel, in CSS pixels, under which a press and release is a click rather than a drag (MapLibre's `clickTolerance`). */
const CLICK_TOLERANCE_PIXELS = 3

export interface EarthOptions {
  /** Drives the sun's position. Default: now. */
  date?: Date
  /**
   * The view to start in: `'3d'` (globe) or `'2d'` (flat Web Mercator map). Default: the first map style's root
   * `projection` (`'mercator'` is `'2d'`), else '3d'.
   */
  view?: ViewMode
  /**
   * Where the camera starts: `earth.camera.jumpTo(initialView)` on the first `update`, once the camera
   * is known. Default: the first map style's root `center`, `zoom`, `bearing` and `pitch` when it loads, if
   * nothing moved the camera before; otherwise the camera stays where it is.
   */
  initialView?: MapViewChange
  /** Bounds the camera stays within: zoom, tilt and the box the centre stays in (`earth.camera.setLimits`). Default: none. */
  cameraLimits?: CameraLimits
  /**
   * Whether markers and popups get the built-in look: the popup's font, colours, box, tip and close button,
   * the focus rings (the default pin keeps its shape and `--earthkit-marker-color`). False leaves them unstyled
   * apart from what places them, for an app that brings its own CSS
   * (target `.earthkit-marker`, `.earthkit-popup`, `.earthkit-popup-content`, …). With it on, restyle through
   * the same classes or the `--earthkit-popup-*` and `--earthkit-marker-color` CSS variables. Default: true.
   */
  defaultOverlayStyles?: boolean
}

/** A JSON snapshot of what the Earth is doing, for agents and devtools. */
export interface EarthInspection {
  date: string
  /** Main-thread time of the last `update()`: tile traversal, imagery composition and the sun. */
  updateMilliseconds: number
  terrain: null | {
    url: string
    /** True when the earth built it from a map style's root `terrain` (the app set no terrain). */
    fromStyle: boolean
    tilesLoaded: number
    tilesVisible: number
    tilesDownloading: number
    tilesParsing: number
    memoryUsedBytes: number
    memoryBudgetBytes: number
    /** Terrain-tile imagery textures composed on the GPU over the last frame, redraws after `invalidate` included. */
    imageryTilesComposited: number
    /** Main-thread milliseconds spent on imagery over the last frame (composition, layer setup, tile splitting). */
    imageryMainThreadMilliseconds: number
    /** Imagery compositions waiting for a later frame's budget. */
    imageryCompositionsPending: number
    /** Imagery textures waiting to be redrawn after `MapStyleSource.invalidate`, or being redrawn. */
    imageryRecompositionsPending: number
    /** Terrain-tile imagery textures composed since the terrain was created. */
    imageryTilesCompositedTotal: number
    /** Main-thread milliseconds spent on imagery since the terrain was created. */
    imageryMainThreadMillisecondsTotal: number
    /** Labels of map style sources that face the viewer, summed over the sources; null when none draws them. */
    symbols: ScreenSymbolsInspection | null
    /** Buildings of map style sources standing in 3D (`fill-extrusion`), summed over the sources; null when none draws them. */
    extrusions: ExtrusionsInspection | null
  }
  imageryLayers: number
  /** `earth.camera.getView()`, or null before the first `update`. */
  camera: MapView | null
  /** True once the first view finished loading (the `load` event fired). */
  loaded: boolean
  /** True while nothing is moving, loading or composing (since the last `idle` event). */
  idle: boolean
  /** The globe-to-map morph: `morph` is 0 on the globe and 1 on the flat map. */
  view: { mode: ViewMode; morph: number; anchorLongitudeDegrees: number; anchorLatitudeDegrees: number }
  /** Null without an atmosphere. */
  atmosphere: {
    /** True once the lookup textures are generated; until then the scene renders without haze or sky. */
    ready: boolean
    /** True once the skylight is copied to the CPU too (`Atmosphere.getSunAndSkyIlluminance`), shortly after `ready`. */
    skylightOnCpu: boolean
    /** Time the lookup textures took to generate, or to load from the cache. */
    generationTimeMilliseconds: number | null
    /** Animation frames they took. */
    generationFrames: number | null
    loadedFromCache: boolean
  } | null
  /** Installed plugins by name, in install order. */
  plugins: Record<string, PluginInspection>
  /** Render passes (`earth.renderPasses` and built-in ones such as `fxaa`), in the order they run. */
  renderPasses: RenderPassInspection[]
  /** Draped layers (`earth.drapedLayers`), bottom to top. */
  drapedLayers: DrapedLayerInspection[]
  /** Terrain shadings (`earth.terrainShadings`) by name, in the order they run. */
  terrainShadings: string[]
}

function inspectImagery(terrain: Terrain) {
  const { lastFrame, total } = terrain.overlays.statistics
  return {
    imageryTilesComposited: lastFrame.tilesComposited,
    imageryMainThreadMilliseconds: lastFrame.mainThreadMilliseconds,
    imageryCompositionsPending: terrain.imageryCompositionsPending,
    imageryRecompositionsPending: terrain.imageryRecompositionsPending,
    imageryTilesCompositedTotal: total.tilesComposited,
    imageryMainThreadMillisecondsTotal: total.mainThreadMilliseconds,
    symbols: terrain.inspectSymbols(),
    extrusions: terrain.inspectExtrusions(),
  }
}

/**
 * The root of a map: holds the terrain, imagery and atmosphere, all in Earth-centred, Earth-fixed
 * (ECEF, WGS84) metres. Add it to the scene and call `update` once per frame.
 */
export class Earth extends Group<EarthEventMap> {
  date: Date
  /** Whether markers and popups get the built-in look (`EarthOptions.defaultOverlayStyles`). */
  readonly defaultOverlayStyles: boolean
  terrain: Terrain | null = null
  atmosphere: Atmosphere | null = null
  /** The globe-to-map morph, shared with the terrain, atmosphere and controls. Change it with `setView`. */
  readonly view = new ViewMorph()
  /** Zoom, centre, bounds and screen conversions for the camera the Earth is seen through. */
  readonly camera = new EarthCamera(this)
  /** Main-thread time of the last `update()`, in milliseconds. */
  lastUpdateMilliseconds = 0
  /** The installed plugins, in install order. Add and remove them with `addPlugin` and `removePlugin`. */
  readonly plugins: PluginManager = new PluginManager(this)
  /** Custom style layer types plugins registered (`context.registerStyleLayerType`), drawn by map style sources. */
  readonly styleLayerTypes = new StyleLayerTypeRegistry()
  /** Symbol effects plugins registered (`context.registerSymbolEffect`), for labels of layers whose metadata names one. */
  readonly symbolEffects = new SymbolEffectRegistry()
  /** Terrain shadings plugins registered (`context.registerTerrainShading`), run by the terrain's tile materials over the imagery. */
  readonly terrainShadings = new TerrainShadingRegistry()
  /** Screen effects plugins registered (`context.registerRenderPass`), built into the output by `EarthRenderPipeline`. */
  readonly renderPasses = new RenderPassRegistry()
  /** Layers plugins drape above every imagery layer (`context.registerDrapedLayer`), drawn by the terrain. */
  readonly drapedLayers = new DrapedLayerRegistry()
  /**
   * Pointer events scoped to style layers (`click`, `pointerenter`, `pointerleave`…), a pointer cursor over
   * layers, and hover feature-state. See `LayerEvents`.
   */
  readonly layerEvents: LayerEvents = new LayerEvents(this)
  /**
   * Presses plugins and apps take from the camera controls (dragging a vertex, a gizmo handle). Connected to the
   * canvas by `attachPointerEvents`. See `PointerInteractions`.
   */
  readonly interactions: PointerInteractions = new PointerInteractions(this.camera)
  /** Layer ids `queryRenderedFeatures` warned about, so each is reported once. */
  protected readonly unknownQueryLayers = new Set<string>()
  /** Anchors made by `createGeographicAnchor`, placed for the morph every frame. */
  protected readonly anchors = new Set<GeographicAnchor>()
  protected readonly events = new EarthEventTracker()
  protected readonly cameraMotion = new CameraMotionDetector()
  protected readonly viewportSize = new Vector2()
  protected readonly imagery = new Set<Imagery>()
  protected readonly attributionSubscriptions = new Map<AttributionProvider, () => void>()
  /** `performance.now()` at the last `update()`, for the morph's clock. */
  protected lastUpdateTimestamp: number | null = null
  /** Applied by the first `update`. */
  protected pendingInitialView: MapViewChange | null
  /** Whether the app chose the view (`view` option, `setView`): styles' root `projection` then leaves it alone. */
  protected viewChosen: boolean
  /** The view the last style's root `projection` asked for, so only a change to it morphs again. */
  protected styleView: ViewMode | null = null
  /** Whether the starting camera is settled (`initialView`, or a style's root `center`…): later styles leave it. */
  protected initialViewSettled: boolean
  /** The camera of the last `update`, to tell whether the app placed it before a style's view arrived. */
  protected lastCamera: Camera | null = null
  /** The terrain the app set with `setTerrain`; without one, `terrain` is built from a style's root `terrain`. */
  protected appTerrain: Terrain | null = null
  /** The terrain built from a map style's root `terrain`, while the app sets none. */
  protected styleTerrain: { source: MapStyleSource; key: string; terrain: Terrain; removeFrameRequestListener: () => void } | null = null
  /** Map style sources of the imagery layers, followed for their root properties: their last read root and how to stop. */
  protected readonly followedStyles = new Map<MapStyleSource, { root: StyleRoot | null; stop: () => void }>()
  /** Style root warnings already logged, so each is reported once. */
  protected readonly styleRootWarnings = new Set<string>()
  /** The element `attachPointerEvents` listens to, and how to stop listening. */
  protected pointerTarget: { element: HTMLElement; remove: () => void } | null = null
  protected readonly viewSample: ViewSample = { groundMetersPerPixel: 0, headingDegrees: 0, pitchDegrees: 0 }

  constructor({ date = new Date(), view, initialView, cameraLimits, defaultOverlayStyles = true }: EarthOptions = {}) {
    super()
    this.name = 'Earth'
    this.date = date
    this.defaultOverlayStyles = defaultOverlayStyles
    this.pendingInitialView = initialView ?? null
    this.initialViewSettled = initialView !== undefined
    if (cameraLimits !== undefined) this.camera.setLimits(cameraLimits)
    this.viewChosen = view !== undefined
    if (view === '2d') this.view.setMode('2d', { durationSeconds: 0 })
  }

  /**
   * Listens to pointer input on `element`, for the `click`, `doubleclick`, `contextmenu` and `pointermove`
   * events. `element` is the canvas, or the element that receives its events (R3F's `eventSource`); screen
   * positions are measured from `canvas` (default: `element`). `<Earth>` calls it. Calling it again moves
   * the listeners.
   */
  attachPointerEvents(element: HTMLElement, { canvas = element }: { canvas?: HTMLElement } = {}): void {
    this.detachPointerEvents()
    /** Where the primary pointer went down, for telling clicks from drags. */
    let down: { x: number; y: number } | null = null
    const dispatch = (type: 'click' | 'doubleclick' | 'contextmenu' | 'pointermove' | 'pointerout', originalEvent: MouseEvent) => {
      // Nothing to measure without a listener (pointermove fires constantly; the rectangle can force a layout).
      if (!this.hasListeners(type)) return
      const rectangle = canvas.getBoundingClientRect()
      const screen = { xPixels: originalEvent.clientX - rectangle.left, yPixels: originalEvent.clientY - rectangle.top }
      const camera = this.camera
      let geographic: EarthPointerEvent['geographic'] | undefined
      const event = {
        type,
        screen,
        originalEvent,
        get geographic() {
          if (geographic === undefined) geographic = camera.ready ? camera.unproject(screen) : null
          return geographic
        },
      }
      this.dispatchEvent(event as never)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary) down = { x: event.clientX, y: event.clientY }
    }
    const onClick = (event: MouseEvent) => {
      // A drag that ends over the canvas still fires `click`: only a press and release in place counts.
      const moved = down === null ? 0 : Math.hypot(event.clientX - down.x, event.clientY - down.y)
      down = null
      if (moved <= CLICK_TOLERANCE_PIXELS) dispatch('click', event)
    }
    const onDoubleClick = (event: MouseEvent) => dispatch('doubleclick', event)
    const onContextMenu = (event: MouseEvent) => dispatch('contextmenu', event)
    const onPointerMove = (event: PointerEvent) => dispatch('pointermove', event)
    const onPointerLeave = (event: PointerEvent) => dispatch('pointerout', event)
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointerleave', onPointerLeave)
    element.addEventListener('click', onClick)
    element.addEventListener('dblclick', onDoubleClick)
    element.addEventListener('contextmenu', onContextMenu)
    element.addEventListener('pointermove', onPointerMove)
    this.interactions.attach(element, canvas)
    this.pointerTarget = {
      element,
      remove: () => {
        this.interactions.detach()
        element.removeEventListener('pointerdown', onPointerDown)
        element.removeEventListener('click', onClick)
        element.removeEventListener('dblclick', onDoubleClick)
        element.removeEventListener('contextmenu', onContextMenu)
        element.removeEventListener('pointermove', onPointerMove)
        element.removeEventListener('pointerleave', onPointerLeave)
      },
    }
  }

  /** True when a listener waits for this event type. */
  protected hasListeners(type: string): boolean {
    const listeners = (this as unknown as { _listeners?: Record<string, unknown[] | undefined> })._listeners
    return (listeners?.[type]?.length ?? 0) > 0
  }

  /** The element `attachPointerEvents` listens to, or null. `layerEvents.addCursor` sets its cursor. */
  get pointerEventsElement(): HTMLElement | null {
    return this.pointerTarget?.element ?? null
  }

  /** Stops listening to pointer input. */
  detachPointerEvents(): void {
    this.pointerTarget?.remove()
    this.pointerTarget = null
  }

  /**
   * Morphs to the globe (`'3d'`) or the flat Web Mercator map (`'2d'`), over `durationSeconds` (default
   * 1.8, 0 switches at once). The map is anchored where the camera looks, and on the way to 2D the camera
   * turns to look straight down. The morph runs in `update`; `view.transitioning` tells when it is done.
   */
  setView(mode: ViewMode, options?: ViewTransitionOptions): void {
    this.viewChosen = true
    this.view.setMode(mode, options)
  }

  /**
   * Prepares the renderer for planet-scale coordinates: model-view matrices are computed in 64-bit on
   * the CPU (relative to the camera), so vertices stay stable at centimetre scale anywhere on Earth.
   */
  connect(renderer: WebGPURenderer): void {
    renderer.highPrecision = true
  }

  /**
   * Installs a plugin: it registers what it adds through a `PluginContext`, and `removePlugin` undoes all of
   * it. Throws if a different plugin with the same name is installed, or if the plugin was built for another
   * plugin API version (`PLUGIN_API_VERSION`). Adding the same plugin twice does nothing.
   */
  addPlugin(plugin: EarthPlugin): void {
    this.plugins.add(plugin)
  }

  /** Removes a plugin (or the plugin with this name) and undoes everything it registered. */
  removePlugin(plugin: EarthPlugin | string): void {
    this.plugins.remove(plugin)
  }

  /**
   * An `Object3D` at a geographic position, oriented east-north-up (x east, y north, z up, metres), that the
   * earth keeps on its spot through the globe-to-map morph, at the map's scale. Add it under the earth
   * (`earth.add(anchor)`, or `context.addObject(anchor)` in a plugin) and put your objects in it.
   * `anchor.dispose()` stops the updates and removes it.
   * @example
   * const anchor = earth.createGeographicAnchor({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, heightMeters: 3800 })
   * anchor.add(new Mesh(new SphereGeometry(100), material))
   * earth.add(anchor)
   */
  createGeographicAnchor(position: GeographicPosition, options?: GeographicAnchorOptions): GeographicAnchor {
    const anchor = new GeographicAnchor(position, options)
    anchor.update(this.view)
    this.anchors.add(anchor)
    return anchor
  }

  /**
   * Sets the ground. Without one (null), the earth builds terrain from the root `terrain` of its first map style
   * that has one (a `RasterDemSource` of the raster-dem source it names, with its exaggeration), and drops it when
   * the app sets a terrain again.
   */
  setTerrain(terrain: Terrain | null): void {
    if (this.appTerrain === terrain && this.terrain === (terrain ?? this.styleTerrain?.terrain ?? null)) return
    this.appTerrain = terrain
    this.updateStyleTerrain()
  }

  protected attachTerrain(terrain: Terrain | null): void {
    if (this.terrain === terrain) return
    if (this.terrain !== null) {
      this.unsubscribeAttributions(this.terrain)
      this.terrain.setView(null)
      this.terrain.setStyleLayerTypes(null)
      this.terrain.setSymbolEffects(null)
      this.terrain.setTerrainShadings(null)
      this.terrain.setDrapedLayers(null)
      for (const imagery of this.imagery) this.terrain.removeImagery(imagery)
      this.remove(this.terrain.object)
      this.remove(this.terrain.symbols)
      this.remove(this.terrain.extrusions)
    }
    this.terrain = terrain
    if (terrain !== null) {
      this.subscribeAttributions(terrain)
      terrain.setView(this.view)
      terrain.setStyleLayerTypes(this.styleLayerTypes)
      terrain.setSymbolEffects(this.symbolEffects)
      terrain.setTerrainShadings(this.terrainShadings)
      this.add(terrain.object)
      this.add(terrain.symbols)
      this.add(terrain.extrusions)
      // Imagery first: draped layers take the layer slots left after it (one that does not fit is logged).
      for (const imagery of this.imagery) {
        try {
          terrain.addImagery(imagery)
        } catch (error) {
          console.error(error)
        }
      }
      terrain.setDrapedLayers(this.drapedLayers)
    }
    this.dispatchEvent({ type: 'attributionchange' })
  }

  /** Throws, stating the fix, when the terrain has no layer slot left for its sources (nothing changes then). */
  addImagery(imagery: Imagery): void {
    this.terrain?.addImagery(imagery)
    if (!this.imagery.has(imagery)) this.subscribeAttributions(imagery)
    this.imagery.add(imagery)
    this.followStyles()
    this.dispatchEvent({ type: 'attributionchange' })
  }

  removeImagery(imagery: Imagery): void {
    this.unsubscribeAttributions(imagery)
    this.imagery.delete(imagery)
    this.terrain?.removeImagery(imagery)
    this.followStyles()
    this.dispatchEvent({ type: 'attributionchange' })
  }

  /** Map style sources of the imagery layers, in the order the layers were added. */
  protected *mapStyleSources(): Iterable<MapStyleSource> {
    for (const imagery of this.imagery) {
      for (const source of imagery.sources) if (typeof (source as Partial<MapStyleSource>).getStyleRoot === 'function') yield source as MapStyleSource
    }
  }

  /** Starts following the root properties of new map styles, stops for those gone, and updates the style terrain. */
  protected followStyles(): void {
    const current = new Set(this.mapStyleSources())
    for (const [source, followed] of this.followedStyles) {
      if (current.has(source)) continue
      followed.stop()
      this.followedStyles.delete(source)
    }
    for (const source of current) {
      if (this.followedStyles.has(source)) continue
      const onStyleData = () => this.applyStyleRoot(source)
      source.addEventListener('styledata', onStyleData)
      this.followedStyles.set(source, { root: null, stop: () => source.removeEventListener('styledata', onStyleData) })
      if (source.getStyle() !== null) {
        this.applyStyleRoot(source)
      } else if (this.terrain === null) {
        // Nothing draws the style yet (no terrain), so nothing loads it: load it to read its root `terrain`.
        source
          .getMapStyle()
          .load()
          .catch((error: unknown) => console.warn(`MapStyleSource: the style could not load, so its root properties are not read. ${(error as Error).message}`))
      }
    }
    this.updateStyleTerrain()
  }

  /** Follows a style's root `projection`, `center`… (first load only) and `terrain`, after it loaded or changed. */
  protected applyStyleRoot(source: MapStyleSource): void {
    const followed = this.followedStyles.get(source)
    if (followed === undefined) return
    const root = source.getStyleRoot()
    followed.root = root
    if (root === null) return
    for (const warning of root.warnings) {
      if (this.styleRootWarnings.has(warning)) continue
      this.styleRootWarnings.add(warning)
      console.warn(warning)
    }
    if (!this.viewChosen && root.view !== null && root.view !== this.styleView) {
      // The first style's projection applies at once; a later change morphs, as `setView` does.
      this.view.setMode(root.view, this.styleView === null ? { durationSeconds: 0 } : undefined)
      this.styleView = root.view
    }
    if (!this.initialViewSettled && root.initialView !== null) {
      this.initialViewSettled = true
      if (this.cameraUnplaced()) {
        this.pendingInitialView = root.initialView
        this.requestFrame()
      }
    }
    this.updateStyleTerrain()
    this.requestFrame()
  }

  /**
   * True while nothing placed the camera: no `jumpTo` or animation, and the camera is still where a fresh three.js
   * camera starts, near the Earth's centre (an app's `setCameraView`, controls or its own code put it outside).
   */
  protected cameraUnplaced(): boolean {
    if (this.camera.hasPlacedView) return false
    const camera = this.lastCamera
    if (camera === null) return true
    camera.updateMatrixWorld()
    const elements = camera.matrixWorld.elements
    return Math.hypot(elements[12]!, elements[13]!, elements[14]!) < UNPLACED_CAMERA_DISTANCE_METERS
  }

  /**
   * Sets `terrain`: the app's, else one built from the root `terrain` of the first map style that has one (rebuilt
   * when its source changes, exaggeration applied in place), else none.
   */
  protected updateStyleTerrain(): void {
    let wanted: { source: MapStyleSource; key: string; root: StyleRoot } | null = null
    if (this.appTerrain === null) {
      for (const source of this.mapStyleSources()) {
        const root = this.followedStyles.get(source)?.root
        if (root?.terrain == null) continue
        wanted = { source, key: JSON.stringify([root.terrain.sourceId, root.terrain.source]), root }
        break
      }
    }
    const previous = this.styleTerrain
    if (wanted !== null && previous !== null && previous.source === wanted.source && previous.key === wanted.key) {
      previous.terrain.exaggeration = wanted.root.terrain!.exaggeration
      return
    }
    this.styleTerrain = null
    if (wanted !== null) {
      const { source, exaggeration } = wanted.root.terrain!
      let terrain: Terrain
      try {
        terrain = new Terrain({ sources: [new RasterDemSource(source)], exaggeration })
      } catch (error) {
        // `readStyleRoot` checks the source; anything it misses must not break the earth for every later change.
        console.warn(`MapStyleSource: the style's terrain could not be built, so it is ignored; put a <RasterDemSource> in the <Terrain> instead. ${(error as Error).message}`)
        this.attachTerrain(this.appTerrain ?? null)
        if (previous !== null) {
          previous.removeFrameRequestListener()
          previous.terrain.dispose()
        }
        return
      }
      const removeFrameRequestListener = terrain.addFrameRequestListener(() => this.requestFrame())
      this.styleTerrain = { source: wanted.source, key: wanted.key, terrain, removeFrameRequestListener }
    }
    this.attachTerrain(this.appTerrain ?? this.styleTerrain?.terrain ?? null)
    if (previous !== null && previous !== this.styleTerrain) {
      previous.removeFrameRequestListener()
      previous.terrain.dispose()
    }
  }

  /**
   * The credits of everything on the earth, de-duplicated: the terrain first, then the imagery layers in the
   * order they were added. Each is a string of text, possibly with `<a href>` links (`parseAttribution` splits it
   * safely). `AttributionControl` shows them; listen to the `attributionchange` event to follow changes.
   */
  getAttributions(): string[] {
    return collectAttributions([...(this.terrain === null ? [] : [this.terrain]), ...this.imagery])
  }

  protected subscribeAttributions(provider: AttributionProvider): void {
    const remove = provider.addAttributionListener?.(() => this.dispatchEvent({ type: 'attributionchange' }))
    if (remove !== undefined) this.attributionSubscriptions.set(provider, remove)
  }

  protected unsubscribeAttributions(provider: AttributionProvider): void {
    this.attributionSubscriptions.get(provider)?.()
    this.attributionSubscriptions.delete(provider)
  }

  setAtmosphere(atmosphere: Atmosphere | null): void {
    if (this.atmosphere !== null) this.remove(this.atmosphere.light)
    this.atmosphere = atmosphere
    if (atmosphere !== null) this.add(atmosphere.light)
  }

  /**
   * Advances the view morph, loads tiles for the camera and moves the sun. Call once per frame, before
   * rendering. `deltaSeconds` (time since the last frame) drives the morph; without it the clock is used.
   * Returns true while the view is morphing, so hosts that render on demand can ask for another frame.
   */
  update(camera: Camera, renderer: WebGPURenderer, deltaSeconds?: number): boolean {
    const now = performance.now()
    const delta = deltaSeconds ?? (this.lastUpdateTimestamp === null ? 0 : (now - this.lastUpdateTimestamp) / 1000)
    this.lastUpdateTimestamp = now
    renderer.getSize(this.viewportSize)
    this.camera.setCamera(camera)
    this.camera.setViewportSize(this.viewportSize.x, this.viewportSize.y)
    this.lastCamera = camera
    if (this.pendingInitialView !== null && this.camera.ready && !this.view.transitioning) {
      this.camera.jumpToInitialView(this.pendingInitialView)
      this.pendingInitialView = null
    }
    // Before the morph and the tiles, so they follow this frame's camera.
    const animating = this.camera.advanceAnimation(delta)
    // After the animation and the controls (which ran before this update), so every move keeps to the limits. Not
    // before the camera is placed: a fresh camera inside the Earth would be moved out, and a style's start view lost.
    if (this.camera.hasLimits && this.pendingInitialView === null && !this.cameraUnplaced()) this.camera.applyLimits()
    const morphing = this.view.update(camera, Math.min(delta, 0.1))
    this.view.updateWorldCopies(camera)
    this.updateAnchors()
    this.terrain?.update(camera, renderer)
    if (this.atmosphere !== null) {
      // The sky and haze belong to the globe: they fade out on the flat map.
      this.atmosphere.opacity = 1 - this.view.morph
      // The sun keeps lighting the ground the unroll has not reached yet; the flat map is unlit.
      this.atmosphere.light.intensity = this.view.morph < 1 ? 1 : 0
      this.atmosphere.update(camera, this.date)
    }
    const symbolsNeedFrame = this.updateSymbols(camera, delta, now)
    const cameraMoved = this.dispatchFrameEvents(camera, morphing)
    const pluginsNeedFrame = this.plugins.update(camera, delta, renderer)
    this.dispatchEvent({ type: 'update' })
    this.lastUpdateMilliseconds = performance.now() - now
    // After a move, one more frame tells whether the camera stopped (`moveend`).
    return morphing || this.view.transitioning || cameraMoved || animating || pluginsNeedFrame || symbolsNeedFrame
  }

  /**
   * Places the labels of map style sources that face the viewer, and sets their buildings standing in 3D. Returns
   * true while they need another frame.
   */
  protected updateSymbols(camera: Camera, deltaSeconds: number, timeMilliseconds: number): boolean {
    const terrain = this.terrain
    if (terrain === null || (!terrain.hasScreenSymbols && !terrain.hasExtrusions) || !this.camera.ready) return false
    const view = this.camera.readEllipsoidView()
    // The view on the ellipsoid (no raycast), brought up to the terrain at the screen centre with one height read: on a
    // plateau the ground is nearer than the ellipsoid, so the zoom is deeper (MapLibre's zoom follows the terrain too).
    const degrees = Math.PI / 180
    const groundHeightMeters = terrain.sampleElevation(view.longitudeDegrees * degrees, view.latitudeDegrees * degrees) ?? 0
    const sine = Math.max(MINIMUM_CENTER_RAY_SINE, Math.sin(-view.pitchDegrees * degrees))
    // At most MAXIMUM_GROUND_ZOOM_GAIN levels deeper: ground at or above the camera (a ridge behind the ellipsoid point,
    // seen from a valley) must not send the zoom to the maximum.
    const centerDistanceMeters = Math.max(view.distanceMeters / 2 ** MAXIMUM_GROUND_ZOOM_GAIN, view.distanceMeters - groundHeightMeters / sine)
    const centerHeightMeters = (view.distanceMeters - centerDistanceMeters) * sine
    const frame = {
      camera,
      widthPixels: this.viewportSize.x,
      heightPixels: this.viewportSize.y,
      zoom: view.zoom + Math.log2(view.distanceMeters / centerDistanceMeters),
      centerDistanceMeters,
      centerHeightMeters,
      view: this.view,
      sampleTerrainElevation: (longitudeRadians, latitudeRadians) => terrain.sampleElevation(longitudeRadians, latitudeRadians),
      terrainExaggeration: terrain.exaggeration,
      elevationBudget: { remaining: SYMBOL_ELEVATION_READS_PER_FRAME, milliseconds: SYMBOL_ELEVATION_MILLISECONDS_PER_FRAME },
      timeMilliseconds,
      deltaSeconds,
      requestFrame: () => this.requestFrame(),
    } satisfies SymbolFrame
    const symbolsNeedFrame = terrain.hasScreenSymbols && terrain.updateSymbols(frame)
    // Buildings read the terrain under them with a budget of their own.
    const extrusionsNeedFrame =
      terrain.hasExtrusions &&
      terrain.updateExtrusions({ ...frame, terrainVersion: terrain.visibleTilesVersion, elevationBudget: { remaining: EXTRUSION_ELEVATION_READS_PER_FRAME, milliseconds: EXTRUSION_ELEVATION_MILLISECONDS_PER_FRAME } })
    return symbolsNeedFrame || extrusionsNeedFrame
  }

  /** Places the anchors made by `createGeographicAnchor` for this frame's morph. */
  protected updateAnchors(): void {
    for (const anchor of this.anchors) {
      if (anchor.isDisposed) this.anchors.delete(anchor)
      else anchor.update(this.view)
    }
  }

  /** Fires this frame's `move*`, `load` and `idle` events. Returns true when the camera moved. */
  protected dispatchFrameEvents(camera: Camera, morphing: boolean): boolean {
    camera.updateMatrixWorld()
    // A running morph counts as one move, even on frames where the camera itself holds still.
    const cameraMoved = this.cameraMotion.update(camera, this.viewportSize.x, this.viewportSize.y) || morphing
    const busy = morphing || this.view.transitioning || this.camera.animating || this.isLoading()
    const view = (cameraMoved || this.events.needsViewSample) && this.camera.ready ? this.sampleView() : undefined
    for (const type of this.events.update({ cameraMoved, busy, view })) this.dispatchEvent({ type })
    return cameraMoved
  }

  /** The scale, heading and pitch at the centre, on the ellipsoid (cheap: no terrain raycast). */
  protected sampleView(): ViewSample {
    const view = this.camera.readEllipsoidView()
    this.viewSample.groundMetersPerPixel = this.camera.distanceToGroundMetersPerPixel(view.distanceMeters)
    this.viewSample.headingDegrees = view.headingDegrees
    this.viewSample.pitchDegrees = view.pitchDegrees
    return this.viewSample
  }

  /** True while terrain tiles or imagery are loading or waiting to be composed, or the atmosphere is generating. */
  protected isLoading(): boolean {
    if (this.terrain?.loading === true) return true
    if (this.plugins.loading) return true
    // A failed generation leaves the atmosphere off for good: it must not hold `idle` back.
    return this.atmosphere !== null && this.atmosphere.generating && this.atmosphere.context.texturesReady.value !== 1
  }

  /** True once the first view finished loading (the `load` event fired). */
  get loaded(): boolean {
    return this.events.loaded
  }

  /** True while nothing is moving, loading or composing (since the last `idle` event). */
  get idle(): boolean {
    return this.events.idle
  }

  /** Asks the host for a frame (the `framerequest` event), for changes made between frames. */
  requestFrame(): void {
    this.dispatchEvent({ type: 'framerequest' })
  }

  /** Where a geographic position appears on the screen. See `EarthCamera.project`. */
  project(position: GeographicPosition): ProjectedPosition {
    return this.camera.project(position)
  }

  /** The geographic position under a screen point, or null on sky. See `EarthCamera.unproject`. */
  unproject(screen: ScreenPosition): (GeographicPosition & { heightMeters: number }) | null {
    return this.camera.unproject(screen)
  }

  /**
   * The features drawn at a screen point, or in a screen box (two opposite corners), or on the whole screen (no
   * geometry), in every `MapStyleSource`: MapLibre's `queryRenderedFeatures`. Top-most first: the top imagery
   * layer first, and within a style, labels (they draw above every shape) then shapes from the top style layer
   * down. Hits follow what is drawn: line widths, circle radii, placed label boxes, the zoom the terrain is
   * textured at there. Asynchronous: the vector worker answers. A box is followed on the ground along its outline;
   * its parts on the sky are left out.
   * @example
   * const [feature] = await earth.queryRenderedFeatures(event.screen, { layers: ['countries'] })
   * if (feature) feature.mapStyleSource.setFeatureState(feature, { selected: true })
   */
  async queryRenderedFeatures(geometry?: ScreenQueryGeometry, options: RenderedFeatureQueryOptions = {}): Promise<RenderedFeature[]> {
    if (!this.camera.ready) return []
    const screen = geometry ?? ([{ xPixels: 0, yPixels: 0 }, { xPixels: this.viewportSize.x, yPixels: this.viewportSize.y }] as const)
    const mercator = screenToMercatorQuery(screen, position => this.camera.unproject(position))
    if (mercator === null) return []
    // Where the query lies on the screen: labels facing the viewer are hit there.
    const corners = 'xPixels' in screen ? [screen, screen] : screen
    const screenBox = [
      Math.min(corners[0].xPixels, corners[1].xPixels),
      Math.min(corners[0].yPixels, corners[1].yPixels),
      Math.max(corners[0].xPixels, corners[1].xPixels),
      Math.max(corners[0].yPixels, corners[1].yPixels),
    ] as const
    const queries: Array<Promise<RenderedFeature[]>> = []
    const styles: MapStyleSource[] = []
    // Top-most first: imagery layers stack in the order they were added, and sources within a layer bottom to top.
    for (const imagery of [...this.imagery].reverse()) {
      for (let index = imagery.sources.length - 1; index >= 0; index--) {
        const overlay = imagery.overlays[index] as Partial<QueryableOverlay> | undefined
        if (typeof overlay?.queryRenderedFeatures !== 'function') continue
        const source = imagery.sources[index] as MapStyleSource
        styles.push(source)
        if (imagery.opacity <= 0) continue // not drawn
        if (!this.screenBoxOverlapsClip(imagery, screenBox)) continue // clipped away there (`screenClip`)
        const answer = overlay.queryRenderedFeatures(mercator, options, screenBox).then(features => features.map(feature => Object.assign(feature, { mapStyleSource: source })))
        // A source disposed meanwhile (its layer unmounted, a style swap) answers nothing rather than failing the rest.
        queries.push(answer.catch((error: unknown) => {
          if ((error as Error)?.name === 'AbortError') return []
          throw error
        }))
      }
    }
    this.warnUnknownQueryLayers(options.layers, styles)
    return (await Promise.all(queries)).flat()
  }

  /** Whether any corner of the query box (CSS pixels) is in the part of the canvas the layer keeps: a half-plane holds a box's part iff it holds a corner. */
  protected screenBoxOverlapsClip(imagery: Imagery, [left, top, right, bottom]: readonly [number, number, number, number]): boolean {
    const clip = imagery.screenClip
    const { x: width, y: height } = this.viewportSize
    if (clip === null || width <= 0 || height <= 0) return true
    return [left, right].some(x => [top, bottom].some(y => screenClipKeeps(clip, x / width, y / height)))
  }

  /** Warns once per id that no loaded style has, as MapLibre reports layers it cannot query. */
  protected warnUnknownQueryLayers(layers: readonly string[] | undefined, styles: readonly MapStyleSource[]): void {
    if (layers === undefined || styles.length === 0 || styles.some(style => style.getStyle() === null)) return
    for (const id of layers) {
      if (this.unknownQueryLayers.has(id) || styles.some(style => style.getLayer(id) !== undefined)) continue
      this.unknownQueryLayers.add(id)
      console.warn(`Earth.queryRenderedFeatures: no style has a layer "${id}"; check the id against source.getLayerIds().`)
    }
  }

  /** Height of the loaded terrain at a position, or null where none is loaded. See `EarthCamera.queryTerrainElevation`. */
  queryTerrainElevation(position: GeographicPosition): number | null {
    return this.camera.queryTerrainElevation(position)
  }

  inspect(): EarthInspection {
    // Runtime fields 3DTilesRenderer's typings leave out:
    const terrain = this.terrain
    const tiles = terrain?.tiles as
      | (Terrain['tiles'] & {
          rootURL: string
          stats: { loaded: number; downloading: number; parsing: number }
          lruCache: { cachedBytes: number; maxBytesSize: number }
        })
      | undefined
    return {
      date: this.date.toISOString(),
      updateMilliseconds: this.lastUpdateMilliseconds,
      terrain:
        tiles === undefined || terrain === null
          ? null
          : {
              url: tiles.rootURL ?? '',
              fromStyle: this.styleTerrain !== null && this.styleTerrain.terrain === terrain,
              tilesLoaded: tiles.stats.loaded,
              tilesVisible: tiles.visibleTiles.size,
              tilesDownloading: tiles.stats.downloading,
              tilesParsing: tiles.stats.parsing,
              memoryUsedBytes: tiles.lruCache.cachedBytes,
              memoryBudgetBytes: tiles.lruCache.maxBytesSize,
              ...inspectImagery(terrain),
            },
      imageryLayers: this.imagery.size,
      camera: this.camera.ready ? this.camera.getView() : null,
      loaded: this.events.loaded,
      idle: this.events.idle,
      view: this.view.inspect(),
      atmosphere:
        this.atmosphere === null
          ? null
          : {
              ready: this.atmosphere.context.texturesReady.value === 1,
              skylightOnCpu: this.atmosphere.illuminance.skyAvailable,
              generationTimeMilliseconds: this.atmosphere.generationTimeMilliseconds,
              generationFrames: this.atmosphere.generationFrames,
              loadedFromCache: this.atmosphere.loadedFromCache,
            },
      plugins: this.plugins.inspect(),
      renderPasses: this.renderPasses.inspect(),
      drapedLayers: this.drapedLayers.inspect(),
      terrainShadings: this.terrainShadings.ordered().map(definition => definition.name),
    }
  }

  override dispose(): void {
    this.layerEvents.dispose()
    this.plugins.clear()
    for (const anchor of this.anchors) anchor.dispose()
    this.anchors.clear()
    this.detachPointerEvents()
    this.camera.stop()
    for (const remove of this.attributionSubscriptions.values()) remove()
    this.attributionSubscriptions.clear()
    for (const followed of this.followedStyles.values()) followed.stop()
    this.followedStyles.clear()
    this.styleTerrain?.removeFrameRequestListener()
    this.terrain?.dispose()
    this.atmosphere?.dispose()
  }
}
