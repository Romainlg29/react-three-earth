import { Vector3 } from 'three'
import { dot, screenUV, step } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Which part of the canvas a clipped layer keeps, on either side of a vertical (`left`, `right`) or horizontal (`top`, `bottom`) line. */
export type ScreenClipSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Keeps a layer to one part of the canvas: everything the layer draws (its imagery, a map style's labels and 3D
 * buildings) shows only on `side` of a line across the canvas. Two layers clipped to opposite sides of the same line
 * make a swipe comparison (`@earthkit/compare`). Clipping is per pixel in the terrain's shader, so moving the line
 * every frame costs nothing: no reload, no shader rebuild, no extra draw.
 *
 * @example imagery.screenClip = { side: 'left', positionFraction: 0.5 } // the left half of the canvas
 */
export interface ScreenClip {
  side: ScreenClipSide
  /**
   * Where the line crosses the canvas, from 0 to 1: a fraction of its width from the left edge for `left` and `right`,
   * of its height from the top edge for `top` and `bottom`.
   */
  positionFraction: number
}

/** The plane of no clip: every pixel passes. */
const UNCLIPPED_PLANE = new Vector3(0, 0, -1)

/**
 * Writes `clip` as a half-plane over the canvas's normalised coordinates (0 to 1, from the top left): a pixel at
 * (u, v) is kept where `x·u + y·v >= z`. Null keeps every pixel.
 */
export function screenClipPlane(clip: ScreenClip | null, target: Vector3 = new Vector3()): Vector3 {
  if (clip === null) return target.copy(UNCLIPPED_PLANE)
  const position = Math.min(1, Math.max(0, clip.positionFraction))
  switch (clip.side) {
    case 'left':
      return target.set(-1, 0, -position)
    case 'right':
      return target.set(1, 0, position)
    case 'top':
      return target.set(0, -1, -position)
    case 'bottom':
      return target.set(0, 1, position)
  }
}

/** Throws, stating the fix, when `clip` is not a valid `ScreenClip` (from JavaScript or untyped data). */
export function validateScreenClip(clip: ScreenClip | null, what: string): void {
  if (clip === null) return
  if (!['left', 'right', 'top', 'bottom'].includes(clip.side)) {
    throw new Error(`${what}: screenClip.side must be 'left', 'right', 'top' or 'bottom', not ${JSON.stringify(clip.side)}.`)
  }
  if (!Number.isFinite(clip.positionFraction)) {
    throw new Error(`${what}: screenClip.positionFraction must be a number from 0 to 1, not ${String(clip.positionFraction)}.`)
  }
}

/** 1 where the pixel is kept by the half-plane `plane` (from `screenClipPlane`), 0 where it is clipped. */
export function screenClipFactor(plane: Node<'vec3'>): Node<'float'> {
  return step(plane.z, dot(plane.xy, screenUV)) as unknown as Node<'float'>
}
