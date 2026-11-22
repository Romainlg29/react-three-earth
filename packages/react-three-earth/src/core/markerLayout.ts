import type { ScreenPosition } from './projection.js'

/**
 * The point of an element that sits on its position: its centre, an edge's middle or a corner. `'bottom'`
 * puts the element's bottom edge on the point, so the element stands above it.
 */
export type ScreenAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** A pointer that moves less than this between press and release clicks; more is a drag or a pan. */
export const CLICK_TOLERANCE_PIXELS = 3

/** Every `ScreenAnchor`, in the order `resolvePopupAnchor` documents. */
export const SCREEN_ANCHORS: readonly ScreenAnchor[] = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']

/**
 * How a marker turns and tilts. `'viewport'` keeps it upright on the screen; `'map'` turns it with the
 * map's heading (`rotationAlignment`) or lays it on the ground (`pitchAlignment`); `'auto'` is `'viewport'`
 * for the rotation and follows the rotation alignment for the pitch, as in MapLibre.
 */
export type MarkerAlignment = 'viewport' | 'map' | 'auto'

/** A shift on the screen in CSS pixels: `xPixels` to the right, `yPixels` down. */
export interface ScreenOffset {
  xPixels: number
  yPixels: number
}

/** A box on the screen, in CSS pixels from the container's top-left corner. */
export interface ScreenBox {
  leftPixels: number
  topPixels: number
  widthPixels: number
  heightPixels: number
}

/** Where the anchor sits inside an element's box: 0 is the left (top) edge, 1 the right (bottom) one. */
export function anchorFraction(anchor: ScreenAnchor): { x: number; y: number } {
  const x = anchor === 'left' || anchor.endsWith('-left') ? 0 : anchor === 'right' || anchor.endsWith('-right') ? 1 : 0.5
  const y = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5
  return { x, y }
}

/**
 * The box of an element whose `anchor` sits on `point`, shifted by `offset`. Pixel-rounded, as the DOM
 * places it, so text stays sharp.
 */
export function anchoredBox(point: ScreenPosition, widthPixels: number, heightPixels: number, anchor: ScreenAnchor, offset: ScreenOffset = ZERO_OFFSET): ScreenBox {
  const { x, y } = anchorFraction(anchor)
  return {
    leftPixels: Math.round(point.xPixels - x * widthPixels + offset.xPixels),
    topPixels: Math.round(point.yPixels - y * heightPixels + offset.yPixels),
    widthPixels,
    heightPixels,
  }
}

const ZERO_OFFSET: ScreenOffset = { xPixels: 0, yPixels: 0 }

/**
 * A popup's offset for an anchor. A number moves the popup that far away from its point, on the side its
 * anchor puts it (up for `'bottom'`, diagonally for corners); an object is used as given.
 */
export function popupOffset(anchor: ScreenAnchor, offsetPixels: number | ScreenOffset): ScreenOffset {
  if (typeof offsetPixels !== 'number') return offsetPixels
  const { x, y } = anchorFraction(anchor)
  const directionX = 1 - 2 * x // left edge on the point: the popup goes right
  const directionY = 1 - 2 * y
  const diagonal = directionX !== 0 && directionY !== 0 ? Math.SQRT1_2 : 1
  return { xPixels: Math.round(directionX * offsetPixels * diagonal), yPixels: Math.round(directionY * offsetPixels * diagonal) }
}

/**
 * The anchor of a popup set to `'auto'`: above its point (`'bottom'`) unless it would leave the container at
 * the top, then below (`'top'`); to the side where it would leave it at the left or right, as MapLibre does.
 */
export function resolvePopupAnchor(
  point: ScreenPosition,
  popupWidthPixels: number,
  popupHeightPixels: number,
  containerWidthPixels: number,
  containerHeightPixels: number,
  offsetPixels: number | ScreenOffset = 0,
): ScreenAnchor {
  // The offset of the default anchor tells how much room the popup needs above its point.
  const above = popupOffset('bottom', offsetPixels)
  let vertical: 'top' | 'bottom' | '' = ''
  if (point.yPixels + above.yPixels < popupHeightPixels) vertical = 'top'
  else if (point.yPixels > containerHeightPixels - popupHeightPixels) vertical = 'bottom'
  let horizontal: 'left' | 'right' | '' = ''
  if (point.xPixels < popupWidthPixels / 2) horizontal = 'left'
  else if (point.xPixels > containerWidthPixels - popupWidthPixels / 2) horizontal = 'right'
  if (vertical === '' && horizontal === '') return 'bottom'
  if (vertical === '') return horizontal as ScreenAnchor
  if (horizontal === '') return vertical
  return `${vertical}-${horizontal}`
}

/**
 * Where a popup with `popupAnchor` attaches to a marker's box, so it opens beside the marker rather than over
 * it: above the box for `'bottom'`, below it for `'top'`, at the opposite corner for a corner, at its centre for
 * `'center'`.
 */
export function popupPointOnBox(box: ScreenBox, popupAnchor: ScreenAnchor): ScreenPosition {
  const { x, y } = anchorFraction(popupAnchor)
  return { xPixels: box.leftPixels + (1 - x) * box.widthPixels, yPixels: box.topPixels + (1 - y) * box.heightPixels }
}

/**
 * The CSS `transform` that puts an element's `anchor` on `point` (pixel-rounded), shifted by `offset`, then
 * tilted by `tiltDegrees` around the horizontal axis and turned clockwise by `rotationDegrees`, both around
 * the anchor (set `transform-origin` with `anchorTransformOrigin`). The element sits at the top-left corner of
 * its container.
 */
export function anchoredTransform(
  point: ScreenPosition,
  anchor: ScreenAnchor,
  offset: ScreenOffset = ZERO_OFFSET,
  rotationDegrees = 0,
  tiltDegrees = 0,
): string {
  const { x, y } = anchorFraction(anchor)
  const left = Math.round(point.xPixels + offset.xPixels)
  const top = Math.round(point.yPixels + offset.yPixels)
  let transform = `translate(${left}px, ${top}px) translate(${-x * 100}%, ${-y * 100}%)`
  if (tiltDegrees !== 0) transform += ` rotateX(${round(tiltDegrees)}deg)`
  if (rotationDegrees !== 0) transform += ` rotateZ(${round(rotationDegrees)}deg)`
  return transform
}

/** The CSS `transform-origin` at an anchor, so rotations turn around the point on the map. */
export function anchorTransformOrigin(anchor: ScreenAnchor): string {
  const { x, y } = anchorFraction(anchor)
  return `${x * 100}% ${y * 100}%`
}

/**
 * A marker's screen rotation and tilt, in degrees, from its alignments and the camera's heading and pitch at
 * the marker. With `'map'` rotation it turns against the heading so it keeps pointing the same way on the
 * ground; with `'map'` pitch it tilts by the camera's angle from straight down, lying on the ground.
 */
export function markerRotation(
  rotationDegrees: number,
  rotationAlignment: MarkerAlignment,
  pitchAlignment: MarkerAlignment,
  headingDegrees: number,
  pitchDegrees: number,
): { rotationDegrees: number; tiltDegrees: number } {
  const rotationOnMap = rotationAlignment === 'map'
  const pitchOnMap = pitchAlignment === 'map' || (pitchAlignment === 'auto' && rotationOnMap)
  return {
    rotationDegrees: rotationOnMap ? rotationDegrees - headingDegrees : rotationDegrees,
    // Pitch -90 looks straight down: no tilt. Clamped short of edge-on, where the element would vanish.
    tiltDegrees: pitchOnMap ? Math.min(85, Math.max(0, 90 + pitchDegrees)) : 0,
  }
}

function round(degrees: number): number {
  return Math.round(degrees * 100) / 100
}
