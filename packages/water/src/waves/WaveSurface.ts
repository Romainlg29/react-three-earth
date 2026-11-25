import { Matrix4, Vector3, type Camera, type Object3D } from 'three'
import { cameraWorldMatrix, float, fwidth, max, positionView, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

import type { SeaStateOptions } from './spectrum.js'
import { WaveField, type WaveFieldOptions } from './WaveField.js'

/** WGS84 semi-axes, metres. */
const EQUATORIAL_RADIUS_METERS = 6378137
const POLAR_RADIUS_METERS = 6356752.314245
/**
 * How far the camera may move along the sea from the wave plane's anchor before it is laid again under the camera, metres.
 * The plane is flat, and its coordinates lose precision far from the anchor; laying it again shifts the waves once.
 */
const REANCHOR_DISTANCE_METERS = 20_000
/**
 * Above this height the longest cascade has faded out everywhere (a pixel spans more than two of its 12.5 m texels even
 * straight down), so `update` skips the simulation, metres.
 */
export const WAVE_MAXIMUM_CAMERA_HEIGHT_METERS = 30_000

export interface WaveSurfaceNodes {
  /** The resolved waves' slope at the fragment, east and north, dimensionless. 0 where the waves fade out. */
  slope: Node<'vec2'>
  /** The slope variance the drawn waves carry at the fragment: what roughness need not stand for any more. */
  resolvedMeanSquareSlope: Node<'float'>
  /** The wave plane's east and north axes, in world space. */
  east: Node<'vec3'>
  north: Node<'vec3'>
}

/**
 * The wave field laid on the globe: a flat plane tangent to the ellipsoid under the camera, on which the cascades tile.
 * A fragment's place on it comes from its camera-relative position (exact under the renderer's `highPrecision`) and
 * the camera's offset from the plane's anchor (64-bit, on the CPU), so the waves hold still to the millimetre anywhere on
 * Earth. Each cascade fades out where a pixel covers several of its texels: there its waves are too small to draw and the
 * roughness takes them back.
 */
export class WaveSurface {
  readonly field: WaveField
  /** 1 draws the waves, 0 leaves the sea flat. */
  readonly weight = uniform(1)
  protected readonly east = uniform(new Vector3(1, 0, 0))
  protected readonly north = uniform(new Vector3(0, 1, 0))
  protected readonly cameraFromAnchor = uniform(new Vector3())
  protected readonly meanSquareSlopes: UniformNode<'float', number>[]
  protected anchorEarthCenteredMeters: Vector3 | null = null
  protected readonly anchorEast = new Vector3()
  protected readonly anchorNorth = new Vector3()
  protected readonly anchorUp = new Vector3()
  protected timeSecondsValue = 0

  constructor(options: WaveFieldOptions = {}) {
    this.field = new WaveField(options)
    this.meanSquareSlopes = this.field.cascades.map(() => uniform(0) as UniformNode<'float', number>)
  }

  get timeSeconds(): number {
    return this.timeSecondsValue
  }

  setSeaState(options: SeaStateOptions): void {
    this.field.setSeaState(options)
    this.field.cascades.forEach((cascade, index) => {
      this.meanSquareSlopes[index]!.value = cascade.meanSquareSlope
    })
  }

  /**
   * Advances the waves and lays the plane under the camera. `earth` is the object whose frame is ECEF. Returns false,
   * doing nothing, when the camera is too high for any wave to show (`WAVE_MAXIMUM_CAMERA_HEIGHT_METERS`).
   */
  update(deltaSeconds: number, camera: Camera, earth: Object3D): boolean {
    this.timeSecondsValue += deltaSeconds
    const cameraWorld = scratchCamera.setFromMatrixPosition(camera.matrixWorld)
    const cameraEarth = scratchCameraEarth.copy(cameraWorld).applyMatrix4(scratchMatrix.copy(earth.matrixWorld).invert())
    if (heightAboveEllipsoid(cameraEarth) > WAVE_MAXIMUM_CAMERA_HEIGHT_METERS) return false
    this.field.update(this.timeSecondsValue)
    this.followCamera(cameraWorld, cameraEarth, earth)
    return true
  }

  protected followCamera(cameraWorld: Vector3, cameraEarth: Vector3, earth: Object3D): void {
    const anchor = this.anchorEarthCenteredMeters
    if (anchor === null || horizontalDistance(cameraEarth, anchor, this.anchorUp) > REANCHOR_DISTANCE_METERS) {
      this.anchorEarthCenteredMeters = cameraEarth.clone()
      const { east, north, up } = eastNorthAt(cameraEarth)
      this.anchorEast.copy(east)
      this.anchorNorth.copy(north)
      this.anchorUp.copy(up)
    }
    this.east.value.copy(this.anchorEast).transformDirection(earth.matrixWorld)
    this.north.value.copy(this.anchorNorth).transformDirection(earth.matrixWorld)
    // Both in 64-bit: the difference is small near the anchor, so it survives the shader's 32-bit floats.
    this.cameraFromAnchor.value.copy(cameraWorld).sub(scratchAnchor.copy(this.anchorEarthCenteredMeters!).applyMatrix4(earth.matrixWorld))
  }

  createNodes(): WaveSurfaceNodes {
    const offset = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz.add(this.cameraFromAnchor)
    const plane = vec2(offset.dot(this.east), offset.dot(this.north))
    // Metres a pixel spans on the plane.
    const footprint = max(fwidth(plane.x), fwidth(plane.y))
    let slope: Node = vec2(0)
    let resolved: Node = float(0)
    this.field.cascades.forEach((cascade, index) => {
      const texelMeters = cascade.lengthMeters / this.field.gridSize
      // Gone before a pixel spans two texels: without mipmaps, a cascade sampled sparser than that shimmers.
      const fade = float(1).sub(smoothstep(texelMeters * 0.75, texelMeters * 2, footprint)).mul(this.weight)
      slope = (slope as Node<'vec2'>).add(texture(cascade.texture, plane.div(cascade.lengthMeters)).rg.mul(fade))
      // The slopes are scaled by the fade, so the variance drawn by its square.
      resolved = (resolved as Node<'float'>).add(this.meanSquareSlopes[index]!.mul(fade.mul(fade)))
    })
    return {
      slope: slope as Node<'vec2'>,
      resolvedMeanSquareSlope: resolved as Node<'float'>,
      east: this.east as unknown as Node<'vec3'>,
      north: this.north as unknown as Node<'vec3'>,
    }
  }

  dispose(): void {
    this.field.dispose()
  }
}

/** The local east and north directions at a point given in ECEF metres, from the ellipsoid's normal there. */
export function eastNorthAt(point: Vector3): { east: Vector3; north: Vector3; up: Vector3 } {
  const up = new Vector3(point.x / EQUATORIAL_RADIUS_METERS ** 2, point.y / EQUATORIAL_RADIUS_METERS ** 2, point.z / POLAR_RADIUS_METERS ** 2).normalize()
  const east = new Vector3(-point.y, point.x, 0)
  // At a pole every direction is south: pick one.
  if (east.lengthSq() < 1e-6) east.set(0, 1, 0)
  east.normalize()
  const north = new Vector3().crossVectors(up, east).normalize()
  return { east, north, up }
}

const scratchCamera = new Vector3()
const scratchCameraEarth = new Vector3()
const scratchAnchor = new Vector3()
const scratchOffset = new Vector3()
const scratchMatrix = new Matrix4()

function horizontalDistance(point: Vector3, anchor: Vector3, up: Vector3): number {
  const offset = scratchOffset.copy(point).sub(anchor)
  const vertical = offset.dot(up)
  return Math.sqrt(Math.max(offset.lengthSq() - vertical * vertical, 0))
}

/** Height of an ECEF point above the WGS84 ellipsoid, metres, to within a few kilometres: enough to tell orbit from sea. */
function heightAboveEllipsoid(point: Vector3): number {
  const horizontal = Math.hypot(point.x, point.y)
  const latitude = Math.atan2(point.z, horizontal)
  const radius = Math.hypot(EQUATORIAL_RADIUS_METERS * Math.cos(latitude), POLAR_RADIUS_METERS * Math.sin(latitude))
  return point.length() - radius
}
