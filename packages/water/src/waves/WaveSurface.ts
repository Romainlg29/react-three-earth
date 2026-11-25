import { DataArrayTexture, HalfFloatType, LinearFilter, Matrix4, RepeatWrapping, RGBAFormat, Vector2, Vector3, type Camera, type Object3D } from 'three'
import { cameraWorldMatrix, float, fwidth, int, max, mix, mx_fractal_noise_float, mx_worley_noise_float, positionView, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import type { Node, TextureNode, UniformNode, WebGPURenderer } from 'three/webgpu'

import { inverseStandardNormal, WAVE_BREAKING_SHARE, WAVE_CHOPPINESS } from './foam.js'
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
  /** Where the fragment lies on the wave plane: metres east and north of its anchor. */
  plane: Node<'vec2'>
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
  /** Φ⁻¹ of the share breaking now (`WAVE_BREAKING_SHARE` of `whitecapCoverage`): how far below its mean the Jacobian falls on a breaking crest. */
  protected readonly whitecapScore = uniform(-8)
  /** The slope variance of the ripples finer than the smallest cascade: what the close-up detail draws. */
  protected readonly unresolvedMeanSquareSlope = uniform(0)
  /** The sea surface's whole slope variance (`setSurfaceMeanSquareSlope`), cascades and finer ripples together. */
  protected surfaceMeanSquareSlope = 0
  /** 1 once the GPU computes the displacement's derivatives, so the foam follows the breaking crests. */
  protected readonly foamFromWaves = uniform(0)
  /** Sample the slopes (and on the GPU the displacement's derivatives): their values swap to the GPU's textures. */
  protected readonly surfaceSampler: TextureNode
  protected readonly foldSampler: TextureNode
  /** Samples the foam the crests left (on the GPU path; zeros before). */
  protected readonly foamSampler: TextureNode
  protected readonly emptyFold: DataArrayTexture
  protected readonly east = uniform(new Vector3(1, 0, 0))
  protected readonly north = uniform(new Vector3(0, 1, 0))
  protected readonly cameraFromAnchor = uniform(new Vector3())
  /** The camera on the wave plane: metres east and north of the anchor. */
  readonly cameraPlane = uniform(new Vector2())
  /** The camera's height over the wave plane, metres (the plane lies at sea level under the anchor). */
  readonly cameraPlaneHeight = uniform(0)
  /** Sea level, metres above the ellipsoid: where a mesh of the waves lies. */
  seaLevelMeters = 0
  /** The camera's height above sea level, metres, from the last `update`. */
  cameraHeightAboveSeaMeters = Infinity
  /** The camera's height above the WGS84 ellipsoid and its geodetic position, as of the last `update`. */
  cameraHeightMeters = Infinity
  cameraLatitudeRadians = 0
  cameraLongitudeRadians = 0
  /**
   * The wave plane's frame in ECEF (the earth's frame) at sea level under the anchor: x east, y north, z up, metres. A mesh
   * of the waves placed in it lies on the plane; `curvatureRadiusMeters` bends it down with the Earth.
   */
  readonly planeFrame = new Matrix4()
  /** The Earth's mean radius of curvature at the anchor, metres. */
  curvatureRadiusMeters = EQUATORIAL_RADIUS_METERS
  protected laidSeaLevelMeters = 0
  /** Counts the anchor's moves, so a mesh knows to lay itself again. */
  anchorVersion = 0
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
    this.foamSampler = texture(this.emptyFold)
  }

  /** Sets the share of the sea white with whitecaps (`whitecapCoverage`): the drawn foam covers as much. */
  setWhitecapCoverage(coverage: number): void {
    this.whitecapCoverage.value = coverage
    this.whitecapScore.value = inverseStandardNormal(coverage * WAVE_BREAKING_SHARE)
    if (this.computeField !== null) this.computeField.breakingScore.value = this.whitecapScore.value
  }

  /**
   * Sets the sea surface's whole slope variance (Cox & Munk's, from the wind): what the cascades do not draw, ripples
   * finer than the smallest, is drawn near the camera as detail (`WAVE_DETAIL_SCALES`), and stands as roughness beyond.
   */
  setSurfaceMeanSquareSlope(meanSquareSlope: number): void {
    this.surfaceMeanSquareSlope = meanSquareSlope
    this.useField(this.computeSpectrum ?? this.field)
  }

  /** The GPU simulation while a WebGPU renderer runs `update`; null on the CPU path (WebGL2). */
  get compute(): WaveComputeField | null {
    return this.computeField
  }

  /**
   * The waves' clock, seconds. It advances with every `update`; set it (with the same seed) to show the same sea on
   * several devices at once, for example from a shared server time.
   */
  get timeSeconds(): number {
    return this.timeSecondsValue
  }

  set timeSeconds(value: number) {
    if (!Number.isFinite(value)) throw new Error(`WaveSurface: timeSeconds must be a finite number, got ${value}.`)
    this.timeSecondsValue = value
  }

  /** The seed of the waves' random phases: the same seed, sea state and time draw the same sea everywhere. */
  get seed(): number {
    return this.field.seed
  }

  /** Draws another sea from `seed` (any integer), in the same sea state. */
  setSeed(seed: number): void {
    this.field.setSeed(seed)
    this.computeSpectrum?.setSeed(seed)
    this.useField(this.computeSpectrum ?? this.field)
  }

  setSeaState(options: SeaStateOptions): void {
    this.seaState = { ...options }
    this.field.setSeaState(options)
    this.computeSpectrum?.setSeaState(options)
    this.useField(this.computeSpectrum ?? this.field)
  }

  /** Points the uniforms at the simulation drawn now: its texel sizes and slope variances. */
  protected useField(field: WaveField): void {
    let drawn = 0
    field.cascades.forEach((cascade, index) => {
      this.meanSquareSlopes[index]!.value = cascade.meanSquareSlope
      this.texelSizes[index]!.value = cascade.lengthMeters / field.gridSize
      drawn += cascade.meanSquareSlope
    })
    this.unresolvedMeanSquareSlope.value = Math.max(this.surfaceMeanSquareSlope - drawn, 0)
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
    const { latitude, height } = geodeticLatitudeAndHeight(cameraEarth)
    this.cameraHeightAboveSeaMeters = height - this.seaLevelMeters
    this.cameraHeightMeters = height
    this.cameraLatitudeRadians = latitude
    this.cameraLongitudeRadians = Math.atan2(cameraEarth.y, cameraEarth.x)
    if (height > WAVE_MAXIMUM_CAMERA_HEIGHT_METERS) return false
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
    const spectrum = new WaveField({ ...this.fieldOptions, seed: this.field.seed, gridSize: WAVE_COMPUTE_GRID_SIZE })
    if (this.seaState !== null) spectrum.setSeaState(this.seaState)
    this.computeSpectrum = spectrum
    this.useField(spectrum)
    const compute = new WaveComputeField(spectrum)
    this.surfaceSampler.value = compute.surfaceTexture
    this.foldSampler.value = compute.foldTexture
    this.foamSampler.value = compute.foamTexture
    compute.breakingScore.value = this.whitecapScore.value
    this.foamFromWaves.value = 1
    return compute
  }

  /** Moves the simulation back to the CPU and frees the GPU's. */
  protected stopCompute(): void {
    this.surfaceSampler.value = this.field.texture
    this.foldSampler.value = this.emptyFold
    this.foamSampler.value = this.emptyFold
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
      this.layPlaneFrame(cameraEarth)
    } else if (this.laidSeaLevelMeters !== this.seaLevelMeters) {
      this.layPlaneFrame(anchor)
    }
    this.east.value.copy(this.anchorEast).transformDirection(earth.matrixWorld)
    this.north.value.copy(this.anchorNorth).transformDirection(earth.matrixWorld)
    // Both in 64-bit: the difference is small near the anchor, so it survives the shader's 32-bit floats.
    this.cameraFromAnchor.value.copy(cameraWorld).sub(scratchAnchor.copy(this.anchorEarthCenteredMeters!).applyMatrix4(earth.matrixWorld))
    const fromAnchor = scratchOffset.copy(cameraEarth).sub(this.anchorEarthCenteredMeters!)
    this.cameraPlane.value.set(fromAnchor.dot(this.anchorEast), fromAnchor.dot(this.anchorNorth))
    this.cameraPlaneHeight.value = scratchOffset.copy(cameraEarth).sub(scratchOrigin.setFromMatrixPosition(this.planeFrame)).dot(this.anchorUp)
  }

  /** Lays the plane's frame at sea level under the anchor, with the Earth's curvature there. */
  protected layPlaneFrame(anchor: Vector3): void {
    const { latitude, height } = geodeticLatitudeAndHeight(anchor)
    const origin = scratchOrigin.copy(anchor).addScaledVector(this.anchorUp, this.seaLevelMeters - height)
    this.planeFrame.makeBasis(this.anchorEast, this.anchorNorth, this.anchorUp).setPosition(origin)
    const sine = Math.sin(latitude)
    const denominator = 1 - ECCENTRICITY_SQUARED * sine * sine
    const meridian = (EQUATORIAL_RADIUS_METERS * (1 - ECCENTRICITY_SQUARED)) / denominator ** 1.5
    const primeVertical = EQUATORIAL_RADIUS_METERS / Math.sqrt(denominator)
    this.curvatureRadiusMeters = Math.sqrt(meridian * primeVertical)
    this.laidSeaLevelMeters = this.seaLevelMeters
    this.anchorVersion++
  }

  /**
   * The waves at the fragment of a surface lying on the sea (the terrain), from its camera-relative position: the plane
   * coordinates follow from it, and each cascade fades by the fragment's footprint.
   */
  createNodes(): WaveSurfaceNodes {
    const offset = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz.add(this.cameraFromAnchor)
    const plane = vec2(offset.dot(this.east), offset.dot(this.north)) as unknown as Node<'vec2'>
    return this.sampleWaves(plane)
  }

  /**
   * The waves at a point of the plane (metres east and north of the anchor), in a fragment shader: each cascade fades
   * where the fragment's footprint on the plane covers several of its texels.
   */
  sampleWaves(plane: Node<'vec2'>): WaveSurfaceNodes {
    // Metres a pixel spans on the plane.
    const footprint = max(fwidth(plane.x), fwidth(plane.y))
    let slope: Node = vec2(0)
    // ∂Dx/∂x, ∂Dy/∂y and ∂Dx/∂y of the displacement, summed over the cascades.
    let stretch: Node = vec2(0)
    let shear: Node = float(0)
    // The foam the cascades' crests left, weighted by the slope variance each draws here.
    let left: Node = float(0)
    let resolved: Node = float(0)
    let total: Node = float(0)
    this.field.cascades.forEach((cascade, index) => {
      const fade = this.cascadeFade(index, footprint)
      const uv = plane.div(cascade.lengthMeters)
      const surface = this.surfaceSampler.sample(uv).depth(int(index))
      slope = (slope as Node<'vec2'>).add(surface.xy.mul(fade))
      stretch = (stretch as Node<'vec2'>).add(surface.zw.mul(fade))
      shear = (shear as Node<'float'>).add(this.foldSampler.sample(uv).depth(int(index)).x.mul(fade))
      // The slopes are scaled by the fade, so the variance drawn by its square.
      const drawn = this.meanSquareSlopes[index]!.mul(fade.mul(fade))
      resolved = (resolved as Node<'float'>).add(drawn)
      left = (left as Node<'float'>).add(this.foamSampler.sample(uv).depth(int(index)).x.mul(drawn))
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
    const { slope: detailSlope, meanSquareSlope: detailMeanSquareSlope } = this.sampleDetail(plane, footprint)
    // Crests breaking now, and the foam left where they broke, fading.
    const density = max(breaking, (left as Node<'float'>).div(max(resolved as Node<'float'>, 1e-8)))
    // Where the waves fade out, their foam gives way to the whitecap share spread evenly.
    const drawnShare = (resolved as Node<'float'>).div(max(total as Node<'float'>, 1e-8)).mul(this.foamFromWaves)
    const foam = mix(this.whitecapCoverage, foamPattern(plane, footprint, density as Node<'float'>), drawnShare)
    return {
      plane,
      slope: (slope as Node<'vec2'>).add(detailSlope) as unknown as Node<'vec2'>,
      resolvedMeanSquareSlope: (resolved as Node<'float'>).add(detailMeanSquareSlope) as unknown as Node<'float'>,
      east: this.east as unknown as Node<'vec3'>,
      north: this.north as unknown as Node<'vec3'>,
      foam: foam as unknown as Node<'float'>,
    }
  }

  /**
   * The ripples finer than the smallest cascade, near the camera: its texture read again shrunk by each of
   * `WAVE_DETAIL_SCALES` and turned, scaled so that together they carry the slope variance the cascades leave out. Each
   * fades as a cascade does, by its own texels; the variance drawn comes back with them, for the roughness to give up.
   */
  protected sampleDetail(plane: Node<'vec2'>, footprint: Node<'float'>): { slope: Node<'vec2'>; meanSquareSlope: Node<'float'> } {
    const last = this.field.cascades.length - 1
    const lengthMeters = this.field.cascades[last]!.lengthMeters
    const share = this.unresolvedMeanSquareSlope.div(WAVE_DETAIL_SCALES.length)
    const gain = sqrt(share.div(max(this.meanSquareSlopes[last]!, 1e-8)))
    let slope: Node = vec2(0)
    let drawn: Node = float(0)
    WAVE_DETAIL_SCALES.forEach((scale, index) => {
      const angle = WAVE_DETAIL_ANGLES_RADIANS[index]!
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const turned = vec2(plane.x.mul(cosine).sub(plane.y.mul(sine)), plane.x.mul(sine).add(plane.y.mul(cosine)))
      const texelMeters = this.texelSizes[last]!.div(scale)
      const fade = float(1).sub(smoothstep(texelMeters.mul(0.75), texelMeters.mul(2), footprint)).mul(this.weight)
      const sampled = this.surfaceSampler.sample(turned.mul(scale / lengthMeters)).depth(int(last)).xy
      // The slope found in the turned frame, turned back.
      const back = vec2(sampled.x.mul(cosine).add(sampled.y.mul(sine)), sampled.y.mul(cosine).sub(sampled.x.mul(sine)))
      slope = (slope as Node<'vec2'>).add(back.mul(gain.mul(fade)))
      drawn = (drawn as Node<'float'>).add(share.mul(fade.mul(fade)))
    })
    return { slope: slope as Node<'vec2'>, meanSquareSlope: drawn as Node<'float'> }
  }

  /**
   * The surface's displacement at a point of the plane, in a vertex shader: east and north (the choppy waves' pull
   * towards the crests, -λ D) and up (the height), metres. Each cascade fades where `spacingMeters` (the vertices'
   * spacing) covers several of its texels, so a coarse mesh does not alias the short waves. Zero on the CPU path, which
   * transforms neither.
   */
  sampleDisplacement(plane: Node<'vec2'>, spacingMeters: Node<'float'>): Node<'vec3'> {
    let displacement: Node = vec3(0)
    this.field.cascades.forEach((cascade, index) => {
      const fade = this.cascadeFade(index, spacingMeters)
      const fold = this.foldSampler.sample(plane.div(cascade.lengthMeters)).depth(int(index)).level(float(0))
      displacement = (displacement as Node<'vec3'>).add(vec3(fold.z.mul(-WAVE_CHOPPINESS), fold.w.mul(-WAVE_CHOPPINESS), fold.y).mul(fade))
    })
    return (displacement as Node<'vec3'>).mul(this.foamFromWaves) as unknown as Node<'vec3'>
  }

  /**
   * The surface's slopes (east, north) at a point of the plane, outside a fragment shader: each cascade fades where
   * `spacingMeters` covers several of its texels, as in `sampleDisplacement`.
   */
  sampleSlope(plane: Node<'vec2'>, spacingMeters: Node<'float'>): Node<'vec2'> {
    let slope: Node = vec2(0)
    this.field.cascades.forEach((cascade, index) => {
      const fade = this.cascadeFade(index, spacingMeters)
      const surface = this.surfaceSampler.sample(plane.div(cascade.lengthMeters)).depth(int(index)).level(float(0))
      slope = (slope as Node<'vec2'>).add(surface.xy.mul(fade))
    })
    return slope as Node<'vec2'>
  }

  /**
   * Where a point given in ECEF metres lies on the wave plane: metres east and north of its anchor, into `target`. Null
   * before the plane is first laid (the first `update` below `WAVE_MAXIMUM_CAMERA_HEIGHT_METERS`).
   */
  planePosition(earthCentered: Vector3, target: Vector2): Vector2 | null {
    const anchor = this.anchorEarthCenteredMeters
    if (anchor === null) return null
    const offset = scratchOffset.copy(earthCentered).sub(anchor)
    return target.set(offset.dot(this.anchorEast), offset.dot(this.anchorNorth))
  }

  /** Turns a direction from ECEF into the plane's frame (x east, y north, z up, at the anchor), into `target`. */
  directionToPlane(direction: Vector3, target: Vector3): Vector3 {
    return target.set(direction.dot(this.anchorEast), direction.dot(this.anchorNorth), direction.dot(this.anchorUp))
  }

  /** Turns a direction from the plane's frame (x east, y north, z up, at the anchor) into ECEF, in place. */
  planeDirectionToEarth(direction: Vector3): Vector3 {
    const { x, y, z } = direction
    return direction.copy(this.anchorEast).multiplyScalar(x).addScaledVector(this.anchorNorth, y).addScaledVector(this.anchorUp, z)
  }

  /** 1 while a cascade's texels are well sampled at `footprint` metres, falling to 0 before it spans two of them. */
  protected cascadeFade(index: number, footprint: Node<'float'>): Node<'float'> {
    const texelMeters = this.texelSizes[index]!
    // Without mipmaps, a cascade sampled sparser than that shimmers.
    return float(1).sub(smoothstep(texelMeters.mul(0.75), texelMeters.mul(2), footprint)).mul(this.weight) as unknown as Node<'float'>
  }

  dispose(): void {
    this.stopCompute()
    this.field.dispose()
    this.emptyFold.dispose()
  }
}

/**
 * How much smaller than the smallest cascade the close-up ripples are drawn: two scales that never line up, so the
 * detail does not repeat visibly. With 256 texels on the GPU, the finest texel is a few millimetres.
 */
export const WAVE_DETAIL_SCALES = [3.7, 6.3] as const
/** The detail layers' turns from the wind, radians: their own directions, as capillary ripples have. */
const WAVE_DETAIL_ANGLES_RADIANS = [0.9, 2.3] as const

/** The size of the foam's bubbly cells, metres. */
const FOAM_CELL_METERS = 0.6

/**
 * Foam of `density` (0 to 1) broken into bubbly cells: fresh foam covers them all, thinning foam opens their middles
 * into a web, then wisps. Farther than a pixel per cell, the density itself.
 */
function foamPattern(plane: Node<'vec2'>, footprint: Node<'float'>, density: Node<'float'>): Node<'float'> {
  const swirl = mx_fractal_noise_float(plane.div(FOAM_CELL_METERS * 6), 3)
  // The cells, warped: bubbles clear their middles first, so thinning foam is a web between them, then wisps.
  const cells = mx_worley_noise_float(plane.div(FOAM_CELL_METERS).add(swirl.mul(1.5)))
  const pattern = float(1).sub(cells).mul(0.75).add(swirl.mul(0.2)).add(0.1)
  const patches = smoothstep(pattern.sub(0.1), pattern.add(0.1), density)
  return mix(patches, density, smoothstep(FOAM_CELL_METERS * 0.5, FOAM_CELL_METERS * 2, footprint)) as unknown as Node<'float'>
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
const scratchOrigin = new Vector3()
const scratchCameraEarth = new Vector3()
const scratchAnchor = new Vector3()
const scratchOffset = new Vector3()
const scratchMatrix = new Matrix4()

function horizontalDistance(point: Vector3, anchor: Vector3, up: Vector3): number {
  const offset = scratchOffset.copy(point).sub(anchor)
  const vertical = offset.dot(up)
  return Math.sqrt(Math.max(offset.lengthSq() - vertical * vertical, 0))
}

const ECCENTRICITY_SQUARED = 1 - (POLAR_RADIUS_METERS / EQUATORIAL_RADIUS_METERS) ** 2

/** A geographic position (WGS84 degrees, metres above the ellipsoid) in ECEF metres, into `target`. */
export function earthCenteredFromGeographic(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number, target: Vector3): Vector3 {
  const longitude = (longitudeDegrees * Math.PI) / 180
  const latitude = (latitudeDegrees * Math.PI) / 180
  const sine = Math.sin(latitude)
  const cosine = Math.cos(latitude)
  const primeVertical = EQUATORIAL_RADIUS_METERS / Math.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
  const horizontal = (primeVertical + heightMeters) * cosine
  return target.set(horizontal * Math.cos(longitude), horizontal * Math.sin(longitude), (primeVertical * (1 - ECCENTRICITY_SQUARED) + heightMeters) * sine)
}

/** Geodetic latitude (radians) and height above the WGS84 ellipsoid (metres) of an ECEF point, to the millimetre (Bowring). */
export function geodeticLatitudeAndHeight(point: Vector3): { latitude: number; height: number } {
  const a = EQUATORIAL_RADIUS_METERS
  const b = POLAR_RADIUS_METERS
  const horizontal = Math.hypot(point.x, point.y)
  const secondEccentricitySquared = (a * a - b * b) / (b * b)
  const theta = Math.atan2(point.z * a, horizontal * b)
  const latitude = Math.atan2(point.z + secondEccentricitySquared * b * Math.sin(theta) ** 3, horizontal - ECCENTRICITY_SQUARED * a * Math.cos(theta) ** 3)
  const sine = Math.sin(latitude)
  const primeVertical = a / Math.sqrt(1 - ECCENTRICITY_SQUARED * sine * sine)
  // Near the poles the horizontal form loses precision: use the vertical one there.
  const height = Math.abs(Math.cos(latitude)) > 1e-3 ? horizontal / Math.cos(latitude) - primeVertical : Math.abs(point.z) / Math.abs(sine) - primeVertical * (1 - ECCENTRICITY_SQUARED)
  return { latitude, height }
}

