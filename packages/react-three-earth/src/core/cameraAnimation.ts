import { MathUtils } from 'three'

import {
  clampLatitudeToWebMercator,
  latitudeToMercatorY,
  longitudeToMercatorX,
  mercatorXToLongitude,
  mercatorYToLatitude,
} from '../view/webMercator.js'
import type { GeographicBounds } from './camera.js'
import { wrapLongitudeDegrees } from './projection.js'
import { zoomToMercatorMetersPerPixel } from './zoom.js'

/** Space kept clear on each side of the screen, in CSS pixels. MapLibre's `padding`. */
export interface ViewPadding {
  topPixels: number
  rightPixels: number
  bottomPixels: number
  leftPixels: number
}

/** The same padding on every side, or some sides (the others are 0). */
export type PaddingPixels = number | Partial<ViewPadding>

/** Turns `PaddingPixels` into a full `ViewPadding`. */
export function toViewPadding(padding: PaddingPixels | undefined): ViewPadding {
  if (typeof padding === 'number') return { topPixels: padding, rightPixels: padding, bottomPixels: padding, leftPixels: padding }
  return { topPixels: padding?.topPixels ?? 0, rightPixels: padding?.rightPixels ?? 0, bottomPixels: padding?.bottomPixels ?? 0, leftPixels: padding?.leftPixels ?? 0 }
}

/** Options every camera animation takes. */
export interface AnimationOptions {
  /** Length of the animation. 0 jumps. Default: 0.5 for `easeTo` and its shortcuts; computed for `flyTo`. */
  durationSeconds?: number
  /** Maps time (0 to 1) to progress (0 to 1). Default: `defaultEasing`, CSS `ease`. */
  easing?: (time: number) => number
  /**
   * Animate even when the user asked the system to reduce motion (`prefers-reduced-motion`). Without it,
   * the camera jumps to the end for those users. Default: false.
   */
  essential?: boolean
}

/** `flyTo`'s options: van Wijk and Nuij's "smooth and efficient zooming and panning", as MapLibre does it. */
export interface FlyToOptions extends AnimationOptions {
  /**
   * How far the camera zooms out along the way: higher zooms out more. 1.42 is what people chose as most
   * pleasing in van Wijk and Nuij's study. Default: 1.42.
   */
  curve?: number
  /** Average speed along the curve, in screenfuls per second. Ignored with `durationSeconds`. Default: 1.2. */
  speed?: number
  /** Average speed in screenfuls per second as if `curve` were 1. Wins over `speed`. */
  screenSpeed?: number
  /** Longer flights than this jump instead. Default: no limit. */
  maximumDurationSeconds?: number
  /** The zoom at the top of the curve. Overrides `curve`. */
  minimumZoom?: number
}

/** `fitBounds`' and `cameraForBounds`' options. */
export interface FitBoundsOptions extends FlyToOptions {
  /** Space around the bounds, in CSS pixels, on top of `earth.camera.padding`. Default: 0. */
  paddingPixels?: PaddingPixels
  /** The closest zoom to fit at, so a tiny box does not zoom in all the way. Default: 22. */
  maximumZoom?: number
  /** Default: the current heading. */
  headingDegrees?: number
  /** Default: the current pitch. */
  pitchDegrees?: number
  /** True eases along a straight line (`easeTo`); false flies (`flyTo`). Default: false. */
  linear?: boolean
}

/** The zoom `fitBounds` stops at by default, as MapLibre's default `maxZoom`. */
export const DEFAULT_FIT_MAXIMUM_ZOOM = 22

/**
 * A cubic Bézier easing from (0, 0) to (1, 1) with control points (x1, y1) and (x2, y2), like CSS
 * `cubic-bezier()`. x1 and x2 must lie in [0, 1].
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (time: number) => {
    if (time <= 0) return 0
    if (time >= 1) return 1
    // Newton's method, then bisection where the slope is too flat.
    let t = time
    for (let iteration = 0; iteration < 8; iteration++) {
      const error = sampleX(t) - time
      if (Math.abs(error) < 1e-7) return sampleY(t)
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    let low = 0
    let high = 1
    t = time
    for (let iteration = 0; iteration < 40; iteration++) {
      const x = sampleX(t)
      if (Math.abs(x - time) < 1e-7) break
      if (x < time) low = t
      else high = t
      t = (low + high) / 2
    }
    return sampleY(t)
  }
}

/** CSS `ease`, MapLibre's default easing. */
export const defaultEasing = cubicBezier(0.25, 0.1, 0.25, 1)

/** Straight through: progress equals time. */
export const linearEasing = (time: number) => time

/** True when the user asked the system to reduce motion. False outside a browser. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Interpolates an angle in degrees the short way round. */
export function interpolateDegrees(fromDegrees: number, toDegrees: number, amount: number): number {
  return fromDegrees + wrapLongitudeDegrees(toDegrees - fromDegrees) * amount
}

/** Web Mercator metres of a position (y up, x unwrapped as given). */
export function toMercatorMeters(longitudeDegrees: number, latitudeDegrees: number): { xMeters: number; yMeters: number } {
  return {
    xMeters: longitudeToMercatorX(MathUtils.degToRad(longitudeDegrees)),
    yMeters: latitudeToMercatorY(clampLatitudeToWebMercator(MathUtils.degToRad(latitudeDegrees))),
  }
}

/** The position of Web Mercator metres; the longitude is wrapped to [-180, 180). */
export function fromMercatorMeters(xMeters: number, yMeters: number): { longitudeDegrees: number; latitudeDegrees: number } {
  return {
    longitudeDegrees: wrapLongitudeDegrees(MathUtils.radToDeg(mercatorXToLongitude(xMeters))),
    latitudeDegrees: MathUtils.radToDeg(mercatorYToLatitude(yMeters)),
  }
}

/** A centre between two others, at `amount` (0 to 1) of the way. */
export type CenterPath = (amount: number) => { longitudeDegrees: number; latitudeDegrees: number }

/** A straight line on the Web Mercator map, the short way round the antimeridian. */
export function mercatorCenterPath(
  from: { longitudeDegrees: number; latitudeDegrees: number },
  to: { longitudeDegrees: number; latitudeDegrees: number },
): CenterPath {
  const start = toMercatorMeters(from.longitudeDegrees, from.latitudeDegrees)
  const end = toMercatorMeters(from.longitudeDegrees + wrapLongitudeDegrees(to.longitudeDegrees - from.longitudeDegrees), to.latitudeDegrees)
  return amount => {
    if (amount >= 1) return { longitudeDegrees: to.longitudeDegrees, latitudeDegrees: to.latitudeDegrees }
    return fromMercatorMeters(MathUtils.lerp(start.xMeters, end.xMeters, amount), MathUtils.lerp(start.yMeters, end.yMeters, amount))
  }
}

/** The great circle between two positions (on a sphere, close enough for a camera path). */
export function greatCircleCenterPath(
  from: { longitudeDegrees: number; latitudeDegrees: number },
  to: { longitudeDegrees: number; latitudeDegrees: number },
): CenterPath {
  const unit = ({ longitudeDegrees, latitudeDegrees }: { longitudeDegrees: number; latitudeDegrees: number }) => {
    const longitude = MathUtils.degToRad(longitudeDegrees)
    const latitude = MathUtils.degToRad(latitudeDegrees)
    return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)] as const
  }
  const a = unit(from)
  const b = unit(to)
  const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
  // Nearly the same point, or exactly opposite (no single great circle): the map's straight line.
  if (angle < 1e-9 || Math.PI - angle < 1e-6) return mercatorCenterPath(from, to)
  const sine = Math.sin(angle)
  return amount => {
    if (amount >= 1) return { longitudeDegrees: to.longitudeDegrees, latitudeDegrees: to.latitudeDegrees }
    const weightA = Math.sin((1 - amount) * angle) / sine
    const weightB = Math.sin(amount * angle) / sine
    const x = weightA * a[0] + weightB * b[0]
    const y = weightA * a[1] + weightB * b[1]
    const z = weightA * a[2] + weightB * b[2]
    return { longitudeDegrees: MathUtils.radToDeg(Math.atan2(y, x)), latitudeDegrees: MathUtils.radToDeg(Math.atan2(z, Math.hypot(x, y))) }
  }
}

/** Distance between two centres on the Web Mercator map, in pixels at `zoom`, the short way round. */
export function mercatorDistancePixels(
  from: { longitudeDegrees: number; latitudeDegrees: number },
  to: { longitudeDegrees: number; latitudeDegrees: number },
  zoom: number,
): number {
  const start = toMercatorMeters(from.longitudeDegrees, from.latitudeDegrees)
  const end = toMercatorMeters(from.longitudeDegrees + wrapLongitudeDegrees(to.longitudeDegrees - from.longitudeDegrees), to.latitudeDegrees)
  return Math.hypot(end.xMeters - start.xMeters, end.yMeters - start.yMeters) / zoomToMercatorMetersPerPixel(zoom)
}

/** A van Wijk–Nuij flight: how far along the centre is and how wide the view is, at each step `s` of the path. */
export interface FlightPath {
  /** Length of the path, in the curve's own units. 0 when nothing changes. */
  length: number
  /** The curvature used: `curve`, or the one `minimumZoomChange` called for. */
  curve: number
  /** Share of the way from the start centre to the end centre (0 to 1) at step `s`. */
  centerAmount(s: number): number
  /** Zoom change from the start at step `s`, in zoom levels. */
  zoomChange(s: number): number
}

/**
 * The flight from one view to another, after van Wijk and Nuij, "Smooth and efficient zooming and panning"
 * (2003), as MapLibre's `flyTo` does it. `startWidthPixels` is the visible width (the larger screen side,
 * less padding), `distancePixels` the distance between the centres in pixels at the start zoom, and
 * `zoomChange` the end zoom minus the start zoom.
 */
export function createFlightPath({
  startWidthPixels,
  distancePixels,
  zoomChange,
  curve = 1.42,
  minimumZoomChange,
}: {
  startWidthPixels: number
  distancePixels: number
  zoomChange: number
  curve?: number
  /** The top of the curve, as a zoom change from the start (negative zooms out). Overrides `curve`. */
  minimumZoomChange?: number
}): FlightPath {
  const w0 = startWidthPixels
  const w1 = w0 / 2 ** zoomChange
  const u1 = distancePixels
  let rho = curve
  if (minimumZoomChange !== undefined && u1 > 0) {
    const widestPixels = w0 / 2 ** Math.min(minimumZoomChange, 0, zoomChange)
    rho = Math.sqrt((widestPixels / u1) * 2)
  }
  const rho2 = rho * rho
  /** r(0) at the start, r(1) at the end: the curve's parameter where the view is w0 and w1 wide. */
  const r = (end: 0 | 1) => {
    const b = (w1 * w1 - w0 * w0 + (end === 1 ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (end === 1 ? w1 : w0) * rho2 * u1)
    return Math.log(Math.sqrt(b * b + 1) - b)
  }
  const r0 = r(0)
  const length = (r(1) - r0) / rho
  if (Math.abs(u1) < 1e-6 || !Number.isFinite(length)) {
    // No pan: zoom only, exponentially.
    if (Math.abs(w0 - w1) < 1e-6) return { length: 0, curve: rho, centerAmount: () => 1, zoomChange: s => (s > 0 ? zoomChange : 0) }
    const direction = w1 < w0 ? -1 : 1
    return {
      length: Math.abs(Math.log(w1 / w0)) / rho,
      curve: rho,
      centerAmount: () => 1,
      // w(s) = exp(direction · rho · s), zoom change = -log2(w(s))
      zoomChange: s => -(direction * rho * s) / Math.LN2,
    }
  }
  return {
    length,
    curve: rho,
    centerAmount: s => (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2)) / u1,
    zoomChange: s => Math.log2(Math.cosh(r0 + rho * s) / Math.cosh(r0)),
  }
}

/** The flight's duration in seconds, from MapLibre's `speed` and `screenSpeed` (screenfuls per second). */
export function flightDurationSeconds(path: FlightPath, { speed = 1.2, screenSpeed }: Pick<FlyToOptions, 'speed' | 'screenSpeed'>): number {
  // Divided by the curvature actually flown, which `minimumZoom` may have replaced.
  const velocity = screenSpeed !== undefined ? screenSpeed / path.curve : speed
  return path.length / velocity
}

/**
 * The centre and zoom that fit a longitude-latitude box into a screen, on the Web Mercator map, seen from
 * above with this heading. `padding` is the space kept clear around the box; `viewPadding` is the part of it
 * that the camera's own padding already shifts the centre by. Null when the padding leaves no room.
 */
export function fitBoundsOnMap(
  bounds: GeographicBounds,
  {
    widthPixels,
    heightPixels,
    padding,
    viewPadding,
    headingDegrees,
    maximumZoom = DEFAULT_FIT_MAXIMUM_ZOOM,
  }: { widthPixels: number; heightPixels: number; padding: ViewPadding; viewPadding: ViewPadding; headingDegrees: number; maximumZoom?: number },
): { longitudeDegrees: number; latitudeDegrees: number; zoom: number } | null {
  const availableWidth = widthPixels - padding.leftPixels - padding.rightPixels
  const availableHeight = heightPixels - padding.topPixels - padding.bottomPixels
  if (availableWidth <= 0 || availableHeight <= 0) return null
  // East unwrapped past west, so a box across the antimeridian stays one box.
  const eastDegrees = bounds.eastDegrees < bounds.westDegrees ? bounds.eastDegrees + 360 : bounds.eastDegrees
  const southWest = toMercatorMeters(bounds.westDegrees, bounds.southDegrees)
  const northEast = toMercatorMeters(eastDegrees, bounds.northDegrees)
  const heading = MathUtils.degToRad(headingDegrees)
  const cosine = Math.cos(heading)
  const sine = Math.sin(heading)
  // The box's corners on the screen's axes: right is (cos h, -sin h) and up is (sin h, cos h) in (east, north).
  let minimumX = Infinity
  let maximumX = -Infinity
  let minimumY = Infinity
  let maximumY = -Infinity
  for (const x of [southWest.xMeters, northEast.xMeters]) {
    for (const y of [southWest.yMeters, northEast.yMeters]) {
      const right = x * cosine - y * sine
      const up = x * sine + y * cosine
      minimumX = Math.min(minimumX, right)
      maximumX = Math.max(maximumX, right)
      minimumY = Math.min(minimumY, up)
      maximumY = Math.max(maximumY, up)
    }
  }
  // Metres per pixel that fit both sides; zoom from it.
  const metersPerPixel = Math.max((maximumX - minimumX) / availableWidth, (maximumY - minimumY) / availableHeight)
  const zoom = Math.min(maximumZoom, metersPerPixel > 0 ? Math.log2(zoomToMercatorMetersPerPixel(0) / metersPerPixel) : Infinity)
  const pixelMeters = zoomToMercatorMetersPerPixel(zoom)
  // The box's centre sits at the middle of the padded area. The camera's centre is the middle of the
  // area its own padding leaves, so shift by the difference: the rest of the padding, half each way.
  const extraRight = (padding.leftPixels - viewPadding.leftPixels - (padding.rightPixels - viewPadding.rightPixels)) / 2
  const extraDown = (padding.topPixels - viewPadding.topPixels - (padding.bottomPixels - viewPadding.bottomPixels)) / 2
  // The camera's centre is at (-extraRight, +extraDown) pixels from the box's centre: left of it when the left padding is larger.
  const centerRight = (minimumX + maximumX) / 2 - extraRight * pixelMeters
  const centerUp = (minimumY + maximumY) / 2 + extraDown * pixelMeters
  const x = centerRight * cosine + centerUp * sine
  const y = -centerRight * sine + centerUp * cosine
  return { ...fromMercatorMeters(x, y), zoom }
}
