import { DataArrayTexture, HalfFloatType, LinearFilter, Matrix4, RepeatWrapping, RGBAFormat, Vector3, type Camera, type Object3D } from 'three'
import { cameraWorldMatrix, float, fwidth, int, max, mix, positionView, smoothstep, sqrt, texture, uniform, vec2, vec4 } from 'three/tsl'
import type { Node, TextureNode, UniformNode, WebGPURenderer } from 'three/webgpu'

import { inverseStandardNormal, WAVE_CHOPPINESS } from './foam.js'
import type { SeaStateOptions } from './spectrum.js'
import { WaveComputeField } from './WaveComputeField.js'
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
/**
 * Texels per side of each cascade on the GPU. Four times the CPU's: each tile then holds four times the wavelengths, so
 * the waves that show at a given distance come from a longer tile and its repeats are far apart.
 */
export const WAVE_COMPUTE_GRID_SIZE = 256

export interface WaveSurfaceNodes {
  /** The resolved waves' slope at the fragment, east and north, dimensionless. 0 where the waves fade out. */
  slope: Node<'vec2'>
  /** The slope variance the drawn waves carry at the fragment: what roughness need not stand for any more. */
  resolvedMeanSquareSlope: Node<'float'>
  /** The wave plane's east and north axes, in world space. */
  east: Node<'vec3'>
  north: Node<'vec3'>
  /**
   * The whitecap foam at the fragment, 0 to 1. On the GPU path, the breaking crests of the drawn waves (their Jacobian),
   * covering the whitecap share; where no wave is drawn, and on the CPU path, that share spread evenly.
   */
  foam: Node<'float'>
}

/**
 * The wave field laid on the globe: a flat plane tangent to the ellipsoid under the camera, on which the cascades tile.
 * A fragment's place on it comes from its camera-relative position (exact under the renderer's `highPrecision`) and
 * the camera's offset from the plane's anchor (64-bit, on the CPU), so the waves hold still to the millimetre anywhere on
 * Earth. Each cascade fades out where a pixel covers several of its texels: there its waves are too small to draw and the
 * roughness takes them back.
 */
export class WaveSurface {
  /** The CPU simulation (WebGL2), `WAVE_GRID_SIZE` texels a side. */
  readonly field: WaveField
  /** The spectrum the GPU simulates, `WAVE_COMPUTE_GRID_SIZE` texels a side: made with the GPU simulation. */
  protected computeSpectrum: WaveField | null = null
  protected readonly fieldOptions: WaveFieldOptions
  protected seaState: SeaStateOptions | null = null
  /** Per cascade: the metres a texel spans in the simulation drawn now (CPU or GPU). */
  protected readonly texelSizes: UniformNode<'float', number>[]
  /** The GPU simulation while a WebGPU renderer runs `update`; null on the CPU path (WebGL2). */
  protected computeField: WaveComputeField | null = null
  /** 1 draws the waves, 0 leaves the sea flat. */
  readonly weight = uniform(1)
  /** The share of the sea white with whitecaps. */
  protected readonly whitecapCoverage = uniform(0)
  /** Φ⁻¹ of `whitecapCoverage`: how far below its mean the Jacobian falls on the foam. */
  protected readonly whitecapScore = uniform(-8)
  /** 1 once the GPU computes the displacement's derivatives, so the foam follows the breaking crests. */
  protected readonly foamFromWaves = uniform(0)
  /** Sample the slopes (and on the GPU the displacement's derivatives): their values swap to the GPU's textures. */
  protected readonly surfaceSampler: TextureNode
  protected readonly foldSampler: TextureNode
  protected readonly emptyFold: DataArrayTexture
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
    this.fieldOptions = options
    this.field = new WaveField(options)
    this.meanSquareSlopes = this.field.cascades.map(() => uniform(0) as UniformNode<'float', number>)
    this.texelSizes = this.field.cascades.map(cascade => uniform(cascade.lengthMeters / this.field.gridSize) as UniformNode<'float', number>)
    this.surfaceSampler = texture(this.field.texture)
    // Until the GPU writes them, no fold: zeros, one texel per cascade.
    const layers = this.field.cascades.length
    this.emptyFold = new DataArrayTexture(new Uint16Array(4 * layers), 1, 1, layers)
    this.emptyFold.format = RGBAFormat
    this.emptyFold.type = HalfFloatType
    // The GPU's sampling, which shaders built before the swap keep: filtered and repeating.
    this.emptyFold.wrapS = RepeatWrapping
    this.emptyFold.wrapT = RepeatWrapping
    this.emptyFold.minFilter = LinearFilter
    this.emptyFold.magFilter = LinearFilter
    this.emptyFold.generateMipmaps = false
    this.emptyFold.needsUpdate = true
    this.foldSampler = texture(this.emptyFold)
  }

  /** Sets the share of the sea white with whitecaps (`whitecapCoverage`): the drawn foam covers as much. */
  setWhitecapCoverage(coverage: number): void {
    this.whitecapCoverage.value = coverage
    this.whitecapScore.value = inverseStandardNormal(coverage)
  }

  /** The GPU simulation while a WebGPU renderer runs `update`; null on the CPU path (WebGL2). */
  get compute(): WaveComputeField | null {
    return this.computeField
  }

  get timeSeconds(): number {
    return this.timeSecondsValue
  }

  setSeaState(options: SeaStateOptions): void {
    this.seaState = { ...options }
    this.field.setSeaState(options)
    this.computeSpectrum?.setSeaState(options)
    this.useField(this.computeSpectrum ?? this.field)
  }

  /** Points the uniforms at the simulation drawn now: its texel sizes and slope variances. */
  protected useField(field: WaveField): void {
    field.cascades.forEach((cascade, index) => {
      this.meanSquareSlopes[index]!.value = cascade.meanSquareSlope
      this.texelSizes[index]!.value = cascade.lengthMeters / field.gridSize
    })
  }

  /**
   * Advances the waves and lays the plane under the camera. `earth` is the object whose frame is ECEF. With a WebGPU
   * `renderer` the simulation runs on the GPU (and draws foam); without one, or on WebGL2, on the CPU. Returns false,
   * doing nothing, when the camera is too high for any wave to show (`WAVE_MAXIMUM_CAMERA_HEIGHT_METERS`).
   */
  update(deltaSeconds: number, camera: Camera, earth: Object3D, renderer?: WebGPURenderer): boolean {
    this.timeSecondsValue += deltaSeconds
    const cameraWorld = scratchCamera.setFromMatrixPosition(camera.matrixWorld)
    const cameraEarth = scratchCameraEarth.copy(cameraWorld).applyMatrix4(scratchMatrix.copy(earth.matrixWorld).invert())
    if (heightAboveEllipsoid(cameraEarth) > WAVE_MAXIMUM_CAMERA_HEIGHT_METERS) return false
    if (renderer !== undefined && isWebGPUBackend(renderer)) {
      this.computeField ??= this.startCompute()
      this.computeField.update(renderer, this.timeSecondsValue)
    } else {
      // No WebGPU (or another renderer took over): back to the CPU.
      if (this.computeField !== null) this.stopCompute()
      this.field.update(this.timeSecondsValue)
    }
    this.followCamera(cameraWorld, cameraEarth, earth)
    return true
  }

  /** Moves the simulation to the GPU: the shaders already built sample its textures from now on. */
  protected startCompute(): WaveComputeField {
    const spectrum = new WaveField({ ...this.fieldOptions, gridSize: WAVE_COMPUTE_GRID_SIZE })
    if (this.seaState !== null) spectrum.setSeaState(this.seaState)
    this.computeSpectrum = spectrum
    this.useField(spectrum)
    const compute = new WaveComputeField(spectrum)
    this.surfaceSampler.value = compute.surfaceTexture
    this.foldSampler.value = compute.foldTexture
    this.foamFromWaves.value = 1
    return compute
  }

  /** Moves the simulation back to the CPU and frees the GPU's. */
  protected stopCompute(): void {
    this.surfaceSampler.value = this.field.texture
    this.foldSampler.value = this.emptyFold
    this.foamFromWaves.value = 0
    this.computeField?.dispose()
    this.computeField = null
    this.computeSpectrum?.dispose()
    this.computeSpectrum = null
    this.useField(this.field)
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
    // ∂Dx/∂x, ∂Dy/∂y and ∂Dx/∂y of the displacement, summed over the cascades.
    let stretch: Node = vec2(0)
    let shear: Node = float(0)
    let resolved: Node = float(0)
    let total: Node = float(0)
    this.field.cascades.forEach((cascade, index) => {
      const texelMeters = this.texelSizes[index]!
      // Gone before a pixel spans two texels: without mipmaps, a cascade sampled sparser than that shimmers.
      const fade = float(1).sub(smoothstep(texelMeters.mul(0.75), texelMeters.mul(2), footprint)).mul(this.weight)
      const uv = plane.div(cascade.lengthMeters)
      const surface = this.surfaceSampler.sample(uv).depth(int(index))
      slope = (slope as Node<'vec2'>).add(surface.xy.mul(fade))
      stretch = (stretch as Node<'vec2'>).add(surface.zw.mul(fade))
      shear = (shear as Node<'float'>).add(this.foldSampler.sample(uv).depth(int(index)).x.mul(fade))
      // The slopes are scaled by the fade, so the variance drawn by its square.
      resolved = (resolved as Node<'float'>).add(this.meanSquareSlopes[index]!.mul(fade.mul(fade)))
      total = (total as Node<'float'>).add(this.meanSquareSlopes[index]!)
    })
    const stretched = stretch as Node<'vec2'>
    const sheared = shear as Node<'float'>
    const lambda = WAVE_CHOPPINESS
    const jacobian = float(1)
      .sub(stretched.x.mul(lambda))
      .mul(float(1).sub(stretched.y.mul(lambda)))
      .sub(sheared.mul(sheared).mul(lambda * lambda))
    // The Jacobian's spread here (first order): λ σ, σ² the slope variance drawn. Foam below 1 + λ z σ, softly.
    const spread = sqrt(resolved as Node<'float'>).mul(lambda)
    const threshold = float(1).add(spread.mul(this.whitecapScore))
    const edge = spread.mul(0.25).add(1e-4)
    const breaking = float(1).sub(smoothstep(threshold.sub(edge), threshold.add(edge), jacobian))
    // Where the waves fade out, their foam gives way to the whitecap share spread evenly.
    const drawnShare = (resolved as Node<'float'>).div(max(total as Node<'float'>, 1e-8)).mul(this.foamFromWaves)
    const foam = mix(this.whitecapCoverage, breaking, drawnShare)
    return {
      slope: slope as Node<'vec2'>,
      resolvedMeanSquareSlope: resolved as Node<'float'>,
      east: this.east as unknown as Node<'vec3'>,
      north: this.north as unknown as Node<'vec3'>,
      foam: foam as unknown as Node<'float'>,
    }
  }

  dispose(): void {
    this.stopCompute()
    this.field.dispose()
    this.emptyFold.dispose()
  }
}

function isWebGPUBackend(renderer: WebGPURenderer): boolean {
  return (renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true
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
