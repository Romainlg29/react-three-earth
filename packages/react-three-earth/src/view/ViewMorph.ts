import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Matrix4, Plane, Quaternion, Ray, Vector3, type Camera } from 'three'

import {
  latitudeToMercatorY,
  longitudeToMercatorX,
  mercatorScaleFactor,
  mercatorXToLongitude,
  mercatorYToLatitude,
  WEB_MERCATOR_HALF_EXTENT_METERS,
} from './webMercator.js'

/** `'3d'`: the globe. `'2d'`: a flat Web Mercator map of the same terrain and imagery. */
export type ViewMode = '2d' | '3d'

export interface ViewTransitionOptions {
  /**
   * Length of the transition, in which the map unrolls off the globe or rolls back up. 0 switches at once.
   * Default: 1.8.
   */
  durationSeconds?: number
}

const DEFAULT_TRANSITION_SECONDS = 1.8
/** How far the camera pulls back halfway through a transition, as a share of its distance. */
const TRANSITION_BREATH = 0.06
/** Most copies of the world drawn side by side on the flat map. */
export const MAXIMUM_WORLD_COPIES = 5
const WORLD_WIDTH_METERS = 2 * WEB_MERCATOR_HALF_EXTENT_METERS

/** What the flat map needs from a camera to fit it: a perspective camera's field of view and aspect. */
type PerspectiveLike = Camera & { fov?: number; aspect?: number }

const east = new Vector3()
const north = new Vector3()
const scratchVector = new Vector3()
const scratchPosition = new Vector3()
const scratchScale = new Vector3()
const scratchQuaternion = new Quaternion()
const scratchMatrix = new Matrix4()
const scratchMatrix2 = new Matrix4()
const scratchMatrix3 = new Matrix4()
const ray = new Ray()
const plane = new Plane()
const cartographic = { lat: 0, lon: 0, height: 0 }
const cameraFlat = new Vector3()
const cornerFlat = new Vector3()
const screenUp = new Vector3()
const screenRight = new Vector3()
const anchorNorth = new Vector3()
const NDC_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const

/**
 * A transition between globe and map. The camera holds its place, only turning to look straight down
 * (towards the map) and easing to a height the map allows, while the projection changes under it: the map
 * unrolls from the point looked at outwards, or rolls back up from its edges (see `FlatMapPlugin`). Time runs
 * from 0 (start view) to 1 (target view), and backwards when the transition is reversed halfway.
 */
interface Transition {
  /** True if time 1 is the flat map. */
  readonly towardsFlatMap: boolean
  timeFraction: number
  /** +1 playing forward, -1 reversed. */
  direction: 1 | -1
  durationSeconds: number
  readonly camera: Camera
  readonly pivot: Vector3
  readonly startDirection: Vector3
  /** Turns `startDirection` to straight above the pivot. */
  readonly directionRotation: Quaternion
  readonly startQuaternion: Quaternion
  readonly topDownQuaternion: Quaternion
  readonly startDistanceMeters: number
  readonly endDistanceMeters: number
  /** Slide that keeps the end view within the map's poles (zero towards the globe). */
  readonly endOffset: Vector3
}

function smootherstep(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

/** Interpolates distances geometrically, so a change of height feels like a steady zoom. */
function logarithmicLerp(from: number, to: number, amount: number): number {
  return from * Math.pow(to / from, amount)
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value)
}

/**
 * The state of the globe-to-map morph, shared by the terrain, the atmosphere and the controls.
 *
 * The flat map is laid on the plane tangent to the ellipsoid at an anchor, the point the camera looked at
 * when the morph started, and scaled so that around the anchor it matches the globe at true size. The
 * camera never jumps: near the anchor, globe and map coincide, and the rest of the globe unrolls into the
 * plane. The map's own coordinates ("flat coordinates") are Web Mercator metres: x east, y north, and z the
 * height times the projection's scale factor, so relief keeps its shape at every latitude.
 *
 * Everything here is in the Earth's frame (ECEF metres). The camera is read and moved in world space, so
 * keep the `Earth` at the scene origin (its default), as `setCameraView` and the controls also assume.
 */
export class ViewMorph {
  /** The view shown, or being morphed to. */
  mode: ViewMode = '3d'

  /** Progress of the unroll from the globe (0) to the map (1). */
  protected progress = 0
  protected durationSeconds = DEFAULT_TRANSITION_SECONDS
  /** Set by `setMode`, consumed by the next `update`, which has the camera. */
  protected pendingStart = false
  protected transition: Transition | null = null

  anchorLongitudeRadians = 0
  anchorLatitudeRadians = 0
  /** Web Mercator x of the anchor. */
  anchorMercatorXMeters = 0
  /** ECEF position of the anchor, on the ellipsoid. */
  readonly anchorPosition = new Vector3()
  /** Ellipsoid normal at the anchor: the map plane's normal. */
  readonly anchorUp = new Vector3(0, 0, 1)
  /** Map metres per Web Mercator metre: `cos(anchorLatitudeRadians)`, so the map is true to scale at the anchor. */
  scale = 1
  /** Flat coordinates to ECEF. A similarity: rotation, uniform scale and translation. */
  readonly flatToEarth = new Matrix4()
  /** ECEF to flat coordinates. */
  readonly earthToFlat = new Matrix4()
  /** The anchor's east-north-up frame in ECEF (rigid): map-plane axes, origin at the anchor. */
  readonly anchorFrame = new Matrix4()

  /**
   * Brightness of unlit imagery on the flat map. In 2D the terrain is shown as a map, without sunlight, so
   * night and slopes do not darken it: the imagery colour times this value is emitted, fading in with the
   * morph. `<Atmosphere>` sets it to undo its exposure, and the atmosphere's sun fades out as it fades in.
   * Lights of your own are not touched: scale them by `1 - morph` (the playground's `PlainLights` does), or
   * the map is lit and emitted at once and looks too bright.
   */
  flatMapLuminance = 1

  /**
   * Copies of the world drawn side by side on the flat map, as on MapLibre: `worldCopyCount` copies
   * starting `firstWorldCopy` world widths east of the copy around `worldCopyReferenceXMeters`. `update` fits them to the camera.
   * One copy (0) on the globe and during the morph.
   */
  firstWorldCopy = 0
  worldCopyCount = 1
  /**
   * Web Mercator x that meshes and tiles are wrapped around (within half a world): the camera's on the
   * flat map, so everything near the camera is drawn without a shader offset at full precision, and the
   * anchor's otherwise.
   */
  worldCopyReferenceXMeters = 0

  constructor() {
    this.setAnchor(0, 0)
  }

  /** 0 on the globe, 1 on the flat map, eased in between. */
  get morph(): number {
    return smoothstep(this.progress)
  }

  /** True while a transition runs, or until the next `update` after `setMode`. */
  get transitioning(): boolean {
    return this.pendingStart || this.transition !== null
  }

  /**
   * Starts a transition to a view; it begins on the next `update`. Switching back halfway plays it in
   * reverse from where it is. Asking for the view already shown or headed to only changes the length.
   */
  setMode(mode: ViewMode, { durationSeconds = DEFAULT_TRANSITION_SECONDS }: ViewTransitionOptions = {}): void {
    const transition = this.transition
    if (mode === this.mode) {
      // Already headed there: only a running transition changes speed (a pending one keeps its own length).
      if (!this.pendingStart) this.setDuration(durationSeconds)
      return
    }
    this.mode = mode
    this.setDuration(durationSeconds)
    if (transition !== null) {
      transition.direction = (mode === '2d') === transition.towardsFlatMap ? 1 : -1
      return
    }
    // Back to the view shown before the transition even started: nothing to do.
    this.pendingStart = this.progress !== (mode === '2d' ? 1 : 0)
  }

  protected setDuration(durationSeconds: number): void {
    this.durationSeconds = Math.max(0, durationSeconds)
    if (this.transition !== null) this.transition.durationSeconds = this.durationSeconds
  }

  /** Places the map plane tangent to the ellipsoid at this point (radians). Moves the map, not the camera. */
  setAnchor(longitudeRadians: number, latitudeRadians: number): void {
    this.anchorLongitudeRadians = longitudeRadians
    this.anchorLatitudeRadians = latitudeRadians
    this.anchorMercatorXMeters = longitudeToMercatorX(longitudeRadians)
    WGS84_ELLIPSOID.getCartographicToPosition(latitudeRadians, longitudeRadians, 0, this.anchorPosition)
    WGS84_ELLIPSOID.getEastNorthUpAxes(latitudeRadians, longitudeRadians, east, north, this.anchorUp)
    this.anchorFrame.makeBasis(east, north, this.anchorUp).setPosition(this.anchorPosition)
    this.scale = 1 / mercatorScaleFactor(latitudeRadians)
    const scale = this.scale
    this.flatToEarth
      .copy(this.anchorFrame)
      .multiply(scratchMatrix.makeScale(scale, scale, scale))
      .multiply(scratchMatrix.makeTranslation(-longitudeToMercatorX(longitudeRadians), -latitudeToMercatorY(latitudeRadians), 0))
    this.earthToFlat.copy(this.flatToEarth).invert()
  }

  /** Flat coordinates of a geodetic position (radians, metres). */
  geodeticToFlat(longitudeRadians: number, latitudeRadians: number, heightMeters: number, target = new Vector3()): Vector3 {
    return target.set(
      longitudeToMercatorX(longitudeRadians),
      latitudeToMercatorY(latitudeRadians),
      heightMeters * mercatorScaleFactor(latitudeRadians),
    )
  }

  /** Longitude, latitude (radians) and height (metres) of a point given in flat coordinates. */
  flatToGeodetic(flat: Vector3): { longitudeRadians: number; latitudeRadians: number; heightMeters: number } {
    const latitudeRadians = mercatorYToLatitude(flat.y)
    return { longitudeRadians: mercatorXToLongitude(flat.x), latitudeRadians, heightMeters: flat.z / mercatorScaleFactor(latitudeRadians) }
  }

  /**
   * Advances the transition. Call once per frame with the camera the map is seen through: the transition
   * picks its anchor from the camera when it starts, then moves it.
   * Returns true while the transition runs.
   */
  update(camera: Camera, deltaSeconds: number): boolean {
    if (this.pendingStart) {
      this.pendingStart = false
      this.transition = this.begin(camera)
    }
    const transition = this.transition
    if (transition === null) return false
    const step = transition.durationSeconds === 0 ? 1 : deltaSeconds / transition.durationSeconds
    transition.timeFraction = MathUtils.clamp(transition.timeFraction + transition.direction * step, 0, 1)
    this.applyTransition(transition)
    const finished = transition.direction === 1 ? transition.timeFraction === 1 : transition.timeFraction === 0
    if (finished) this.transition = null
    return true
  }

  /**
   * Fits the world copies to what the camera sees on the flat map. `Earth.update` calls it every frame,
   * after `update`.
   */
  updateWorldCopies(camera: Camera): void {
    if (this.morph !== 1) {
      this.firstWorldCopy = 0
      this.worldCopyCount = 1
      this.worldCopyReferenceXMeters = this.anchorMercatorXMeters
      return
    }
    camera.updateMatrixWorld()
    cameraFlat.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.earthToFlat)
    let westMeters = cameraFlat.x
    let eastMeters = cameraFlat.x
    for (const [x, y] of NDC_CORNERS) {
      cornerFlat.set(x, y, 0.5).unproject(camera).applyMatrix4(this.earthToFlat).sub(cameraFlat)
      // A corner above the horizon (a tilted view) sees the map run on: take as many copies as allowed.
      const distance = cornerFlat.z < 0 ? -cameraFlat.z / cornerFlat.z : Infinity
      const hitX = cameraFlat.x + cornerFlat.x * distance
      westMeters = Math.min(westMeters, Number.isFinite(hitX) ? hitX : -Infinity)
      eastMeters = Math.max(eastMeters, Number.isFinite(hitX) ? hitX : Infinity)
    }
    const reference = cameraFlat.x
    this.worldCopyReferenceXMeters = reference
    // Meshes are placed by their centre within half a world of the reference, and the widest tiles span
    // half a world: a copy can reach three quarters of a world past its centre.
    const reach = 1.5 * WEB_MERCATOR_HALF_EXTENT_METERS
    const half = Math.floor(MAXIMUM_WORLD_COPIES / 2)
    const first = Math.max(-half, Math.ceil((westMeters - reference - reach) / WORLD_WIDTH_METERS))
    const last = Math.min(half, Math.floor((eastMeters - reference + reach) / WORLD_WIDTH_METERS))
    this.firstWorldCopy = Math.min(first, 0)
    this.worldCopyCount = Math.max(last, 0) - this.firstWorldCopy + 1
  }

  /**
   * How far north and south a camera at 1 m above the map sees, in metres, with this orientation: screen
   * half-extents projected on the map's north axis. Top-down approximation (exact without tilt).
   */
  protected northHalfExtentPerHeight(camera: PerspectiveLike, quaternion: Quaternion): number {
    const tangentVertical = Math.tan(MathUtils.degToRad((camera.fov ?? 60) / 2))
    const tangentHorizontal = tangentVertical * (camera.aspect ?? 1)
    anchorNorth.set(0, 1, 0).transformDirection(this.anchorFrame)
    screenUp.set(0, 1, 0).applyQuaternion(quaternion)
    screenRight.set(1, 0, 0).applyQuaternion(quaternion)
    return tangentVertical * Math.abs(screenUp.dot(anchorNorth)) + tangentHorizontal * Math.abs(screenRight.dot(anchorNorth))
  }

  /**
   * Highest the camera may be above the flat map, in metres: where the map's full height (about ±85°)
   * just fills the screen north to south, like MapLibre's lowest zoom.
   */
  maximumFlatCameraHeightMeters(camera: PerspectiveLike, quaternion: Quaternion = camera.quaternion): number {
    return (WEB_MERCATOR_HALF_EXTENT_METERS * this.scale) / Math.max(this.northHalfExtentPerHeight(camera, quaternion), 1e-6)
  }

  /**
   * Keeps a camera on the flat map like MapLibre: no higher than the map's full height fits, never showing
   * past its north and south edges, and, since the world repeats, brought back to the anchor's copy of the
   * world when it pans more than half a world away (the view does not change). Controls call it after
   * moving the camera, with `wrap: false` mid-drag (the drag's grip point would not follow). The camera
   * must have no parent (R3F's default camera has none). Returns true if the camera moved.
   */
  constrainFlatCamera(camera: PerspectiveLike, { wrap = true }: { wrap?: boolean } = {}): boolean {
    camera.updateMatrixWorld()
    cameraFlat.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.earthToFlat)
    const before = cameraFlat.clone()
    const scale = this.scale
    // Flat coordinates are metres before the map's scale: heights here are divided by it.
    const maximumHeight = this.maximumFlatCameraHeightMeters(camera) / scale
    if (cameraFlat.z > maximumHeight) cameraFlat.z = maximumHeight
    const northHalfExtent = Math.max(cameraFlat.z, 0) * this.northHalfExtentPerHeight(camera, camera.quaternion)
    const northLimit = Math.max(WEB_MERCATOR_HALF_EXTENT_METERS - northHalfExtent, 0)
    cameraFlat.y = MathUtils.clamp(cameraFlat.y, -northLimit, northLimit)
    if (wrap) cameraFlat.x -= Math.round((cameraFlat.x - this.anchorMercatorXMeters) / WORLD_WIDTH_METERS) * WORLD_WIDTH_METERS
    if (cameraFlat.distanceToSquared(before) === 0) return false
    // The camera has no parent (R3F's default camera): its world position is its position.
    camera.position.copy(cameraFlat.applyMatrix4(this.flatToEarth))
    camera.updateMatrixWorld()
    return true
  }

  protected begin(camera: Camera): Transition | null {
    camera.updateMatrixWorld()
    const towardsFlatMap = this.mode === '2d'
    if (this.progress === (towardsFlatMap ? 1 : 0)) return null
    if (towardsFlatMap) {
      // Leaving the globe: anchor the map where the camera looks.
      const pivot = this.findGlobeCenterPoint(camera, scratchPosition)
      WGS84_ELLIPSOID.getPositionToCartographic(pivot, cartographic)
      this.setAnchor(cartographic.lon, cartographic.lat)
    } else {
      // Leaving the map: re-anchor where the camera looks now, so the globe rolls up around that place.
      this.reanchorAtMapCenter(camera)
    }
    return this.createTransition(camera, towardsFlatMap)
  }

  protected findGlobeCenterPoint(camera: Camera, target: Vector3): Vector3 {
    ray.origin.setFromMatrixPosition(camera.matrixWorld)
    ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld)
    if (WGS84_ELLIPSOID.intersectRay(ray, target) !== null) return target
    return WGS84_ELLIPSOID.getPositionToSurfacePoint(ray.origin, target)
  }

  protected reanchorAtMapCenter(camera: Camera): void {
    ray.origin.setFromMatrixPosition(camera.matrixWorld)
    ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld)
    plane.setFromNormalAndCoplanarPoint(this.anchorUp, this.anchorPosition)
    const hit = ray.intersectPlane(plane, scratchVector) ?? plane.projectPoint(ray.origin, scratchVector)
    const flat = hit.applyMatrix4(this.earthToFlat)
    const { longitudeRadians: longitude, latitudeRadians: latitude } = this.flatToGeodetic(flat)

    // Moving the anchor moves the map: carry the camera with it, so the view does not change.
    const previousEarthToFlat = scratchMatrix2.copy(this.earthToFlat)
    const wrappedLongitude = MathUtils.euclideanModulo(longitude + Math.PI, 2 * Math.PI) - Math.PI
    this.setAnchor(wrappedLongitude, latitude)
    // Past ±180° the camera sits on another copy of the world: bring it back by whole world widths too.
    const worldCopiesCrossed = Math.round((longitude - wrappedLongitude) / (2 * Math.PI))
    scratchMatrix3.makeTranslation(-worldCopiesCrossed * WORLD_WIDTH_METERS, 0, 0)
    const transform = previousEarthToFlat.premultiply(scratchMatrix3).premultiply(this.flatToEarth)
    camera.matrix.compose(camera.position, camera.quaternion, camera.scale).premultiply(transform)
    camera.matrix.decompose(camera.position, camera.quaternion, scratchScale)
    transform.decompose(scratchVector, scratchQuaternion, scratchScale)
    camera.up.applyQuaternion(scratchQuaternion)
    camera.updateMatrixWorld()
  }

  protected createTransition(camera: PerspectiveLike, towardsFlatMap: boolean): Transition {
    const pivot = this.anchorPosition.clone()
    const position = new Vector3().setFromMatrixPosition(camera.matrixWorld)
    const startDistanceMeters = Math.max(position.distanceTo(pivot), 1)
    const up = this.anchorUp
    const startDirection = position.clone().sub(pivot).divideScalar(startDistanceMeters)

    // Keep the heading: screen-up becomes the camera's forward direction, flattened onto the map plane.
    const forward = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld)
    const heading = forward.clone().addScaledVector(up, -forward.dot(up))
    if (heading.lengthSq() < 1e-6) {
      heading.set(0, 1, 0).transformDirection(camera.matrixWorld)
      heading.addScaledVector(up, -heading.dot(up))
    }
    if (heading.lengthSq() < 1e-8) heading.set(0, 1, 0).transformDirection(this.anchorFrame)
    heading.normalize()
    const right = new Vector3().crossVectors(heading, up)
    const topDownQuaternion = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, heading, up))

    // No higher than the flat map's full height.
    const endDistanceMeters = towardsFlatMap
      ? Math.min(startDistanceMeters, this.maximumFlatCameraHeightMeters(camera, topDownQuaternion))
      : startDistanceMeters
    return {
      towardsFlatMap,
      timeFraction: 0,
      direction: 1,
      durationSeconds: this.durationSeconds,
      camera,
      pivot,
      startDirection,
      directionRotation: new Quaternion().setFromUnitVectors(startDirection, up),
      startQuaternion: camera.quaternion.clone(),
      topDownQuaternion,
      startDistanceMeters,
      endDistanceMeters,
      endOffset: towardsFlatMap ? this.poleClampOffset(camera, topDownQuaternion, endDistanceMeters) : new Vector3(),
    }
  }

  /** World offset along the anchor's north that keeps a top-down view at this height within the poles. */
  protected poleClampOffset(camera: PerspectiveLike, quaternion: Quaternion, heightMeters: number): Vector3 {
    const northHalfExtent = (heightMeters / this.scale) * this.northHalfExtentPerHeight(camera, quaternion)
    const limit = Math.max(WEB_MERCATOR_HALF_EXTENT_METERS - northHalfExtent, 0)
    const anchorY = latitudeToMercatorY(this.anchorLatitudeRadians)
    const shift = (MathUtils.clamp(anchorY, -limit, limit) - anchorY) * this.scale
    return new Vector3(0, 1, 0).transformDirection(this.anchorFrame).multiplyScalar(shift)
  }

  /** Poses the camera and sets the projection for the transition's current time. */
  protected applyTransition(transition: Transition): void {
    const { timeFraction, camera } = transition
    // Towards the map, the camera turns to look down in the first half, as the map starts to unroll.
    const turn = smootherstep(MathUtils.clamp(timeFraction / 0.5, 0, 1))
    const ease = smootherstep(timeFraction)
    this.progress = transition.towardsFlatMap ? timeFraction : 1 - timeFraction
    scratchQuaternion.identity().slerp(transition.directionRotation, turn)
    camera.position
      .copy(transition.startDirection)
      .applyQuaternion(scratchQuaternion)
      // A slight pull-back while the map unrolls, settling at the end: the camera breathes with the morph.
      .multiplyScalar(logarithmicLerp(transition.startDistanceMeters, transition.endDistanceMeters, ease) * (1 + TRANSITION_BREATH * Math.sin(Math.PI * ease)))
      .add(transition.pivot)
      .addScaledVector(transition.endOffset, ease)
    camera.quaternion.slerpQuaternions(transition.startQuaternion, transition.topDownQuaternion, turn)
    camera.up.copy(this.anchorUp)
    camera.updateMatrixWorld()
  }

  /** Plain JSON, for `Earth.inspect`. */
  inspect(): { mode: ViewMode; morph: number; anchorLongitudeDegrees: number; anchorLatitudeDegrees: number } {
    return {
      mode: this.mode,
      morph: this.morph,
      anchorLongitudeDegrees: MathUtils.radToDeg(this.anchorLongitudeRadians),
      anchorLatitudeDegrees: MathUtils.radToDeg(this.anchorLatitudeRadians),
    }
  }
}
