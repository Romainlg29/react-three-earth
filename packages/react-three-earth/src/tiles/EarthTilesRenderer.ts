import { TilesRenderer, type Tile } from '3d-tiles-renderer'
import { Box3, Frustum, Matrix4, Vector3 } from 'three'

import type { ViewMorph } from '../view/ViewMorph.js'
import { latitudeToMercatorY, longitudeToMercatorX, mercatorScaleFactor, wrapMercatorXNear } from '../view/webMercator.js'

/** What `calculateTileViewError` writes (3DTilesRenderer's view error target). */
export interface TileViewError {
  inView: boolean
  error: number
  distanceFromCamera: number
}

/** 3DTilesRenderer's per-camera data, computed in `prepareForTraversal` (private there). */
interface CameraInfo {
  frustum: Frustum
  position: Vector3
  isOrthographic: boolean
  sseDenominator: number
  pixelSize: number
}

/** A camera seen from the map's anchor frame (flat metres around the anchor, east-north-up axes). */
interface FlatCameraInfo {
  frustum: Frustum
  position: Vector3
}

/** The stock renderer, with the internals this class overrides (untyped upstream, pinned to 0.5.x). */
const TilesRendererWithInternals = TilesRenderer as unknown as new (url?: string) => TilesRenderer & {
  cameraInfo: CameraInfo[]
  prepareForTraversal(): void
  calculateTileViewError(tile: Tile, target: TileViewError): void
}

const flatBox = new Box3()
const flatError: TileViewError = { inView: false, error: 0, distanceFromCamera: Infinity }
const groupToAnchor = new Matrix4()

/**
 * Bounds of a tile on the flat map, in metres around the anchor along its east-north-up axes, from its
 * region bounding volume (`[west, south, east, north, minimumHeight, maximumHeight]`, radians and metres).
 * Returns the largest Web Mercator scale factor over the tile, which scales its geometric error.
 */
export function getFlatRegionBox(region: readonly number[], view: ViewMorph, target: Box3): number {
  const [west, south, east, north, minimumHeight, maximumHeight] = region as [number, number, number, number, number, number]
  // Take the copy of the world nearest the anchor, like the meshes (see FlatMapPlugin).
  const unwrappedEast = east < west ? east + 2 * Math.PI : east
  const centerX = longitudeToMercatorX((west + unwrappedEast) / 2)
  const shift = wrapMercatorXNear(centerX, view.anchorMercatorXMeters) - centerX
  const anchorX = view.anchorMercatorXMeters - shift
  const anchorY = latitudeToMercatorY(view.anchorLatitudeRadians)
  const scale = view.scale
  const largestScaleFactor = Math.max(mercatorScaleFactor(south), mercatorScaleFactor(north))
  const smallestScaleFactor = south <= 0 && north >= 0 ? 1 : Math.min(mercatorScaleFactor(south), mercatorScaleFactor(north))
  const heights = [minimumHeight * largestScaleFactor, minimumHeight * smallestScaleFactor, maximumHeight * largestScaleFactor, maximumHeight * smallestScaleFactor]
  target.min.set(
    (longitudeToMercatorX(west) - anchorX) * scale,
    (latitudeToMercatorY(south) - anchorY) * scale,
    Math.min(...heights) * scale,
  )
  target.max.set(
    (longitudeToMercatorX(unwrappedEast) - anchorX) * scale,
    (latitudeToMercatorY(north) - anchorY) * scale,
    Math.max(...heights) * scale,
  )
  return largestScaleFactor
}

/**
 * A `TilesRenderer` that also selects tiles for the flat map. On the globe it is the stock renderer. On the
 * map, a tile's visibility and screen-space error come from where its region lies on the map plane, and its
 * geometric error is scaled by Web Mercator's enlargement there. During the morph, a tile is loaded if
 * either view needs it.
 *
 * Tiles without a region bounding volume (boxes, spheres) are selected as on the globe.
 */
export class EarthTilesRenderer extends TilesRendererWithInternals {
  /** The morph to follow. Null selects tiles for the globe only. */
  view: ViewMorph | null = null
  protected readonly flatCameraInfo: FlatCameraInfo[] = []

  override prepareForTraversal(): void {
    super.prepareForTraversal()
    const view = this.view
    if (view === null || view.morph === 0) return
    // Upstream's frustum and camera position are already in the tile set's frame (ECEF), like the anchor
    // frame. That frame is rigid, so distances measured in it are world distances.
    groupToAnchor.copy(view.anchorFrame).invert()
    while (this.flatCameraInfo.length < this.cameraInfo.length) this.flatCameraInfo.push({ frustum: new Frustum(), position: new Vector3() })
    this.flatCameraInfo.length = this.cameraInfo.length
    this.cameraInfo.forEach((info, index) => {
      const flat = this.flatCameraInfo[index]!
      flat.frustum.copy(info.frustum)
      for (const plane of flat.frustum.planes) plane.applyMatrix4(groupToAnchor)
      flat.position.copy(info.position).applyMatrix4(groupToAnchor)
    })
  }

  override calculateTileViewError(tile: Tile, target: TileViewError): void {
    const view = this.view
    const morph = view?.morph ?? 0
    const region = (tile.boundingVolume as { region?: number[] } | undefined)?.region
    if (view === null || morph === 0 || region === undefined) {
      super.calculateTileViewError(tile, target)
      return
    }
    if (morph === 1) {
      this.calculateFlatTileViewError(tile, region, view, target)
      return
    }
    super.calculateTileViewError(tile, target)
    this.calculateFlatTileViewError(tile, region, view, flatError)
    if (target.inView && flatError.inView) {
      target.error = Math.max(target.error, flatError.error)
      target.distanceFromCamera = Math.min(target.distanceFromCamera, flatError.distanceFromCamera)
    } else if (flatError.inView) {
      target.inView = true
      target.error = flatError.error
      target.distanceFromCamera = flatError.distanceFromCamera
    }
  }

  protected calculateFlatTileViewError(tile: Tile, region: readonly number[], view: ViewMorph, target: TileViewError): void {
    const scaleFactor = getFlatRegionBox(region, view, flatBox)
    const geometricError = tile.geometricError * view.scale * scaleFactor
    let inView = false
    let inViewError = 0
    let inViewDistance = Infinity
    let maxError = 0
    let minDistance = Infinity
    this.cameraInfo.forEach((info, index) => {
      const flat = this.flatCameraInfo[index]
      if (flat === undefined) return
      let error: number
      let distance: number
      if (info.isOrthographic) {
        error = geometricError / info.pixelSize
        distance = Infinity
      } else {
        distance = flatBox.distanceToPoint(flat.position)
        error = distance === 0 ? Infinity : geometricError / (distance * info.sseDenominator)
      }
      if (flat.frustum.intersectsBox(flatBox)) {
        inView = true
        inViewError = Math.max(inViewError, error)
        inViewDistance = Math.min(inViewDistance, distance)
      }
      maxError = Math.max(maxError, error)
      minDistance = Math.min(minDistance, distance)
    })
    target.inView = inView
    target.error = inView ? inViewError : maxError
    target.distanceFromCamera = inView ? inViewDistance : minDistance
  }
}
