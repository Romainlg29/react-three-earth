import { DoubleSide, Matrix3, Mesh, NoBlending, PlaneGeometry, Scene, SRGBColorSpace, Texture } from 'three'
import { texture as textureNode, uniform, positionLocal, step, vec3, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import type { GeographicBounds } from '../../core/camera.js'
import { RegisteredDrapedLayer, type DrapedLayerDrawInputs } from '../../plugins/drapedLayers.js'
import { DrapedLayerOverlay } from './DrapedLayerOverlay.js'

/** The four corners of a georeferenced picture, in degrees: top-left, top-right, bottom-right, bottom-left, as MapLibre's `coordinates`. */
export type GeoreferencedCorners = readonly [
  readonly [longitudeDegrees: number, latitudeDegrees: number],
  readonly [longitudeDegrees: number, latitudeDegrees: number],
  readonly [longitudeDegrees: number, latitudeDegrees: number],
  readonly [longitudeDegrees: number, latitudeDegrees: number],
]

/** Throws an error stating the fix when `corners` is not four finite `[longitude, latitude]` pairs. */
export function validateCorners(corners: unknown, componentName: string): asserts corners is GeoreferencedCorners {
  const valid =
    Array.isArray(corners) &&
    corners.length === 4 &&
    corners.every(corner => Array.isArray(corner) && corner.length >= 2 && Number.isFinite(corner[0]) && Number.isFinite(corner[1]) && Math.abs(corner[1]) <= 90)
  if (!valid) {
    throw new Error(
      `${componentName}: \`coordinates\` must be four [longitudeDegrees, latitudeDegrees] corners, clockwise from the top-left ` +
        '(top-left, top-right, bottom-right, bottom-left), with latitudes within ±90.',
    )
  }
}

/**
 * Longitudes made continuous from the first corner (a picture across the antimeridian lists 179 then -179: the
 * second becomes 181), and the bounds that hold them. West is greater than east when the box crosses the
 * antimeridian, as `GeographicBounds` everywhere.
 */
export function unwrapCorners(corners: GeoreferencedCorners): { longitudes: number[]; bounds: GeographicBounds } {
  const first = corners[0][0]
  const longitudes = corners.map(([longitude]) => longitude - Math.round((longitude - first) / 360) * 360)
  const west = Math.min(...longitudes)
  const east = Math.max(...longitudes)
  const latitudes = corners.map(([, latitude]) => latitude)
  const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180
  return {
    longitudes,
    bounds: { westDegrees: wrap(west), southDegrees: Math.min(...latitudes), eastDegrees: east - west >= 360 ? wrap(west) + 360 : wrap(east), northDegrees: Math.max(...latitudes) },
  }
}

/**
 * The projective map from the unit square of a picture (u right, v up, 0 to 1) to a quad in the region's space:
 * Heckbert's `squareToQuad`. Corners are bottom-left, bottom-right, top-right, top-left. Returns the matrix
 * row-major as nine numbers, or null for a degenerate quad (zero area, or not convex).
 */
export function squareToQuad(points: ReadonlyArray<{ x: number; y: number }>): number[] | null {
  const [p0, p1, p2, p3] = points as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  if (Math.abs(dx3) < 1e-15 && Math.abs(dy3) < 1e-15) {
    const matrix = [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1]
    return Math.abs(matrix[0]! * matrix[4]! - matrix[1]! * matrix[3]!) < 1e-30 ? null : matrix
  }
  const denominator = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denominator) < 1e-30) return null
  const g = (dx3 * dy2 - dy3 * dx2) / denominator
  const h = (dx1 * dy3 - dy1 * dx3) / denominator
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1]
}

export interface GeoreferencedImageOverlayOptions {
  /** The picture's corners (see `GeoreferencedCorners`). */
  coordinates: GeoreferencedCorners
  opacity: number
  /** Names the overlay in error messages. */
  label: string
}

let overlayCount = 0

/**
 * A picture (image, video frame or canvas) stretched over four geographic corners, draped on the terrain: for
 * each terrain region it covers, a quad is drawn through the imagery compositor with the homography of the
 * corners, so it lines up with the map at every zoom. Shared by `ImageSource` and `VideoSource`.
 *
 * It is a draped layer owned by the source: the same region cache, per-frame budget and redraw-in-place as
 * plugins' draped layers. A new picture or new corners redraw only the regions they touch. Give it a texture
 * with `setTexture` and call `invalidate` when its content changed.
 */
export class GeoreferencedImageOverlay extends DrapedLayerOverlay {
  protected corners: GeoreferencedCorners
  protected unwrapped: ReturnType<typeof unwrapCorners>
  protected pictureTexture: Texture | null = null
  protected readonly homography = uniform(new Matrix3())
  protected readonly textureReader = textureNode(new Texture())
  protected readonly scene = new Scene()
  protected readonly quad: Mesh
  protected readonly material: MeshBasicNodeMaterial
  /** Runs once when the overlay is disposed: the source frees what it made for it (a texture, a frame loop). */
  readonly disposers: Array<() => void> = []

  constructor({ coordinates, opacity, label }: GeoreferencedImageOverlayOptions) {
    validateCorners(coordinates, label)
    let overlay: GeoreferencedImageOverlay | null = null
    const layer = new RegisteredDrapedLayer(
      { id: `${label}-${++overlayCount}`, bounds: () => overlay?.unwrapped.bounds ?? null, draw: inputs => overlay?.drawPicture(inputs) },
      0,
    )
    super(layer)
    overlay = this
    this.corners = coordinates
    this.unwrapped = unwrapCorners(coordinates)
    this.opacity = opacity
    this.material = this.createMaterial()
    this.quad = new Mesh(new PlaneGeometry(1, 1), this.material)
    this.quad.position.set(0.5, 0.5, 0)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  protected createMaterial(): MeshBasicNodeMaterial {
    // Region space (0 to 1) → the picture's own space through the inverse homography, per pixel.
    const region = positionLocal.xy.add(0.5)
    const projected = this.homography.mul(vec3(region, 1))
    const uv = projected.xy.div(projected.z)
    const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
    const picture = this.textureReader.sample(uv)
    const material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, side: DoubleSide })
    material.colorNode = vec4(picture.rgb, picture.a.mul(inside))
    return material
  }

  /** The texture drawn, or null while there is none (nothing is drawn). Redraws the covered regions. */
  setTexture(picture: Texture | null): void {
    if (this.pictureTexture === picture) return
    this.pictureTexture = picture
    if (picture !== null) picture.colorSpace = SRGBColorSpace
    this.invalidate()
  }

  /** Moves the picture to new corners, redrawing where it was and where it is now. */
  setCoordinates(coordinates: GeoreferencedCorners): void {
    validateCorners(coordinates, this.layer.id)
    this.corners = coordinates
    this.unwrapped = unwrapCorners(coordinates)
    this.invalidate()
  }

  /** Draws the picture into one region. */
  protected drawPicture({ renderer, region }: DrapedLayerDrawInputs): void {
    const picture = this.pictureTexture
    if (picture === null) return
    const [minimumX, , maximumX] = region.mercatorRange
    const width = maximumX - minimumX
    const centreX = (minimumX + maximumX) / 2
    // Region-space point of each corner. The picture's longitudes are continuous (`unwrapCorners`); the whole quad
    // moves by one whole number of worlds to sit nearest to the region.
    const unwrappedCentreX = (this.unwrapped.longitudes.reduce((sum, value) => sum + value, 0) / 4 + 180) / 360
    const shift = Math.round(unwrappedCentreX - centreX)
    const point = (index: number) => {
      const longitude = this.unwrapped.longitudes[index] ?? 0
      const { y } = region.project({ longitudeDegrees: 0, latitudeDegrees: this.corners[index]?.[1] ?? 0 })
      return { x: ((longitude + 180) / 360 - shift - minimumX) / width, y }
    }
    // Unit square corners bottom-left, bottom-right, top-right, top-left ↔ corners 3, 2, 1, 0.
    const forward = squareToQuad([point(3), point(2), point(1), point(0)])
    if (forward === null) return
    const matrix = this.homography.value as Matrix3
    matrix.set(...(forward as [number, number, number, number, number, number, number, number, number]))
    if (Math.abs(matrix.determinant()) < 1e-300) return
    matrix.invert()
    this.homography.value = matrix
    this.textureReader.value = picture
    renderer.render(this.scene, region.camera)
  }

  get coordinates(): GeoreferencedCorners {
    return this.corners
  }

  override dispose(): void {
    if (this.disposed) return
    for (const dispose of this.disposers.splice(0)) dispose()
    super.dispose()
    this.material.dispose()
    this.quad.geometry.dispose()
    this.pictureTexture = null
  }
}
