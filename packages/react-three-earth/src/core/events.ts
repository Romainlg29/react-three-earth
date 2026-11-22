import type { Camera, Object3DEventMap } from 'three'

/**
 * Events an `Earth` dispatches, on top of three's `Object3D` events. Listen with
 * `earth.addEventListener('moveend', listener)`, or `useEarthEvent('moveend', listener)` in React.
 *
 * Every event but `framerequest` fires from `earth.update`, once per frame at most, in this order:
 * `movestart`, `move`, `moveend`, `load`, `idle`. `framerequest` fires at once, from `earth.requestFrame`.
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
   * The Earth needs a frame although nothing in the scene changed yet, for example after
   * `earth.camera.jumpTo`. Hosts that render on demand (R3F `frameloop="demand"`) call their invalidate;
   * `<Earth>` does it for you.
   */
  framerequest: object
}

export type EarthEventType = Exclude<keyof EarthEventMap, keyof Object3DEventMap>

/** What the Earth did this frame, as `EarthEventTracker.update` needs it. */
export interface EarthFrameState {
  /** The camera's pose or the viewport changed since the last frame. */
  cameraMoved: boolean
  /** Something is still loading, composing or morphing. */
  busy: boolean
}

/**
 * Turns per-frame state into the `move*`, `load` and `idle` events, in order. Pure bookkeeping, so it can
 * be tested and reused without a renderer.
 */
export class EarthEventTracker {
  moving = false
  idle = false
  loaded = false

  protected readonly events: EarthEventType[] = []

  /** The events to dispatch for this frame, in order. The array is reused by the next call. */
  update({ cameraMoved, busy }: EarthFrameState): readonly EarthEventType[] {
    const events = this.events
    events.length = 0
    if (cameraMoved) {
      if (!this.moving) events.push('movestart')
      this.moving = true
      events.push('move')
    } else if (this.moving) {
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
}

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
      if (elements[index] !== this.lastMatrix[index]) moved = true
      this.lastMatrix[index] = elements[index]!
    }
    this.lastCamera = camera
    this.lastFieldOfView = fieldOfView
    this.lastWidthPixels = viewportWidthPixels
    this.lastHeightPixels = viewportHeightPixels
    return moved && !first
  }
}
