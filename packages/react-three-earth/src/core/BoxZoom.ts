import type { GeographicBounds, GeographicPosition } from './camera.js'
import { holdContainerPosition, releaseContainerPosition } from './containerPosition.js'
import type { Earth } from './Earth.js'
import { wrapLongitudeDegrees, type ScreenPosition } from './projection.js'

/** A box smaller than this on both sides is a click, not a box. MapLibre's click tolerance. */
const MINIMUM_BOX_PIXELS = 3

/**
 * The longitude-latitude box around ground points (the corners, edge middles and centre of a box drawn on the
 * screen). Longitudes are unwrapped around the first point, so a box over the antimeridian comes back with
 * `westDegrees` greater than `eastDegrees`. Null with fewer than two points (the box was mostly sky).
 */
export function boundsAroundPositions(positions: readonly GeographicPosition[]): GeographicBounds | null {
  if (positions.length < 2) return null
  const reference = positions[0]!.longitudeDegrees
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const { longitudeDegrees, latitudeDegrees } of positions) {
    const longitude = reference + wrapLongitudeDegrees(longitudeDegrees - reference)
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
    south = Math.min(south, latitudeDegrees)
    north = Math.max(north, latitudeDegrees)
  }
  if (east - west >= 360) return { westDegrees: -180, southDegrees: south, eastDegrees: 180, northDegrees: north }
  return { westDegrees: wrapLongitudeDegrees(west), southDegrees: south, eastDegrees: wrapLongitudeDegrees(east), northDegrees: north }
}

/** Nine points of a screen box: corners, edge middles and centre, in CSS pixels. */
export function boxSamplePoints(start: ScreenPosition, end: ScreenPosition): ScreenPosition[] {
  const xs = [start.xPixels, (start.xPixels + end.xPixels) / 2, end.xPixels]
  const ys = [start.yPixels, (start.yPixels + end.yPixels) / 2, end.yPixels]
  // The centre first: it is the most likely to be on the ground, and longitudes unwrap around it.
  const points: ScreenPosition[] = [{ xPixels: xs[1]!, yPixels: ys[1]! }]
  for (const xPixels of xs) for (const yPixels of ys) if (xPixels !== xs[1] || yPixels !== ys[1]) points.push({ xPixels, yPixels })
  return points
}

/**
 * Zooms to a box drawn with `Shift` + drag, as MapLibre's box zoom: the camera eases to fit the ground inside the
 * box, keeping its heading and pitch. `Escape` or releasing `Shift`'s drag over a tiny box cancels. Mouse and pen
 * only. It takes `Shift` + drag from the pointer controls, where it used to rotate: rotate with the right button.
 * `EarthViewControls` owns one.
 */
export class BoxZoom {
  enabled = true
  /** Length of the ease to the box. Default: 0.5. */
  durationSeconds = 0.5
  protected domElement: HTMLElement | null = null
  protected box: HTMLDivElement | null = null
  protected start: ScreenPosition = { xPixels: 0, yPixels: 0 }
  protected end: ScreenPosition = { xPixels: 0, yPixels: 0 }
  protected pointerId: number | null = null

  constructor(protected readonly earth: Earth) {}

  /** True while a box is being drawn. */
  get active(): boolean {
    return this.pointerId !== null
  }

  /** Listens to the element. Attach before the pointer controls, so `Shift` + drag reaches the box first. */
  attach(domElement: HTMLElement): void {
    this.detach()
    this.domElement = domElement
    // Capture on the element: before the pointer controls' own listener on it
    domElement.addEventListener('pointerdown', this.onPointerDown, { capture: true })
  }

  detach(): void {
    this.cancel()
    this.domElement?.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
    this.domElement = null
  }

  /** Stops drawing without zooming. */
  cancel(): void {
    if (this.pointerId === null) return
    this.pointerId = null
    window.removeEventListener('pointermove', this.onPointerMove, { capture: true })
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true })
    window.removeEventListener('pointercancel', this.onPointerCancel, { capture: true })
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    if (this.box !== null && this.domElement !== null) {
      this.box.remove()
      releaseContainerPosition(this.domElement)
    }
    this.box = null
  }

  protected toElementPixels(event: PointerEvent): ScreenPosition {
    const rect = this.domElement!.getBoundingClientRect()
    return { xPixels: event.clientX - rect.left, yPixels: event.clientY - rect.top }
  }

  protected onPointerDown = (event: PointerEvent): void => {
    const earth = this.earth
    if (!this.enabled || this.pointerId !== null || !event.shiftKey || event.button !== 0 || event.pointerType === 'touch') return
    if (!earth.camera.ready || earth.view.transitioning) return
    // The box's, not the pointer controls' (which would rotate)
    event.stopImmediatePropagation()
    event.preventDefault()
    this.domElement?.focus({ preventScroll: true })
    earth.camera.stop()
    this.pointerId = event.pointerId
    this.start = this.toElementPixels(event)
    this.end = { ...this.start }
    window.addEventListener('pointermove', this.onPointerMove, { capture: true })
    window.addEventListener('pointerup', this.onPointerUp, { capture: true })
    window.addEventListener('pointercancel', this.onPointerCancel, { capture: true })
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
  }

  protected onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return
    this.end = this.toElementPixels(event)
    this.drawBox()
  }

  protected onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return
    this.end = this.toElementPixels(event)
    const start = this.start
    const end = this.end
    this.cancel()
    if (Math.abs(end.xPixels - start.xPixels) < MINIMUM_BOX_PIXELS && Math.abs(end.yPixels - start.yPixels) < MINIMUM_BOX_PIXELS) return
    this.zoomTo(start, end)
  }

  protected onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) this.cancel()
  }

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.cancel()
  }

  protected drawBox(): void {
    const domElement = this.domElement
    if (domElement === null) return
    if (this.box === null) {
      const box = domElement.ownerDocument.createElement('div')
      box.className = 'react-three-earth-box-zoom'
      box.setAttribute('aria-hidden', 'true')
      Object.assign(box.style, {
        position: 'absolute',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        zIndex: '1',
        border: 'var(--react-three-earth-box-zoom-border, 2px dotted #202020)',
        background: 'var(--react-three-earth-box-zoom-background, rgba(56, 135, 190, 0.1))',
      })
      holdContainerPosition(domElement)
      domElement.append(box)
      this.box = box
    }
    const left = Math.min(this.start.xPixels, this.end.xPixels)
    const top = Math.min(this.start.yPixels, this.end.yPixels)
    this.box.style.left = `${left}px`
    this.box.style.top = `${top}px`
    this.box.style.width = `${Math.abs(this.end.xPixels - this.start.xPixels)}px`
    this.box.style.height = `${Math.abs(this.end.yPixels - this.start.yPixels)}px`
  }

  /** Eases to fit the ground inside the screen box. Override to zoom differently. */
  protected zoomTo(start: ScreenPosition, end: ScreenPosition): void {
    const camera = this.earth.camera
    const positions: GeographicPosition[] = []
    for (const point of boxSamplePoints(start, end)) {
      const position = camera.unproject(point)
      if (position !== null) positions.push(position)
    }
    const bounds = boundsAroundPositions(positions)
    if (bounds === null) return
    void camera.fitBounds(bounds, { linear: true, durationSeconds: this.durationSeconds })
    this.earth.requestFrame()
  }

  dispose(): void {
    this.detach()
  }
}
