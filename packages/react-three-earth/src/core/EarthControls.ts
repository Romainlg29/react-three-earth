// Pivot material adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06,
// itself ported from 3DTilesRendererJS's PivotPointMesh (Apache-2.0).
import { EnvironmentControls, GlobeControls } from '3d-tiles-renderer'
import { Group, MathUtils, Vector3, type Camera, type Material, type Mesh } from 'three'
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
  /** Fingers' spread at the last pinch step, in pixels, or null outside a pinch. */
  protected pinchSeparationPixels: number | null = null

  constructor(...args: ConstructorParameters<typeof GlobeControls>) {
    super(...args)
    replacePivotMaterial(this)
  }

  /** 3DTilesRenderer's zoom step (untyped upstream), with pinches kept under the fingers. */
  _updateZoom(): void {
    this.pinchSeparationPixels = lockPinchToFingers(this, this.pinchSeparationPixels)
    ;(GlobeControls.prototype as unknown as { _updateZoom(this: GlobeControls): void })._updateZoom.call(this)
  }
}

/** 3DTilesRenderer's internals that a pinch reads (untyped upstream, pinned to 0.5.x). */
interface PinchInternals {
  state: number
  zoomDelta: number
  zoomSpeed: number
  pointerTracker: {
    getPointerType(): string
    getPointerCount(): number
    getTouchPointerDistance(): number
    getStartTouchPointerDistance(): number
  }
}

/** 3DTilesRenderer's ZOOM state and the share of the distance one zoom unit moves (`ZOOM_DELTA_SCALAR`). */
const ZOOM_STATE = 3
const ZOOM_DELTA_SCALAR = 0.0025

/**
 * Makes a two-finger pinch zoom like a map app: spreading the fingers to twice their distance halves the
 * camera's distance, so the ground stays under them. Upstream moves a fixed share of the distance per
 * pixel of spread instead, which on a phone zooms about half as far as the fingers move. Sets the
 * controls' zoom step for this frame and returns the spread to compare with next frame.
 */
export function lockPinchToFingers(controls: object, previousSeparationPixels: number | null): number | null {
  const internals = controls as PinchInternals
  const tracker = internals.pointerTracker
  if (internals.state !== ZOOM_STATE || tracker.getPointerType() !== 'touch' || tracker.getPointerCount() !== 2) return null
  const separation = tracker.getTouchPointerDistance()
  const previous = previousSeparationPixels ?? tracker.getStartTouchPointerDistance()
  if (separation > 0 && previous > 0) internals.zoomDelta = (1 - previous / separation) / (ZOOM_DELTA_SCALAR * internals.zoomSpeed)
  return separation
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
  /** Fingers' spread at the last pinch step, in pixels, or null outside a pinch. */
  protected pinchSeparationPixels: number | null = null

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

  /** 3DTilesRenderer's zoom step (untyped upstream), with pinches kept under the fingers. */
  _updateZoom(): void {
    this.pinchSeparationPixels = lockPinchToFingers(this, this.pinchSeparationPixels)
    ;(EnvironmentControls.prototype as unknown as { _updateZoom(this: EnvironmentControls): void })._updateZoom.call(this)
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

/**
 * Hands the camera between `EarthControls` on the globe and `FlatMapControls` on the flat map, following
 * `earth.view`: input goes to the controls of the view shown, and is ignored while the view morphs. User
 * input stops a running camera animation. This is what `<EarthControls>` uses; vanilla apps call `update`
 * once per frame, before `earth.update`.
 */
export class EarthViewControls {
  readonly globe = new EarthControls()
  readonly flatMap = new FlatMapControls()

  constructor(protected readonly earth: Earth) {
    this.globe.setScene(earth)
    // User input takes over from a running camera animation (`earth.camera.flyTo` and the rest).
    const stopAnimation = () => earth.camera.stop()
    this.globe.addEventListener('start', stopAnimation)
    this.flatMap.addEventListener('start', stopAnimation)
  }

  setCamera(camera: Camera): void {
    this.globe.setCamera(camera)
    this.flatMap.setCamera(camera)
  }

  attach(domElement: HTMLElement): void {
    this.globe.attach(domElement)
    this.flatMap.attach(domElement)
  }

  detach(): void {
    this.globe.detach()
    this.flatMap.detach()
  }

  set enableDamping(value: boolean) {
    this.globe.enableDamping = value
    this.flatMap.enableDamping = value
  }

  update(deltaSeconds?: number): void {
    const { earth, globe, flatMap } = this
    const view = earth.view
    const onGlobe = view.mode === '3d' && !view.transitioning
    const onFlatMap = view.mode === '2d' && !view.transitioning
    globe.enabled = onGlobe
    flatMap.enabled = onFlatMap
    if (onGlobe) {
      const tiles = earth.terrain?.tiles
      if (tiles !== undefined && globe.ellipsoidGroup !== tiles.group) globe.setEllipsoid(tiles.ellipsoid, tiles.group)
      globe.update(deltaSeconds)
    } else if (onFlatMap) {
      flatMap.followView(view)
      flatMap.terrainHeightMeters = this.findTerrainHeightUnderCamera()
      flatMap.update(deltaSeconds)
    } else {
      // Mid-morph, keep the whole map and globe between the clipping planes.
      const camera = globe.camera as (Camera & { near: number; far: number }) | null
      if (camera !== null && 'near' in camera) fitClippingPlanes(camera, camera.position.distanceTo(view.anchorPosition))
    }
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
    return highest * mercatorScaleFactor(latitudeRadians) * view.scale
  }

  dispose(): void {
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
