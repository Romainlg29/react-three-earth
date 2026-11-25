import type { Earth } from '@earthkit/globe'

import type { FeatureStore } from '../FeatureStore.js'
import type { HeightSampler, OverlayContent } from '../render/LiveOverlay.js'
import type { ElementMode } from './SelectMode.js'
import type { DrawFeature, DrawPointerEvent, DrawStyle, DrawStyleState, LongitudeLatitude } from '../types.js'

/** What a mode reaches its `Draw` through. */
export interface DrawModeContext {
  readonly earth: Earth
  /** The features. Changing them here fires the `Draw`'s events. */
  readonly store: FeatureStore
  /** Terrain heights for the overlay; remember the heights of taps here. */
  readonly heights: HeightSampler
  /** The full style of a feature. */
  style(feature: DrawFeature, state: DrawStyleState): DrawStyle
  /** A new feature id. */
  createId(): string
  /**
   * Screen pixels of a position on the terrain as the overlay last drew it, or null when hidden. Where the terrain's
   * height there is not known yet, `fallbackHeightMeters` stands in (default 0).
   */
  project(position: LongitudeLatitude, fallbackHeightMeters?: number): { x: number; y: number } | null
  /** Screen pixels of a position at a height above the WGS84 ellipsoid, or null when hidden. */
  projectAtHeight(position: LongitudeLatitude, heightMeters: number): { x: number; y: number } | null
  /**
   * How far in front of the camera a position at a height is, in scene units (larger is farther), or null. Optional:
   * the select mode turns gizmo axes pointing away from the camera around with it.
   */
  depthAtHeight?(position: LongitudeLatitude, heightMeters: number): number | null
  /** A number that changes whenever the view (camera, viewport, morph) changes, to cache screen work. Optional. */
  viewVersion?(): number
  /** The mode's state or overlay changed: redraw the overlay and tell subscribers. */
  changed(): void
  /** Adds finished features to the store and fires `create`. */
  create(features: DrawFeature[]): void
  /** Replaces features in the store and fires `update`. */
  update(features: DrawFeature[]): void
  /** Removes features from the store and fires `delete`. */
  remove(ids: readonly string[]): void
  /** Sets the cursor over the map (null: the map's own). */
  setCursor(cursor: string | null): void
  /** Turns double-click and double-tap zoom off while the mode places things by tapping. Released on `exit`. */
  holdDoubleClickZoom(): void
  /** Gives double-click and double-tap zoom back before `exit`. */
  releaseDoubleClickZoom(): void
}

/** What a mode reports for `Draw.getState()`. */
export interface DrawModeStatus {
  /** A feature is being drawn. */
  drawing: boolean
  /** Vertices placed in the feature being drawn. */
  vertexCount: number
  /** `finish()` would create a feature. */
  canFinish: boolean
  /** `undo()` would remove the last vertex. */
  canUndo: boolean
  /** The select mode is in edit mode: the selected feature shows its elements rather than its gizmo. Default: false. */
  editingVertices?: boolean
  /** The elements the select mode's edit mode picks. Default: the select mode's. */
  elementMode?: ElementMode
  /** The select mode's `extrude()` would act: a face is picked. Default: false. */
  canExtrude?: boolean
}

export const IDLE_STATUS: DrawModeStatus = Object.freeze({ drawing: false, vertexCount: 0, canFinish: false, canUndo: false, editingVertices: false })

/** No selected features: one shared empty list, so states compare equal by identity. */
export const NO_FEATURE_IDS: readonly string[] = Object.freeze([])

/** How close a tap must land to a handle to hit it, in CSS pixels: wider for fingers. */
export function hitTolerancePixels(pointerType: string): number {
  return pointerType === 'touch' ? 22 : 10
}

/**
 * A way of using the map in a `Draw`: `'point'`, `'linestring'`, `'polygon'`, `'static'`, or your own. A `Draw` holds one
 * mode at a time (`draw.setMode(name)`) and hands it the pointer: taps (`click`), mouse moves (`hover`) and presses it
 * may take from the camera controls (`pointerDown` returning true, then `pointerMove` and `pointerUp`).
 *
 * Subclass it for a new tool: override what you need, draw in-progress geometry in `overlay`, and report progress in
 * `status`. Everything is `protected`, so built-in modes can be extended too.
 */
export abstract class DrawMode {
  /** The name `draw.setMode` takes. Unique within a `Draw`. */
  abstract readonly name: string
  protected context: DrawModeContext | null = null

  /** The mode became active. */
  enter(context: DrawModeContext): void {
    this.context = context
  }

  /** Another mode took over: drop whatever is in progress. */
  exit(): void {
    this.cancel()
    this.context = null
  }

  /** A tap or click on the map (not after a drag). */
  click(_event: DrawPointerEvent): void {}

  /** A double click or double tap. */
  doubleClick(_event: DrawPointerEvent): void {}

  /** The mouse moved over the map without a button (touch screens have no hover). */
  hover(_event: DrawPointerEvent): void {}

  /** A press on the map: return true to take it from the camera controls (it then never pans the map). */
  pointerDown(_event: DrawPointerEvent): boolean {
    return false
  }

  pointerMove(_event: DrawPointerEvent): void {}

  pointerUp(_event: DrawPointerEvent): void {}

  pointerCancel(): void {}

  /** A key pressed while the map has focus: return true when handled. */
  keyDown(_event: KeyboardEvent): boolean {
    return false
  }

  /**
   * A press of the mouse's secondary (right) button on the map, while the `Draw`'s `keyboard` option is on: return true
   * to take it (the camera controls and the context menu then ignore it). The select mode cancels a keyboard move.
   */
  secondaryPress(): boolean {
    return false
  }

  /** The map lost the keyboard focus (or the window its focus): drop what keys started. */
  focusLost(): void {}

  /** Completes the feature being drawn, if it can be. */
  finish(): void {}

  /** Drops the feature being drawn. */
  cancel(): void {}

  /** Removes the last vertex placed. */
  undo(): void {}

  /** Adds what the mode draws live to `content`: the feature in progress, guides, handles. */
  overlay(_content: OverlayContent): void {}

  /** Ids of the selected features: the same array until the selection changes. Modes that do not select return none. */
  selectedFeatureIds(): readonly string[] {
    return NO_FEATURE_IDS
  }

  /** Selects these features (unknown ids are skipped). Returns false when the mode does not select. */
  setSelection(_ids: readonly string[]): boolean {
    return false
  }

  /** Deletes what is selected: a picked vertex, or the selected features. Returns true when something was deleted. */
  deleteSelection(): boolean {
    return false
  }

  /** Ids of stored features the mode draws live (in `overlay`): they are left out of the draped layer meanwhile. */
  liveFeatureIds(): readonly string[] {
    return []
  }

  status(): DrawModeStatus {
    return IDLE_STATUS
  }

  /** Data for `draw.inspect()`. */
  inspect(): unknown {
    return this.status()
  }
}

/** The mode that does nothing: the map pans and zooms as usual. The default. */
export class StaticMode extends DrawMode {
  readonly name: string = 'static'
}
