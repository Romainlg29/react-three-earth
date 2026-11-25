import { Vector3 } from 'three'
import { dot, screenUV, step } from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'

/** Which part of the canvas a clipped layer keeps, on either side of a vertical (`left`, `right`) or horizontal (`top`, `bottom`) line. */
export type ScreenClipSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Keeps a layer to one part of the canvas: everything the layer draws (its imagery, a map style's labels and 3D
 * buildings) shows only on `side` of a line across the canvas. Two layers clipped to opposite sides of the same line
 * make a swipe comparison. Clipping is per pixel in the terrain's shader, so moving the line
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

/** Whether `clip` keeps the point at (u, v), the canvas's normalised coordinates from the top left. */
export function screenClipKeeps(clip: ScreenClip | null, u: number, v: number): boolean {
  if (clip === null) return true
  const position = Math.min(1, Math.max(0, clip.positionFraction))
  switch (clip.side) {
    case 'left':
      return u <= position
    case 'right':
      return u >= position
    case 'top':
      return v <= position
    case 'bottom':
      return v >= position
  }
}

/** Where a material keeps the discard test `setScreenClipMask` switches on. */
const SCREEN_CLIP_MASK = 'screenClipMask'

/** Gives `material` the discard test `mask`, used only while a clip is set (`setScreenClipMask`). */
export function prepareScreenClipMask(material: NodeMaterial, mask: Node): void {
  material.userData[SCREEN_CLIP_MASK] = mask
}

/**
 * Turns the material's clip discard on while `plane` clips and off otherwise. A shader that discards loses the GPU's
 * early depth rejection, so the discard is only compiled in while needed: one rebuild when a clip is set or cleared,
 * none while it moves.
 */
export function setScreenClipMask(material: NodeMaterial, plane: Vector3): void {
  const mask = (material.userData[SCREEN_CLIP_MASK] as Node | undefined) ?? null
  const wanted = plane.x === 0 && plane.y === 0 ? null : mask
  if (material.maskNode === wanted) return
  material.maskNode = wanted
  material.needsUpdate = true
}
