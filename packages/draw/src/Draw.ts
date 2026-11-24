import type { FeatureCollection } from 'geojson'
import {
  PLUGIN_API_VERSION,
  type DrapedLayerHandle,
  type Earth,
  type EarthPlugin,
  type EarthPointerEvent,
  type GeographicBounds,
  type PluginContext,
  type PluginFrame,
  type PointerInteractionEvent,
} from 'react-three-earth'
import { EventDispatcher, Matrix4 } from 'three'

import { createFeatureId, FeatureStore, type FeatureStoreChange } from './FeatureStore.js'
import { geometryBounds, padBounds, unionBounds } from './geometry.js'
import { DrawMode, StaticMode, type DrawModeContext, type DrawModeStatus } from './modes/DrawMode.js'
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
  /** The modes `setMode` can switch to. Default: static, point, linestring, polygon, circle, rectangle and sphere. */
  modes?: DrawMode[]
  /** The mode to start in. Default: 'static'. */
  mode?: string
  /** How features look. Default: blue fills, lines and points, white vertex handles. */
  style?: DrawStyleInput
  /** Features to start with. */
  features?: DrawFeatureInput
  /** Escape, Enter and Backspace act on the mode while the map has focus. Default: true. */
  keyboard?: boolean
  /** Makes the id of each new feature. Default: a random UUID. */
  createId?: () => string
}

/** What `getState()` returns: a new object on each change, so it can be compared by identity. */
export interface DrawState extends DrawModeStatus {
  /** The active mode's name. */
  mode: string
  /** Every mode `setMode` takes. */
  modes: readonly string[]
  /** Every finished feature, as GeoJSON. */
  features: FeatureCollection<DrawGeometry>
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
 * Headless drawing on the globe and the flat map, as a react-three-earth plugin: points, line strings and polygons,
 * output as GeoJSON. It draws the features (draped on the terrain, styled by `style`) and the handles of the feature in
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
  protected readonly keyboard: boolean
  protected readonly makeId: () => string
  protected readonly listeners = new Set<DrawStateListener>()
  protected state: DrawState
  protected earth: Earth | null = null
  protected overlay: LiveOverlay | null = null
  protected readonly draped = new DrapedFeatures()
  protected drapedLayer: DrapedLayerHandle | null = null
  /** 3D features (extruded, spheres, at an altitude), drawn as solids in the scene rather than draped. */
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

  constructor({ name = 'draw', modes, mode = 'static', style, features, keyboard = true, createId = createFeatureId }: DrawOptions = {}) {
    super()
    this.name = name
    this.styleInput = style
    this.keyboard = keyboard
    this.makeId = createId
    for (const each of modes ?? [new StaticMode(), new PointMode(), new LineStringMode(), new PolygonMode(), new CircleMode(), new RectangleMode(), new SphereMode()]) {
      if (this.modes.has(each.name)) throw new Error(`Draw: two modes are named "${each.name}"; give each mode a unique name.`)
      this.modes.set(each.name, each)
    }
    const first = this.modes.get(mode)
    if (first === undefined) throw new Error(`Draw: no mode named "${mode}"; pick one of ${[...this.modes.keys()].join(', ')}, or add it to \`modes\`.`)
    this.mode = first
    this.modeContext = this.createModeContext()
    if (features !== undefined) this.store.replace(this.withIds(features))
    this.store.subscribe(this.onStoreChange)
    this.state = this.computeState()
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

  /** Removes the last vertex of the feature being drawn. */
  undo(): void {
    this.mode.undo()
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
      context.onDispose(() => window.removeEventListener('keydown', this.onKeyDown))
    }
    context.onUpdate(frame => this.updateOverlay(frame))
    context.onDispose(() => {
      this.exitMode()
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
      project: position => this.overlay?.project(position[0], position[1], this.overlay.heights.heightAt(position[0], position[1]), { x: 0, y: 0 }) ?? null,
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
      setCursor: cursor => this.applyCursor(cursor),
      holdDoubleClickZoom: () => {
        this.doubleClickZoomRelease ??= this.earth?.interactions.holdDoubleClickZoom() ?? null
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

  protected fromEarthEvent(event: EarthPointerEvent): DrawPointerEvent {
    return { screen: event.screen, get geographic() { return event.geographic }, pointerType: (event.originalEvent as PointerEvent).pointerType ?? 'mouse', originalEvent: event.originalEvent }
  }

  protected fromInteraction(event: PointerInteractionEvent): DrawPointerEvent {
    return { screen: event.screen, get geographic() { return event.geographic }, pointerType: event.pointerType, originalEvent: event.originalEvent }
  }

  protected onStoreChange = (change: FeatureStoreChange): void => {
    const changed = new Set<string>([...change.added, ...change.updated, ...change.removed.map(feature => feature.id)])
    this.refreshDraped(changed, false)
    this.refresh()
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
    return { mode: this.mode.name, modes: this.modeNames(), features: this.store.toFeatureCollection(), ...this.mode.status() }
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
    // Solids on the ground follow the terrain's height as it loads.
    if (this.solids?.update() === true) this.earth?.requestFrame()
    const overlay = this.overlay
    if (overlay === null) return false
    camera.updateMatrixWorld()
    const moved = !this.lastCameraMatrix.equals(camera.matrixWorld) || !this.lastProjectionMatrix.equals(camera.projectionMatrix) || morph !== this.lastMorph
    if (!moved && !this.overlayDirty) return false
    this.lastCameraMatrix.copy(camera.matrixWorld)
    this.lastProjectionMatrix.copy(camera.projectionMatrix)
    this.lastMorph = morph
    this.overlayDirty = false
    const content: OverlayContent = { features: [], lines: [], handles: [] }
    this.mode.overlay(content)
    const pending = overlay.draw(camera, content)
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
