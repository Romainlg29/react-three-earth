import type { Feature, FeatureCollection } from 'geojson'
import {
  PLUGIN_API_VERSION,
  type DrapedLayerHandle,
  type Earth,
  type EarthPlugin,
  type EarthPointerEvent,
  type GeoJsonFeatureId,
  type GeoJsonSource,
  type GeographicBounds,
  type PluginContext,
  type PluginFrame,
  type PointerInteractionEvent,
} from '@earthkit/globe'
import { EventDispatcher, Matrix4 } from 'three'

import { createFeatureId, FeatureStore, isDrawableFeature, type FeatureStoreChange } from './FeatureStore.js'
import { geometryBounds, padBounds, unionBounds } from './geometry.js'
import { DrawMode, StaticMode, type DrawModeContext, type DrawModeStatus } from './modes/DrawMode.js'
import { ELEMENT_MODES, GIZMO_SPACES, GIZMO_TOOLS, SelectMode, type ElementMode, type GizmoSpace, type GizmoTool } from './modes/SelectMode.js'
import { LineStringMode, PointMode, PolygonMode } from './modes/PathModes.js'
import { CircleMode, RectangleMode, SphereMode } from './modes/ShapeModes.js'
import { DrapedFeatures } from './render/DrapedFeatures.js'
import { LiveOverlay, type OverlayContent } from './render/LiveOverlay.js'
import { isSolidFeature, SolidFeatures } from './render/SolidFeatures.js'
import { resolveStyle } from './style.js'
import type { DrawFeature, DrawGeometry, DrawPointerEvent, DrawStyle, DrawStyleInput, DrawStyleState } from './types.js'

/** Features to load: a collection or an array, with ids that may be numbers or missing (a new one is made). */
export type DrawFeatureInput = FeatureCollection<DrawGeometry> | ReadonlyArray<Omit<DrawFeature, 'id'> & { id?: string | number | null }>

export interface DrawOptions {
  /**
   * The plugin's name, unique on an earth; also the prefix of its draped layer id. Change it to install two `Draw`s.
   * Default: 'draw'.
   */
  name?: string
  /** The modes `setMode` can switch to. Default: static, select, point, linestring, polygon, circle, rectangle and sphere. */
  modes?: DrawMode[]
  /** The mode to start in. Default: 'static'. */
  mode?: string
  /** How features look. Default: blue fills, lines and points, white vertex handles. */
  style?: DrawStyleInput
  /** Features to start with. */
  features?: DrawFeatureInput
  /**
   * Keys act on the mode while the map has focus: Escape, Enter, Backspace and Delete, and in the select mode G, R and
   * S (move, rotate, scale under the pointer), then X, Y and Z (lock to an axis); a right click cancels such a move.
   * Tab enters and leaves edit mode, where 1, 2 and 3 pick vertices, edges or faces, A picks them all (Alt+A none), G
   * moves what is picked (then X, Y or Z for one axis) and E extrudes the picked face. Shift+tap adds to what is picked.
   * Default: false (opt-in).
   */
  keyboard?: boolean
  /** Makes the id of each new feature. Default: a random UUID. */
  createId?: () => string
  /**
   * A GeoJSON source to edit in place instead of holding features of its own: see `setSource`. Default: none.
   */
  source?: GeoJsonSource
}

/** What `getState()` returns: a new object on each change, so it can be compared by identity. */
export interface DrawState extends DrawModeStatus {
  /** The active mode's name. */
  mode: string
  /** Every mode `setMode` takes. */
  modes: readonly string[]
  /** Every finished feature, as GeoJSON. */
  features: FeatureCollection<DrawGeometry>
  /** Ids of the selected features (in the select mode). The same array until the selection changes. */
  selectedIds: readonly string[]
  /**
   * The select mode is in edit mode: the selected feature shows its vertices, edges or faces (`elementMode`) to pick and
   * drag; false while it shows the gizmo (or in other modes).
   */
  editingVertices: boolean
  /** The elements edit mode picks: `'vertex'` (the default), `'edge'` or `'face'`. See `setElementMode`. */
  elementMode: ElementMode
  /** `extrude()` would act: in edit mode, faces, edges or a line's elements are picked. */
  canExtrude: boolean
  /** Elements picked in edit mode (Shift+tap adds one, `selectAllElements` picks them all); 0 outside it. */
  pickedElementCount: number
  /** The gizmo's handles: `'all'` (the default), or only those of `'move'`, `'rotate'` or `'scale'`. See `setGizmoTool`. */
  gizmoTool: GizmoTool
  /** The gizmo's axes: east, north and up (`'world'`, the default), or the feature's own (`'local'`). See `setGizmoSpace`. */
  gizmoSpace: GizmoSpace
}

/** Events a `Draw` fires (`draw.addEventListener('create', listener)`). */
export interface DrawEventMap {
  /** Features were finished by a mode or added with `addFeatures`. */
  create: { features: DrawFeature[] }
  /** Features changed (edited, moved, replaced with `addFeatures`). */
  update: { features: DrawFeature[] }
  /** Features were removed. */
  delete: { features: DrawFeature[] }
  /** The mode changed. */
  modechange: { mode: string; previousMode: string }
  /** Anything in the features changed: the new collection. Fires after `create`, `update` and `delete`. */
  change: { features: FeatureCollection<DrawGeometry> }
}

/** Called with the new state on each change. */
export type DrawStateListener = (state: DrawState) => void

/** Bounds padding around changed features, so points and line widths near region edges redraw too. */
const INVALIDATE_PADDING_FRACTION = 0.1
const INVALIDATE_PADDING_DEGREES = 0.5

/**
 * Headless drawing on the globe and the flat map, as an earthkit plugin: points, line strings, polygons and
 * solid meshes (multipolygons of faces with altitudes), output as GeoJSON. It draws the features (draped on the terrain, styled by `style`) and the handles of the feature in
 * progress, and nothing else: no buttons, no CSS. Build your toolbar from `getState()`, `subscribe` and the actions.
 *
 * ```ts
 * const draw = new Draw()
 * earth.addPlugin(draw)
 * polygonButton.onclick = () => draw.setMode('polygon')
 * draw.addEventListener('create', ({ features }) => save(features))
 * draw.subscribe(state => (finishButton.disabled = !state.canFinish))
 * ```
 *
 * Taps place vertices; one finger still pans the map between taps and two fingers still pinch, on the globe and on the
 * flat map. Finished features are draped like an imagery layer (redrawn once when they change); what is being drawn
 * moves in a screen-space overlay every frame.
 */
export class Draw extends EventDispatcher<DrawEventMap> implements EarthPlugin {
  readonly name: string
  readonly apiVersion = PLUGIN_API_VERSION
  readonly store = new FeatureStore()
  protected readonly modes = new Map<string, DrawMode>()
  protected mode: DrawMode
  /** The mode holding the press it took from the camera controls, if any. */
  protected pressMode: DrawMode | null = null
  protected styleInput: DrawStyleInput | undefined
  /** Whether keys act on the mode (`DrawOptions.keyboard`). */
  readonly keyboard: boolean
  protected gizmoTool: GizmoTool = 'all'
  protected gizmoSpace: GizmoSpace = 'world'
  /** A secondary press the mode took: the context menu it opens is not shown. */
  protected swallowContextMenu = false
  /** When the swallowing of a taken right press's release and context menu ends, if they never come. */
  protected swallowContextMenuUntil = 0
  /** Changes whenever the overlay's camera does (`DrawModeContext.viewVersion`). */
  protected viewVersionNumber = 0
  protected readonly makeId: () => string
  protected readonly listeners = new Set<DrawStateListener>()
  protected state: DrawState
  protected earth: Earth | null = null
  protected overlay: LiveOverlay | null = null
  protected readonly draped = new DrapedFeatures()
  protected drapedLayer: DrapedLayerHandle | null = null
  /** 3D features (meshes, polygons and lines at an altitude), drawn as solids in the scene rather than draped. */
  protected solids: SolidFeatures | null = null
  /** Bounds of each draped feature, to redraw where a changed feature was. */
  protected drapedBounds = new Map<string, GeographicBounds>()
  /** Live ids the draped layer leaves out, from the last refresh. */
  protected liveIds = new Set<string>()
  protected overlayDirty = true
  protected readonly lastCameraMatrix = new Matrix4()
  protected readonly lastProjectionMatrix = new Matrix4()
  protected lastMorph = -1
  protected cursor: string | null = null
  protected doubleClickZoomRelease: (() => void) | null = null
  protected readonly modeContext: DrawModeContext
  /** The GeoJSON source edited in place (`setSource`), or null. */
  protected source: GeoJsonSource | null = null
  /**
   * For features of the source whose Draw id is not their own: the id the source knows them by (a number, or the
   * `promoteId` property) and their GeoJSON `id` as it was. Features with a string `id` and no `promoteId` need none.
   */
  protected readonly sourceKeys = new Map<string, { key: GeoJsonFeatureId; featureId: GeoJsonFeatureId | undefined }>()
  /** The edited source's `promoteId`, read when editing starts. */
  protected sourcePromoteId: string | undefined
  /** Set while the store is filled from the source: those changes are not written back. */
  protected fillingFromSource = false

  constructor({ name = 'draw', modes, mode = 'static', style, features, keyboard = false, createId = createFeatureId, source }: DrawOptions = {}) {
    super()
    this.name = name
    this.styleInput = style
    this.keyboard = keyboard
    this.makeId = createId
    for (const each of modes ?? [new StaticMode(), new SelectMode(), new PointMode(), new LineStringMode(), new PolygonMode(), new CircleMode(), new RectangleMode(), new SphereMode()]) {
      if (this.modes.has(each.name)) throw new Error(`Draw: two modes are named "${each.name}"; give each mode a unique name.`)
      this.modes.set(each.name, each)
    }
    const first = this.modes.get(mode)
    if (first === undefined) throw new Error(`Draw: no mode named "${mode}"; pick one of ${[...this.modes.keys()].join(', ')}, or add it to \`modes\`.`)
    this.mode = first
    // The gizmo settings start as the first select mode's.
    const select = [...this.modes.values()].find((each): each is SelectMode => each instanceof SelectMode)
    if (select !== undefined) {
      this.gizmoTool = select.gizmoTool
      this.gizmoSpace = select.gizmoSpace
    }
    this.modeContext = this.createModeContext()
    if (features !== undefined) this.store.replace(this.withIds(features))
    this.store.subscribe(this.onStoreChange)
    this.state = this.computeState()
    if (source !== undefined) this.setSource(source)
  }

  // ---- State, for toolbars ----

  /** The current state. The same object until something changes. */
  getState = (): DrawState => this.state

  /** Calls `listener` on each change of state, and returns the function that stops it. */
  subscribe = (listener: DrawStateListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---- Modes ----

  /** Switches to a mode by name, dropping whatever the old mode had in progress. */
  setMode(name: string): void {
    const next = this.modes.get(name)
    if (next === undefined) throw new Error(`Draw.setMode: no mode named "${name}"; pick one of ${[...this.modes.keys()].join(', ')}, or add it to \`modes\`.`)
    if (next === this.mode) return
    const previous = this.mode
    if (this.earth !== null) this.exitMode()
    this.mode = next
    if (this.earth !== null) next.enter(this.modeContext)
    this.refresh()
    this.dispatchEvent({ type: 'modechange', mode: next.name, previousMode: previous.name })
  }

  /** The active mode. */
  getMode(): DrawMode {
    return this.mode
  }

  /** Completes the feature being drawn, when it has enough vertices. */
  finish(): void {
    this.mode.finish()
  }

  /** Drops the feature being drawn. */
  cancel(): void {
    this.mode.cancel()
  }

  /** Removes the last vertex of the feature being drawn, or takes back the last edit in the select mode. */
  undo(): void {
    this.mode.undo()
  }

  // ---- Gizmo ----

  /**
   * Which handles the select mode's gizmo shows: `'all'` (arrows, planes, the center ring, rotation arcs and scale cubes
   * together), or only those of `'move'`, `'rotate'` or `'scale'`. Headless: build the buttons from `state.gizmoTool`.
   */
  setGizmoTool(tool: GizmoTool): void {
    if (!GIZMO_TOOLS.includes(tool)) throw new Error(`Draw.setGizmoTool: "${String(tool)}" is no gizmo tool; pick one of ${GIZMO_TOOLS.join(', ')}.`)
    this.gizmoTool = tool
    for (const mode of this.modes.values()) if (mode instanceof SelectMode) mode.setGizmoTool(tool)
    this.refresh()
  }

  /** The gizmo's axes: east, north and up (`'world'`), or the selected feature's own (`'local'`, see `featureAxes`). */
  setGizmoSpace(space: GizmoSpace): void {
    if (!GIZMO_SPACES.includes(space)) throw new Error(`Draw.setGizmoSpace: "${String(space)}" is no gizmo space; pick 'world' or 'local'.`)
    this.gizmoSpace = space
    for (const mode of this.modes.values()) if (mode instanceof SelectMode) mode.setGizmoSpace(space)
    this.refresh()
  }

  // ---- Edit mode ----

  /**
   * Which elements the select mode's edit mode picks: `'vertex'`, `'edge'` or `'face'` (what was picked is dropped).
   * Headless: build the buttons from `state.elementMode`; a double tap on a mesh switches to `'face'`.
   */
  setElementMode(mode: ElementMode): void {
    if (!ELEMENT_MODES.includes(mode)) throw new Error(`Draw.setElementMode: "${String(mode)}" is no element mode; pick 'vertex', 'edge' or 'face'.`)
    for (const each of this.modes.values()) if (each instanceof SelectMode) each.setElementMode(mode)
    this.refresh()
  }

  /**
   * Extrudes what is picked in edit mode, as E does with `keyboard`: a mesh's faces along their mean normal as one
   * region (a polygon's face becomes a prism), edges straight up into new faces, and a line, whatever is picked of it,
   * into a wall. One `update`, one undo step; what it made stays picked. Without `distanceMeters`, half the arrow's
   * length (about 40 px on the screen). Returns false when nothing can be extruded (`state.canExtrude`), and for a
   * negative distance on a line or a polygon's face (a mesh's faces extrude inwards, its edges down).
   */
  extrude(distanceMeters?: number): boolean {
    return this.mode instanceof SelectMode ? this.mode.extrude(distanceMeters) : false
  }

  /**
   * Picks every vertex, edge or face (`state.elementMode`) of the selected feature in edit mode, as A does with
   * `keyboard`: a drag on one of them, or the move gizmo over them, moves them all. Returns false outside edit mode.
   */
  selectAllElements(): boolean {
    const done = this.mode instanceof SelectMode && this.mode.selectAllElements()
    this.refresh()
    return done
  }

  /** Drops what is picked in edit mode, as Alt+A does with `keyboard`. Returns false when nothing was picked. */
  clearElementSelection(): boolean {
    const done = this.mode instanceof SelectMode && this.mode.clearElementSelection()
    this.refresh()
    return done
  }

  // ---- Selection ----

  /** Ids of the selected features. */
  getSelectedIds(): readonly string[] {
    return this.mode.selectedFeatureIds()
  }

  /**
   * Selects features by id (an empty list clears the selection). Switches to the `'select'` mode first when the active
   * mode does not select.
   */
  select(ids: readonly string[]): void {
    if (this.mode.setSelection(ids)) {
      this.refresh()
      return
    }
    if (!this.modes.has('select')) throw new Error('Draw.select: no mode selects features; add a SelectMode to `modes`.')
    this.setMode('select')
    this.mode.setSelection(ids)
    // Before install the mode has no context to refresh through.
    this.refresh()
  }

  /** Deletes what is selected: the picked vertex of the selected feature, or else the selected features. Fires `update` or `delete`. */
  deleteSelected(): boolean {
    return this.mode.deleteSelection()
  }

  // ---- Features ----

  /** Every finished feature, as a GeoJSON feature collection (the same object until something changes). */
  getFeatures(): FeatureCollection<DrawGeometry> {
    return this.store.toFeatureCollection()
  }

  getFeature(id: string): DrawFeature | undefined {
    return this.store.get(id)
  }

  /**
   * Adds features, giving those without an id one; a feature whose id is taken replaces it. Returns the ids. Fires
   * `create` for new ones and `update` for replaced ones.
   */
  addFeatures(features: DrawFeatureInput): string[] {
    const withIds = this.withIds(features)
    const added = withIds.filter(feature => !this.store.has(feature.id))
    const updated = withIds.filter(feature => this.store.has(feature.id))
    this.store.set(withIds)
    if (added.length > 0) this.dispatchEvent({ type: 'create', features: added })
    if (updated.length > 0) this.dispatchEvent({ type: 'update', features: updated })
    this.dispatchChange()
    return withIds.map(feature => feature.id)
  }

  /** Removes features by id. Fires `delete`. */
  removeFeatures(ids: readonly string[]): void {
    const removed = ids.map(id => this.store.get(id)).filter((feature): feature is DrawFeature => feature !== undefined)
    if (removed.length === 0) return
    this.store.remove(ids)
    this.dispatchEvent({ type: 'delete', features: removed })
    this.dispatchChange()
  }

  /** Removes every feature. Fires `delete`. */
  clear(): void {
    this.removeFeatures([...this.store.values()].map(feature => feature.id))
  }

  // ---- Editing a GeoJSON source in place ----

  /**
   * Edits a `GeoJsonSource` in place: its features become Draw's features, with no copy of their coordinates (the store
   * holds the source's own feature objects), and every change (a move, a vertex, a new feature, a delete, `addFeatures`)
   * is written back to it with `updateData` once it is made, on release, never on each frame of a drag. The source's
   * layers keep drawing its features in their own style; Draw drapes none of them and only draws, in its overlay, the
   * features it edits, which it hides from the source's tiles meanwhile (`GeoJsonSource.setHiddenFeatureIds`: no
   * tiling again). The features Draw held before are dropped; `null` stops editing (the source keeps its data).
   *
   * Points, line strings, polygons and multipolygons are editable; other features stay in the source, untouched.
   * Features without an id are given one first (a single `setData`). The source's data must be an object, not a URL.
   * Change the data through Draw while it edits, or call `setSource` again after changing it elsewhere.
   */
  setSource(source: GeoJsonSource | null): void {
    if (source === this.source) return
    if (source === null) this.sourceKeys.clear()
    const features = source === null ? [] : this.featuresOfSource(source)
    this.source?.setHiddenFeatureIds([])
    this.source = source
    this.fillingFromSource = true
    try {
      this.store.replace(features)
    } finally {
      this.fillingFromSource = false
    }
    this.refreshDraped(null, true)
    this.dispatchChange()
  }

  /** The GeoJSON source edited in place (`setSource`), or null. */
  getSource(): GeoJsonSource | null {
    return this.source
  }

  /** Changes how features look, and redraws them. */
  setStyle(style: DrawStyleInput | undefined): void {
    this.styleInput = style
    this.refreshDraped(null, true)
    this.overlayDirty = true
    this.earth?.requestFrame()
  }

  /** The full style of a feature. */
  styleOf(feature: DrawFeature, state: DrawStyleState = { selected: false, drawing: false }): DrawStyle {
    return resolveStyle(this.styleInput, feature, state)
  }

  // ---- Plugin ----

  install(context: PluginContext): void {
    const earth = context.earth
    this.earth = earth
    const overlay = new LiveOverlay(earth)
    this.overlay = overlay
    context.addObject(overlay.object)
    const solids = new SolidFeatures(earth)
    this.solids = solids
    context.addObject(solids.object)
    this.drapedLayer = context.registerDrapedLayer({
      id: `${this.name}:features`,
      premultipliedAlpha: true,
      bounds: () => {
        const bounds = this.draped.bounds()
        return bounds === null ? null : padBounds(bounds, INVALIDATE_PADDING_FRACTION, INVALIDATE_PADDING_DEGREES)
      },
      draw: inputs => this.draped.draw(inputs),
    })
    // A press goes to the mode that took it until it ends: a mode switched to mid-press never sees it.
    context.addPointerInteraction({
      pointerDown: event => {
        const taken = this.mode.pointerDown(this.fromInteraction(event))
        if (taken) this.pressMode = this.mode
        return taken
      },
      pointerMove: event => this.pressMode?.pointerMove(this.fromInteraction(event)),
      pointerUp: event => {
        const mode = this.pressMode
        this.pressMode = null
        mode?.pointerUp(this.fromInteraction(event))
      },
      pointerCancel: () => this.cancelPress(),
    })
    context.addEventListener('click', event => this.mode.click(this.fromEarthEvent(event)))
    context.addEventListener('doubleclick', event => this.mode.doubleClick(this.fromEarthEvent(event)))
    context.addEventListener('pointermove', event => {
      if ((event.originalEvent as PointerEvent).pointerType !== 'touch' && (event.originalEvent as PointerEvent).buttons === 0) this.mode.hover(this.fromEarthEvent(event))
    })
    if (this.keyboard && typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown)
      // Captured on the window, before the camera controls see a right press.
      window.addEventListener('pointerdown', this.onSecondaryPress, true)
      window.addEventListener('pointerup', this.onSecondaryRelease, true)
      window.addEventListener('contextmenu', this.onContextMenu, true)
      window.addEventListener('blur', this.onFocusLost)
      window.addEventListener('focusout', this.onFocusOut, true)
      context.onDispose(() => {
        window.removeEventListener('keydown', this.onKeyDown)
        window.removeEventListener('pointerdown', this.onSecondaryPress, true)
        window.removeEventListener('pointerup', this.onSecondaryRelease, true)
        window.removeEventListener('contextmenu', this.onContextMenu, true)
        window.removeEventListener('blur', this.onFocusLost)
        window.removeEventListener('focusout', this.onFocusOut, true)
      })
    }
    context.onUpdate(frame => {
      solids.update()
      this.updateOverlay(frame)
    })
    context.onDispose(() => {
      this.exitMode()
      this.source?.setHiddenFeatureIds([])
      this.applyCursor(null)
      overlay.dispose()
      this.overlay = null
      solids.dispose()
      this.solids = null
      this.drapedLayer = null
      this.earth = null
    })
    this.mode.enter(this.modeContext)
    this.refresh()
    this.refreshDraped(null, true)
  }

  uninstall(): void {
    this.draped.dispose()
  }

  inspect(): unknown {
    return { mode: this.mode.name, features: this.store.size, solids: this.solids?.size ?? 0, live: [...this.liveIds], modeState: this.mode.inspect() }
  }

  // ---- Internals ----

  protected createModeContext(): DrawModeContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below read the installed earth lazily
    const draw = this
    return {
      get earth() {
        return draw.requireEarth()
      },
      store: this.store,
      get heights() {
        return draw.requireOverlay().heights
      },
      style: (feature, state) => this.styleOf(feature, state),
      createId: () => this.makeId(),
      project: (position, fallbackHeightMeters = 0) => this.overlay?.project(position[0], position[1], this.overlay.heights.heightAt(position[0], position[1], fallbackHeightMeters), { x: 0, y: 0 }) ?? null,
      projectAtHeight: (position, heightMeters) => this.overlay?.project(position[0], position[1], heightMeters, { x: 0, y: 0 }) ?? null,
      depthAtHeight: (position, heightMeters) => this.overlay?.depth(position[0], position[1], heightMeters) ?? null,
      viewVersion: () => this.viewVersionNumber,
      changed: () => this.refresh(),
      create: features => {
        this.store.set(features)
        this.dispatchEvent({ type: 'create', features })
        this.dispatchChange()
      },
      update: features => {
        this.store.set(features)
        this.dispatchEvent({ type: 'update', features })
        this.dispatchChange()
      },
      remove: ids => this.removeFeatures(ids),
      setCursor: cursor => this.applyCursor(cursor),
      holdDoubleClickZoom: () => {
        this.doubleClickZoomRelease ??= this.earth?.interactions.holdDoubleClickZoom() ?? null
      },
      releaseDoubleClickZoom: () => {
        this.doubleClickZoomRelease?.()
        this.doubleClickZoomRelease = null
      },
    }
  }

  protected requireEarth(): Earth {
    if (this.earth === null) throw new Error(`Draw "${this.name}": not installed. Add it with earth.addPlugin(draw) or <Earth plugins={[draw]}>.`)
    return this.earth
  }

  /** The features with string ids (a new one when missing) and properties. */
  protected withIds(features: DrawFeatureInput): DrawFeature[] {
    const list = 'features' in features ? features.features : features
    return list.map(feature => ({ ...feature, id: feature.id === undefined || feature.id === null ? this.makeId() : String(feature.id), properties: feature.properties ?? {} }) as DrawFeature)
  }

  protected requireOverlay(): LiveOverlay {
    if (this.overlay === null) throw new Error(`Draw "${this.name}": not installed. Add it with earth.addPlugin(draw) or <Earth plugins={[draw]}>.`)
    return this.overlay
  }

  /** Ends the press a mode took, telling it (`pointerCancel`). Its remaining moves and release go nowhere. */
  protected cancelPress(): void {
    const mode = this.pressMode
    this.pressMode = null
    mode?.pointerCancel()
  }

  protected exitMode(): void {
    this.cancelPress()
    this.mode.exit()
    this.doubleClickZoomRelease?.()
    this.doubleClickZoomRelease = null
    this.applyCursor(null)
  }

  protected applyCursor(cursor: string | null): void {
    const element = this.earth?.pointerEventsElement
    if (element === null || element === undefined) {
      this.cursor = cursor
      return
    }
    // Only undo a cursor this Draw set, so another tool's (or the layer events') stays.
    if (cursor === null) {
      if (this.cursor !== null && element.style.cursor === this.cursor) element.style.cursor = ''
    } else element.style.cursor = cursor
    this.cursor = cursor
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    const element = this.earth?.pointerEventsElement
    if (element === null || element === undefined || event.defaultPrevented) return
    const active = element.ownerDocument.activeElement
    if (active === null || !(active === element || element.contains(active))) return
    if (this.mode.keyDown(event)) event.preventDefault()
  }

  /** A right press on the map goes to the mode first (it cancels a keyboard move); taken, the camera never sees it. */
  protected onSecondaryPress = (event: PointerEvent): void => {
    // Any new press ends the swallowing of an earlier one's release and menu (which may never have come).
    this.swallowContextMenu = false
    const element = this.earth?.pointerEventsElement
    if (event.button !== 2 || element === null || element === undefined || !(event.target instanceof Node) || !element.contains(event.target)) return
    if (!this.mode.secondaryPress()) return
    // Its release and its context menu are the mode's too: the camera, the earth's events and the browser never see them.
    this.swallowContextMenu = true
    this.swallowContextMenuUntil = performance.now() + 1000
    event.stopPropagation()
    event.preventDefault()
  }

  protected onSecondaryRelease = (event: PointerEvent): void => {
    if (!this.swallowContextMenu || event.button !== 2) return
    if (performance.now() > this.swallowContextMenuUntil) {
      this.swallowContextMenu = false
      return
    }
    event.stopPropagation()
    event.preventDefault()
  }

  protected onContextMenu = (event: MouseEvent): void => {
    if (!this.swallowContextMenu) return
    this.swallowContextMenu = false
    if (performance.now() > this.swallowContextMenuUntil) return
    event.stopPropagation()
    event.preventDefault()
  }

  protected onFocusLost = (): void => this.mode.focusLost()

  /** Focus leaving the map for something outside it. */
  protected onFocusOut = (event: FocusEvent): void => {
    const element = this.earth?.pointerEventsElement
    if (element === null || element === undefined || !(event.target instanceof Node) || !element.contains(event.target)) return
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return
    this.mode.focusLost()
  }

  protected fromEarthEvent(event: EarthPointerEvent): DrawPointerEvent {
    return { screen: event.screen, get geographic() { return event.geographic }, pointerType: (event.originalEvent as PointerEvent).pointerType ?? 'mouse', originalEvent: event.originalEvent }
  }

  protected fromInteraction(event: PointerInteractionEvent): DrawPointerEvent {
    return { screen: event.screen, get geographic() { return event.geographic }, pointerType: event.pointerType, originalEvent: event.originalEvent }
  }

  protected onStoreChange = (change: FeatureStoreChange): void => {
    this.writeToSource(change)
    const changed = new Set<string>([...change.added, ...change.updated, ...change.removed.map(feature => feature.id)])
    this.refreshDraped(changed, false)
    this.refresh()
  }

  /**
   * The editable features of a source, as Draw features: the source's own objects where their id is a string and
   * there is no `promoteId`, shallow copies (sharing the geometry) otherwise. Gives features without an id one first.
   */
  protected featuresOfSource(source: GeoJsonSource): DrawFeature[] {
    const data = source.data
    if (typeof data === 'string') {
      throw new Error(`Draw.setSource: GeoJsonSource "${source.id}" loads its data from a URL; fetch the GeoJSON in the app and pass the object as its \`data\`, then edit it.`)
    }
    const promoteId = source.toSpecification().promoteId
    let list: readonly Feature[] = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : []
    if (data.type !== 'FeatureCollection' && data.type !== 'Feature') {
      throw new Error(`Draw.setSource: GeoJsonSource "${source.id}" holds a bare ${data.type} geometry; give it a Feature or a FeatureCollection to edit.`)
    }
    const keyOf = (feature: Feature): unknown => (promoteId === undefined ? feature.id : feature.properties?.[promoteId])
    const hasKey = (feature: Feature) => {
      const key = keyOf(feature)
      return typeof key === 'string' || typeof key === 'number'
    }
    if (!list.every(hasKey)) {
      // Once, so every feature can be updated by id from now on.
      list = list.map(feature => {
        if (hasKey(feature)) return feature
        const id = this.makeId()
        return promoteId === undefined ? { ...feature, id } : { ...feature, properties: { ...feature.properties, [promoteId]: id } }
      })
      source.setData({ type: 'FeatureCollection', features: [...list] })
    }
    this.sourcePromoteId = promoteId
    this.sourceKeys.clear()
    const features: DrawFeature[] = []
    for (const feature of list) {
      const key = keyOf(feature) as GeoJsonFeatureId
      const id = String(key)
      const own = promoteId === undefined && typeof key === 'string' && feature.properties !== null && feature.properties !== undefined
      const drawFeature = (own ? feature : { ...feature, id, properties: feature.properties ?? {} }) as DrawFeature
      if (!isDrawableFeature(drawFeature)) continue
      if (!own) this.sourceKeys.set(id, { key, featureId: feature.id })
      features.push(drawFeature)
    }
    return features
  }

  /** The id the source knows a Draw feature by. */
  protected sourceKey(id: string): GeoJsonFeatureId {
    return this.sourceKeys.get(id)?.key ?? id
  }

  /** A Draw feature as the source holds it: its own id (a number, or none with `promoteId`) and the promoted property. */
  protected toSourceFeature(feature: DrawFeature): Feature {
    const promoteId = this.sourcePromoteId
    if (promoteId === undefined) {
      const entry = this.sourceKeys.get(feature.id)
      return entry === undefined ? feature : { ...feature, id: entry.key }
    }
    let entry = this.sourceKeys.get(feature.id)
    if (entry === undefined) {
      // New: the source finds it by the promoted property.
      entry = { key: feature.id, featureId: undefined }
      this.sourceKeys.set(feature.id, entry)
    }
    const { id: _drawId, ...rest } = feature
    const properties = rest.properties?.[promoteId] === entry.key ? rest.properties : { ...rest.properties, [promoteId]: entry.key }
    return entry.featureId === undefined ? { ...rest, properties } : { ...rest, id: entry.featureId, properties }
  }

  /** Writes a store change to the edited source, as one `updateData`. */
  protected writeToSource(change: FeatureStoreChange): void {
    const source = this.source
    if (source === null || this.fillingFromSource) return
    const remove = change.removed.map(feature => this.sourceKey(feature.id))
    for (const feature of change.removed) this.sourceKeys.delete(feature.id)
    const add: Feature[] = []
    for (const id of [...change.added, ...change.updated]) {
      const feature = this.store.get(id)
      if (feature !== undefined) add.push(this.toSourceFeature(feature))
    }
    if (remove.length > 0 || add.length > 0) source.updateData({ ...(remove.length > 0 ? { remove } : {}), ...(add.length > 0 ? { add } : {}) })
  }

  protected dispatchChange(): void {
    this.dispatchEvent({ type: 'change', features: this.store.toFeatureCollection() })
  }

  /**
   * Hands the draped layer the features not drawn live, and redraws the regions where `changed` features were and are
   * (every region with `all`).
   */
  protected refreshDraped(changed: Set<string> | null, all: boolean): void {
    const live = new Set(this.mode.liveFeatureIds())
    const touched = new Set(changed ?? [])
    // Features entering or leaving the live overlay redraw where they are.
    for (const id of live) if (!this.liveIds.has(id)) touched.add(id)
    for (const id of this.liveIds) if (!live.has(id)) touched.add(id)
    this.liveIds = live
    const source = this.source
    if (source !== null) {
      // The source's layers draw its features; the ones edited live are drawn by the overlay, hidden from its tiles.
      source.setHiddenFeatureIds([...live].filter(id => this.store.has(id)).map(id => this.sourceKey(id)))
      if (this.drapedBounds.size > 0 || all) {
        this.solids?.setFeatures([])
        this.draped.setFeatures([])
        this.drapedBounds = new Map()
        this.drapedLayer?.invalidate()
      }
      return
    }
    const entries: Array<{ feature: DrawFeature; style: DrawStyle }> = []
    const solidEntries: Array<{ feature: DrawFeature; style: DrawStyle }> = []
    const bounds = new Map<string, GeographicBounds>()
    for (const feature of this.store.values()) {
      if (live.has(feature.id)) continue
      const style = this.styleOf(feature, { selected: false, drawing: false })
      // 3D features stand in the scene; the rest drape on the terrain.
      if (isSolidFeature(feature)) {
        solidEntries.push({ feature, style })
        continue
      }
      entries.push({ feature, style })
      bounds.set(feature.id, geometryBounds(feature.geometry))
    }
    this.solids?.setFeatures(solidEntries)
    let dirty: GeographicBounds | null = null
    for (const id of touched) dirty = unionBounds(unionBounds(dirty, this.drapedBounds.get(id) ?? null), bounds.get(id) ?? null)
    this.drapedBounds = bounds
    this.draped.setFeatures(entries)
    if (all) this.drapedLayer?.invalidate()
    else if (dirty !== null) this.drapedLayer?.invalidate(padBounds(dirty, INVALIDATE_PADDING_FRACTION, INVALIDATE_PADDING_DEGREES))
  }

  /** Recomputes the state and redraws the overlay after a mode or the store changed. */
  protected refresh(): void {
    // The mode may have taken features live or let them go.
    const live = this.mode.liveFeatureIds()
    if (live.length !== this.liveIds.size || live.some(id => !this.liveIds.has(id))) this.refreshDraped(null, false)
    this.overlayDirty = true
    this.earth?.requestFrame()
    const next = this.computeState()
    if (shallowEqual(next, this.state)) return
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }

  protected computeState(): DrawState {
    const status = this.mode.status()
    return {
      mode: this.mode.name,
      modes: this.modeNames(),
      features: this.store.toFeatureCollection(),
      selectedIds: this.mode.selectedFeatureIds(),
      ...status,
      editingVertices: status.editingVertices ?? false,
      elementMode: status.elementMode ?? [...this.modes.values()].find((each): each is SelectMode => each instanceof SelectMode)?.elementMode ?? 'vertex',
      canExtrude: status.canExtrude ?? false,
      pickedElementCount: status.pickedElementCount ?? 0,
      gizmoTool: this.gizmoTool,
      gizmoSpace: this.gizmoSpace,
    }
  }

  protected cachedModeNames: readonly string[] = []

  protected modeNames(): readonly string[] {
    const names = [...this.modes.keys()]
    if (names.length !== this.cachedModeNames.length || names.some((name, index) => name !== this.cachedModeNames[index])) this.cachedModeNames = names
    return this.cachedModeNames
  }

  /** Redraws the overlay when the camera, the morph or the content changed. */
  protected updateOverlay({ camera, morph }: PluginFrame): boolean {
    this.draped.startFrame()
    const overlay = this.overlay
    if (overlay === null) return false
    camera.updateMatrixWorld()
    const moved = !this.lastCameraMatrix.equals(camera.matrixWorld) || !this.lastProjectionMatrix.equals(camera.projectionMatrix) || morph !== this.lastMorph
    if (!moved && !this.overlayDirty) return false
    this.lastCameraMatrix.copy(camera.matrixWorld)
    this.lastProjectionMatrix.copy(camera.projectionMatrix)
    this.lastMorph = morph
    this.viewVersionNumber++
    this.overlayDirty = false
    const content: OverlayContent = { features: [], lines: [], handles: [], polygons: [] }
    // The mode measures the screen with this frame's camera (the gizmo's size in metres).
    overlay.prepare(camera)
    // The mode samples terrain too (a shape's base on the ground): with this frame's budget, and drawn again until
    // every height it asked for is known.
    overlay.heights.startFrame()
    this.mode.overlay(content)
    const modePending = overlay.heights.pending
    // Solids the mode draws live (dragged, transformed) stay 3D: previews in the scene rather than flat in the overlay.
    const previews = content.features.filter(entry => isSolidFeature(entry.feature))
    if (previews.length > 0) content.features = content.features.filter(entry => !isSolidFeature(entry.feature))
    this.solids?.setPreviews(previews)
    const pending = overlay.draw(camera, content) || modePending
    if (pending) this.overlayDirty = true
    return pending
  }
}

function shallowEqual(a: object, b: object): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  return true
}
