import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Ray, Raycaster, Vector2, Vector3, type Camera, type Intersection } from 'three'

import { mercatorScaleFactor, WEB_MERCATOR_HALF_EXTENT_METERS, wrapMercatorXNear } from '../view/webMercator.js'
import { placeCameraAround, toCartesian, type GeographicBounds, type GeographicPosition } from './camera.js'
import {
  createFlightPath,
  DEFAULT_FIT_MAXIMUM_ZOOM,
  defaultEasing,
  fitBoundsOnMap,
  flightDurationSeconds,
  fromMercatorMeters,
  greatCircleCenterPath,
  interpolateDegrees,
  mercatorCenterPath,
  mercatorDistancePixels,
  prefersReducedMotion,
  toMercatorMeters,
  toViewPadding,
  type AnimationOptions,
  type CenterPath,
  type FitBoundsOptions,
  type FlyToOptions,
  type PaddingPixels,
  type ViewPadding,
} from './cameraAnimation.js'
import { constrainView, hasCameraLimits, validateCameraLimits, type CameraLimits } from './cameraLimits.js'
import type { Earth } from './Earth.js'
import {
  ellipsoidHorizonPoint,
  headingAndPitch,
  intersectEllipsoidOrHorizon,
  isOccludedByEllipsoid,
  wrapLongitudeDegrees,
  type ProjectedPosition,
  type ScreenPosition,
} from './projection.js'
import {
  focalLengthPixels,
  groundMetersPerPixelToZoom,
  mercatorMetersPerPixelToZoom,
  zoomToGroundMetersPerPixel,
  zoomToMercatorMetersPerPixel,
} from './zoom.js'

/** Where the camera is and looks, the way a map describes it. Returned by `EarthCamera.getView`. */
export interface MapView {
  /** The point at the centre of the screen. */
  longitudeDegrees: number
  latitudeDegrees: number
  /** Ellipsoidal height of that point: the terrain's when it is loaded there, otherwise 0. */
  heightMeters: number
  /** MapLibre-equivalent zoom (512-pixel tiles) at the centre of the screen. Continuous. */
  zoom: number
  /** Compass direction the camera faces, clockwise from north. */
  headingDegrees: number
  /** Angle below the horizon: -90 looks straight down, 0 at the horizon. */
  pitchDegrees: number
  /** Distance from the camera to the centre point. */
  distanceMeters: number
}

/**
 * What `EarthCamera.jumpTo` changes. Fields left out keep their current value; `zoom` stays the same
 * when only the centre moves. Give `zoom` or `distanceMeters`; when both are given, `zoom` wins.
 */
export type MapViewChange = Partial<MapView>

/** Above Everest: terrain rays start here and go straight down. */
const TERRAIN_RAY_START_HEIGHT_METERS = 100_000
/** Fixed-point steps that settle a screen ray on the relief of the flat map. */
const FLAT_MAP_RELIEF_ITERATIONS = 4
/** Screen-edge samples per side for `getBounds`. */
const BOUNDS_SAMPLES_PER_EDGE = 8
/** Halvings that place the horizon on a screen edge: 1/4096 of the edge between two samples. */
const HORIZON_BISECTION_STEPS = 12
/** Points along the globe's outline for `getBounds`. */
const HORIZON_SAMPLES = 32

/** Steps that correct a fit on screen (each one projects the box's edges once). */
const FIT_REFINEMENT_STEPS = 6
/** Zoom levels a fit may back out by when part of the box starts past the horizon. */
const FIT_ZOOM_OUT_STEPS = 8
/** Points along each edge of a box when fitting it. */
const FIT_SAMPLES_PER_EDGE = 16
/** MapLibre's default `easeTo` duration. */
const DEFAULT_EASE_DURATION_SECONDS = 0.5

/** What an animation does from its start view: its length and the view at each progress (0 to 1). */
interface AnimationPlan {
  durationSeconds: number
  frame: (progress: number) => MapViewChange
}

interface RunningAnimation {
  /** Builds the plan from the view at the start; null when there is nothing to do. */
  plan: (start: MapView) => AnimationPlan | null
  /** Null until the animation starts (the camera is known and no morph runs). */
  frame: AnimationPlan['frame'] | null
  durationSeconds: number
  elapsedSeconds: number
  easing: (time: number) => number
  reduceMotion: boolean
  /** False until the first frame advanced it. */
  stepped: boolean
  resolve: (completed: boolean) => void
}

/** Differences below these are rounding, not a view outside the limits (re-reading a placed view is not exact). */
const LIMIT_TOLERANCE_ZOOM = 1e-6
const LIMIT_TOLERANCE_DEGREES = 1e-6
/** Halvings that find where a move crossed a zoom limit: 1/4096 of the move. */
const ZOOM_LIMIT_BISECTION_STEPS = 12
/** A step that changes the camera's distance to the ground by more than this share is a zoom. */
const ZOOM_STEP_DISTANCE_SHARE = 0.01
const limitStart = new Vector3()
const limitEnd = new Vector3()

/** Points along a flight sampled for its lowest zoom. */
const FLIGHT_ZOOM_SAMPLES = 64

/** The lowest zoom change along a flight path, sampled. */
function lowestZoomChange(flight: { length: number; zoomChange: (s: number) => number }): number {
  let lowest = 0
  for (let index = 0; index <= FLIGHT_ZOOM_SAMPLES; index++) lowest = Math.min(lowest, flight.zoomChange((index / FLIGHT_ZOOM_SAMPLES) * flight.length))
  return lowest
}

/** The longest first animation step: one frame at 60 fps. */
const FIRST_STEP_SECONDS = 1 / 60

const ray = new Ray()
const flatRay = new Ray()
const raycaster = new Raycaster()
;(raycaster as Raycaster & { firstHitOnly: boolean }).firstHitOnly = true
const hits: Intersection[] = []
const pointer = new Vector2()
const cameraPosition = new Vector3()
const forward = new Vector3()
const cameraUp = new Vector3()
const east = new Vector3()
const north = new Vector3()
const up = new Vector3()
const surfacePoint = new Vector3()
const flatPoint = new Vector3()
const scenePoint = new Vector3()
const flatScenePoint = new Vector3()
const viewPoint = new Vector3()
const screenPoint = { xPixels: 0, yPixels: 0 }
const cartographic = { lat: 0, lon: 0, height: 0 }

/**
 * The map-level view of an `Earth`'s camera: centre, zoom, heading and pitch, bounds, and conversions
 * between geographic positions and screen pixels, on the globe and on the flat map. `Earth` creates one
 * (`earth.camera`) and hands it the camera and viewport size in every `update`.
 *
 * On the globe the centre and `unproject` follow the loaded terrain (ellipsoid where none is loaded); on the
 * flat map they follow its relief. While the view morphs, the view closer to its end is used, except by
 * `project`, which follows the morphing ground exactly.
 */
export class EarthCamera {
  /** The camera the Earth is seen through. Set by every `earth.update`, or with `setCamera`. */
  camera: Camera | null = null
  /** Size of the canvas in CSS pixels. Set by every `earth.update`, or with `setViewportSize`. */
  viewportWidthPixels = 0
  viewportHeightPixels = 0
  /** Space kept clear on each side of the screen. Default: none. Set it with `setPadding`. */
  padding: ViewPadding = toViewPadding(0)
  protected animation: RunningAnimation | null = null
  /** A copy of the camera that `cameraForBounds` measures fits with. */
  protected fitCamera: Camera | null = null
  protected placedView = false
  protected limits: CameraLimits = {}
  /** The camera's world matrix and viewport when the limits were last checked: unchanged means nothing to check. */
  protected readonly checkedMatrix = new Float64Array(18)
  protected limitsChecked = false
  /** The view's distance at the last check, to tell a zoom step from a pan. */
  protected checkedDistanceMeters = 0

  constructor(protected readonly earth: Earth) {}

  /**
   * Bounds the camera stays within (MapLibre's `minZoom`, `maxZoom`, `minPitch`, `maxPitch` and `maxBounds`). Replaces
   * the previous limits; fields left out are unlimited, and `{}` removes every limit. Every way the camera moves
   * keeps to them: the controls, `jumpTo`, the animations (they end inside the limits) and the app's own camera code,
   * which `earth.update` corrects before the frame draws. A camera outside new limits moves inside on the next frame.
   */
  setLimits(limits: CameraLimits): void {
    this.limits = validateCameraLimits(limits)
    this.limitsChecked = false
    this.earth.requestFrame()
  }

  /** True when `setLimits` set at least one limit. */
  get hasLimits(): boolean {
    return hasCameraLimits(this.limits)
  }

  /** The limits `setLimits` set, as validated. Read-only: change them with `setLimits`. */
  getLimits(): Readonly<CameraLimits> {
    return this.limits
  }

  /** The view moved inside the limits: what an animation ends on, or what `jumpTo` would place. */
  constrainView<View extends { longitudeDegrees: number; latitudeDegrees: number; zoom: number; pitchDegrees: number }>(view: View): View {
    return constrainView(view, this.limits)
  }

  /**
   * Moves the camera inside the limits when it left them. `earth.update` calls it every frame, after the
   * animation and before the tiles; it reads the view (a terrain raycast) only on frames where the camera or
   * viewport changed, and not during an animation (whose plan already keeps to the limits). Returns true when it
   * moved the camera.
   *
   * A move that crossed a zoom limit is cut short where it reaches the limit, along the camera's own path: a wheel
   * zooming towards the cursor stops there rather than sliding the map. Tilt and the centre are then held around
   * the centre of the screen.
   */
  applyLimits(): boolean {
    if (!hasCameraLimits(this.limits) || !this.ready || this.earth.view.transitioning) return false
    if (this.animation?.frame != null) return false
    const camera = this.requireCamera()
    camera.updateMatrixWorld()
    if (this.limitsChecked && !this.cameraChangedSinceCheck(camera)) return false
    let view = this.getView()
    let moved = false
    // A step of the controls (a wheel tick, a pinch) moves less than the camera's distance to the ground; a jump or
    // the app's own placement moves farther, and is held around the centre instead.
    // Only a step that changed the distance to the ground is a zoom; a pan that crosses a limit because zoom follows
    // latitude and the terrain's height (dragging towards a pole at the minimum zoom) is held around the centre, so it
    // keeps moving.
    const step = this.limitsChecked ? camera.position.distanceTo(limitStart.set(this.checkedMatrix[12]!, this.checkedMatrix[13]!, this.checkedMatrix[14]!)) : Infinity
    const zoomStep = Math.abs(view.distanceMeters - this.checkedDistanceMeters) > ZOOM_STEP_DISTANCE_SHARE * view.distanceMeters
    if (this.outsideZoomLimits(view.zoom) && zoomStep && step < view.distanceMeters && this.checkedViewportUnchanged()) {
      moved = this.cutMoveAtZoomLimit(view.zoom)
      if (moved) view = this.getView()
    }
    const limited = constrainView(view, this.limits)
    const outside =
      Math.abs(limited.zoom - view.zoom) > LIMIT_TOLERANCE_ZOOM ||
      Math.abs(limited.pitchDegrees - view.pitchDegrees) > LIMIT_TOLERANCE_DEGREES ||
      Math.abs(limited.longitudeDegrees - view.longitudeDegrees) > LIMIT_TOLERANCE_DEGREES ||
      Math.abs(limited.latitudeDegrees - view.latitudeDegrees) > LIMIT_TOLERANCE_DEGREES
    if (outside) {
      const centerMoved = limited.longitudeDegrees !== view.longitudeDegrees || limited.latitudeDegrees !== view.latitudeDegrees
      const heightMeters = centerMoved ? (this.queryTerrainElevation(limited) ?? view.heightMeters) : view.heightMeters
      this.placeView({
        longitudeDegrees: limited.longitudeDegrees,
        latitudeDegrees: limited.latitudeDegrees,
        heightMeters,
        zoom: limited.zoom,
        headingDegrees: view.headingDegrees,
        pitchDegrees: limited.pitchDegrees,
      })
      camera.updateMatrixWorld()
      moved = true
    }
    this.checkedDistanceMeters = view.distanceMeters
    this.rememberCheckedCamera(camera)
    return moved
  }

  protected outsideZoomLimits(zoom: number): boolean {
    const { minimumZoom, maximumZoom } = this.limits
    return (minimumZoom !== undefined && zoom < minimumZoom - LIMIT_TOLERANCE_ZOOM) || (maximumZoom !== undefined && zoom > maximumZoom + LIMIT_TOLERANCE_ZOOM)
  }

  protected checkedViewportUnchanged(): boolean {
    return this.viewportWidthPixels === this.checkedMatrix[16] && this.viewportHeightPixels === this.checkedMatrix[17]
  }

  /**
   * Moves the camera back along the straight line from where it was at the last check (inside the zoom limits) to
   * where it is now, to the last point inside them, keeping its orientation. False when the last position was
   * outside too, so there is no point inside to stop at.
   */
  protected cutMoveAtZoomLimit(endZoom: number): boolean {
    const camera = this.requireCamera()
    const checked = this.checkedMatrix
    limitStart.set(checked[12]!, checked[13]!, checked[14]!)
    limitEnd.copy(camera.position)
    // On the ellipsoid (no terrain raycast), shifted by the terrain's share at the end: `applyLimits` holds what is left.
    const terrainZoom = endZoom - this.readView(false).zoom
    const zoomAt = (amount: number) => {
      camera.position.lerpVectors(limitStart, limitEnd, amount)
      camera.updateMatrixWorld()
      return this.readView(false).zoom + terrainZoom
    }
    if (this.outsideZoomLimits(zoomAt(0))) {
      camera.position.copy(limitEnd)
      camera.updateMatrixWorld()
      return false
    }
    let inside = 0
    let outside = 1
    for (let step = 0; step < ZOOM_LIMIT_BISECTION_STEPS; step++) {
      const middle = (inside + outside) / 2
      if (this.outsideZoomLimits(zoomAt(middle))) outside = middle
      else inside = middle
    }
    zoomAt(inside)
    return true
  }

  protected cameraChangedSinceCheck(camera: Camera): boolean {
    const elements = camera.matrixWorld.elements
    const checked = this.checkedMatrix
    for (let index = 0; index < 16; index++) if (elements[index] !== checked[index]) return true
    return this.viewportWidthPixels !== checked[16] || this.viewportHeightPixels !== checked[17]
  }

  protected rememberCheckedCamera(camera: Camera): void {
    this.checkedMatrix.set(camera.matrixWorld.elements)
    this.checkedMatrix[16] = this.viewportWidthPixels
    this.checkedMatrix[17] = this.viewportHeightPixels
    this.limitsChecked = true
  }

  setCamera(camera: Camera): void {
    this.camera = camera
  }

  setViewportSize(widthPixels: number, heightPixels: number): void {
    this.viewportWidthPixels = widthPixels
    this.viewportHeightPixels = heightPixels
  }

  /** Whether `jumpTo`, an animation or the earth's initial view placed the camera (a style's root view then no longer applies). */
  get hasPlacedView(): boolean {
    return this.placedView
  }

  /** True once there is a perspective camera and a viewport size, so every method can run. */
  get ready(): boolean {
    return (this.camera as { isPerspectiveCamera?: boolean } | null)?.isPerspectiveCamera === true && this.viewportWidthPixels > 0 && this.viewportHeightPixels > 0
  }

  /** True when positions are read on the flat map rather than the globe. */
  get onFlatMap(): boolean {
    return this.earth.view.morph > 0.5
  }

  /**
   * The centre of the screen (of the area `padding` leaves), zoom, heading, pitch and distance. With
   * padding, `distanceMeters` is measured along the camera's axis, so zoom stays the scale at the centre.
   */
  getView(): MapView {
    return this.readView(true)
  }

  /** `getView` on the ellipsoid (the map's plane in 2D), without raycasting the terrain. For the per-frame events. */
  readEllipsoidView(): MapView {
    return this.readView(false)
  }

  /** Ground metres per pixel at the centre for a camera this far away (along its axis): the scale the `zoom` events follow. */
  distanceToGroundMetersPerPixel(distanceMeters: number): number {
    const focalLength = focalLengthPixels(this.requireCamera(), this.requireViewport().height)
    return distanceMeters / focalLength
  }

  /** `getView`, on the ellipsoid (the map's plane in 2D) when `followTerrain` is false: no terrain raycast. */
  protected readView(followTerrain: boolean): MapView {
    const camera = this.requireCamera()
    const { width, height } = this.requireViewport()
    const focalLength = focalLengthPixels(camera, height)
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld)
    cameraUp.set(0, 1, 0).transformDirection(camera.matrixWorld)
    const { rightPixels, downPixels } = this.paddingOffset()
    if (rightPixels === 0 && downPixels === 0) ray.set(cameraPosition, forward)
    else this.setScreenRay(width / 2 + rightPixels, height / 2 + downPixels, ray)
    return this.onFlatMap ? this.getFlatMapView(focalLength, followTerrain) : this.getGlobeView(focalLength, followTerrain)
  }

  protected getGlobeView(focalLength: number, followTerrain = true): MapView {
    const point = (followTerrain ? this.intersectTerrain(ray, surfacePoint) : null) ?? intersectEllipsoidOrHorizon(ray, surfacePoint)?.point
    // Looking away from the Earth: use the point under the camera.
    const center = point ?? WGS84_ELLIPSOID.getPositionToSurfacePoint(cameraPosition, surfacePoint)
    WGS84_ELLIPSOID.getPositionToCartographic(center, cartographic)
    WGS84_ELLIPSOID.getEastNorthUpAxes(cartographic.lat, cartographic.lon, east, north, up)
    // Along the camera's axis (the same as straight to the centre without padding).
    const distanceMeters = cameraPosition.distanceTo(center) * ray.direction.dot(forward)
    const latitudeDegrees = MathUtils.radToDeg(cartographic.lat)
    const { headingRadians, pitchRadians } = headingAndPitch(forward, cameraUp, east, north, up)
    return {
      longitudeDegrees: MathUtils.radToDeg(cartographic.lon),
      latitudeDegrees,
      heightMeters: cartographic.height,
      zoom: groundMetersPerPixelToZoom(distanceMeters / focalLength, latitudeDegrees),
      headingDegrees: MathUtils.radToDeg(headingRadians),
      pitchDegrees: MathUtils.radToDeg(pitchRadians),
      distanceMeters,
    }
  }

  protected getFlatMapView(focalLength: number, followTerrain = true): MapView {
    const view = this.earth.view
    this.toFlatRay(ray, flatRay)
    // Looking above the map's horizon: use the point under the camera.
    const center = this.intersectFlatMap(flatRay, flatPoint, followTerrain) ?? flatPoint.copy(flatRay.origin).setZ(0)
    const { longitudeRadians, latitudeRadians, heightMeters } = view.flatToGeodetic(center)
    // Flat coordinates are Web Mercator metres; the map is `view.scale` ECEF metres per flat unit. Along the
    // camera's axis, as on the globe.
    const flatForward = viewPoint.copy(forward).transformDirection(view.earthToFlat)
    const flatDistance = flatRay.origin.distanceTo(center) * flatRay.direction.dot(flatForward)
    const { headingRadians, pitchRadians } = headingAndPitch(
      flatForward,
      cameraUp.transformDirection(view.earthToFlat),
      east.set(1, 0, 0),
      north.set(0, 1, 0),
      up.set(0, 0, 1),
    )
    return {
      longitudeDegrees: wrapLongitudeDegrees(MathUtils.radToDeg(longitudeRadians)),
      latitudeDegrees: MathUtils.radToDeg(latitudeRadians),
      heightMeters,
      zoom: mercatorMetersPerPixelToZoom(flatDistance / focalLength),
      headingDegrees: MathUtils.radToDeg(headingRadians),
      pitchDegrees: MathUtils.radToDeg(pitchRadians),
      distanceMeters: flatDistance * view.scale,
    }
  }

  /**
   * Moves the camera at once, and stops a running animation. Fields left out keep their current value.
   * Without `heightMeters`, a new centre sits on the loaded terrain (0 where none is loaded). During a morph
   * to the flat map the morph flies the camera itself: jump once `earth.view.transitioning` is false. When
   * the screen centre shows sky, `getView` stands in the horizon point (or the point under the camera), so
   * changing only zoom, heading or pitch re-aims the camera at that point.
   */
  jumpTo(change: MapViewChange): void {
    this.placedView = true
    this.stop()
    this.placeView(change)
    // A jump is held around its centre, not cut short along the way.
    this.limitsChecked = false
    this.applyLimits()
    this.earth.requestFrame()
  }

  /** `jumpTo` without stopping animations or asking for a frame: what each animation frame calls. */
  protected placeView(change: MapViewChange): void {
    const camera = this.requireCamera()
    const focalLength = focalLengthPixels(camera, this.requireViewport().height)
    const complete =
      change.longitudeDegrees !== undefined &&
      change.latitudeDegrees !== undefined &&
      change.heightMeters !== undefined &&
      (change.zoom !== undefined || change.distanceMeters !== undefined) &&
      change.headingDegrees !== undefined &&
      change.pitchDegrees !== undefined
    // Animation frames give every field: no need to read the current view (a terrain raycast).
    const current = complete ? null : this.getView()
    const centerMoved = change.longitudeDegrees !== undefined || change.latitudeDegrees !== undefined
    const longitudeDegrees = change.longitudeDegrees ?? current!.longitudeDegrees
    const latitudeDegrees = change.latitudeDegrees ?? current!.latitudeDegrees
    const position = { longitudeDegrees, latitudeDegrees }
    const heightMeters = change.heightMeters ?? (centerMoved ? (this.queryTerrainElevation(position) ?? 0) : current!.heightMeters)
    const zoom = change.zoom ?? (change.distanceMeters === undefined ? current!.zoom : undefined)
    const heading = MathUtils.degToRad(change.headingDegrees ?? current!.headingDegrees)
    const pitch = MathUtils.degToRad(change.pitchDegrees ?? current!.pitchDegrees)

    let distanceMeters: number
    if (this.onFlatMap) {
      const view = this.earth.view
      const latitude = MathUtils.degToRad(latitudeDegrees)
      const target = view.geodeticToFlat(MathUtils.degToRad(longitudeDegrees), latitude, heightMeters, flatPoint)
      // Onto the copy of the world around the camera (the anchor's when it is still).
      target.x = wrapMercatorXNear(target.x, view.worldCopyReferenceXMeters)
      target.applyMatrix4(view.flatToEarth)
      distanceMeters = zoom === undefined ? change.distanceMeters! : zoomToMercatorMetersPerPixel(zoom) * focalLength * view.scale
      // The flat map's axes in ECEF: east and north along the plane, up its normal.
      east.setFromMatrixColumn(view.anchorFrame, 0)
      north.setFromMatrixColumn(view.anchorFrame, 1)
      placeCameraAround(camera, target, east, north, up.copy(view.anchorUp), heading, pitch, distanceMeters)
    } else {
      const latitude = MathUtils.degToRad(latitudeDegrees)
      const longitude = MathUtils.degToRad(longitudeDegrees)
      const target = WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, heightMeters, surfacePoint)
      WGS84_ELLIPSOID.getEastNorthUpAxes(latitude, longitude, east, north, up)
      distanceMeters = zoom === undefined ? change.distanceMeters! : zoomToGroundMetersPerPixel(zoom, latitudeDegrees) * focalLength
      placeCameraAround(camera, target, east, north, up, heading, pitch, distanceMeters)
    }
    // With padding, slide the camera across its screen plane so the target shows at the padded centre.
    const { rightPixels, downPixels } = this.paddingOffset()
    if (rightPixels !== 0 || downPixels !== 0) {
      const metersPerPixel = distanceMeters / focalLength
      camera.position
        .addScaledVector(east.setFromMatrixColumn(camera.matrixWorld, 0).normalize(), -rightPixels * metersPerPixel)
        .addScaledVector(north.setFromMatrixColumn(camera.matrixWorld, 1).normalize(), downPixels * metersPerPixel)
      camera.updateMatrixWorld()
    }
  }

  /** How far the padded centre sits from the middle of the screen, in CSS pixels (right and down). */
  protected paddingOffset(): { rightPixels: number; downPixels: number } {
    const { topPixels, rightPixels, bottomPixels, leftPixels } = this.padding
    return { rightPixels: (leftPixels - rightPixels) / 2, downPixels: (topPixels - bottomPixels) / 2 }
  }

  /**
   * Space kept clear on each side of the screen, in CSS pixels (MapLibre's `padding`), for example under a
   * side panel: the view's centre, `jumpTo`, the animations and `fitBounds` use the middle of the area it
   * leaves. Changing it does not move the camera; the centre `getView` reports moves instead.
   */
  setPadding(padding: PaddingPixels): void {
    this.padding = toViewPadding(padding)
  }

  // ---------------------------------------------------------------------------------------------------
  // Animations

  /** True while an animation (`easeTo`, `flyTo` and the rest) runs or waits for the camera or a morph. */
  get animating(): boolean {
    return this.animation !== null
  }

  /**
   * Stops a running animation where it is. Its promise resolves to false. User input on `EarthControls`
   * calls it, as do `jumpTo` and the start of another animation.
   */
  stop(): void {
    const animation = this.animation
    if (animation === null) return
    this.animation = null
    animation.resolve(false)
  }

  /**
   * Animates to a view along a straight line: centre, zoom, heading and pitch change together. Resolves to
   * true at the end, false when stopped (`stop`, `jumpTo`, another animation, user input or a morph).
   */
  easeTo(change: MapViewChange, options: AnimationOptions = {}): Promise<boolean> {
    return this.animate(options, start => this.planEase(start, change, options))
  }

  /**
   * Flies to a view, zooming out and back in along the way like MapLibre's `flyTo` (van Wijk and Nuij):
   * the duration follows the distance (`speed`, `screenSpeed`) unless `durationSeconds` is given. Resolves
   * like `easeTo`.
   */
  flyTo(change: MapViewChange, options: FlyToOptions = {}): Promise<boolean> {
    return this.animate(options, start => this.planFlight(start, change, options))
  }

  /** Eases to a zoom, keeping the centre, heading and pitch. */
  zoomTo(zoom: number, options?: AnimationOptions): Promise<boolean> {
    return this.easeTo({ zoom }, options)
  }

  /** Eases to a heading (clockwise from north), the short way round. */
  rotateTo(headingDegrees: number, options?: AnimationOptions): Promise<boolean> {
    return this.easeTo({ headingDegrees }, options)
  }

  /** Eases the heading back to north. */
  resetNorth(options?: AnimationOptions): Promise<boolean> {
    return this.rotateTo(0, options)
  }

  /** Eases to north, looking straight down. */
  resetNorthPitch(options?: AnimationOptions): Promise<boolean> {
    return this.easeTo({ headingDegrees: 0, pitchDegrees: -90 }, options)
  }

  /** Eases the centre to a position, keeping zoom, heading and pitch. */
  panTo(position: GeographicPosition, options?: AnimationOptions): Promise<boolean> {
    return this.easeTo({ longitudeDegrees: position.longitudeDegrees, latitudeDegrees: position.latitudeDegrees, heightMeters: position.heightMeters }, options)
  }

  /**
   * Eases the centre by a screen offset, in CSS pixels: the point that shows `offset` away from the centre
   * becomes the centre (positive x right, positive y down).
   */
  panBy(offset: ScreenPosition, options?: AnimationOptions): Promise<boolean> {
    if (!this.ready) return Promise.resolve(false)
    const { width, height } = this.requireViewport()
    const { rightPixels, downPixels } = this.paddingOffset()
    const under = this.unproject({ xPixels: width / 2 + rightPixels + offset.xPixels, yPixels: height / 2 + downPixels + offset.yPixels })
    if (under !== null) return this.panTo(under, options)
    // Sky there: move along the map, seen from above with the current heading.
    const view = this.getView()
    const heading = MathUtils.degToRad(view.headingDegrees)
    const metersPerPixel = zoomToMercatorMetersPerPixel(view.zoom)
    const center = toMercatorMeters(view.longitudeDegrees, view.latitudeDegrees)
    const up = -offset.yPixels
    const eastward = (offset.xPixels * Math.cos(heading) + up * Math.sin(heading)) * metersPerPixel
    const northward = (-offset.xPixels * Math.sin(heading) + up * Math.cos(heading)) * metersPerPixel
    return this.panTo(fromMercatorMeters(center.xMeters + eastward, center.yMeters + northward), options)
  }

  /**
   * The view that shows a longitude-latitude box inside the screen, less `padding` and
   * `options.paddingPixels`: centre, zoom, heading and pitch, for `jumpTo`, `easeTo` or `flyTo`. Null
   * before the first frame, or when the padding leaves no room (a warning says so). Fitted on screen, for
   * the globe's curvature and tilted views too; when part of a box starts past the globe's horizon, it zooms
   * out until all of it shows, then fits.
   */
  cameraForBounds(bounds: GeographicBounds, options: FitBoundsOptions = {}): MapViewChange | null {
    if (!this.ready) return null
    const view = this.getView()
    const extra = toViewPadding(options.paddingPixels)
    const padding = {
      topPixels: this.padding.topPixels + extra.topPixels,
      rightPixels: this.padding.rightPixels + extra.rightPixels,
      bottomPixels: this.padding.bottomPixels + extra.bottomPixels,
      leftPixels: this.padding.leftPixels + extra.leftPixels,
    }
    const headingDegrees = options.headingDegrees ?? view.headingDegrees
    const fit = fitBoundsOnMap(bounds, {
      widthPixels: this.viewportWidthPixels,
      heightPixels: this.viewportHeightPixels,
      padding,
      viewPadding: this.padding,
      headingDegrees,
      maximumZoom: options.maximumZoom,
    })
    if (fit === null) {
      console.warn('EarthCamera.cameraForBounds: the padding leaves no room on the screen. Use smaller paddingPixels or earth.camera.padding.')
      return null
    }
    // The map's fit is exact on the flat map seen from above; refine it on screen for the globe's curvature
    // and for tilted views.
    const change = { ...fit, headingDegrees, pitchDegrees: options.pitchDegrees ?? view.pitchDegrees }
    return this.refineFit(bounds, change, padding, options.maximumZoom ?? DEFAULT_FIT_MAXIMUM_ZOOM)
  }

  /**
   * Moves a fit's centre and zoom until the box, projected through a copy of the camera, fills the padded
   * area: a few steps of measuring the box on screen and correcting. Keeps the last good step when the box
   * reaches past the horizon or behind the camera.
   */
  protected refineFit(
    bounds: GeographicBounds,
    change: { longitudeDegrees: number; latitudeDegrees: number; zoom: number; headingDegrees: number; pitchDegrees: number },
    padding: ViewPadding,
    maximumZoom: number,
  ): MapViewChange {
    const camera = this.requireCamera()
    const scratch = (this.fitCamera ??= camera.clone())
    scratch.copy(camera as never)
    const { width, height } = this.requireViewport()
    const availableWidth = width - padding.leftPixels - padding.rightPixels
    const availableHeight = height - padding.topPixels - padding.bottomPixels
    const targetX = padding.leftPixels + availableWidth / 2
    const targetY = padding.topPixels + availableHeight / 2
    const { rightPixels, downPixels } = this.paddingOffset()
    // Only a measured step counts; without one, the map's fit stands.
    let best = change
    const longitudeSpan = (bounds.eastDegrees < bounds.westDegrees ? bounds.eastDegrees + 360 : bounds.eastDegrees) - bounds.westDegrees
    const canShowWhole = this.onFlatMap || (longitudeSpan < 180 && bounds.northDegrees - bounds.southDegrees < 180)
    this.camera = scratch
    try {
      let current = change
      let measured = false
      for (let step = 0; step < FIT_REFINEMENT_STEPS + FIT_ZOOM_OUT_STEPS; step++) {
        this.placeView({ ...current, heightMeters: 0 })
        const extent = this.measureBoundsOnScreen(bounds)
        if (extent === null) {
          // Part of the box is past the horizon or behind the camera: before any good step, zoom out
          // until all of it shows, then refine from there. After one, keep it. A box wider than a
          // hemisphere never shows whole on the globe: it keeps the map's fit.
          if (measured || step >= FIT_ZOOM_OUT_STEPS || !canShowWhole) break
          current = { ...current, zoom: current.zoom - 1 }
          continue
        }
        measured = true
        best = current
        const scale = Math.max((extent.maximumX - extent.minimumX) / availableWidth, (extent.maximumY - extent.minimumY) / availableHeight)
        const offsetX = (extent.minimumX + extent.maximumX) / 2 - targetX
        const offsetY = (extent.minimumY + extent.maximumY) / 2 - targetY
        const zoom = Math.min(maximumZoom, current.zoom - Math.log2(scale))
        if (Math.abs(zoom - current.zoom) < 1e-5 && Math.hypot(offsetX, offsetY) < 0.01) break
        // The point now at the camera's centre plus the box's offset becomes the centre.
        const center = this.unprojectOnSurface(width / 2 + rightPixels + offsetX, height / 2 + downPixels + offsetY)
        if (center === null) break
        current = { ...current, longitudeDegrees: wrapLongitudeDegrees(center.longitudeDegrees), latitudeDegrees: center.latitudeDegrees, zoom }
      }
    } finally {
      this.camera = camera
    }
    return best
  }

  /** Screen extent of a box's edges for the current camera, or null when part of it is hidden or behind. */
  protected measureBoundsOnScreen({ westDegrees, southDegrees, eastDegrees, northDegrees }: GeographicBounds) {
    const east = eastDegrees < westDegrees ? eastDegrees + 360 : eastDegrees
    let minimumX = Infinity
    let maximumX = -Infinity
    let minimumY = Infinity
    let maximumY = -Infinity
    const camera = this.requireCamera()
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    for (let index = 0; index <= FIT_SAMPLES_PER_EDGE; index++) {
      const amount = index / FIT_SAMPLES_PER_EDGE
      const longitudeDegrees = westDegrees + (east - westDegrees) * amount
      const latitudeDegrees = southDegrees + (northDegrees - southDegrees) * amount
      for (let side = 0; side < 4; side++) {
        const position =
          side === 0 ? { longitudeDegrees, latitudeDegrees: southDegrees }
          : side === 1 ? { longitudeDegrees, latitudeDegrees: northDegrees }
          : side === 2 ? { longitudeDegrees: westDegrees, latitudeDegrees }
          : { longitudeDegrees: east, latitudeDegrees }
        const point = this.toScenePosition(position, scenePoint)
        if (!this.toScreen(point, screenPoint).inFront) return null
        if (!this.onFlatMap && isOccludedByEllipsoid(cameraPosition, point)) return null
        minimumX = Math.min(minimumX, screenPoint.xPixels)
        maximumX = Math.max(maximumX, screenPoint.xPixels)
        minimumY = Math.min(minimumY, screenPoint.yPixels)
        maximumY = Math.max(maximumY, screenPoint.yPixels)
      }
    }
    return { minimumX, maximumX, minimumY, maximumY }
  }

  /**
   * Animates to the view that shows a longitude-latitude box (see `cameraForBounds`): flies, or eases with
   * `linear: true`. Resolves like `easeTo`, and to false at once when the box cannot fit.
   */
  fitBounds(bounds: GeographicBounds, options: FitBoundsOptions = {}): Promise<boolean> {
    if (!this.ready) {
      // Before the first frame: fit once the camera is known.
      return this.animate(options, start => {
        const change = this.cameraForBounds(bounds, options)
        if (change === null) return null
        return options.linear === true ? this.planEase(start, change, options) : this.planFlight(start, change, options)
      })
    }
    const change = this.cameraForBounds(bounds, options)
    if (change === null) return Promise.resolve(false)
    return options.linear === true ? this.easeTo(change, options) : this.flyTo(change, options)
  }

  /**
   * Advances the running animation by `deltaSeconds`. `earth.update` calls it before choosing tiles.
   * Returns true while an animation still needs frames.
   */
  advanceAnimation(deltaSeconds: number): boolean {
    const animation = this.animation
    if (animation === null) return false
    if (this.earth.view.transitioning) {
      // The morph flies the camera: a running animation stops, one not started yet waits.
      if (animation.frame !== null) this.stop()
      return this.animation !== null
    }
    if (animation.frame === null) {
      if (!this.ready) return true
      if (!this.startAnimation(animation)) return false
    }
    // The first step counts one frame at most: the time before it is the host's idle time (a vanilla host
    // that renders on demand may not have updated for seconds), not animation time.
    animation.elapsedSeconds += animation.stepped ? deltaSeconds : Math.min(deltaSeconds, FIRST_STEP_SECONDS)
    animation.stepped = true
    this.stepAnimation(animation)
    return this.animation !== null
  }

  /**
   * `jumpTo` without stopping an animation that waits for the first frame: `earth.update` applies
   * `initialView` with it, so an animation called at mount starts from the initial view.
   */
  jumpToInitialView(change: MapViewChange): void {
    this.placedView = true
    this.placeView(change)
    this.earth.requestFrame()
  }

  protected animate(options: AnimationOptions, plan: (start: MapView) => AnimationPlan | null): Promise<boolean> {
    this.placedView = true
    this.stop()
    let resolve!: (completed: boolean) => void
    const promise = new Promise<boolean>(settle => (resolve = settle))
    const animation: RunningAnimation = {
      plan,
      frame: null,
      durationSeconds: 0,
      elapsedSeconds: 0,
      easing: options.easing ?? defaultEasing,
      reduceMotion: options.essential !== true && prefersReducedMotion(),
      stepped: false,
      resolve,
    }
    this.animation = animation
    // Start now when the camera is known (MapLibre captures the start view at the call), else on the first frame.
    if (this.ready && !this.earth.view.transitioning && this.startAnimation(animation)) {
      if (animation.durationSeconds === 0) this.stepAnimation(animation)
    }
    this.earth.requestFrame()
    return promise
  }

  /** Plans the animation from the current view. False (and resolved false) when there is nothing to do. */
  protected startAnimation(animation: RunningAnimation): boolean {
    const plan = animation.plan(this.getView())
    if (plan === null) {
      this.animation = null
      animation.resolve(false)
      return false
    }
    animation.frame = plan.frame
    animation.durationSeconds = animation.reduceMotion ? 0 : Math.max(0, plan.durationSeconds)
    return true
  }

  protected stepAnimation(animation: RunningAnimation): void {
    const time = animation.durationSeconds === 0 ? 1 : Math.min(1, animation.elapsedSeconds / animation.durationSeconds)
    const change = animation.frame!(time >= 1 ? 1 : animation.easing(time))
    // The flight's top is planned above the minimum zoom, but only approximately: hold each frame's zoom too.
    const { minimumZoom, maximumZoom } = this.limits
    if (change.zoom !== undefined) change.zoom = Math.min(maximumZoom ?? Infinity, Math.max(minimumZoom ?? -Infinity, change.zoom))
    this.placeView(change)
    if (time >= 1) {
      this.animation = null
      animation.resolve(true)
    }
  }

  /** The full end view of a change made from `start`. */
  protected resolveTarget(start: MapView, change: MapViewChange): Required<Omit<MapView, 'distanceMeters'>> {
    const centerMoved = change.longitudeDegrees !== undefined || change.latitudeDegrees !== undefined
    const longitudeDegrees = change.longitudeDegrees ?? start.longitudeDegrees
    const latitudeDegrees = change.latitudeDegrees ?? start.latitudeDegrees
    const heightMeters = change.heightMeters ?? (centerMoved ? (this.queryTerrainElevation({ longitudeDegrees, latitudeDegrees }) ?? 0) : start.heightMeters)
    const zoom = change.zoom ?? (change.distanceMeters !== undefined ? this.distanceToZoom(change.distanceMeters, latitudeDegrees) : start.zoom)
    // Animations end inside the limits; `planFlight` keeps a flight's top above the minimum zoom.
    const limited = constrainView(
      { longitudeDegrees, latitudeDegrees, zoom, pitchDegrees: change.pitchDegrees ?? start.pitchDegrees },
      this.limits,
    )
    const limitedCenterMoved = limited.longitudeDegrees !== longitudeDegrees || limited.latitudeDegrees !== latitudeDegrees
    return {
      longitudeDegrees: limited.longitudeDegrees,
      latitudeDegrees: limited.latitudeDegrees,
      heightMeters: limitedCenterMoved ? (this.queryTerrainElevation(limited) ?? heightMeters) : heightMeters,
      zoom: limited.zoom,
      headingDegrees: change.headingDegrees ?? start.headingDegrees,
      pitchDegrees: limited.pitchDegrees,
    }
  }

  /**
   * The end centre's height, frame by frame. Without `heightMeters`, a new centre sits on the terrain, and
   * the terrain there loads finer as the camera nears it (coarse tiles can sit kilometres below the
   * ground), so it is read again each frame.
   */
  protected followEndHeight(change: MapViewChange, end: { longitudeDegrees: number; latitudeDegrees: number; heightMeters: number }): () => number {
    const centerMoved = change.longitudeDegrees !== undefined || change.latitudeDegrees !== undefined
    if (change.heightMeters !== undefined || !centerMoved) return () => end.heightMeters
    let heightMeters = end.heightMeters
    const position = { longitudeDegrees: end.longitudeDegrees, latitudeDegrees: end.latitudeDegrees }
    return () => (heightMeters = this.queryTerrainElevation(position) ?? heightMeters)
  }

  /** The zoom at which the camera is this far from a centre at this latitude. */
  protected distanceToZoom(distanceMeters: number, latitudeDegrees: number): number {
    const focalLength = focalLengthPixels(this.requireCamera(), this.requireViewport().height)
    if (this.onFlatMap) return mercatorMetersPerPixelToZoom(distanceMeters / (focalLength * this.earth.view.scale))
    return groundMetersPerPixelToZoom(distanceMeters / focalLength, latitudeDegrees)
  }

  protected centerPath(start: MapView, end: { longitudeDegrees: number; latitudeDegrees: number }): CenterPath {
    // A straight line on the map; the shortest way on the globe.
    return this.onFlatMap ? mercatorCenterPath(start, end) : greatCircleCenterPath(start, end)
  }

  protected planEase(start: MapView, change: MapViewChange, options: AnimationOptions): AnimationPlan {
    const end = this.resolveTarget(start, change)
    const endHeight = this.followEndHeight(change, end)
    const path = this.centerPath(start, end)
    return {
      durationSeconds: options.durationSeconds ?? DEFAULT_EASE_DURATION_SECONDS,
      frame: progress => ({
        ...path(progress),
        heightMeters: MathUtils.lerp(start.heightMeters, endHeight(), progress),
        zoom: MathUtils.lerp(start.zoom, end.zoom, progress),
        headingDegrees: progress >= 1 ? end.headingDegrees : interpolateDegrees(start.headingDegrees, end.headingDegrees, progress),
        pitchDegrees: MathUtils.lerp(start.pitchDegrees, end.pitchDegrees, progress),
      }),
    }
  }

  protected planFlight(start: MapView, change: MapViewChange, options: FlyToOptions): AnimationPlan {
    const end = this.resolveTarget(start, change)
    const { topPixels, rightPixels, bottomPixels, leftPixels } = this.padding
    const flightOptions = {
      startWidthPixels: Math.max(this.viewportWidthPixels - leftPixels - rightPixels, this.viewportHeightPixels - topPixels - bottomPixels, 1),
      distancePixels: mercatorDistancePixels(start, end, start.zoom),
      zoomChange: end.zoom - start.zoom,
      curve: options.curve,
      minimumZoomChange: options.minimumZoom === undefined ? undefined : options.minimumZoom - start.zoom,
    }
    let flight = createFlightPath(flightOptions)
    // A flight whose top would zoom out past the minimum zoom flies lower, with its speed planned for that height
    // (rather than racing over the ground at the clamped zoom).
    const minimumZoom = this.limits.minimumZoom
    if (minimumZoom !== undefined && flight.length > 0 && start.zoom + lowestZoomChange(flight) < minimumZoom) {
      flight = createFlightPath({ ...flightOptions, minimumZoomChange: Math.min(minimumZoom, start.zoom, end.zoom) - start.zoom })
    }
    // Nothing to fly over (only heading or pitch change): ease, as MapLibre does.
    if (flight.length === 0) return this.planEase(start, change, options)
    const endHeight = this.followEndHeight(change, end)
    let durationSeconds = options.durationSeconds ?? flightDurationSeconds(flight, options)
    if (options.maximumDurationSeconds !== undefined && durationSeconds > options.maximumDurationSeconds) durationSeconds = 0
    const path = this.centerPath(start, end)
    return {
      durationSeconds,
      frame: progress => {
        const s = progress * flight.length
        return {
          ...path(progress >= 1 ? 1 : flight.centerAmount(s)),
          heightMeters: MathUtils.lerp(start.heightMeters, endHeight(), progress),
          zoom: progress >= 1 ? end.zoom : start.zoom + flight.zoomChange(s),
          headingDegrees: progress >= 1 ? end.headingDegrees : interpolateDegrees(start.headingDegrees, end.headingDegrees, progress),
          pitchDegrees: MathUtils.lerp(start.pitchDegrees, end.pitchDegrees, progress),
        }
      },
    }
  }

  /** Ground metres one CSS pixel spans at the centre of the screen. */
  getGroundResolutionMetersPerPixel(): number {
    const { zoom, latitudeDegrees } = this.getView()
    return zoomToGroundMetersPerPixel(zoom, latitudeDegrees)
  }

  /**
   * The longitude-latitude box around what the screen shows, on the ellipsoid (the map's plane in 2D),
   * from points along the screen's edges. Where an edge goes from ground to sky, the box reaches the
   * horizon, and on the globe the horizon's visible part bounds it too. It crosses the antimeridian when
   * `westDegrees > eastDegrees`, and spans every longitude when a pole is in view.
   */
  getBounds(): GeographicBounds {
    const camera = this.requireCamera()
    const { width, height } = this.requireViewport()
    const onFlatMap = this.onFlatMap
    const centerHit = this.unprojectOnSurface(width / 2, height / 2)
    // The reference for unwrapping longitudes; only a real hit bounds the box.
    const center = centerHit ?? this.getView()
    let west = Infinity
    let east = -Infinity
    let south = Infinity
    let north = -Infinity
    const include = (position: GeographicPosition) => {
      // On the globe, unwrapped around the centre so a box across the antimeridian stays one box. Flat-map
      // longitudes are already continuous across the map.
      const longitude = onFlatMap
        ? position.longitudeDegrees
        : center.longitudeDegrees + wrapLongitudeDegrees(position.longitudeDegrees - center.longitudeDegrees)
      west = Math.min(west, longitude)
      east = Math.max(east, longitude)
      south = Math.min(south, position.latitudeDegrees)
      north = Math.max(north, position.latitudeDegrees)
    }

    // Walk each edge; where it crosses the horizon, bisect to the last point on the ground.
    const corners = [[0, 0], [width, 0], [width, height], [0, height]] as const
    for (let side = 0; side < 4; side++) {
      const [startX, startY] = corners[side]!
      const [endX, endY] = corners[(side + 1) % 4]!
      const at = (amount: number) => this.unprojectOnSurface(startX + (endX - startX) * amount, startY + (endY - startY) * amount)
      let previous = at(0)
      for (let index = 1; index <= BOUNDS_SAMPLES_PER_EDGE; index++) {
        const amount = index / BOUNDS_SAMPLES_PER_EDGE
        const current = at(amount)
        if (current !== null) include(current)
        if ((previous === null) !== (current === null)) {
          let ground = previous === null ? amount : amount - 1 / BOUNDS_SAMPLES_PER_EDGE
          let sky = previous === null ? amount - 1 / BOUNDS_SAMPLES_PER_EDGE : amount
          for (let step = 0; step < HORIZON_BISECTION_STEPS; step++) {
            const middle = (ground + sky) / 2
            if (at(middle) === null) sky = middle
            else ground = middle
          }
          const horizon = at(ground)
          if (horizon !== null) include(horizon)
        }
        previous = current
      }
    }
    if (centerHit !== null) include(centerHit)

    if (!onFlatMap) {
      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
      // The globe's outline, where it is on screen (the whole globe may sit inside the screen).
      for (let index = 0; index < HORIZON_SAMPLES; index++) {
        const point = ellipsoidHorizonPoint(cameraPosition, (index / HORIZON_SAMPLES) * 2 * Math.PI, surfacePoint)
        if (point === null || !this.toScreen(point, screenPoint).inViewport) continue
        WGS84_ELLIPSOID.getPositionToCartographic(point, cartographic)
        include({ longitudeDegrees: MathUtils.radToDeg(cartographic.lon), latitudeDegrees: MathUtils.radToDeg(cartographic.lat) })
      }
      for (const latitudeDegrees of [90, -90]) {
        if (this.project({ longitudeDegrees: 0, latitudeDegrees }).visible) {
          if (latitudeDegrees > 0) north = 90
          else south = -90
          west = -180
          east = 180
        }
      }
    }
    if (west === Infinity) return { westDegrees: -180, southDegrees: -90, eastDegrees: 180, northDegrees: 90 }
    if (east - west >= 360) return { westDegrees: -180, southDegrees: south, eastDegrees: 180, northDegrees: north }
    const eastWrapped = wrapLongitudeDegrees(east)
    return { westDegrees: wrapLongitudeDegrees(west), southDegrees: south, eastDegrees: eastWrapped === -180 ? 180 : eastWrapped, northDegrees: north }
  }

  /**
   * Where a geographic position appears on the screen, in CSS pixels from the canvas's top-left corner.
   * `visible` is false behind the camera, outside the viewport or beyond the globe's horizon (terrain does
   * not hide points). Follows the ground through the morph.
   */
  project(position: GeographicPosition, target: ProjectedPosition = { xPixels: 0, yPixels: 0, visible: false }): ProjectedPosition {
    const camera = this.requireCamera()
    const point = this.toScenePosition(position, scenePoint)
    const { inFront, inViewport } = this.toScreen(point, target)
    const behindHorizon = !this.onFlatMap && isOccludedByEllipsoid(cameraPosition.setFromMatrixPosition(camera.matrixWorld), point)
    target.visible = inFront && inViewport && !behindHorizon
    return target
  }

  /** Screen position of a scene point, in CSS pixels, written to `target`. */
  protected toScreen(point: Vector3, target: ScreenPosition): { inFront: boolean; inViewport: boolean } {
    const camera = this.requireCamera()
    const { width, height } = this.requireViewport()
    viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse)
    const inFront = viewPoint.z < 0
    viewPoint.applyMatrix4(camera.projectionMatrix)
    target.xPixels = ((viewPoint.x + 1) / 2) * width
    target.yPixels = ((1 - viewPoint.y) / 2) * height
    const inViewport = inFront && target.xPixels >= 0 && target.xPixels <= width && target.yPixels >= 0 && target.yPixels <= height
    return { inFront, inViewport }
  }

  /**
   * The geographic position under a screen point (CSS pixels from the canvas's top-left corner), on the
   * loaded terrain, or on the ellipsoid (the map's plane in 2D) where none is loaded. Null when the point
   * shows sky.
   */
  unproject(screen: ScreenPosition): (GeographicPosition & { heightMeters: number }) | null {
    this.setScreenRay(screen.xPixels, screen.yPixels, ray)
    if (this.onFlatMap) {
      this.toFlatRay(ray, flatRay)
      const point = this.intersectFlatMap(flatRay, flatPoint)
      return point === null ? null : this.flatToPosition(point)
    }
    const point = this.intersectTerrain(ray, surfacePoint) ?? (WGS84_ELLIPSOID.intersectRay(ray, surfacePoint) as Vector3 | null)
    if (point === null) return null
    WGS84_ELLIPSOID.getPositionToCartographic(point, cartographic)
    return { longitudeDegrees: MathUtils.radToDeg(cartographic.lon), latitudeDegrees: MathUtils.radToDeg(cartographic.lat), heightMeters: cartographic.height }
  }

  /**
   * Ellipsoidal height of the loaded terrain at a position, in metres, at the level of detail loaded there.
   * Null without terrain, or where no tile is loaded yet.
   */
  queryTerrainElevation({ longitudeDegrees, latitudeDegrees }: GeographicPosition): number | null {
    const terrain = this.earth.terrain
    if (terrain === null) return null
    const latitude = MathUtils.degToRad(latitudeDegrees)
    const longitude = MathUtils.degToRad(longitudeDegrees)
    WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, TERRAIN_RAY_START_HEIGHT_METERS, raycaster.ray.origin)
    WGS84_ELLIPSOID.getEastNorthUpAxes(latitude, longitude, east, north, up)
    raycaster.ray.direction.copy(up).negate()
    const point = this.raycastTerrain(surfacePoint)
    // A ray straight down a seam between two tiles can slip between their float32 edges: read the tile's mesh then.
    if (point === null) return terrain.sampleElevation(longitude, latitude)
    WGS84_ELLIPSOID.getPositionToCartographic(point, cartographic)
    return cartographic.height
  }

  /** The scene position of a geographic position: on the globe, the flat map, or in between during the morph. */
  toScenePosition(position: GeographicPosition, target = new Vector3()): Vector3 {
    toCartesian(position, target)
    const view = this.earth.view
    const morph = view.morph
    if (morph === 0) return target
    const latitude = MathUtils.degToRad(position.latitudeDegrees)
    const flat = view.geodeticToFlat(MathUtils.degToRad(position.longitudeDegrees), latitude, position.heightMeters ?? 0, flatScenePoint)
    // The copy of the world nearest the camera on the flat map (the anchor's during the morph).
    flat.x = wrapMercatorXNear(flat.x, view.worldCopyReferenceXMeters)
    return target.lerp(flat.applyMatrix4(view.flatToEarth), morph)
  }

  protected requireCamera(): Camera {
    if (this.camera === null) {
      throw new Error('EarthCamera: no camera yet. It is set by the first earth.update(camera, renderer); before that, call earth.camera.setCamera(camera).')
    }
    this.camera.updateMatrixWorld()
    return this.camera
  }

  protected requireViewport(): { width: number; height: number } {
    if (this.viewportWidthPixels <= 0 || this.viewportHeightPixels <= 0) {
      throw new Error('EarthCamera: no viewport size yet. It is set by the first earth.update(camera, renderer); before that, call earth.camera.setViewportSize(width, height).')
    }
    return { width: this.viewportWidthPixels, height: this.viewportHeightPixels }
  }

  protected setScreenRay(xPixels: number, yPixels: number, target: Ray): Ray {
    const camera = this.requireCamera()
    const { width, height } = this.requireViewport()
    pointer.set((xPixels / width) * 2 - 1, 1 - (yPixels / height) * 2)
    raycaster.setFromCamera(pointer, camera)
    return target.copy(raycaster.ray)
  }

  /**
   * The surface position under a screen point, ignoring terrain: the ellipsoid, or the map's plane in 2D
   * (longitudes not wrapped, so they stay continuous across world copies). Null on sky.
   */
  protected unprojectOnSurface(xPixels: number, yPixels: number): GeographicPosition | null {
    this.setScreenRay(xPixels, yPixels, ray)
    if (this.onFlatMap) {
      this.toFlatRay(ray, flatRay)
      if (flatRay.direction.z >= 0) return null
      const point = flatRay.at(-flatRay.origin.z / flatRay.direction.z, flatPoint)
      // The map ends north and south at the Web Mercator square; east and west, copies of the world repeat,
      // so a view wider than one world spans every longitude.
      point.y = Math.max(-WEB_MERCATOR_HALF_EXTENT_METERS, Math.min(WEB_MERCATOR_HALF_EXTENT_METERS, point.y))
      const { longitudeRadians, latitudeRadians } = this.earth.view.flatToGeodetic(point)
      return { longitudeDegrees: MathUtils.radToDeg(longitudeRadians), latitudeDegrees: MathUtils.radToDeg(latitudeRadians) }
    }
    if (WGS84_ELLIPSOID.intersectRay(ray, surfacePoint) === null) return null
    WGS84_ELLIPSOID.getPositionToCartographic(surfacePoint, cartographic)
    return { longitudeDegrees: MathUtils.radToDeg(cartographic.lon), latitudeDegrees: MathUtils.radToDeg(cartographic.lat) }
  }

  /** The first hit of a ray on the loaded terrain tiles (as on the globe), or null. */
  protected intersectTerrain(sceneRay: Ray, target: Vector3): Vector3 | null {
    if (this.earth.terrain === null) return null
    raycaster.ray.copy(sceneRay)
    return this.raycastTerrain(target)
  }

  protected raycastTerrain(target: Vector3): Vector3 | null {
    const terrain = this.earth.terrain
    if (terrain === null) return null
    hits.length = 0
    raycaster.intersectObject(terrain.object, true, hits)
    let closest: Intersection | null = null
    for (const hit of hits) if (closest === null || hit.distance < closest.distance) closest = hit
    hits.length = 0
    return closest === null ? null : target.copy(closest.point)
  }

  /** A scene ray in flat coordinates (Web Mercator metres, z the scaled height). */
  protected toFlatRay(sceneRay: Ray, target: Ray): Ray {
    const view = this.earth.view
    target.origin.copy(sceneRay.origin).applyMatrix4(view.earthToFlat)
    target.direction.copy(sceneRay.direction).transformDirection(view.earthToFlat)
    return target
  }

  /**
   * Where a flat-coordinate ray meets the flat map's relief: it meets the plane at the terrain height found
   * under the last guess, a few times over. Exact on flat ground, within centimetres on slopes seen from
   * above. Null when the ray points above the map's horizon.
   */
  protected intersectFlatMap(flat: Ray, target: Vector3, followTerrain = true): Vector3 | null {
    if (flat.direction.z >= 0) return null
    let heightFlat = 0
    const iterations = this.earth.terrain === null || !followTerrain ? 1 : FLAT_MAP_RELIEF_ITERATIONS
    for (let iteration = 0; iteration < iterations; iteration++) {
      const distance = (heightFlat - flat.origin.z) / flat.direction.z
      if (distance < 0) return iteration === 0 ? null : target
      flat.at(distance, target)
      if (iteration === iterations - 1) break
      const { longitudeRadians, latitudeRadians } = this.earth.view.flatToGeodetic(target)
      const elevation = this.queryTerrainElevation({
        longitudeDegrees: MathUtils.radToDeg(longitudeRadians),
        latitudeDegrees: MathUtils.radToDeg(latitudeRadians),
      })
      heightFlat = (elevation ?? 0) * mercatorScaleFactor(latitudeRadians)
    }
    return target
  }

  protected flatToPosition(flat: Vector3): GeographicPosition & { heightMeters: number } {
    const { longitudeRadians, latitudeRadians, heightMeters } = this.earth.view.flatToGeodetic(flat)
    return {
      longitudeDegrees: wrapLongitudeDegrees(MathUtils.radToDeg(longitudeRadians)),
      latitudeDegrees: MathUtils.radToDeg(latitudeRadians),
      heightMeters,
    }
  }
}
