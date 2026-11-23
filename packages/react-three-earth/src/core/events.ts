import type { Camera, Object3DEventMap } from 'three'

import type { GeographicPosition } from './camera.js'
import type { ScreenPosition } from './projection.js'

/**
 * A pointer event on the map, with where it happened on Earth. `click`, `doubleclick`, `contextmenu` and
 * `pointermove` carry it.
 */
export interface EarthPointerEvent {
  /** Where the pointer is, in CSS pixels from the canvas's top-left corner. */
  screen: ScreenPosition
  /**
   * The position under the pointer, on the loaded terrain (`earth.camera.unproject`), or null on sky.
   * Computed when first read, so read it in the listener.
   */
  readonly geographic: (GeographicPosition & { heightMeters: number }) | null
  /** The DOM event. Call `originalEvent.preventDefault()` to stop the browser's own handling. */
  originalEvent: MouseEvent
}

/**
 * Events an `Earth` dispatches, on top of three's `Object3D` events. Listen with
 * `earth.addEventListener('moveend', listener)`, or `useEarthEvent('moveend', listener)` in React.
 *
 * The camera and loading events fire from `earth.update`, once per frame at most, in this order: `movestart`,
 * `zoomstart`, `rotatestart`, `pitchstart`, `move`, `zoom`, `rotate`, `pitch`, `zoomend`, `rotateend`,
 * `pitchend`, `moveend`, `load`, `idle`, then `update` last. `framerequest` fires at once, from `earth.requestFrame`. The
 * pointer events (`click`, `doubleclick`, `contextmenu`, `pointermove`) fire from the DOM, once
 * `earth.attachPointerEvents(canvas)` is called; `<Earth>` does it.
 */
export interface EarthEventMap extends Object3DEventMap {
  /**
   * The first time the Earth is idle: the first view is fully loaded and drawn. Fires once, just before
   * the first `idle`.
   */
  load: object
  /**
   * Nothing left to do: the camera is still, no morph runs, no terrain tile or imagery is loading or
   * waiting to be composed, and the atmosphere is ready. Fires again after the next change settles.
   */
  idle: object
  /** The camera started moving, from the controls, `earth.camera.jumpTo`, the morph or your own code. */
  movestart: object
  /** The camera moved since the last frame. Fires every frame while it moves. */
  move: object
  /** The camera stopped: the first frame it did not move after moving. */
  moveend: object
  /**
   * The scale at the centre of the screen (ground metres per pixel) started changing. On the globe this is
   * the camera's distance, not `getView().zoom`, which also changes with latitude while panning.
   */
  zoomstart: object
  /** The scale at the centre changed since the last frame. */
  zoom: object
  /** The scale at the centre stopped changing. */
  zoomend: object
  /** The heading started changing. */
  rotatestart: object
  /** The heading changed since the last frame. */
  rotate: object
  /** The heading stopped changing. */
  rotateend: object
  /** The pitch started changing. */
  pitchstart: object
  /** The pitch changed since the last frame. */
  pitch: object
  /** The pitch stopped changing. */
  pitchend: object
  /** A click on the map: pressed and released within 3 pixels (a drag is not a click). */
  click: EarthPointerEvent
  /** A double click on the map. */
  doubleclick: EarthPointerEvent
  /** A right click, or a long press on touch screens. */
  contextmenu: EarthPointerEvent
  /** The pointer moved over the map, dragging or not. */
  pointermove: EarthPointerEvent
  /**
   * The Earth needs a frame although nothing in the scene changed yet, for example after
   * `earth.camera.jumpTo`. Hosts that render on demand (R3F `frameloop="demand"`) call their invalidate;
   * `<Earth>` does it for you.
   */
  framerequest: object
  /**
   * The result of `getAttributions()` may have changed: a source was added or removed, or a style finished
   * loading its metadata. `AttributionControl` follows it.
   */
  attributionchange: object
  /**
   * The end of every `earth.update`: the camera, the morph and the tiles are final for the frame about to be
   * drawn. Markers and popups place themselves here, so they never lag behind the map. Move the camera before
   * `earth.update` (as `EarthControls` does) for anything listening here to see it in the same frame.
   */
  update: object
}

export type EarthEventType = Exclude<keyof EarthEventMap, keyof Object3DEventMap>

/** The parts of the view the `zoom`, `rotate` and `pitch` events follow. */
export interface ViewSample {
  groundMetersPerPixel: number
  headingDegrees: number
  pitchDegrees: number
}

/** What the Earth did this frame, as `EarthEventTracker.update` needs it. */
export interface EarthFrameState {
  /** The camera's pose or the viewport changed since the last frame. */
  cameraMoved: boolean
  /** Something is still loading, composing or morphing. */
  busy: boolean
  /** The view this frame, when the camera moved. Without it, no `zoom`, `rotate` or `pitch` events. */
  view?: ViewSample
}

/** Changes smaller than these are noise, not a zoom, rotation or tilt. */
const ZOOM_CHANGE_THRESHOLD = 1e-5
const ANGLE_CHANGE_THRESHOLD_DEGREES = 1e-4

type ViewQuantity = 'zoom' | 'rotate' | 'pitch'
const VIEW_QUANTITIES: readonly ViewQuantity[] = ['zoom', 'rotate', 'pitch']

/**
 * Turns per-frame state into the `move*`, `load` and `idle` events, in order. Pure bookkeeping, so it can
 * be tested and reused without a renderer.
 */
export class EarthEventTracker {
  moving = false
  idle = false
  loaded = false
  /** Which of zoom, rotate and pitch are changing. */
  readonly changing: Record<ViewQuantity, boolean> = { zoom: false, rotate: false, pitch: false }

  protected readonly events: EarthEventType[] = []
  protected lastView: ViewSample | null = null

  /** The events to dispatch for this frame, in order. The array is reused by the next call. */
  update({ cameraMoved, busy, view }: EarthFrameState): readonly EarthEventType[] {
    const events = this.events
    events.length = 0
    const changed = this.compareView(view, cameraMoved)
    if (cameraMoved) {
      if (!this.moving) events.push('movestart')
      this.moving = true
      for (const quantity of VIEW_QUANTITIES) if (changed[quantity] && !this.changing[quantity]) events.push(`${quantity}start`)
      events.push('move')
      for (const quantity of VIEW_QUANTITIES) if (changed[quantity]) events.push(quantity)
    }
    for (const quantity of VIEW_QUANTITIES) {
      if (this.changing[quantity] && !changed[quantity]) events.push(`${quantity}end`)
      this.changing[quantity] = changed[quantity]
    }
    if (!cameraMoved && this.moving) {
      this.moving = false
      events.push('moveend')
    }
    if (cameraMoved || busy) {
      this.idle = false
    } else if (!this.idle) {
      this.idle = true
      if (!this.loaded) {
        this.loaded = true
        events.push('load')
      }
      events.push('idle')
    }
    return events
  }

  protected readonly changed: Record<ViewQuantity, boolean> = { zoom: false, rotate: false, pitch: false }

  /** Which quantities changed since the last sample (none when the camera did not move). Keeps the sample. */
  protected compareView(view: ViewSample | undefined, cameraMoved: boolean): Readonly<Record<ViewQuantity, boolean>> {
    const changed = this.changed
    const last = this.lastView
    changed.zoom = changed.rotate = changed.pitch = false
    if (view === undefined) return changed
    if (last !== null && cameraMoved) {
      changed.zoom = Math.abs(Math.log2(view.groundMetersPerPixel / last.groundMetersPerPixel)) > ZOOM_CHANGE_THRESHOLD
      const heading = ((((view.headingDegrees - last.headingDegrees + 180) % 360) + 360) % 360) - 180
      changed.rotate = Math.abs(heading) > ANGLE_CHANGE_THRESHOLD_DEGREES
      changed.pitch = Math.abs(view.pitchDegrees - last.pitchDegrees) > ANGLE_CHANGE_THRESHOLD_DEGREES
    }
    if (last === null) this.lastView = { ...view }
    else Object.assign(last, view)
    return changed
  }

  /** True until a first view sample is given: `update` wants one even on a frame the camera holds still. */
  get needsViewSample(): boolean {
    return this.lastView === null
  }
}

/** Matrix changes below this share of an element's size are rounding, not motion (6 µm at the Earth's radius). */
const MATRIX_NOISE_RELATIVE = 1e-12

/**
 * Tells whether a camera moved between calls: its world matrix, field of view or the viewport changed.
 * Near and far planes are left out, since the controls refit them every frame.
 */
export class CameraMotionDetector {
  protected readonly lastMatrix = new Float64Array(16)
  protected lastCamera: Camera | null = null
  protected lastFieldOfView = 0
  protected lastWidthPixels = 0
  protected lastHeightPixels = 0

  /** True when the camera differs from the last call. The first call only records it. */
  update(camera: Camera, viewportWidthPixels: number, viewportHeightPixels: number): boolean {
    const elements = camera.matrixWorld.elements
    const fieldOfView = (camera as { getEffectiveFOV?: () => number }).getEffectiveFOV?.() ?? 0
    const first = this.lastCamera !== camera
    let moved =
      fieldOfView !== this.lastFieldOfView ||
      viewportWidthPixels !== this.lastWidthPixels ||
      viewportHeightPixels !== this.lastHeightPixels
    for (let index = 0; index < 16; index++) {
      const value = elements[index]!
      // A few units in the last place is float noise, not motion: GlobeControls can re-derive the same pose
      // every frame with the last bits flipping, which would hold `idle` back forever.
      if (first || Math.abs(value - this.lastMatrix[index]!) > MATRIX_NOISE_RELATIVE * Math.max(1, Math.abs(value))) {
        moved = true
        // Kept only on a real change, so a slow creep still adds up to one.
        this.lastMatrix[index] = value
      }
    }
    this.lastCamera = camera
    this.lastFieldOfView = fieldOfView
    this.lastWidthPixels = viewportWidthPixels
    this.lastHeightPixels = viewportHeightPixels
    return moved && !first
  }
}
