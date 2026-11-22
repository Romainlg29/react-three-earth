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
  /** Set by an item whose terrain check is stale but had to wait: the overlay asks for a later frame. */
  followUpNeeded: boolean
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
      followUpNeeded: false,
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
    frame.followUpNeeded = false
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
    if (frame.followUpNeeded && this.followUpTimer === null) {
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = null
        this.earth.requestFrame()
      }, TERRAIN_CHECK_INTERVAL_MILLISECONDS)
    }
  }

  /** Bumps `sceneVersion` when the camera moved, the view morphs, or terrain is loading or just finished. */
  protected updateSceneVersion(): void {
    const elements = this.frame.camera.matrixWorld.elements
    let changed = false
    for (let index = 0; index < 16; index++) {
      if (elements[index] !== this.lastCameraMatrix[index]) changed = true
      this.lastCameraMatrix[index] = elements[index]!
    }
    const loading = this.earth.terrain?.loading === true
    const view = this.earth.view
    if (changed || loading || this.terrainWasLoading || view.transitioning) this.frame.sceneVersion++
    this.terrainWasLoading = loading
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
  if (frame.timeMilliseconds - state.lastCheckMilliseconds < intervalMilliseconds || !takeRaycast(frame)) {
    frame.followUpNeeded = true
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

const STYLE_ELEMENT_ATTRIBUTE = 'data-react-three-earth-markers-style'
const layers = new WeakMap<HTMLElement, { element: HTMLElement; users: number }>()

/**
 * The CSS, injected once per document. Restyle through CSS variables, or override the classes:
 * `--react-three-earth-marker-color` (the default pin), `--react-three-earth-popup-background`, `-color`,
 * `-shadow`, `-radius`, `-padding`, `-font`.
 */
const STYLE = `
.react-three-earth-markers {
  position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none;
}
.react-three-earth-marker {
  position: absolute; left: 0; top: 0; pointer-events: auto; will-change: transform; cursor: pointer;
}
.react-three-earth-marker[data-visibility="hidden"], .react-three-earth-popup[data-visibility="hidden"] { visibility: hidden; }
.react-three-earth-marker[data-draggable] { cursor: grab; touch-action: none; }
.react-three-earth-marker[data-dragging] { cursor: grabbing; }
.react-three-earth-marker:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; border-radius: 2px; }
.react-three-earth-marker-pin {
  appearance: none; box-sizing: border-box; display: block; width: 27px; height: 41px; margin: 0; padding: 0;
  border: 0; background: none; font: inherit; cursor: inherit;
  color: var(--react-three-earth-marker-color, #3fb1ce);
}
.react-three-earth-marker-pin svg, .react-three-earth-marker-fallback-pin svg { display: block; width: 100%; height: 100%; }
/* The pin a React <Marker> shows while it has no content of its own (popups render nothing in it). */
.react-three-earth-marker-fallback-pin {
  display: block; width: 27px; height: 41px; color: var(--react-three-earth-marker-color, #3fb1ce);
}
.react-three-earth-marker-fallback-pin:not(:only-child) { display: none; }
.react-three-earth-popup {
  position: absolute; left: 0; top: 0; z-index: 3; display: flex; pointer-events: auto; will-change: transform;
  font: var(--react-three-earth-popup-font, 13px / 1.4 system-ui, sans-serif);
  color: var(--react-three-earth-popup-color, #222);
}
.react-three-earth-popup[data-tracking-pointer] { pointer-events: none; }
.react-three-earth-popup-content {
  position: relative; box-sizing: border-box; min-width: 0; max-width: 100%;
  padding: var(--react-three-earth-popup-padding, 10px 12px);
  background: var(--react-three-earth-popup-background, #fff);
  border-radius: var(--react-three-earth-popup-radius, 6px);
  box-shadow: var(--react-three-earth-popup-shadow, 0 1px 4px rgba(0, 0, 0, 0.3));
}
/* Focused only to bring screen readers into the popup: no ring around the whole box. */
.react-three-earth-popup-content:focus { outline: none; }
.react-three-earth-popup[data-close-button] .react-three-earth-popup-content { padding-right: 28px; }
.react-three-earth-popup-close {
  all: unset; position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; line-height: 1;
}
.react-three-earth-popup-close:hover { background: rgba(0, 0, 0, 0.06); }
.react-three-earth-popup-close:focus-visible { outline: 2px solid #1a73e8; }
.react-three-earth-popup-tip { width: 0; height: 0; border: 8px solid transparent; z-index: 1; align-self: center; }
.react-three-earth-popup[data-anchor="bottom"], .react-three-earth-popup[data-anchor^="bottom-"] { flex-direction: column-reverse; }
.react-three-earth-popup[data-anchor="top"], .react-three-earth-popup[data-anchor^="top-"] { flex-direction: column; }
.react-three-earth-popup[data-anchor="left"] { flex-direction: row; }
.react-three-earth-popup[data-anchor="right"] { flex-direction: row-reverse; }
.react-three-earth-popup[data-anchor="center"] .react-three-earth-popup-tip { display: none; }
.react-three-earth-popup[data-anchor^="bottom"] .react-three-earth-popup-tip { border-bottom: none; border-top-color: var(--react-three-earth-popup-background, #fff); }
.react-three-earth-popup[data-anchor^="top"] .react-three-earth-popup-tip { border-top: none; border-bottom-color: var(--react-three-earth-popup-background, #fff); }
.react-three-earth-popup[data-anchor="left"] .react-three-earth-popup-tip { border-left: none; border-right-color: var(--react-three-earth-popup-background, #fff); }
.react-three-earth-popup[data-anchor="right"] .react-three-earth-popup-tip { border-right: none; border-left-color: var(--react-three-earth-popup-background, #fff); }
.react-three-earth-popup[data-anchor$="-left"] .react-three-earth-popup-tip { align-self: flex-start; }
.react-three-earth-popup[data-anchor$="-right"] .react-three-earth-popup-tip { align-self: flex-end; }
.react-three-earth-popup[data-anchor="top-left"] .react-three-earth-popup-content { border-top-left-radius: 0; }
.react-three-earth-popup[data-anchor="top-right"] .react-three-earth-popup-content { border-top-right-radius: 0; }
.react-three-earth-popup[data-anchor="bottom-left"] .react-three-earth-popup-content { border-bottom-left-radius: 0; }
.react-three-earth-popup[data-anchor="bottom-right"] .react-three-earth-popup-content { border-bottom-right-radius: 0; }
`

function ensureStyle(document: Document): void {
  if (document.head.querySelector(`style[${STYLE_ELEMENT_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_ELEMENT_ATTRIBUTE, '')
  style.textContent = STYLE
  document.head.append(style)
}

/**
 * The layer markers and popups go in, filling `container` above the canvas (and below the attribution).
 * Shared by everything in the container; give it back with `releaseScreenLayer`. The container is made
 * `position: relative` while it is static.
 */
export function acquireScreenLayer(container: HTMLElement): HTMLElement {
  const existing = layers.get(container)
  if (existing !== undefined) {
    existing.users++
    return existing.element
  }
  const document = container.ownerDocument
  ensureStyle(document)
  holdContainerPosition(container)
  const element = document.createElement('div')
  element.className = 'react-three-earth-markers'
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
