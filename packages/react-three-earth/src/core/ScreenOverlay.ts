import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Raycaster, Vector3, type Camera, type Intersection } from 'three'

import { holdContainerPosition, releaseContainerPosition } from './containerPosition.js'
import type { Earth } from './Earth.js'
import { headingAndPitch, isOccludedByEllipsoid, type ScreenPosition } from './projection.js'

/**
 * Whether a marker shows. `'visible'`; `'occluded'` behind terrain (drawn at `occludedOpacity`); `'hidden'`
 * behind the globe's horizon or the camera, or before the first frame.
 */
export type ScreenVisibility = 'visible' | 'occluded' | 'hidden'

/** What every marker and popup reads in a frame, computed once by `ScreenOverlay`. */
export interface ScreenOverlayFrame {
  earth: Earth
  camera: Camera
  cameraPosition: Vector3
  /** The camera's forward and up directions, in the scene. */
  cameraForward: Vector3
  cameraUp: Vector3
  widthPixels: number
  heightPixels: number
  /** True when markers sit on the flat map rather than the globe (the morph is past half way). */
  onFlatMap: boolean
  /** `performance.now()` for this frame. */
  timeMilliseconds: number
  /** Terrain raycasts left this frame, shared by every marker on the earth. Take one with `takeRaycast`. */
  raycastsLeft: number
  /**
   * Goes up whenever terrain checks may give a new answer: the camera moved, the view morphed, or terrain tiles
   * loaded. A marker checked at the current version needs no new check.
   */
  sceneVersion: number
  /**
   * Set by an item whose terrain check is stale but had to wait: the overlay asks for a frame this many
   * milliseconds later (0 when only the budget was short). Infinity when nothing waits.
   */
  followUpDelayMilliseconds: number
}

/** When an item last read the terrain: see `startTerrainCheck`. */
export interface TerrainCheckState {
  lastCheckMilliseconds: number
  lastCheckSceneVersion: number
}

/** A state that checks on the next frame with budget: for a new item, or one that moved. */
export function staleTerrainCheck(): TerrainCheckState {
  return { lastCheckMilliseconds: -Infinity, lastCheckSceneVersion: -1 }
}

/** Something drawn over the canvas at a place on the earth, updated once per frame by `ScreenOverlay`. */
export interface ScreenOverlayItem {
  /** Places the item for this frame. Markers update before popups, which may follow a marker. */
  updateScreen(frame: ScreenOverlayFrame): void
}

/** Terrain raycasts per frame, for every marker of an earth together. Each samples the loaded tiles. */
export const TERRAIN_RAYCASTS_PER_FRAME = 4

const overlays = new WeakMap<Earth, ScreenOverlay>()

/** Milliseconds between two terrain checks of one item, and the delay of a follow-up frame. */
export const TERRAIN_CHECK_INTERVAL_MILLISECONDS = 250

/**
 * Updates the markers and popups of one `Earth` at the end of each `earth.update`, once the camera is final
 * for the frame about to be drawn, so they never lag behind the map. Shares per-frame work (camera vectors, the
 * terrain raycast budget) between them. `Marker` and `Popup` register themselves; apps rarely touch it.
 */
export class ScreenOverlay {
  protected readonly markers: ScreenOverlayItem[] = []
  protected readonly popups: ScreenOverlayItem[] = []
  protected readonly frame: ScreenOverlayFrame
  protected readonly onUpdate = () => this.update()
  /** The marker served first next frame: the one after the last that got a raycast, so all get their turn. */
  protected cursor = 0
  protected readonly lastCameraMatrix = new Float64Array(16)
  protected terrainWasLoading = false
  protected lastTerrainTileCount = -1
  protected lastTerrainExaggeration = 1
  protected followUpTimer: ReturnType<typeof setTimeout> | null = null

  /** The overlay of an earth, created on first use. */
  static of(earth: Earth): ScreenOverlay {
    let overlay = overlays.get(earth)
    if (overlay === undefined) {
      overlay = new ScreenOverlay(earth)
      overlays.set(earth, overlay)
    }
    return overlay
  }

  constructor(protected readonly earth: Earth) {
    this.frame = {
      earth,
      camera: null as unknown as Camera,
      cameraPosition: new Vector3(),
      cameraForward: new Vector3(),
      cameraUp: new Vector3(),
      widthPixels: 0,
      heightPixels: 0,
      onFlatMap: false,
      timeMilliseconds: 0,
      raycastsLeft: 0,
      sceneVersion: 0,
      followUpDelayMilliseconds: Infinity,
    }
  }

  add(item: ScreenOverlayItem, kind: 'marker' | 'popup'): void {
    const list = kind === 'marker' ? this.markers : this.popups
    if (list.includes(item)) return
    if (this.markers.length + this.popups.length === 0) this.earth.addEventListener('update', this.onUpdate)
    list.push(item)
    // Placed at once when the earth has drawn a frame, so a marker added between frames shows in place; its
    // terrain checks wait for the next frame's budget, which it asks for.
    this.refresh(item)
    this.earth.requestFrame()
  }

  delete(item: ScreenOverlayItem): void {
    const list = this.markers.includes(item) ? this.markers : this.popups
    const index = list.indexOf(item)
    if (index === -1) return
    list.splice(index, 1)
    if (this.markers.length + this.popups.length > 0) return
    this.earth.removeEventListener('update', this.onUpdate)
    if (this.followUpTimer !== null) clearTimeout(this.followUpTimer)
    this.followUpTimer = null
  }

  /** Places one item now, from the last frame's camera. False before the earth's first `update`. */
  refresh(item: ScreenOverlayItem): boolean {
    if (!this.prepareFrame()) return false
    // Between frames there is no raycast budget: terrain checks wait for the next frame.
    this.frame.raycastsLeft = 0
    item.updateScreen(this.frame)
    return true
  }

  /** Places every marker, then every popup. Called for you at the end of every `earth.update`. */
  update(): void {
    const frame = this.frame
    if (!this.prepareFrame()) return
    this.updateSceneVersion()
    frame.raycastsLeft = TERRAIN_RAYCASTS_PER_FRAME
    frame.followUpDelayMilliseconds = Infinity
    // Round robin: start where the budget ran out last frame, so every marker gets its checks however many there are.
    const count = this.markers.length
    const start = count === 0 ? 0 : this.cursor % count
    let next = -1
    for (let offset = 0; offset < count; offset++) {
      const index = (start + offset) % count
      this.markers[index]!.updateScreen(frame)
      if (next === -1 && frame.raycastsLeft === 0) next = (index + 1) % count
    }
    if (next !== -1) this.cursor = next
    // Popups are few: they always get a raycast of their own.
    frame.raycastsLeft = Math.max(frame.raycastsLeft, 1)
    for (const popup of this.popups) popup.updateScreen(frame)
    // With on-demand rendering no frame may come: ask for one when a stale check had to wait.
    if (frame.followUpDelayMilliseconds !== Infinity && this.followUpTimer === null) {
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = null
        this.earth.requestFrame()
      }, frame.followUpDelayMilliseconds)
    }
  }

  /**
   * Bumps `sceneVersion` when the camera moved, the view morphs, or the terrain's tiles changed (loaded, shown,
   * or loading started or ended). Not on every frame a download is pending: nothing changed for a raycast then.
   */
  protected updateSceneVersion(): void {
    const elements = this.frame.camera.matrixWorld.elements
    let changed = false
    for (let index = 0; index < 16; index++) {
      if (elements[index] !== this.lastCameraMatrix[index]) changed = true
      this.lastCameraMatrix[index] = elements[index]!
    }
    const terrain = this.earth.terrain
    const loading = terrain?.loading === true
    // Runtime fields 3DTilesRenderer's typings leave out.
    const tiles = terrain?.tiles as { stats?: { loaded?: number }; visibleTiles?: Set<unknown> } | undefined
    const tileCount = (tiles?.stats?.loaded ?? 0) * 100_003 + (tiles?.visibleTiles?.size ?? 0)
    const exaggeration = terrain?.exaggeration ?? 1
    const tilesChanged = tileCount !== this.lastTerrainTileCount || loading !== this.terrainWasLoading || exaggeration !== this.lastTerrainExaggeration
    this.lastTerrainExaggeration = exaggeration
    if (changed || tilesChanged || this.earth.view.transitioning) this.frame.sceneVersion++
    this.terrainWasLoading = loading
    this.lastTerrainTileCount = tileCount
  }

  protected prepareFrame(): boolean {
    const earthCamera = this.earth.camera
    if (!earthCamera.ready) return false
    const camera = earthCamera.camera!
    camera.updateMatrixWorld()
    const frame = this.frame
    frame.camera = camera
    frame.cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    frame.cameraForward.set(0, 0, -1).transformDirection(camera.matrixWorld)
    frame.cameraUp.set(0, 1, 0).transformDirection(camera.matrixWorld)
    frame.widthPixels = earthCamera.viewportWidthPixels
    frame.heightPixels = earthCamera.viewportHeightPixels
    frame.onFlatMap = earthCamera.onFlatMap
    frame.timeMilliseconds = performance.now()
    return true
  }
}

/**
 * True when an item should read the terrain now: its last check is older than the scene and the interval, and
 * the frame's budget has a raycast left (taken). When the check is stale but must wait, asks for a follow-up
 * frame, so the answer settles after the camera stops even with on-demand rendering.
 */
export function startTerrainCheck(frame: ScreenOverlayFrame, state: TerrainCheckState, intervalMilliseconds = TERRAIN_CHECK_INTERVAL_MILLISECONDS): boolean {
  if (state.lastCheckSceneVersion === frame.sceneVersion) return false
  const waitMilliseconds = intervalMilliseconds - (frame.timeMilliseconds - state.lastCheckMilliseconds)
  if (waitMilliseconds > 0) {
    frame.followUpDelayMilliseconds = Math.min(frame.followUpDelayMilliseconds, waitMilliseconds)
    return false
  }
  // Out of budget: the next frame serves the next markers in turn, at once.
  if (!takeRaycast(frame)) {
    frame.followUpDelayMilliseconds = 0
    return false
  }
  state.lastCheckMilliseconds = frame.timeMilliseconds
  state.lastCheckSceneVersion = frame.sceneVersion
  return true
}

/** Takes one terrain raycast from the frame's budget. False when the budget is spent: try next frame. */
export function takeRaycast(frame: ScreenOverlayFrame): boolean {
  if (frame.raycastsLeft <= 0) return false
  frame.raycastsLeft--
  return true
}

const viewPoint = new Vector3()

/**
 * Screen position of a scene point in CSS pixels (written to `target`, not rounded), and whether it is in
 * front of the camera.
 */
export function sceneToScreen(frame: ScreenOverlayFrame, point: Vector3, target: ScreenPosition): boolean {
  const camera = frame.camera
  viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse)
  const inFront = viewPoint.z < 0
  viewPoint.applyMatrix4(camera.projectionMatrix)
  target.xPixels = ((viewPoint.x + 1) / 2) * frame.widthPixels
  target.yPixels = ((1 - viewPoint.y) / 2) * frame.heightPixels
  return inFront
}

/** True when the globe hides a scene point: behind the horizon. Never on the flat map. */
export function isBehindHorizon(frame: ScreenOverlayFrame, point: Vector3): boolean {
  return !frame.onFlatMap && isOccludedByEllipsoid(frame.cameraPosition, point)
}

const raycaster = new Raycaster()
const hits: Intersection[] = []
const toPoint = new Vector3()

/**
 * True when loaded terrain lies between the camera and a scene point, more than `toleranceMeters` before it
 * (the point's own ground must not hide it). Only on the globe at rest: on the flat map the tiles are moved
 * on the GPU, so their meshes do not match what is drawn.
 */
export function isBehindTerrain(frame: ScreenOverlayFrame, point: Vector3, toleranceMeters: number): boolean {
  const terrain = frame.earth.terrain
  if (terrain === null || frame.earth.view.morph !== 0) return false
  toPoint.subVectors(point, frame.cameraPosition)
  const distance = toPoint.length()
  if (distance <= toleranceMeters) return false
  raycaster.ray.set(frame.cameraPosition, toPoint.divideScalar(distance))
  raycaster.near = 0
  raycaster.far = distance - toleranceMeters
  hits.length = 0
  raycaster.intersectObject(terrain.object, true, hits)
  const hidden = hits.length > 0
  hits.length = 0
  return hidden
}

const east = new Vector3()
const north = new Vector3()
const up = new Vector3()

/**
 * The camera's heading and pitch, in degrees, in the local frame at a position: on the globe its east-north-up
 * axes, on the flat map the map's own.
 */
export function localHeadingAndPitch(frame: ScreenOverlayFrame, longitudeDegrees: number, latitudeDegrees: number): { headingDegrees: number; pitchDegrees: number } {
  const view = frame.earth.view
  if (frame.onFlatMap) {
    east.setFromMatrixColumn(view.anchorFrame, 0)
    north.setFromMatrixColumn(view.anchorFrame, 1)
    up.copy(view.anchorUp)
  } else {
    WGS84_ELLIPSOID.getEastNorthUpAxes(MathUtils.degToRad(latitudeDegrees), MathUtils.degToRad(longitudeDegrees), east, north, up)
  }
  const { headingRadians, pitchRadians } = headingAndPitch(frame.cameraForward, frame.cameraUp, east, north, up)
  return { headingDegrees: MathUtils.radToDeg(headingRadians), pitchDegrees: MathUtils.radToDeg(pitchRadians) }
}

// --- The DOM layer over the canvas, shared by the markers and popups of a container -----------------------

const STYLE_ELEMENT_ATTRIBUTE = 'data-earthkit-styles'
/** On the layer while its earth was made with `defaultOverlayStyles: false`: the built-in look stays off. */
const UNSTYLED_ATTRIBUTE = 'data-earthkit-unstyled'
/** The built-in look applies inside a layer without the unstyled attribute. `:where` keeps its specificity at zero. */
const THEMED = `:where([data-earthkit-markers]:not([${UNSTYLED_ATTRIBUTE}]))`
const layers = new WeakMap<HTMLElement, { element: HTMLElement; users: number }>()

/**
 * The CSS, injected once per document, in two parts.
 *
 * What places markers and popups, always on, found by data attributes (`data-earthkit-markers`,
 * `-marker`, `-popup`) so app class names never clash with it.
 *
 * The built-in look, off with `defaultOverlayStyles: false`, on classes (`:where` keeps the scope out of their
 * specificity). Restyle through the classes or CSS variables:
 * `--earthkit-marker-color` (the default pin), `--earthkit-popup-background`, `-color`, `-shadow`, `-radius`,
 * `-padding`, `-font`.
 */
const STYLE = `
[data-earthkit-markers] {
  position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none;
}
[data-earthkit-marker] {
  position: absolute; left: 0; top: 0; pointer-events: auto; will-change: transform; cursor: pointer;
}
[data-earthkit-marker][data-visibility="hidden"], [data-earthkit-popup][data-visibility="hidden"] { visibility: hidden; }
[data-earthkit-marker][data-draggable] { cursor: grab; touch-action: none; }
[data-earthkit-marker][data-dragging] { cursor: grabbing; }
.earthkit-marker-pin {
  appearance: none; box-sizing: border-box; display: block; width: 27px; height: 41px; margin: 0; padding: 0;
  border: 0; background: none; font: inherit; cursor: inherit; color: var(--earthkit-marker-color, #3fb1ce);
}
.earthkit-marker-pin svg, .earthkit-marker-fallback-pin svg { display: block; width: 100%; height: 100%; }
/* The pin a React <Marker> shows while it has no content of its own (popups render nothing in it). */
.earthkit-marker-fallback-pin { display: block; width: 27px; height: 41px; color: var(--earthkit-marker-color, #3fb1ce); }
.earthkit-marker-fallback-pin:not(:only-child) { display: none; }
[data-earthkit-popup] {
  position: absolute; left: 0; top: 0; z-index: 3; display: flex; pointer-events: auto; will-change: transform;
}
[data-earthkit-popup][data-tracking-pointer] { pointer-events: none; }
[data-earthkit-popup][data-anchor="bottom"], [data-earthkit-popup][data-anchor^="bottom-"] { flex-direction: column-reverse; }
[data-earthkit-popup][data-anchor="top"], [data-earthkit-popup][data-anchor^="top-"] { flex-direction: column; }
[data-earthkit-popup][data-anchor="left"] { flex-direction: row; }
[data-earthkit-popup][data-anchor="right"] { flex-direction: row-reverse; }

${THEMED} .earthkit-marker:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; border-radius: 2px; }
${THEMED} .earthkit-popup {
  font: var(--earthkit-popup-font, 13px / 1.4 system-ui, sans-serif);
  color: var(--earthkit-popup-color, #222);
}
${THEMED} .earthkit-popup-content {
  position: relative; box-sizing: border-box; min-width: 0; max-width: 100%;
  padding: var(--earthkit-popup-padding, 10px 12px);
  background: var(--earthkit-popup-background, #fff);
  border-radius: var(--earthkit-popup-radius, 6px);
  box-shadow: var(--earthkit-popup-shadow, 0 1px 4px rgba(0, 0, 0, 0.3));
}
/* Focused only to bring screen readers into the popup: no ring around the whole box. */
${THEMED} .earthkit-popup-content:focus { outline: none; }
${THEMED} .earthkit-popup[data-close-button] .earthkit-popup-content { padding-right: 28px; }
${THEMED} .earthkit-popup-close {
  all: unset; position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; line-height: 1;
}
${THEMED} .earthkit-popup-close:hover { background: rgba(0, 0, 0, 0.06); }
${THEMED} .earthkit-popup-close:focus-visible { outline: 2px solid #1a73e8; }
${THEMED} .earthkit-popup-tip { width: 0; height: 0; border: 8px solid transparent; z-index: 1; align-self: center; }
${THEMED} .earthkit-popup[data-anchor="center"] .earthkit-popup-tip { display: none; }
${THEMED} .earthkit-popup[data-anchor^="bottom"] .earthkit-popup-tip { border-bottom: none; border-top-color: var(--earthkit-popup-background, #fff); }
${THEMED} .earthkit-popup[data-anchor^="top"] .earthkit-popup-tip { border-top: none; border-bottom-color: var(--earthkit-popup-background, #fff); }
${THEMED} .earthkit-popup[data-anchor="left"] .earthkit-popup-tip { border-left: none; border-right-color: var(--earthkit-popup-background, #fff); }
${THEMED} .earthkit-popup[data-anchor="right"] .earthkit-popup-tip { border-right: none; border-left-color: var(--earthkit-popup-background, #fff); }
${THEMED} .earthkit-popup[data-anchor$="-left"] .earthkit-popup-tip { align-self: flex-start; }
${THEMED} .earthkit-popup[data-anchor$="-right"] .earthkit-popup-tip { align-self: flex-end; }
${THEMED} .earthkit-popup[data-anchor="top-left"] .earthkit-popup-content { border-top-left-radius: 0; }
${THEMED} .earthkit-popup[data-anchor="top-right"] .earthkit-popup-content { border-top-right-radius: 0; }
${THEMED} .earthkit-popup[data-anchor="bottom-left"] .earthkit-popup-content { border-bottom-left-radius: 0; }
${THEMED} .earthkit-popup[data-anchor="bottom-right"] .earthkit-popup-content { border-bottom-right-radius: 0; }
`

function ensureStyle(document: Document): void {
  if (document.head.querySelector(`style[${STYLE_ELEMENT_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_ELEMENT_ATTRIBUTE, '')
  style.textContent = STYLE
  document.head.append(style)
}

export interface ScreenLayerOptions {
  /**
   * Whether the markers and popups in the layer get the built-in look (pass `earth.defaultOverlayStyles`). The last
   * call for a container sets it. Default: true.
   */
  defaultStyles?: boolean
}

/**
 * The layer markers and popups go in, filling `container` above the canvas (and below the attribution).
 * Shared by everything in the container; give it back with `releaseScreenLayer`. The container is made
 * `position: relative` while it is static.
 */
export function acquireScreenLayer(container: HTMLElement, { defaultStyles = true }: ScreenLayerOptions = {}): HTMLElement {
  const existing = layers.get(container)
  if (existing !== undefined) {
    existing.users++
    existing.element.toggleAttribute(UNSTYLED_ATTRIBUTE, !defaultStyles)
    return existing.element
  }
  const document = container.ownerDocument
  ensureStyle(document)
  holdContainerPosition(container)
  const element = document.createElement('div')
  element.setAttribute('data-earthkit-markers', '')
  element.toggleAttribute(UNSTYLED_ATTRIBUTE, !defaultStyles)
  container.append(element)
  layers.set(container, { element, users: 1 })
  return element
}

/** Gives back a layer from `acquireScreenLayer`; the last user removes it. */
export function releaseScreenLayer(container: HTMLElement): void {
  const layer = layers.get(container)
  if (layer === undefined) return
  if (--layer.users > 0) return
  layer.element.remove()
  layers.delete(container)
  releaseContainerPosition(container)
}
