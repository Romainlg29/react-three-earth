import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Plane, Quaternion, Ray, Vector2, Vector3, type Camera } from 'three'

/** A finger on the screen, in normalized device coordinates (x right, y up, -1 to 1). */
export type ScreenPoint = Vector2

/** What two fingers did since the last frame: where they were and where they are now. */
export interface TwoFingerFrame {
  /** `transform` pans, zooms and rotates together; `tilt` tips the view (two fingers moving up or down). */
  mode: 'transform' | 'tilt'
  previous: readonly [ScreenPoint, ScreenPoint]
  current: readonly [ScreenPoint, ScreenPoint]
  /** Height of the element, in CSS pixels: turns finger travel into a tilt angle. */
  heightPixels: number
}

interface Finger {
  clientX: number
  clientY: number
}

/** Finger travel, in CSS pixels, before a two-finger gesture picks between tilting and the rest. */
const GESTURE_DECISION_PIXELS = 8

/** The presses and lifts the gestures make up for the controls (a finger handed back after a pinch): no user press. */
export const SYNTHETIC_TOUCH_EVENTS = new WeakSet<Event>()

/**
 * Two-finger touch gestures like Apple Maps and Google Maps: pinch, twist and drag act together, the
 * ground under both fingers staying under them, and a two-finger drag up or down tilts. One finger is
 * left to the controls (pan with fling, double tap to zoom).
 *
 * It listens on the window in the capture phase, ahead of 3DTilesRenderer's controls, and hides the
 * second finger from them: when it lands, the controls are told the first finger lifted, and when one
 * finger is left, that it touched down again where it is, so their own drag restarts cleanly.
 */
export class TouchGestures {
  /** Called when a two-finger gesture starts. */
  onStart: (() => void) | null = null
  /** Whether a two-finger drag up or down may tilt the view. */
  tiltEnabled = true

  protected element: HTMLElement | null = null
  protected readonly fingers = new Map<number, Finger>()
  /** The two fingers of the gesture, in touch order. */
  protected gesturePointerIds: [number, number] | null = null
  protected mode: TwoFingerFrame['mode'] | null = null
  protected readonly gestureStart: [Finger, Finger] = [{ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 }]
  protected readonly frameStart: [Finger, Finger] = [{ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 }]
  protected readonly synthetic = new WeakSet<Event>()
  /** Fingers the controls never saw (a third finger): their events stay hidden until they lift. */
  protected readonly hiddenPointerIds = new Set<number>()
  /** The finger handed back to the controls after a gesture: its lift must not count as a tap. */
  protected handedBackPointerId: number | null = null

  protected readonly handlePointerDown = (event: PointerEvent): void => this.pointerDown(event)
  protected readonly handlePointerMove = (event: PointerEvent): void => this.pointerMove(event)
  protected readonly handlePointerUp = (event: PointerEvent): void => this.pointerUp(event)

  /** Starts listening. Call before attaching the controls, so the gestures see each touch first. */
  attach(element: HTMLElement): void {
    this.detach()
    this.element = element
    window.addEventListener('pointerdown', this.handlePointerDown, { capture: true })
    window.addEventListener('pointermove', this.handlePointerMove, { capture: true })
    window.addEventListener('pointerup', this.handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', this.handlePointerUp, { capture: true })
  }

  detach(): void {
    if (this.element === null) return
    window.removeEventListener('pointerdown', this.handlePointerDown, { capture: true })
    window.removeEventListener('pointermove', this.handlePointerMove, { capture: true })
    window.removeEventListener('pointerup', this.handlePointerUp, { capture: true })
    window.removeEventListener('pointercancel', this.handlePointerUp, { capture: true })
    this.element = null
    this.fingers.clear()
    this.gesturePointerIds = null
    this.mode = null
    this.hiddenPointerIds.clear()
    this.handedBackPointerId = null
  }

  /** True while two fingers are down. */
  get active(): boolean {
    return this.gesturePointerIds !== null
  }

  /**
   * What the fingers did since the last call, or null when there is nothing to apply (no gesture, or one
   * that has not yet picked between tilting and the rest). Call once per frame.
   */
  takeFrame(): TwoFingerFrame | null {
    const ids = this.gesturePointerIds
    const element = this.element
    if (ids === null || element === null || this.mode === null) return null
    const first = this.fingers.get(ids[0])
    const second = this.fingers.get(ids[1])
    if (first === undefined || second === undefined) return null
    const rect = element.getBoundingClientRect()
    const frame: TwoFingerFrame = {
      mode: this.mode,
      previous: [toScreenPoint(this.frameStart[0], rect), toScreenPoint(this.frameStart[1], rect)],
      current: [toScreenPoint(first, rect), toScreenPoint(second, rect)],
      heightPixels: rect.height,
    }
    copyFinger(first, this.frameStart[0])
    copyFinger(second, this.frameStart[1])
    return frame
  }

  protected pointerDown(event: PointerEvent): void {
    if (this.synthetic.has(event) || event.pointerType !== 'touch' || this.element === null) return
    if (!(event.target instanceof Node) || !this.element.contains(event.target)) return
    this.fingers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
    if (this.gesturePointerIds !== null) {
      // A third finger: ignored, and hidden from the controls until it lifts.
      this.hiddenPointerIds.add(event.pointerId)
      event.stopImmediatePropagation()
      return
    }
    // The fingers the controls see: hidden ones (a third finger left from an earlier gesture) never count.
    const visibleIds = [...this.fingers.keys()].filter((id) => !this.hiddenPointerIds.has(id))
    if (visibleIds.length !== 2) return
    const [firstId, secondId] = visibleIds as [number, number]
    this.gesturePointerIds = [firstId, secondId]
    this.mode = null
    this.handedBackPointerId = null
    copyFinger(this.fingers.get(firstId)!, this.gestureStart[0])
    copyFinger(this.fingers.get(secondId)!, this.gestureStart[1])
    copyFinger(this.gestureStart[0], this.frameStart[0])
    copyFinger(this.gestureStart[1], this.frameStart[1])
    event.stopImmediatePropagation()
    // Before the lift below: a plugin holding the first finger's press cancels it rather than taking the lift.
    this.onStart?.()
    // The controls saw the first finger: end its drag, as if it lifted.
    this.dispatchSynthetic('pointerup', firstId, this.fingers.get(firstId)!)
  }

  protected pointerMove(event: PointerEvent): void {
    if (this.synthetic.has(event) || event.pointerType !== 'touch') return
    const finger = this.fingers.get(event.pointerId)
    if (finger === undefined) return
    finger.clientX = event.clientX
    finger.clientY = event.clientY
    if (this.hiddenPointerIds.has(event.pointerId)) {
      event.stopImmediatePropagation()
      return
    }
    if (this.gesturePointerIds === null) return
    event.stopImmediatePropagation()
    event.preventDefault()
    if (this.mode === null) this.mode = this.decideMode()
  }

  protected pointerUp(event: PointerEvent): void {
    if (this.synthetic.has(event) || event.pointerType !== 'touch') return
    const finger = this.fingers.get(event.pointerId)
    if (finger === undefined) return
    finger.clientX = event.clientX
    finger.clientY = event.clientY
    this.fingers.delete(event.pointerId)
    if (this.hiddenPointerIds.delete(event.pointerId)) {
      event.stopImmediatePropagation()
      return
    }
    if (event.pointerId === this.handedBackPointerId) {
      // The controls' tap detection reads button 0 on lift: end the drag with a lift that is no tap.
      this.handedBackPointerId = null
      event.stopImmediatePropagation()
      this.dispatchSynthetic('pointerup', event.pointerId, finger)
      return
    }
    const ids = this.gesturePointerIds
    if (ids === null) return
    event.stopImmediatePropagation()
    if (event.pointerId !== ids[0] && event.pointerId !== ids[1]) return
    this.gesturePointerIds = null
    this.mode = null
    // One finger left on the glass: hand it back to the controls, from where it is now.
    const remainingId = event.pointerId === ids[0] ? ids[1] : ids[0]
    const remaining = this.fingers.get(remainingId)
    if (remaining === undefined) return
    this.handedBackPointerId = remainingId
    this.dispatchSynthetic('pointerdown', remainingId, remaining)
  }

  /** Tilt when both fingers move up or down together without spreading; otherwise pan, zoom and twist. */
  protected decideMode(): TwoFingerFrame['mode'] | null {
    const ids = this.gesturePointerIds!
    const first = this.fingers.get(ids[0])!
    const second = this.fingers.get(ids[1])!
    const [start0, start1] = this.gestureStart
    const dx0 = first.clientX - start0.clientX
    const dy0 = first.clientY - start0.clientY
    const dx1 = second.clientX - start1.clientX
    const dy1 = second.clientY - start1.clientY
    const travel0 = Math.hypot(dx0, dy0)
    const travel1 = Math.hypot(dx1, dy1)
    if (Math.max(travel0, travel1) < GESTURE_DECISION_PIXELS) return null
    // Each finger's move arrives as its own event: wait for the other one, unless it stays put (a twist).
    if (Math.min(travel0, travel1) < GESTURE_DECISION_PIXELS / 2 && Math.max(travel0, travel1) < 3 * GESTURE_DECISION_PIXELS) return null
    const spreadChange = Math.abs(fingerDistance(first, second) - fingerDistance(start0, start1))
    const vertical = Math.min(Math.abs(dy0), Math.abs(dy1))
    const tilting =
      this.tiltEnabled &&
      Math.sign(dy0) === Math.sign(dy1) &&
      Math.abs(dy0) > 1.5 * Math.abs(dx0) &&
      Math.abs(dy1) > 1.5 * Math.abs(dx1) &&
      spreadChange < 0.5 * vertical
    return tilting ? 'tilt' : 'transform'
  }

  protected dispatchSynthetic(type: 'pointerdown' | 'pointerup', pointerId: number, finger: Finger): void {
    const element = this.element
    if (element === null) return
    // button -1: no button changed, so the controls do not count it as a tap (double tap to zoom).
    const event = new PointerEvent(type, {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      clientX: finger.clientX,
      clientY: finger.clientY,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerdown' ? 1 : 0,
      bubbles: true,
      cancelable: true,
    })
    this.synthetic.add(event)
    SYNTHETIC_TOUCH_EVENTS.add(event)
    try {
      element.dispatchEvent(event)
    } catch {
      // A controls handler failed on the synthetic event (pointer capture on a lifted finger): ignore.
    }
  }
}

function copyFinger(from: Finger, to: Finger): void {
  to.clientX = from.clientX
  to.clientY = from.clientY
}

function fingerDistance(a: Finger, b: Finger): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function toScreenPoint(finger: Finger, rect: DOMRect): ScreenPoint {
  return new Vector2(((finger.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((finger.clientY - rect.top) / rect.height) * 2)
}

const ray = new Ray()
const scratchVector = new Vector3()
const scratchQuaternion = new Quaternion()
const planeHits = [new Vector3(), new Vector3(), new Vector3(), new Vector3()] as const
const axisU = new Vector3()
const axisV = new Vector3()
const middlePrevious = new Vector3()
const middleCurrent = new Vector3()
const spanPrevious = new Vector3()
const spanCurrent = new Vector3()

/** The ray from the camera through a screen point (normalized device coordinates), in world space. */
export function getScreenRay(camera: Camera, point: ScreenPoint, target = ray): Ray {
  camera.updateMatrixWorld()
  target.origin.setFromMatrixPosition(camera.matrixWorld)
  target.direction.set(point.x, point.y, 0.5).unproject(camera).sub(target.origin).normalize()
  return target
}

/** Signed angle from `from` to `to` about `axis` (all perpendicular to it, or projected), in radians. */
function signedAngle(from: Vector3, to: Vector3, axis: Vector3): number {
  return Math.atan2(scratchVector.crossVectors(from, to).dot(axis), from.dot(to))
}

/**
 * Moves the camera so that the ground points that were under the fingers (`previous`) are under them now
 * (`current`), on a plane: one similarity (move, turn about the plane's normal, and scale towards the
 * plane) does pan, twist and pinch together. Returns false, leaving the camera, if a finger points above
 * the horizon.
 */
export function applyTwoFingerTransformOnPlane(camera: Camera, plane: Plane, frame: TwoFingerFrame, limits: DistanceLimits = {}): boolean {
  const [previous0, previous1, current0, current1] = planeHits
  const points = [frame.previous[0], frame.previous[1], frame.current[0], frame.current[1]]
  for (let index = 0; index < 4; index++) {
    if (getScreenRay(camera, points[index]!).intersectPlane(plane, planeHits[index]!) === null) return false
  }
  spanPrevious.subVectors(previous1, previous0)
  spanCurrent.subVectors(current1, current0)
  const currentLength = spanCurrent.length()
  if (currentLength < 1e-9) return false
  const normal = plane.normal
  let scale = spanPrevious.length() / currentLength
  const angle = signedAngle(spanCurrent, spanPrevious, normal)
  middlePrevious.addVectors(previous0, previous1).multiplyScalar(0.5)
  middleCurrent.addVectors(current0, current1).multiplyScalar(0.5)
  scale = clampScale(scale, Math.abs(plane.distanceToPoint(camera.position)), limits)
  // X -> middlePrevious + scale * R * (X - middleCurrent)
  scratchQuaternion.setFromAxisAngle(normal, angle)
  camera.position.sub(middleCurrent).applyQuaternion(scratchQuaternion).multiplyScalar(scale).add(middlePrevious)
  camera.quaternion.premultiply(scratchQuaternion)
  camera.updateMatrixWorld()
  return true
}

export interface DistanceLimits {
  /** Lowest height above the ground, in metres. */
  minimumHeightMeters?: number
  /** Highest height above the ground, in metres. */
  maximumHeightMeters?: number
}

function clampScale(scale: number, heightMeters: number, { minimumHeightMeters = 1, maximumHeightMeters = Infinity }: DistanceLimits): number {
  if (heightMeters <= 0) return scale
  return MathUtils.clamp(scale, minimumHeightMeters / heightMeters, maximumHeightMeters / heightMeters)
}

const globeHits = [new Vector3(), new Vector3(), new Vector3(), new Vector3()] as const
const upAtMiddle = new Vector3()

/**
 * The globe's version of `applyTwoFingerTransformOnPlane`, on the WGS84 ellipsoid around the origin: the
 * camera turns about the Earth's centre to bring the fingers' midpoint back under them, twists about the
 * vertical there, and moves towards or away from it with the fingers' spread. When a finger misses the
 * globe (seen from orbit), it only zooms with the spread, towards the Earth's centre.
 */
export function applyTwoFingerTransformOnGlobe(camera: Camera, frame: TwoFingerFrame, limits: DistanceLimits = {}): void {
  const [previous0, previous1, current0, current1] = globeHits
  const points = [frame.previous[0], frame.previous[1], frame.current[0], frame.current[1]]
  let allHit = true
  for (let index = 0; index < 4; index++) {
    if (WGS84_ELLIPSOID.intersectRay(getScreenRay(camera, points[index]!), globeHits[index]!) === null) allHit = false
  }
  const spreadPrevious = frame.previous[0].distanceTo(frame.previous[1])
  const spreadCurrent = frame.current[0].distanceTo(frame.current[1])
  if (!allHit) {
    if (spreadCurrent < 1e-9) return
    const altitude = camera.position.length() - WGS84_ELLIPSOID.radius.x
    const scale = clampScale(spreadPrevious / spreadCurrent, altitude, limits)
    camera.position.setLength(WGS84_ELLIPSOID.radius.x + altitude * scale)
    camera.updateMatrixWorld()
    return
  }
  // Pan: turn about the Earth's centre, taking the midpoint now under the fingers back to where it was.
  middlePrevious.addVectors(previous0, previous1).multiplyScalar(0.5)
  middleCurrent.addVectors(current0, current1).multiplyScalar(0.5)
  scratchQuaternion.setFromUnitVectors(axisU.copy(middleCurrent).normalize(), axisV.copy(middlePrevious).normalize())
  camera.position.applyQuaternion(scratchQuaternion)
  camera.quaternion.premultiply(scratchQuaternion)
  current0.applyQuaternion(scratchQuaternion)
  current1.applyQuaternion(scratchQuaternion)
  // Twist about the vertical at the midpoint.
  WGS84_ELLIPSOID.getPositionToNormal(middlePrevious, upAtMiddle)
  spanPrevious.subVectors(previous1, previous0).projectOnPlane(upAtMiddle)
  spanCurrent.subVectors(current1, current0).projectOnPlane(upAtMiddle)
  const currentLength = spanCurrent.length()
  if (currentLength < 1e-9) {
    camera.updateMatrixWorld()
    return
  }
  const angle = signedAngle(spanCurrent, spanPrevious, upAtMiddle)
  scratchQuaternion.setFromAxisAngle(upAtMiddle, angle)
  camera.position.sub(middlePrevious).applyQuaternion(scratchQuaternion)
  camera.quaternion.premultiply(scratchQuaternion)
  // Pinch: towards or away from the midpoint.
  const height = Math.max(camera.position.dot(upAtMiddle), 0)
  const scale = clampScale(spanPrevious.length() / currentLength, height, limits)
  camera.position.multiplyScalar(scale).add(middlePrevious)
  // The height above was measured from the midpoint's tangent plane, which near the limb understates the
  // altitude: hold the zoom-out cap against the distance from the Earth's centre too.
  const maximumDistance = WGS84_ELLIPSOID.radius.x + (limits.maximumHeightMeters ?? Infinity)
  if (camera.position.length() > maximumDistance) camera.position.setLength(maximumDistance)
  camera.updateMatrixWorld()
}

/** Tilt of a camera away from looking straight down, in radians: 0 looks down, π/2 at the horizon. */
export function getTiltRadians(camera: Camera, up: Vector3): number {
  const forward = scratchVector.set(0, 0, -1).transformDirection(camera.matrixWorld)
  return Math.acos(MathUtils.clamp(-forward.dot(up), -1, 1))
}

const right = new Vector3()

/**
 * Tips the camera about the point it looks at (`pivot`), by the fingers' travel up the screen: half a
 * screen height tilts a quarter turn, as in Apple Maps. Keeps the tilt between 0 (straight down) and
 * `maximumTiltRadians`.
 */
export function applyTwoFingerTilt(camera: Camera, frame: TwoFingerFrame, pivot: Vector3, up: Vector3, maximumTiltRadians: number): void {
  const travel = (frame.current[0].y - frame.previous[0].y + frame.current[1].y - frame.previous[1].y) / 2
  // A screen point's y runs -1 to 1: half a screen height (travel 1) is a quarter turn.
  const requested = (travel * Math.PI) / 2
  const tilt = getTiltRadians(camera, up)
  const angle = MathUtils.clamp(tilt + requested, 0, maximumTiltRadians) - tilt
  if (angle === 0) return
  right.set(1, 0, 0).transformDirection(camera.matrixWorld)
  scratchQuaternion.setFromAxisAngle(right, angle)
  camera.position.sub(pivot).applyQuaternion(scratchQuaternion).add(pivot)
  camera.quaternion.premultiply(scratchQuaternion)
  camera.updateMatrixWorld()
}
