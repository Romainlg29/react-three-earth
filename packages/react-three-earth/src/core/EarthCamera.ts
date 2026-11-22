import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { MathUtils, Ray, Raycaster, Vector2, Vector3, type Camera, type Intersection } from 'three'

import { mercatorScaleFactor, WEB_MERCATOR_HALF_EXTENT_METERS, wrapMercatorXNear } from '../view/webMercator.js'
import { placeCameraAround, toCartesian, type GeographicBounds, type GeographicPosition } from './camera.js'
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

  constructor(protected readonly earth: Earth) {}

  setCamera(camera: Camera): void {
    this.camera = camera
  }

  setViewportSize(widthPixels: number, heightPixels: number): void {
    this.viewportWidthPixels = widthPixels
    this.viewportHeightPixels = heightPixels
  }

  /** True once there is a perspective camera and a viewport size, so every method can run. */
  get ready(): boolean {
    return (this.camera as { isPerspectiveCamera?: boolean } | null)?.isPerspectiveCamera === true && this.viewportWidthPixels > 0 && this.viewportHeightPixels > 0
  }

  /** True when positions are read on the flat map rather than the globe. */
  get onFlatMap(): boolean {
    return this.earth.view.morph > 0.5
  }

  /** The centre of the screen, zoom, heading, pitch and distance. */
  getView(): MapView {
    const camera = this.requireCamera()
    const focalLength = focalLengthPixels(camera, this.requireViewport().height)
    cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld)
    cameraUp.set(0, 1, 0).transformDirection(camera.matrixWorld)
    ray.set(cameraPosition, forward)
    return this.onFlatMap ? this.getFlatMapView(focalLength) : this.getGlobeView(focalLength)
  }

  protected getGlobeView(focalLength: number): MapView {
    const point = this.intersectTerrain(ray, surfacePoint) ?? intersectEllipsoidOrHorizon(ray, surfacePoint)?.point
    // Looking away from the Earth: use the point under the camera.
    const center = point ?? WGS84_ELLIPSOID.getPositionToSurfacePoint(cameraPosition, surfacePoint)
    WGS84_ELLIPSOID.getPositionToCartographic(center, cartographic)
    WGS84_ELLIPSOID.getEastNorthUpAxes(cartographic.lat, cartographic.lon, east, north, up)
    const distanceMeters = cameraPosition.distanceTo(center)
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

  protected getFlatMapView(focalLength: number): MapView {
    const view = this.earth.view
    this.toFlatRay(ray, flatRay)
    // Looking above the map's horizon: use the point under the camera.
    const center = this.intersectFlatMap(flatRay, flatPoint) ?? flatPoint.copy(flatRay.origin).setZ(0)
    const { longitudeRadians, latitudeRadians, heightMeters } = view.flatToGeodetic(center)
    // Flat coordinates are Web Mercator metres; the map is `view.scale` ECEF metres per flat unit.
    const flatDistance = flatRay.origin.distanceTo(center)
    const { headingRadians, pitchRadians } = headingAndPitch(
      flatRay.direction,
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
   * Moves the camera at once. Fields left out keep their current value. Without `heightMeters`, a new
   * centre sits on the loaded terrain (0 where none is loaded). During a morph to the flat map the morph
   * flies the camera itself: jump once `earth.view.transitioning` is false. When the screen centre shows
   * sky, `getView` stands in the horizon point (or the point under the camera), so changing only zoom,
   * heading or pitch re-aims the camera at that point.
   */
  jumpTo(change: MapViewChange): void {
    const camera = this.requireCamera()
    const focalLength = focalLengthPixels(camera, this.requireViewport().height)
    const current = this.getView()
    const centerMoved = change.longitudeDegrees !== undefined || change.latitudeDegrees !== undefined
    const longitudeDegrees = change.longitudeDegrees ?? current.longitudeDegrees
    const latitudeDegrees = change.latitudeDegrees ?? current.latitudeDegrees
    const position = { longitudeDegrees, latitudeDegrees }
    const heightMeters = change.heightMeters ?? (centerMoved ? (this.queryTerrainElevation(position) ?? 0) : current.heightMeters)
    const zoom = change.zoom ?? (change.distanceMeters === undefined ? current.zoom : undefined)
    const heading = MathUtils.degToRad(change.headingDegrees ?? current.headingDegrees)
    const pitch = MathUtils.degToRad(change.pitchDegrees ?? current.pitchDegrees)

    if (this.onFlatMap) {
      const view = this.earth.view
      const latitude = MathUtils.degToRad(latitudeDegrees)
      const target = view.geodeticToFlat(MathUtils.degToRad(longitudeDegrees), latitude, heightMeters, flatPoint)
      target.x = wrapMercatorXNear(target.x, view.anchorMercatorXMeters)
      target.applyMatrix4(view.flatToEarth)
      const distanceMeters = zoom === undefined ? change.distanceMeters! : zoomToMercatorMetersPerPixel(zoom) * focalLength * view.scale
      // The flat map's axes in ECEF: east and north along the plane, up its normal.
      east.setFromMatrixColumn(view.anchorFrame, 0)
      north.setFromMatrixColumn(view.anchorFrame, 1)
      placeCameraAround(camera, target, east, north, up.copy(view.anchorUp), heading, pitch, distanceMeters)
    } else {
      const latitude = MathUtils.degToRad(latitudeDegrees)
      const longitude = MathUtils.degToRad(longitudeDegrees)
      const target = WGS84_ELLIPSOID.getCartographicToPosition(latitude, longitude, heightMeters, surfacePoint)
      WGS84_ELLIPSOID.getEastNorthUpAxes(latitude, longitude, east, north, up)
      const distanceMeters = zoom === undefined ? change.distanceMeters! : zoomToGroundMetersPerPixel(zoom, latitudeDegrees) * focalLength
      placeCameraAround(camera, target, east, north, up, heading, pitch, distanceMeters)
    }
    this.earth.requestFrame()
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
    const center = this.unprojectOnSurface(width / 2, height / 2) ?? this.getView()
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
    if (center !== null) include(center)

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
    if (point === null) return null
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
    flat.x = wrapMercatorXNear(flat.x, view.anchorMercatorXMeters)
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
   * (held inside the one world around the anchor, longitudes not wrapped). Null on sky.
   */
  protected unprojectOnSurface(xPixels: number, yPixels: number): GeographicPosition | null {
    this.setScreenRay(xPixels, yPixels, ray)
    if (this.onFlatMap) {
      this.toFlatRay(ray, flatRay)
      if (flatRay.direction.z >= 0) return null
      const point = flatRay.at(-flatRay.origin.z / flatRay.direction.z, flatPoint)
      // The map ends at the edges of the Web Mercator square: one world wide, around the anchor.
      const anchorX = this.earth.view.anchorMercatorXMeters
      point.x = Math.max(anchorX - WEB_MERCATOR_HALF_EXTENT_METERS, Math.min(anchorX + WEB_MERCATOR_HALF_EXTENT_METERS, point.x))
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
  protected intersectFlatMap(flat: Ray, target: Vector3): Vector3 | null {
    if (flat.direction.z >= 0) return null
    let heightFlat = 0
    const iterations = this.earth.terrain === null ? 1 : FLAT_MAP_RELIEF_ITERATIONS
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
