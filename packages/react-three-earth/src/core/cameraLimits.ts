import type { GeographicBounds } from './camera.js'
import { wrapLongitudeDegrees } from './projection.js'

/**
 * Bounds the camera stays within, like MapLibre's `minZoom`, `maxZoom`, `minPitch`, `maxPitch` and `maxBounds`.
 * Fields left out are unlimited. Set them with `earth.camera.setLimits` or `<Earth cameraLimits>`.
 *
 * Tilt counts from looking straight down (0) towards the horizon (90), as MapLibre's pitch does; `MapView`'s
 * `pitchDegrees` is the same angle minus 90.
 */
export interface CameraLimits {
  /** Farthest out, as a MapLibre zoom level (512-pixel tiles). */
  minimumZoom?: number
  /** Closest in, as a MapLibre zoom level. */
  maximumZoom?: number
  /** Least tilt, in degrees from looking straight down. */
  minimumTiltDegrees?: number
  /** Most tilt, in degrees from looking straight down (MapLibre's `maxPitch`). */
  maximumTiltDegrees?: number
  /**
   * The box the centre of the screen stays inside. West greater than east crosses the antimeridian. Unlike
   * MapLibre's `maxBounds`, the screen's edges may show what lies beyond: only the centre is held.
   */
  maximumBounds?: GeographicBounds
}

/** The parts of a view that limits change. */
export interface LimitedView {
  longitudeDegrees: number
  latitudeDegrees: number
  zoom: number
  pitchDegrees: number
}

/** True when at least one limit is set. */
export function hasCameraLimits(limits: CameraLimits): boolean {
  return (
    limits.minimumZoom !== undefined ||
    limits.maximumZoom !== undefined ||
    limits.minimumTiltDegrees !== undefined ||
    limits.maximumTiltDegrees !== undefined ||
    limits.maximumBounds !== undefined
  )
}

/**
 * Checks the limits and returns a copy with the fields of each pair in order. Warns, stating the fix, when a
 * minimum is above its maximum or a value is not finite, and drops that pair.
 */
export function validateCameraLimits(limits: CameraLimits): CameraLimits {
  const valid: CameraLimits = {}
  const pair = (name: string, minimum: number | undefined, maximum: number | undefined): [number | undefined, number | undefined] => {
    for (const value of [minimum, maximum]) {
      if (value !== undefined && !Number.isFinite(value)) {
        console.warn(`EarthCamera.setLimits: ${name} limits must be finite numbers; they are ignored. Leave a field out to leave it unlimited.`)
        return [undefined, undefined]
      }
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      console.warn(`EarthCamera.setLimits: minimum ${name} (${minimum}) is above maximum ${name} (${maximum}); both are ignored. Swap them.`)
      return [undefined, undefined]
    }
    return [minimum, maximum]
  }
  const [minimumZoom, maximumZoom] = pair('zoom', limits.minimumZoom, limits.maximumZoom)
  if (minimumZoom !== undefined) valid.minimumZoom = minimumZoom
  if (maximumZoom !== undefined) valid.maximumZoom = maximumZoom
  // Tilt runs from 0 (straight down) to 90 (the horizon): values past either end are held there first.
  const clampTilt = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? value : Math.min(90, Math.max(0, value)))
  const [minimumTilt, maximumTilt] = pair('tilt', clampTilt(limits.minimumTiltDegrees), clampTilt(limits.maximumTiltDegrees))
  if (minimumTilt !== undefined) valid.minimumTiltDegrees = minimumTilt
  if (maximumTilt !== undefined) valid.maximumTiltDegrees = maximumTilt
  const bounds = limits.maximumBounds
  if (bounds !== undefined) {
    const values = [bounds.westDegrees, bounds.southDegrees, bounds.eastDegrees, bounds.northDegrees]
    if (!values.every(Number.isFinite)) {
      console.warn('EarthCamera.setLimits: maximumBounds needs finite westDegrees, southDegrees, eastDegrees and northDegrees; it is ignored.')
    } else if (bounds.southDegrees > bounds.northDegrees) {
      console.warn(`EarthCamera.setLimits: maximumBounds has southDegrees (${bounds.southDegrees}) above northDegrees (${bounds.northDegrees}); it is ignored. Swap them.`)
    } else {
      valid.maximumBounds = { ...bounds }
    }
  }
  return valid
}

/** The longitude inside the west-east range (crossing the antimeridian when west > east), else the nearer edge. */
export function clampLongitudeDegrees(longitudeDegrees: number, westDegrees: number, eastDegrees: number): number {
  // A range of a full turn or more holds every longitude.
  if (eastDegrees - westDegrees >= 360) return longitudeDegrees
  const west = wrapLongitudeDegrees(westDegrees)
  const width = (((eastDegrees - westDegrees) % 360) + 360) % 360
  // How far east of the west edge, from 0 to 360.
  const offset = (((longitudeDegrees - west) % 360) + 360) % 360
  if (offset <= width) return longitudeDegrees
  // Outside: the nearer edge, the shorter way round.
  const pastEast = offset - width
  const beforeWest = 360 - offset
  return wrapLongitudeDegrees(pastEast <= beforeWest ? west + width : west)
}

/** The view moved inside the limits; the same object when it already is. */
export function constrainView<View extends LimitedView>(view: View, limits: CameraLimits): View {
  let { longitudeDegrees, latitudeDegrees, zoom, pitchDegrees } = view
  if (limits.minimumZoom !== undefined) zoom = Math.max(zoom, limits.minimumZoom)
  if (limits.maximumZoom !== undefined) zoom = Math.min(zoom, limits.maximumZoom)
  const tilt = pitchDegrees + 90
  if (limits.minimumTiltDegrees !== undefined && tilt < limits.minimumTiltDegrees) pitchDegrees = limits.minimumTiltDegrees - 90
  if (limits.maximumTiltDegrees !== undefined && tilt > limits.maximumTiltDegrees) pitchDegrees = limits.maximumTiltDegrees - 90
  const bounds = limits.maximumBounds
  if (bounds !== undefined) {
    latitudeDegrees = Math.min(Math.max(latitudeDegrees, bounds.southDegrees), bounds.northDegrees)
    longitudeDegrees = clampLongitudeDegrees(longitudeDegrees, bounds.westDegrees, bounds.eastDegrees)
  }
  if (
    longitudeDegrees === view.longitudeDegrees &&
    latitudeDegrees === view.latitudeDegrees &&
    zoom === view.zoom &&
    pitchDegrees === view.pitchDegrees
  ) {
    return view
  }
  return { ...view, longitudeDegrees, latitudeDegrees, zoom, pitchDegrees }
}
