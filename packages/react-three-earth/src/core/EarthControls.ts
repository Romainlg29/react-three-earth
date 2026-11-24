// Pivot material adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06,
// itself ported from 3DTilesRendererJS's PivotPointMesh (Apache-2.0).
import { EnvironmentControls, GlobeControls, WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { Group, MathUtils, Plane, Vector2, Vector3, type Camera, type Material, type Mesh } from 'three'
import {
  cameraProjectionMatrix,
  Fn,
  fwidth,
  modelViewMatrix,
  positionGeometry,
  screenDPR,
  screenSize,
  smoothstep,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { NodeMaterial } from 'three/webgpu'

import type { ViewMorph } from '../view/ViewMorph.js'
import { mercatorScaleFactor } from '../view/webMercator.js'
import type { Earth } from './Earth.js'
import { KeyboardControls } from './KeyboardControls.js'
import {
  applyTwoFingerTilt,
  applyTwoFingerTransformOnGlobe,
  applyTwoFingerTransformOnPlane,
  getScreenRay,
  TouchGestures,
  type TwoFingerFrame,
} from './TouchGestures.js'

function createPivotMaterial(): Material {
  const size = uniform(15).mul(screenDPR)
  const thickness = uniform(2).mul(screenDPR)
  const opacity = uniform(0.5)

  const material = new NodeMaterial()
  material.depthWrite = false
  material.depthTest = false
  material.transparent = true

  material.vertexNode = Fn(() => {
    const aspect = screenSize.x.div(screenSize.y)
    const offset = uv().mul(2).sub(1).toVar()
    offset.y.mulAssign(aspect)
    const screenPoint = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionGeometry, 1)).toVar()
    screenPoint.xy.addAssign(offset.mul(size.add(thickness)).mul(screenPoint.w).div(screenSize.x))
    return screenPoint
  })()

  material.outputNode = Fn(() => {
    const halfThickness = thickness.mul(0.5)
    const planeDimension = size.add(thickness)
    const ringOffset = planeDimension.sub(halfThickness).sub(2).div(planeDimension)
    const texelThickness = halfThickness.div(planeDimension)
    const distance = uv().mul(2).sub(1).length().sub(ringOffset).abs()
    const width = fwidth(distance).mul(0.5)
    const alpha = smoothstep(texelThickness.sub(width), texelThickness.add(width), distance)
    return vec4(1, 1, 1, opacity.mul(alpha.oneMinus()))
  })()

  return material
}

/**
 * 3DTilesRenderer's `GlobeControls` (orbit, pan, zoom to cursor, near/far planes fitted to the globe),
 * with its pivot marker drawn by a node material so it shows on `WebGPURenderer`.
 */
export class EarthControls extends GlobeControls {
  constructor(...args: ConstructorParameters<typeof GlobeControls>) {
    super(...args)
    replacePivotMaterial(this)
  }
}

function replacePivotMaterial(controls: object): void {
  const pivotMesh = (controls as { pivotMesh: Mesh }).pivotMesh
  ;(pivotMesh.material as Material).dispose()
  pivotMesh.material = createPivotMaterial()
  pivotMesh.onBeforeRender = () => {}
}

/**
 * Pan, zoom and rotate over the flat map (`Earth.setView('2d')`): 3DTilesRenderer's `EnvironmentControls`
 * on the map plane, looking straight down by default. Call `followView` before `update` each frame, so the
 * plane follows the map's anchor. Like `EarthControls`, it fits the camera's near and far planes.
 */
export class FlatMapControls extends EnvironmentControls {

  /** Steepest tilt away from looking straight down, in radians. Default: 0 (a flat 2D map). */
  maximumTiltRadians = 0
  /**
   * Highest terrain under the camera, in map metres above the plane: the camera stays `minDistance` above
   * it. `EarthViewControls` sets it from the loaded tiles. Default: 0.
   */
  terrainHeightMeters = 0
  protected view: ViewMorph | null = null

  constructor(camera: Camera | null = null, domElement: HTMLElement | null = null) {
    // The map is not raycast: drags and zooms land on the map plane (the fallback plane).
    super(new Group(), camera as never, domElement as never)
    this.useFallbackPlane = true
    this.minAltitude = 0
    this.minDistance = 10
    replacePivotMaterial(this)
  }

  /** Takes the map plane and its up direction from the view morph. */
  followView(view: ViewMorph): void {
    this.view = view
    this.up.copy(view.anchorUp)
    this.fallbackPlane.setFromNormalAndCoplanarPoint(view.anchorUp, view.anchorPosition)
    this.maxAltitude = this.maximumTiltRadians
  }

  override update(deltaTime?: number): void {
    super.update(deltaTime)
    const camera = this.camera as (Camera & { near: number; far: number; updateProjectionMatrix?: () => void }) | null
    if (camera === null) return
    // Like MapLibre: no zooming out past the map's height, no panning past its poles, and the world
    // repeats east and west (the camera wraps back to the middle copy once the drag ends).
    // Not while dragging or spinning: the grip and rotation pivots are world points that would not follow.
    const internals = this as unknown as { state: number; rotationInertia: { lengthSq(): number } }
    const busy = internals.state !== 0 || internals.rotationInertia.lengthSq() > 0
    this.view?.constrainFlatCamera(camera, { wrap: !busy })
    // The map is not raycast, so keep the camera out of the relief by hand.
    const height = this.fallbackPlane.distanceToPoint(camera.position)
    const lowest = this.terrainHeightMeters + this.minDistance
    if (height < lowest) {
      camera.position.addScaledVector(this.fallbackPlane.normal, lowest - height)
      camera.updateMatrixWorld()
    }
    if ('near' in camera) fitClippingPlanes(camera, Math.max(height, lowest) - this.terrainHeightMeters)
  }
}

const cameraFlat = new Vector3()
const screenCenter = new Vector2(0, 0)
const gesturePlane = new Plane()
const gesturePivot = new Vector3()
const gestureUp = new Vector3()

/** Stops the controls' fling and spin, which a two-finger gesture replaces (internals, pinned to 0.5.x). */
function stopInertia(controls: object): void {
  const internals = controls as {
    dragInertia?: Vector3
    rotationInertia?: { set(x: number, y: number): void }
    globeInertia?: { identity(): void }
    globeInertiaFactor?: number
  }
  internals.dragInertia?.set(0, 0, 0)
  internals.rotationInertia?.set(0, 0)
  internals.globeInertia?.identity()
  if (internals.globeInertiaFactor !== undefined) internals.globeInertiaFactor = 0
}

/**
 * Hands the camera between `EarthControls` on the globe and `FlatMapControls` on the flat map, following
 * `earth.view`: input goes to the controls of the view shown, and is ignored while the view morphs. User
 * input stops a running camera animation. This is what `<EarthControls>` uses; vanilla apps call `update`
 * once per frame, before `earth.update`.
 */
export class EarthViewControls {
  readonly globe = new EarthControls()
  readonly flatMap = new FlatMapControls()
  /** Two-finger touch gestures (pan, pinch, twist and tilt together), like Apple Maps. */
  readonly touchGestures = new TouchGestures()
  /** Arrows, `+` / `-` and `Shift` + arrows while the map has focus, like MapLibre. */
  readonly keyboard: KeyboardControls
  /** Steepest tilt a two-finger drag or `Shift` + up reaches on the globe, in radians. Default: 80°. */
  maximumGlobeTiltRadians = MathUtils.degToRad(80)
  /**
   * What screen readers call the map, on the element the controls attach to (with `role="region"`). Default:
   * "Map". Set it before `attach`, or call `attach` again.
   */
  label = 'Map'
  protected domElement: HTMLElement | null = null
  /** The element's accessibility attributes before `attach`, put back by `detach`. */
  protected savedAttributes = new Map<string, string | null>()

  constructor(protected readonly earth: Earth) {
    this.globe.setScene(earth)
    this.keyboard = new KeyboardControls(earth)
    // User input takes over from a running camera animation (`earth.camera.flyTo` and the rest).
    const stopAnimation = () => earth.camera.stop()
    this.globe.addEventListener('start', stopAnimation)
    this.flatMap.addEventListener('start', stopAnimation)
    this.touchGestures.onStart = stopAnimation
    // A key press replaces the fling of the last drag (the press starts its own animation).
    this.keyboard.onStart = () => {
      stopInertia(this.globe)
      stopInertia(this.flatMap)
    }
  }

  setCamera(camera: Camera): void {
    this.globe.setCamera(camera)
    this.flatMap.setCamera(camera)
  }

  /**
   * Listens to the element's mouse, touch and keyboard input, and makes it the map for assistive technology:
   * in the tab order (`tabindex="0"`), `role="region"`, named by `label`.
   */
  attach(domElement: HTMLElement): void {
    if (this.domElement !== null) this.detach()
    this.domElement = domElement
    this.describe(domElement)
    // First, so the gestures see each touch before the controls do.
    this.touchGestures.attach(domElement)
    this.globe.attach(domElement)
    this.flatMap.attach(domElement)
    this.keyboard.attach(domElement)
  }

  detach(): void {
    this.touchGestures.detach()
    this.globe.detach()
    this.flatMap.detach()
    this.keyboard.detach()
    const domElement = this.domElement
    this.domElement = null
    if (domElement === null) return
    for (const [name, value] of this.savedAttributes) {
      if (value === null) domElement.removeAttribute(name)
      else domElement.setAttribute(name, value)
    }
    this.savedAttributes.clear()
  }

  /** Sets the map's accessibility attributes, keeping the element's own values to put back on `detach`. */
  protected describe(domElement: HTMLElement): void {
    const attributes: Record<string, string> = { tabindex: '0', role: 'region', 'aria-label': this.label }
    for (const [name, value] of Object.entries(attributes)) {
      // An app's own `tabindex` (for example -1, to keep the map out of the tab order) wins
      if (name === 'tabindex' && domElement.hasAttribute('tabindex')) continue
      this.savedAttributes.set(name, domElement.getAttribute(name))
      domElement.setAttribute(name, value)
    }
  }

  set enableDamping(value: boolean) {
    this.globe.enableDamping = value
    this.flatMap.enableDamping = value
  }

  /** Double-click or double-tap zooms in on that point. Default: true. */
  set doubleClickZoom(value: boolean) {
    this.globe.enableDoubleTapZoom = value
    this.flatMap.enableDoubleTapZoom = value
  }

  update(deltaSeconds?: number): void {
    const { earth, globe, flatMap } = this
    const view = earth.view
    const onGlobe = view.mode === '3d' && !view.transitioning
    const onFlatMap = view.mode === '2d' && !view.transitioning
    globe.enabled = onGlobe
    flatMap.enabled = onFlatMap
    this.touchGestures.tiltEnabled = onGlobe || flatMap.maximumTiltRadians > 0
    this.keyboard.maximumTiltDegrees = MathUtils.radToDeg(onFlatMap ? flatMap.maximumTiltRadians : this.maximumGlobeTiltRadians)
    // Taken every frame, so finger travel during a view transition is dropped rather than applied after it.
    const frame = this.touchGestures.takeFrame()
    const gesture = onGlobe || onFlatMap ? frame : null
    if (onGlobe) {
      const tiles = earth.terrain?.tiles
      if (tiles !== undefined && globe.ellipsoidGroup !== tiles.group) globe.setEllipsoid(tiles.ellipsoid, tiles.group)
      if (gesture !== null) this.applyGlobeGesture(gesture)
      globe.update(deltaSeconds)
    } else if (onFlatMap) {
      flatMap.followView(view)
      flatMap.terrainHeightMeters = this.findTerrainHeightUnderCamera()
      if (gesture !== null) this.applyFlatMapGesture(gesture)
      flatMap.update(deltaSeconds)
    } else {
      // Mid-morph, keep the whole map and globe between the clipping planes.
      const camera = globe.camera as (Camera & { near: number; far: number }) | null
      if (camera !== null && 'near' in camera) fitClippingPlanes(camera, camera.position.distanceTo(view.anchorPosition))
    }
  }

  protected applyGlobeGesture(gesture: TwoFingerFrame): void {
    const camera = this.globe.camera
    if (camera === null) return
    stopInertia(this.globe)
    // GlobeControls caps zoom out at a distance from the Earth's centre that keeps the globe in view.
    const globe = this.globe as unknown as { _getMaxPerspectiveDistance?: () => number }
    const perspective = (camera as Camera & { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true
    const maximumDistanceMeters = perspective ? (globe._getMaxPerspectiveDistance?.() ?? Infinity) : Infinity
    const maximumHeightMeters = Math.max(maximumDistanceMeters - WGS84_ELLIPSOID.radius.x, this.globe.minDistance)
    if (gesture.mode === 'transform') {
      applyTwoFingerTransformOnGlobe(camera, gesture, { minimumHeightMeters: this.globe.minDistance, maximumHeightMeters })
      return
    }
    if (WGS84_ELLIPSOID.intersectRay(getScreenRay(camera, screenCenter), gesturePivot) === null) return
    WGS84_ELLIPSOID.getPositionToNormal(gesturePivot, gestureUp)
    applyTwoFingerTilt(camera, gesture, gesturePivot, gestureUp, this.maximumGlobeTiltRadians)
  }

  protected applyFlatMapGesture(gesture: TwoFingerFrame): void {
    const camera = this.flatMap.camera
    if (camera === null) return
    stopInertia(this.flatMap)
    const view = this.earth.view
    gesturePlane.setFromNormalAndCoplanarPoint(view.anchorUp, view.anchorPosition)
    if (gesture.mode === 'transform') {
      applyTwoFingerTransformOnPlane(camera, gesturePlane, gesture, {
        minimumHeightMeters: this.flatMap.terrainHeightMeters + this.flatMap.minDistance,
        maximumHeightMeters: view.maximumFlatCameraHeightMeters(camera),
      })
      return
    }
    if (getScreenRay(camera, screenCenter).intersectPlane(gesturePlane, gesturePivot) === null) return
    applyTwoFingerTilt(camera, gesture, gesturePivot, view.anchorUp, this.flatMap.maximumTiltRadians)
  }

  /** Highest point of the visible tiles under the camera, from their regions, in map metres. */
  protected findTerrainHeightUnderCamera(): number {
    const view = this.earth.view
    const camera = this.flatMap.camera
    const tiles = this.earth.terrain?.tiles
    if (camera === null || tiles === undefined) return 0
    const geodetic = view.flatToGeodetic(cameraFlat.copy(camera.position).applyMatrix4(view.earthToFlat))
    const longitudeRadians = MathUtils.euclideanModulo(geodetic.longitudeRadians + Math.PI, 2 * Math.PI) - Math.PI
    const latitudeRadians = geodetic.latitudeRadians
    let highest = 0
    for (const tile of tiles.visibleTiles as Set<{ boundingVolume?: { region?: number[] } }>) {
      const region = tile.boundingVolume?.region
      if (region === undefined) continue
      const [west, south, east, north, , maximumHeight] = region as [number, number, number, number, number, number]
      if (longitudeRadians < west || longitudeRadians > east || latitudeRadians < south || latitudeRadians > north) continue
      highest = Math.max(highest, maximumHeight)
    }
    // The ground as drawn: exaggerated (raw tile regions hold the data's heights).
    return highest * (this.earth.terrain?.exaggeration ?? 1) * mercatorScaleFactor(latitudeRadians) * view.scale
  }

  dispose(): void {
    this.detach()
    this.globe.dispose()
    this.flatMap.dispose()
  }
}

/** Near and far planes for a camera at this height above the map: the whole visible map, with depth to spare. */
export function fitClippingPlanes(camera: Camera & { near: number; far: number; updateProjectionMatrix?: () => void }, heightMeters: number): void {
  const height = Math.max(Math.abs(heightMeters), 1)
  const near = Math.max(0.1, height * 1e-3)
  const far = Math.max(height * 100, 1e8)
  if (camera.near === near && camera.far === far) return
  camera.near = near
  camera.far = far
  camera.updateProjectionMatrix?.()
}
