import { FloatType, NearestFilter, NoColorSpace, RenderTarget, RGBAFormat, Vector3 } from 'three'
import { floor, Fn, screenCoordinate, vec2, vec4 } from 'three/tsl'
import { NodeMaterial, QuadMesh, type Renderer } from 'three/webgpu'

import { getMieDensity, getOzoneDensity, getRayleighDensity } from './air.js'
import type { AtmosphereContext } from './AtmosphereContext.js'
import { correctPositionForEllipsoid } from './AtmosphereContext.js'
import type { AtmosphereParameters } from './AtmosphereParameters.js'

/** Sunlight and skylight at a point, in the atmosphere's scaled units (see `AtmosphereIlluminance`). */
export interface SunAndSkyIlluminance {
  /** Sunlight reaching the point, on a surface facing the sun: the sun's illuminance after the air above. */
  sun: Vector3
  /** Skylight on a surface facing up (the ellipsoid's normal), without the sun. Zero while `skyAvailable` is false. */
  sky: Vector3
  /** Whether `sky` holds the sky's light: false until the lookup textures are generated and read back. */
  skyAvailable: boolean
}

/** Trapezoid samples of the CPU transmittance integral: the same count as the GPU precomputation. */
const TRANSMITTANCE_SAMPLES = 500

const positionScratch = /*#__PURE__*/ new Vector3()
const normalScratch = /*#__PURE__*/ new Vector3()
const transmittanceScratch = /*#__PURE__*/ new Vector3()
const opticalDepthScratch = /*#__PURE__*/ new Vector3()

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Sunlight and skylight at any ECEF point, on the CPU: for placing lights, lighting effects drawn with
 * their own shaders (an @aeronautic plume's smoke), or exposure. The shader counterpart is
 * `AtmosphereContext.getSunAndSkyIlluminance`; both give the same values.
 *
 * Units are the atmosphere's scaled luminance (see `AtmosphereParameters.getLuminanceScale`): divide by the
 * scale for lux. Colours are the three wavelengths, read as linear RGB.
 *
 * - Sunlight: the transmittance from the point to the sun is integrated here, in double precision, exactly
 *   as the GPU precomputes its lookup texture, so it is available at once.
 * - Skylight: read from the GPU's irradiance lookup texture (4 KB) once it is generated (`readBack`).
 */
export class AtmosphereIlluminance {
  readonly parameters: AtmosphereParameters

  /** Irradiance texels, RGBA, in texture row order (row 0: the bottom of the atmosphere). Null before `readBack`. */
  protected irradiance: Float32Array | null = null

  protected readonly sunLuminanceFactor: Vector3
  protected readonly skyLuminanceFactor: Vector3

  constructor(parameters: AtmosphereParameters) {
    this.parameters = parameters
    const scale = parameters.getLuminanceScale()
    this.sunLuminanceFactor = parameters.sunRadianceToLuminanceLumensPerWatt.clone().multiplyScalar(scale)
    this.skyLuminanceFactor = parameters.skyRadianceToLuminanceLumensPerWatt.clone().multiplyScalar(scale)
  }

  /** Whether the skylight is known (`readBack` has completed). */
  get skyAvailable(): boolean {
    return this.irradiance !== null
  }

  /**
   * Copies the GPU's irradiance lookup texture to the CPU. Call once its data is generated. A small pass
   * looks every texel up through the same TSL the shaders use and tags each row with its index, so the
   * result does not depend on how a backend orders rows in a read-back.
   */
  async readBack(renderer: Renderer, context: AtmosphereContext): Promise<void> {
    const { model, textures } = context
    const size = this.parameters.textureSizesTexels.irradiance
    const target = new RenderTarget(size.x, size.y, { depthBuffer: false, format: RGBAFormat, type: FloatType })
    target.texture.minFilter = NearestFilter
    target.texture.magFilter = NearestFilter
    target.texture.colorSpace = NoColorSpace
    target.texture.generateMipmaps = false
    const material = new NodeMaterial()
    material.name = 'AtmosphereIlluminanceReadBack'
    material.depthTest = false
    material.depthWrite = false
    material.fragmentNode = Fn(() => {
      const { radius, sunZenithCosine } = model.radiusAndSunCosineFromIrradianceTextureUv(screenCoordinate.div(vec2(size.x, size.y)))
      return vec4(model.getIrradiance(textures.irradiance, radius, sunZenithCosine), floor(screenCoordinate.y))
    })()
    const quad = new QuadMesh(material)
    const previousTarget = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(target)
      quad.render(renderer)
      renderer.setRenderTarget(previousTarget)
      const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, size.x, size.y)) as Float32Array
      this.setIrradianceTexels(pixels)
    } finally {
      renderer.setRenderTarget(previousTarget)
      material.dispose()
      target.dispose()
    }
  }

  /**
   * Sets the irradiance texels from a read-back whose alpha channel holds each texel's row (as `readBack`
   * renders them), in any row order.
   */
  setIrradianceTexels(pixels: Float32Array): void {
    const { x: width, y: height } = this.parameters.textureSizesTexels.irradiance
    const ordered = new Float32Array(width * height * 4)
    for (let row = 0; row < height; row++) {
      const offset = row * width * 4
      const textureRow = Math.round(pixels[offset + 3]!)
      if (textureRow < 0 || textureRow >= height) throw new Error(`AtmosphereIlluminance: unexpected irradiance row tag ${textureRow}.`)
      ordered.set(pixels.subarray(offset, offset + width * 4), textureRow * width * 4)
    }
    this.irradiance = ordered
  }

  /** Forgets the read-back skylight (the lookup textures were released). */
  reset(): void {
    this.irradiance = null
  }

  /**
   * Sunlight and skylight at an ECEF point, with the sun in a direction.
   * @param positionMeters ECEF position. Points below the ground are lit as at the ground.
   * @param sunDirection Unit vector towards the sun, ECEF.
   */
  getSunAndSkyIlluminance(positionMeters: Vector3, sunDirection: Vector3, target?: SunAndSkyIlluminance): SunAndSkyIlluminance {
    const result = target ?? { sun: new Vector3(), sky: new Vector3(), skyAvailable: false }
    const p = this.parameters
    const position = correctPositionForEllipsoid(positionMeters, p.ellipsoidRadiiMeters, p.bottomRadiusMeters, positionScratch)
    const radius = Math.min(Math.max(position.length(), p.bottomRadiusMeters + 0.1), p.topRadiusMeters)
    const radii = p.ellipsoidRadiiMeters
    const up = normalScratch.set(positionMeters.x / radii.x ** 2, positionMeters.y / radii.y ** 2, positionMeters.z / radii.z ** 2).normalize()
    const sunZenithCosine = Math.min(Math.max(up.dot(sunDirection), -1), 1)

    const transmittance = this.getTransmittanceToSun(radius, sunZenithCosine, transmittanceScratch)
    result.sun.copy(p.solarIrradianceWattsPerSquareMeterNanometer).multiply(transmittance).multiply(this.sunLuminanceFactor)

    result.skyAvailable = this.irradiance !== null
    if (this.irradiance === null) result.sky.set(0, 0, 0)
    else this.sampleIrradiance(radius, sunZenithCosine, result.sky).multiply(this.skyLuminanceFactor)
    return result
  }

  /**
   * Transmittance from a point at `radiusMeters` from the model's centre to the sun, faded by the share
   * of the sun disk above the horizon (`AtmosphereModel.getTransmittanceToSun`).
   */
  getTransmittanceToSun(radiusMeters: number, sunZenithCosine: number, target = new Vector3()): Vector3 {
    const p = this.parameters
    const sinHorizon = p.bottomRadiusMeters / radiusMeters
    const cosHorizon = -Math.sqrt(Math.max(1 - sinHorizon * sinHorizon, 0))
    const halfWidth = sinHorizon * p.sunAngularRadiusRadians
    const visibleFraction = smoothstep(-halfWidth, halfWidth, sunZenithCosine - cosHorizon)
    return this.getTransmittanceToTopAtmosphereBoundary(radiusMeters, sunZenithCosine, target).multiplyScalar(visibleFraction)
  }

  /** Transmittance along a ray to the top of the atmosphere, by the GPU precomputation's trapezoidal rule. */
  getTransmittanceToTopAtmosphereBoundary(radiusMeters: number, viewZenithCosine: number, target = new Vector3()): Vector3 {
    const p = this.parameters
    const r = radiusMeters
    const discriminant = r * r * (viewZenithCosine * viewZenithCosine - 1) + p.topRadiusMeters ** 2
    const distance = Math.max(-r * viewZenithCosine + Math.sqrt(Math.max(discriminant, 0)), 0)
    const step = distance / TRANSMITTANCE_SAMPLES
    let rayleigh = 0
    let mie = 0
    let ozone = 0
    for (let index = 0; index <= TRANSMITTANCE_SAMPLES; index++) {
      const along = index * step
      const altitude = Math.sqrt(along * along + 2 * r * viewZenithCosine * along + r * r) - p.bottomRadiusMeters
      const weight = index === 0 || index === TRANSMITTANCE_SAMPLES ? 0.5 : 1
      rayleigh += getRayleighDensity(p, altitude) * weight
      mie += getMieDensity(p, altitude) * weight
      ozone += getOzoneDensity(p, altitude) * weight
    }
    const depth = opticalDepthScratch
      .copy(p.rayleighScatteringPerMeter)
      .multiplyScalar(rayleigh * step)
      .addScaledVector(p.mieExtinctionPerMeter, mie * step)
      .addScaledVector(p.ozoneAbsorptionPerMeter, ozone * step)
    return target.set(Math.exp(-depth.x), Math.exp(-depth.y), Math.exp(-depth.z))
  }

  /** Bilinear lookup in the read-back irradiance texture, as `AtmosphereModel.getIrradiance`. */
  protected sampleIrradiance(radiusMeters: number, sunZenithCosine: number, target: Vector3): Vector3 {
    const data = this.irradiance!
    const p = this.parameters
    const { x: width, y: height } = p.textureSizesTexels.irradiance
    const radiusUnit = (radiusMeters - p.bottomRadiusMeters) / (p.topRadiusMeters - p.bottomRadiusMeters)
    const sunUnit = sunZenithCosine * 0.5 + 0.5
    // Unit range to texel space: texel centres at the ends, as `textureCoordinateFromUnitRange`.
    const texelX = Math.min(Math.max(sunUnit * (width - 1), 0), width - 1)
    const texelY = Math.min(Math.max(radiusUnit * (height - 1), 0), height - 1)
    const x0 = Math.floor(texelX)
    const y0 = Math.floor(texelY)
    const x1 = Math.min(x0 + 1, width - 1)
    const y1 = Math.min(y0 + 1, height - 1)
    const fx = texelX - x0
    const fy = texelY - y0
    const at = (x: number, y: number, channel: number): number => data[(y * width + x) * 4 + channel]!
    const channel = (c: number): number =>
      (at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx) * (1 - fy) + (at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx) * fy
    return target.set(channel(0), channel(1), channel(2))
  }
}
