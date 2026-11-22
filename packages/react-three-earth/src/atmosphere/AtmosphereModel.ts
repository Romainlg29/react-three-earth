// Ported to TSL from Eric Bruneton's "Precomputed Atmospheric Scattering: a New Implementation" (2017),
// atmosphere/functions.glsl, https://github.com/ebruneton/precomputed_atmospheric_scattering
// Copyright (c) 2017 Eric Bruneton. All rights reserved. BSD 3-Clause licence:
//   Redistribution and use in source and binary forms, with or without modification, are permitted
//   provided that the following conditions are met: 1. Redistributions of source code must retain the
//   above copyright notice, this list of conditions and the following disclaimer. 2. Redistributions in
//   binary form must reproduce the above copyright notice, this list of conditions and the following
//   disclaimer in the documentation and/or other materials provided with the distribution. 3. Neither
//   the name of the copyright holders nor the names of its contributors may be used to endorse or
//   promote products derived from this software without specific prior written permission.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
//   IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
//   FOR ANY DAMAGES ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE.
// TSL structure informed by takram three-geospatial (MIT, (c) 2024 Shota Matsuda),
// @takram/three-atmosphere src/webgpu/common.ts and runtime.ts.
//
// Function and variable names follow Bruneton's, spelled out: r is `radius`, mu is `viewZenithCosine`,
// mu_s is `sunZenithCosine`, nu is `viewSunCosine`. Lengths are in shader units (kilometres, see
// `LENGTH_UNIT_METERS`) so that float32 keeps sub-metre resolution at planetary radii.

import type { Data3DTexture, Texture } from 'three'
import { abs, clamp, exp, float, floor, If, Loop, max, min, mod, select, smoothstep, sqrt, texture, texture3D, vec2, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { AtmosphereParameters } from './AtmosphereParameters.js'

/** Metres per shader length unit. */
export const LENGTH_UNIT_METERS = 1000

type FloatNode = Node<'float'>
type BoolNode = Node<'bool'>
type Vec2Node = Node<'vec2'>
type Vec3Node = Node<'vec3'>
type Vec4Node = Node<'vec4'>

/** The four parameters of the scattering lookup. */
export interface ScatteringCoordinates {
  radius: FloatNode
  viewZenithCosine: FloatNode
  sunZenithCosine: FloatNode
  viewSunCosine: FloatNode
  rayIntersectsGround: BoolNode
}

/** In-scattered radiance towards the camera, and the transmittance along the same ray. */
export interface RadianceAndTransmittance {
  radiance: Vec3Node
  transmittance: Vec3Node
}

/** Direct sun and diffuse sky irradiance on a surface. */
export interface SunAndSkyIrradiance {
  sun: Vec3Node
  sky: Vec3Node
}

const PI = Math.PI

function toVec3(vector: { x: number; y: number; z: number }, scale = 1): Vec3Node {
  return vec3(vector.x * scale, vector.y * scale, vector.z * scale)
}

/**
 * TSL building blocks of the Bruneton 2017 model, specialised for one set of parameters (they are compiled
 * in as constants). Used both to generate the lookup textures and to read them at runtime.
 */
export class AtmosphereModel {
  readonly parameters: AtmosphereParameters

  // Lengths in shader units, coefficients per shader unit.
  readonly bottomRadius: number
  readonly topRadius: number
  protected readonly rayleighScaleHeight: number
  protected readonly mieScaleHeight: number
  protected readonly ozoneCenterAltitude: number
  protected readonly ozoneHalfWidth: number
  readonly rayleighScattering: Vec3Node
  readonly mieScattering: Vec3Node
  protected readonly mieExtinction: Vec3Node
  protected readonly ozoneAbsorption: Vec3Node
  readonly solarIrradiance: Vec3Node
  readonly groundAlbedo: Vec3Node
  protected readonly minimumSunZenithCosine: number

  constructor(parameters: AtmosphereParameters) {
    this.parameters = parameters
    const perUnit = LENGTH_UNIT_METERS
    this.bottomRadius = parameters.bottomRadiusMeters / perUnit
    this.topRadius = parameters.topRadiusMeters / perUnit
    this.rayleighScaleHeight = parameters.rayleighScaleHeightMeters / perUnit
    this.mieScaleHeight = parameters.mieScaleHeightMeters / perUnit
    this.ozoneCenterAltitude = parameters.ozoneCenterAltitudeMeters / perUnit
    this.ozoneHalfWidth = parameters.ozoneHalfWidthMeters / perUnit
    this.rayleighScattering = toVec3(parameters.rayleighScatteringPerMeter, perUnit)
    this.mieScattering = toVec3(parameters.mieScatteringPerMeter, perUnit)
    this.mieExtinction = toVec3(parameters.mieExtinctionPerMeter, perUnit)
    this.ozoneAbsorption = toVec3(parameters.ozoneAbsorptionPerMeter, perUnit)
    this.solarIrradiance = toVec3(parameters.solarIrradiance)
    this.groundAlbedo = toVec3(parameters.groundAlbedo)
    this.minimumSunZenithCosine = Math.cos(parameters.maximumSunZenithAngleRadians)
  }

  /** Distance from the bottom to the top boundary along a horizontal ray at the ground. */
  protected get horizonDistance(): number {
    return Math.sqrt(this.topRadius ** 2 - this.bottomRadius ** 2)
  }

  // Clamping and geometry

  clampCosine(cosine: FloatNode): FloatNode {
    return clamp(cosine, -1, 1)
  }

  clampDistance(distance: FloatNode): FloatNode {
    return max(distance, 0)
  }

  clampRadius(radius: FloatNode): FloatNode {
    return clamp(radius, this.bottomRadius, this.topRadius)
  }

  safeSqrt(value: FloatNode): FloatNode {
    return sqrt(max(value, 0))
  }

  distanceToTopAtmosphereBoundary(radius: FloatNode, viewZenithCosine: FloatNode): FloatNode {
    const discriminant = radius.mul(radius).mul(viewZenithCosine.mul(viewZenithCosine).sub(1)).add(this.topRadius ** 2)
    return this.clampDistance(radius.negate().mul(viewZenithCosine).add(this.safeSqrt(discriminant)))
  }

  distanceToBottomAtmosphereBoundary(radius: FloatNode, viewZenithCosine: FloatNode): FloatNode {
    const discriminant = radius.mul(radius).mul(viewZenithCosine.mul(viewZenithCosine).sub(1)).add(this.bottomRadius ** 2)
    return this.clampDistance(radius.negate().mul(viewZenithCosine).sub(this.safeSqrt(discriminant)))
  }

  rayIntersectsGround(radius: FloatNode, viewZenithCosine: FloatNode): BoolNode {
    const discriminant = radius.mul(radius).mul(viewZenithCosine.mul(viewZenithCosine).sub(1)).add(this.bottomRadius ** 2)
    return viewZenithCosine.lessThan(0).and(discriminant.greaterThanEqual(0))
  }

  distanceToNearestAtmosphereBoundary(radius: FloatNode, viewZenithCosine: FloatNode, rayIntersectsGround: BoolNode): FloatNode {
    return select(
      rayIntersectsGround,
      this.distanceToBottomAtmosphereBoundary(radius, viewZenithCosine),
      this.distanceToTopAtmosphereBoundary(radius, viewZenithCosine),
    )
  }

  /** Radius at distance `distance` along a ray. */
  radiusAlongRay(radius: FloatNode, viewZenithCosine: FloatNode, distance: FloatNode): FloatNode {
    return this.clampRadius(sqrt(distance.mul(distance).add(radius.mul(viewZenithCosine).mul(distance).mul(2)).add(radius.mul(radius))))
  }

  // Density profiles: relative densities in [0, 1] at an altitude above the ground.

  rayleighDensity(altitude: FloatNode): FloatNode {
    return clamp(exp(altitude.div(-this.rayleighScaleHeight)), 0, 1)
  }

  mieDensity(altitude: FloatNode): FloatNode {
    return clamp(exp(altitude.div(-this.mieScaleHeight)), 0, 1)
  }

  ozoneDensity(altitude: FloatNode): FloatNode {
    return max(float(1).sub(abs(altitude.sub(this.ozoneCenterAltitude)).div(this.ozoneHalfWidth)), 0)
  }

  // Texture coordinate mapping, keeping samples at texel centres

  textureCoordinateFromUnitRange(value: FloatNode, size: number): FloatNode {
    return value.mul(1 - 1 / size).add(0.5 / size)
  }

  unitRangeFromTextureCoordinate(coordinate: FloatNode, size: number): FloatNode {
    return coordinate.sub(0.5 / size).div(1 - 1 / size)
  }

  // Transmittance

  /** Optical lengths (Rayleigh, Mie, ozone) from a point to the top of the atmosphere, by the trapezoidal rule. */
  computeOpticalLengthsToTopAtmosphereBoundary(radius: FloatNode, viewZenithCosine: FloatNode): Vec3Node {
    const sampleCount = 500
    const stepLength = this.distanceToTopAtmosphereBoundary(radius, viewZenithCosine).div(sampleCount).toConst()
    const opticalLengths = vec3(0).toVar()
    Loop({ start: 0, end: sampleCount, type: 'int', condition: '<=' }, ({ i }) => {
      const distance = float(i).mul(stepLength)
      const sampleRadius = sqrt(distance.mul(distance).add(radius.mul(viewZenithCosine).mul(distance).mul(2)).add(radius.mul(radius)))
      const altitude = sampleRadius.sub(this.bottomRadius).toConst()
      const weight = select(i.equal(0).or(i.equal(sampleCount)), float(0.5), float(1))
      const densities = vec3(this.rayleighDensity(altitude), this.mieDensity(altitude), this.ozoneDensity(altitude))
      opticalLengths.addAssign(densities.mul(weight).mul(stepLength))
    })
    return opticalLengths
  }

  computeTransmittanceToTopAtmosphereBoundary(radius: FloatNode, viewZenithCosine: FloatNode): Vec3Node {
    const opticalLengths = this.computeOpticalLengthsToTopAtmosphereBoundary(radius, viewZenithCosine).toConst()
    const opticalDepth = this.rayleighScattering
      .mul(opticalLengths.x)
      .add(this.mieExtinction.mul(opticalLengths.y))
      .add(this.ozoneAbsorption.mul(opticalLengths.z))
    return exp(opticalDepth.negate())
  }

  transmittanceTextureUvFromRadiusAndCosine(radius: FloatNode, viewZenithCosine: FloatNode): Vec2Node {
    const size = this.parameters.textureSizes.transmittance
    const horizon = this.horizonDistance
    const rho = this.safeSqrt(radius.mul(radius).sub(this.bottomRadius ** 2)).toConst()
    const distance = this.distanceToTopAtmosphereBoundary(radius, viewZenithCosine)
    const minimumDistance = float(this.topRadius).sub(radius)
    const maximumDistance = rho.add(horizon)
    const viewZenithUnit = distance.sub(minimumDistance).div(maximumDistance.sub(minimumDistance))
    const radiusUnit = rho.div(horizon)
    return vec2(this.textureCoordinateFromUnitRange(viewZenithUnit, size.x), this.textureCoordinateFromUnitRange(radiusUnit, size.y))
  }

  radiusAndCosineFromTransmittanceTextureUv(uv: Vec2Node): { radius: FloatNode; viewZenithCosine: FloatNode } {
    const size = this.parameters.textureSizes.transmittance
    const horizon = this.horizonDistance
    const viewZenithUnit = this.unitRangeFromTextureCoordinate(uv.x, size.x)
    const radiusUnit = this.unitRangeFromTextureCoordinate(uv.y, size.y)
    const rho = radiusUnit.mul(horizon).toConst()
    const radius = sqrt(rho.mul(rho).add(this.bottomRadius ** 2)).toConst()
    const minimumDistance = float(this.topRadius).sub(radius)
    const maximumDistance = rho.add(horizon)
    const distance = minimumDistance.add(viewZenithUnit.mul(maximumDistance.sub(minimumDistance))).toConst()
    const cosine = float(horizon ** 2).sub(rho.mul(rho)).sub(distance.mul(distance)).div(radius.mul(distance).mul(2))
    const viewZenithCosine = select(distance.equal(0), float(1), this.clampCosine(cosine))
    return { radius, viewZenithCosine }
  }

  getTransmittanceToTopAtmosphereBoundary(transmittanceTexture: Texture, radius: FloatNode, viewZenithCosine: FloatNode): Vec3Node {
    const uv = this.transmittanceTextureUvFromRadiusAndCosine(radius, viewZenithCosine)
    return texture(transmittanceTexture, uv).level(float(0)).rgb
  }

  /** Transmittance between a point and the point `distance` further along the ray. */
  getTransmittance(
    transmittanceTexture: Texture,
    radius: FloatNode,
    viewZenithCosine: FloatNode,
    distance: FloatNode,
    rayIntersectsGround: BoolNode,
  ): Vec3Node {
    const endRadius = this.radiusAlongRay(radius, viewZenithCosine, distance).toConst()
    const endViewZenithCosine = this.clampCosine(radius.mul(viewZenithCosine).add(distance).div(endRadius)).toConst()
    const transmittance = vec3(0).toVar()
    If(rayIntersectsGround, () => {
      transmittance.assign(
        this.getTransmittanceToTopAtmosphereBoundary(transmittanceTexture, endRadius, endViewZenithCosine.negate()).div(
          this.getTransmittanceToTopAtmosphereBoundary(transmittanceTexture, radius, viewZenithCosine.negate()),
        ),
      )
    }).Else(() => {
      transmittance.assign(
        this.getTransmittanceToTopAtmosphereBoundary(transmittanceTexture, radius, viewZenithCosine).div(
          this.getTransmittanceToTopAtmosphereBoundary(transmittanceTexture, endRadius, endViewZenithCosine),
        ),
      )
    })
    return min(transmittance, vec3(1))
  }

  /** Transmittance to the sun, faded by the fraction of the sun disk above the horizon. */
  getTransmittanceToSun(transmittanceTexture: Texture, radius: FloatNode, sunZenithCosine: FloatNode): Vec3Node {
    const sinHorizon = float(this.bottomRadius).div(radius).toConst()
    const cosHorizon = this.safeSqrt(float(1).sub(sinHorizon.mul(sinHorizon))).negate()
    const halfWidth = sinHorizon.mul(this.parameters.sunAngularRadiusRadians)
    const visibleFraction = smoothstep(halfWidth.negate(), halfWidth, sunZenithCosine.sub(cosHorizon))
    return this.getTransmittanceToTopAtmosphereBoundary(transmittanceTexture, radius, sunZenithCosine).mul(visibleFraction)
  }

  // Phase functions

  rayleighPhaseFunction(viewSunCosine: FloatNode): FloatNode {
    return viewSunCosine.mul(viewSunCosine).add(1).mul(3 / (16 * PI))
  }

  miePhaseFunction(viewSunCosine: FloatNode): FloatNode {
    const g = this.parameters.miePhaseAsymmetry
    const k = ((3 / (8 * PI)) * (1 - g * g)) / (2 + g * g)
    const denominator = float(1 + g * g).sub(viewSunCosine.mul(2 * g))
    return viewSunCosine.mul(viewSunCosine).add(1).mul(k).div(denominator.mul(sqrt(denominator)))
  }

  // Scattering texture mapping (4D packed in 3D)

  scatteringTextureUvwzFromCoordinates({ radius, viewZenithCosine, sunZenithCosine, viewSunCosine, rayIntersectsGround }: ScatteringCoordinates): Vec4Node {
    const sizes = this.parameters.textureSizes
    const horizon = this.horizonDistance
    const rho = this.safeSqrt(radius.mul(radius).sub(this.bottomRadius ** 2)).toConst()
    const radiusCoordinate = this.textureCoordinateFromUnitRange(rho.div(horizon), sizes.scatteringAltitude)

    const radiusTimesCosine = radius.mul(viewZenithCosine).toConst()
    const discriminant = radiusTimesCosine.mul(radiusTimesCosine).sub(radius.mul(radius)).add(this.bottomRadius ** 2).toConst()
    const halfViewSize = sizes.scatteringViewZenith / 2

    // Rays hitting the ground use the lower half of the texture, from the ground distance.
    const groundDistance = radiusTimesCosine.negate().sub(this.safeSqrt(discriminant))
    const groundMinimum = radius.sub(this.bottomRadius).toConst()
    const groundMaximum = rho
    const groundUnit = select(
      groundMaximum.equal(groundMinimum),
      float(0),
      groundDistance.sub(groundMinimum).div(groundMaximum.sub(groundMinimum)),
    )
    const groundCoordinate = float(0.5).sub(this.textureCoordinateFromUnitRange(groundUnit, halfViewSize).mul(0.5))

    // Other rays use the upper half, from the distance to the top boundary.
    const topDistance = radiusTimesCosine.negate().add(this.safeSqrt(discriminant.add(horizon ** 2)))
    const topMinimum = float(this.topRadius).sub(radius).toConst()
    const topMaximum = rho.add(horizon)
    const topUnit = topDistance.sub(topMinimum).div(topMaximum.sub(topMinimum))
    const topCoordinate = float(0.5).add(this.textureCoordinateFromUnitRange(topUnit, halfViewSize).mul(0.5))

    const viewCoordinate = select(rayIntersectsGround, groundCoordinate, topCoordinate)

    const sunCoordinate = this.sunZenithCoordinate(sunZenithCosine)
    const viewSunCoordinate = viewSunCosine.add(1).mul(0.5)
    return vec4(viewSunCoordinate, sunCoordinate, viewCoordinate, radiusCoordinate)
  }

  /** Non-linear sun zenith mapping that spends texels where the sky changes fastest. */
  protected sunZenithCoordinate(sunZenithCosine: FloatNode): FloatNode {
    const { bottomRadius, topRadius } = this
    const horizon = this.horizonDistance
    const minimumDistance = topRadius - bottomRadius
    const maximumDistance = horizon
    const distance = this.distanceToTopAtmosphereBoundary(float(bottomRadius), sunZenithCosine)
    const a = distance.sub(minimumDistance).div(maximumDistance - minimumDistance).toConst()
    const A = (this.distanceToTopAtmosphere(bottomRadius, this.minimumSunZenithCosine) - minimumDistance) / (maximumDistance - minimumDistance)
    const unit = max(float(1).sub(a.div(A)), 0).div(a.add(1))
    return this.textureCoordinateFromUnitRange(unit, this.parameters.textureSizes.scatteringSunZenith)
  }

  /** CPU version of `distanceToTopAtmosphereBoundary`, for constants. */
  protected distanceToTopAtmosphere(radius: number, viewZenithCosine: number): number {
    const discriminant = radius * radius * (viewZenithCosine * viewZenithCosine - 1) + this.topRadius ** 2
    return Math.max(-radius * viewZenithCosine + Math.sqrt(Math.max(discriminant, 0)), 0)
  }

  coordinatesFromScatteringTextureUvwz(uvwz: Vec4Node): ScatteringCoordinates {
    const sizes = this.parameters.textureSizes
    const { bottomRadius, topRadius } = this
    const horizon = this.horizonDistance
    const halfViewSize = sizes.scatteringViewZenith / 2

    const rho = this.unitRangeFromTextureCoordinate(uvwz.w, sizes.scatteringAltitude).mul(horizon).toConst()
    const radius = sqrt(rho.mul(rho).add(bottomRadius ** 2)).toConst()

    const rayIntersectsGround = uvwz.z.lessThan(0.5)

    const groundMinimum = radius.sub(bottomRadius).toConst()
    const groundDistance = groundMinimum
      .add(rho.sub(groundMinimum).mul(this.unitRangeFromTextureCoordinate(float(1).sub(uvwz.z.mul(2)), halfViewSize)))
      .toConst()
    const groundCosine = select(
      groundDistance.equal(0),
      float(-1),
      this.clampCosine(rho.mul(rho).add(groundDistance.mul(groundDistance)).div(radius.mul(groundDistance).mul(2)).negate()),
    )

    const topMinimum = float(topRadius).sub(radius).toConst()
    const topMaximum = rho.add(horizon)
    const topDistance = topMinimum
      .add(topMaximum.sub(topMinimum).mul(this.unitRangeFromTextureCoordinate(uvwz.z.mul(2).sub(1), halfViewSize)))
      .toConst()
    const topCosine = select(
      topDistance.equal(0),
      float(1),
      this.clampCosine(float(horizon ** 2).sub(rho.mul(rho)).sub(topDistance.mul(topDistance)).div(radius.mul(topDistance).mul(2))),
    )

    const viewZenithCosine = select(rayIntersectsGround, groundCosine, topCosine).toConst()

    const sunUnit = this.unitRangeFromTextureCoordinate(uvwz.y, sizes.scatteringSunZenith).toConst()
    const minimumDistance = topRadius - bottomRadius
    const maximumDistance = horizon
    const A = (this.distanceToTopAtmosphere(bottomRadius, this.minimumSunZenithCosine) - minimumDistance) / (maximumDistance - minimumDistance)
    const a = float(A).sub(sunUnit.mul(A)).div(sunUnit.mul(A).add(1))
    const sunDistance = min(a, A).mul(maximumDistance - minimumDistance).add(minimumDistance).toConst()
    const sunZenithCosine = select(
      sunDistance.equal(0),
      float(1),
      this.clampCosine(float(horizon ** 2).sub(sunDistance.mul(sunDistance)).div(sunDistance.mul(2 * bottomRadius))),
    ).toConst()

    const viewSunCosine = this.clampCosine(uvwz.x.mul(2).sub(1))
    return { radius, viewZenithCosine, sunZenithCosine, viewSunCosine, rayIntersectsGround }
  }

  /** Coordinates of the texel being rendered, from its fragment coordinate (x, y in pixels, z the slice + 0.5). */
  coordinatesFromScatteringFragmentCoordinate(fragmentCoordinate: Vec3Node): ScatteringCoordinates {
    const sizes = this.parameters.textureSizes
    const sunSize = sizes.scatteringSunZenith
    const viewSunIndex = floor(fragmentCoordinate.x.div(sunSize))
    const sunIndex = mod(fragmentCoordinate.x, sunSize)
    const uvwz = vec4(viewSunIndex, sunIndex, fragmentCoordinate.y, fragmentCoordinate.z).div(
      vec4(sizes.scatteringViewSunAngle - 1, sunSize, sizes.scatteringViewZenith, sizes.scatteringAltitude),
    )
    const coordinates = this.coordinatesFromScatteringTextureUvwz(uvwz)
    // Keep the view-sun angle consistent with the two zenith angles.
    const { viewZenithCosine: mu, sunZenithCosine: muS } = coordinates
    const spread = sqrt(float(1).sub(mu.mul(mu)).mul(float(1).sub(muS.mul(muS)))).toConst()
    const product = mu.mul(muS).toConst()
    return { ...coordinates, viewSunCosine: clamp(coordinates.viewSunCosine, product.sub(spread), product.add(spread)).toConst() }
  }

  /** Reads a 4D scattering texture, interpolating by hand along the packed view-sun axis. */
  getScattering(scatteringTexture: Data3DTexture | Texture, coordinates: ScatteringCoordinates): Vec4Node {
    const uvwz = this.scatteringTextureUvwzFromCoordinates(coordinates).toConst()
    const viewSunSize = this.parameters.textureSizes.scatteringViewSunAngle
    const x = uvwz.x.mul(viewSunSize - 1).toConst()
    const index = floor(x).toConst()
    const fraction = x.sub(index).toConst()
    const uvw0 = vec3(index.add(uvwz.y).div(viewSunSize), uvwz.z, uvwz.w)
    const uvw1 = vec3(index.add(1).add(uvwz.y).div(viewSunSize), uvwz.z, uvwz.w)
    const sample0 = texture3D(scatteringTexture, uvw0).level(float(0))
    const sample1 = texture3D(scatteringTexture, uvw1).level(float(0))
    return sample0.mul(float(1).sub(fraction)).add(sample1.mul(fraction))
  }

  // Irradiance texture mapping

  irradianceTextureUvFromRadiusAndSunCosine(radius: FloatNode, sunZenithCosine: FloatNode): Vec2Node {
    const size = this.parameters.textureSizes.irradiance
    const radiusUnit = radius.sub(this.bottomRadius).div(this.topRadius - this.bottomRadius)
    const sunUnit = sunZenithCosine.mul(0.5).add(0.5)
    return vec2(this.textureCoordinateFromUnitRange(sunUnit, size.x), this.textureCoordinateFromUnitRange(radiusUnit, size.y))
  }

  radiusAndSunCosineFromIrradianceTextureUv(uv: Vec2Node): { radius: FloatNode; sunZenithCosine: FloatNode } {
    const size = this.parameters.textureSizes.irradiance
    const sunUnit = this.unitRangeFromTextureCoordinate(uv.x, size.x)
    const radiusUnit = this.unitRangeFromTextureCoordinate(uv.y, size.y)
    return {
      radius: radiusUnit.mul(this.topRadius - this.bottomRadius).add(this.bottomRadius).toConst(),
      sunZenithCosine: this.clampCosine(sunUnit.mul(2).sub(1)).toConst(),
    }
  }

  getIrradiance(irradianceTexture: Texture, radius: FloatNode, sunZenithCosine: FloatNode): Vec3Node {
    return texture(irradianceTexture, this.irradianceTextureUvFromRadiusAndSunCosine(radius, sunZenithCosine)).level(float(0)).rgb
  }

  // Runtime

  /** Single Mie scattering recovered from the red channel stored in the alpha of the combined texture. */
  protected extrapolatedSingleMieScattering(scattering: Vec4Node): Vec3Node {
    const p = this.parameters
    const ratio = vec3(
      p.mieScatteringPerMeter.x / p.rayleighScatteringPerMeter.x,
      p.mieScatteringPerMeter.y / p.rayleighScatteringPerMeter.y,
      p.mieScatteringPerMeter.z / p.rayleighScatteringPerMeter.z,
    ).mul(p.rayleighScatteringPerMeter.x / p.mieScatteringPerMeter.x)
    const mie = scattering.rgb.mul(scattering.a).div(max(scattering.r, 1e-9)).mul(ratio)
    return select(scattering.r.lessThanEqual(0), vec3(0), mie)
  }

  protected getCombinedScattering(scatteringTexture: Texture, coordinates: ScatteringCoordinates): { rayleigh: Vec3Node; mie: Vec3Node } {
    const combined = this.getScattering(scatteringTexture, coordinates).toConst()
    return { rayleigh: combined.rgb, mie: this.extrapolatedSingleMieScattering(combined) }
  }

  protected applyPhaseFunctions(rayleigh: Vec3Node, mie: Vec3Node, viewSunCosine: FloatNode): Vec3Node {
    return rayleigh.mul(this.rayleighPhaseFunction(viewSunCosine)).add(mie.mul(this.miePhaseFunction(viewSunCosine)))
  }

  /** Keeps a point at or above the ground, so lookups stay defined for terrain below the reference sphere. */
  protected clampToGround(position: Vec3Node): Vec3Node {
    const radius = position.length()
    return position.mul(max(radius, this.bottomRadius + 1e-4).div(radius))
  }

  /**
   * Radiance of the sky along a view ray to infinity, from `camera` (relative to the planet centre, in
   * shader units), and the transmittance along it (zero for rays that hit the ground).
   */
  getSkyRadiance(textures: AtmosphereTextureSet, cameraPosition: Vec3Node, viewDirection: Vec3Node, sunDirection: Vec3Node): RadianceAndTransmittance {
    const camera = this.clampToGround(cameraPosition).toVar()
    const radius = camera.length().toVar()
    const radiusTimesCosine = camera.dot(viewDirection).toVar()
    const discriminant = radiusTimesCosine.mul(radiusTimesCosine).sub(radius.mul(radius)).add(this.topRadius ** 2).toConst()
    const distanceToTop = radiusTimesCosine.negate().sub(this.safeSqrt(discriminant)).toConst()

    // From space, start at the top of the atmosphere.
    If(discriminant.greaterThanEqual(0).and(distanceToTop.greaterThan(0)), () => {
      camera.addAssign(viewDirection.mul(distanceToTop))
      radius.assign(this.topRadius)
      radiusTimesCosine.addAssign(distanceToTop)
    })
    const missesAtmosphere = radius.greaterThan(this.topRadius + 1e-3)

    const coordinates = this.viewCoordinates(camera, radius, radiusTimesCosine, viewDirection, sunDirection)
    const transmittance = select(
      coordinates.rayIntersectsGround,
      vec3(0),
      this.getTransmittanceToTopAtmosphereBoundary(textures.transmittance, radius, coordinates.viewZenithCosine),
    )
    const { rayleigh, mie } = this.getCombinedScattering(textures.scattering, coordinates)
    const radiance = this.applyPhaseFunctions(rayleigh, mie, coordinates.viewSunCosine)
    return {
      radiance: select(missesAtmosphere, vec3(0), radiance),
      transmittance: select(missesAtmosphere, vec3(1), transmittance),
    }
  }

  protected viewCoordinates(
    camera: Vec3Node,
    radius: FloatNode,
    radiusTimesCosine: FloatNode,
    viewDirection: Vec3Node,
    sunDirection: Vec3Node,
  ): ScatteringCoordinates {
    const viewZenithCosine = radiusTimesCosine.div(radius).toConst()
    return {
      radius,
      viewZenithCosine,
      sunZenithCosine: camera.dot(sunDirection).div(radius).toConst(),
      viewSunCosine: viewDirection.dot(sunDirection).toConst(),
      rayIntersectsGround: this.rayIntersectsGround(radius, viewZenithCosine),
    }
  }

  /** Radiance scattered towards the camera between it and a point, and the transmittance between them. */
  getSkyRadianceToPoint(textures: AtmosphereTextureSet, cameraPosition: Vec3Node, pointPosition: Vec3Node, sunDirection: Vec3Node): RadianceAndTransmittance {
    const camera = this.clampToGround(cameraPosition).toVar()
    const point = this.clampToGround(pointPosition).toConst()
    const viewDirection = point.sub(camera).normalize().toConst()
    const radius = camera.length().toVar()
    const radiusTimesCosine = camera.dot(viewDirection).toVar()
    const discriminant = radiusTimesCosine.mul(radiusTimesCosine).sub(radius.mul(radius)).add(this.topRadius ** 2).toConst()
    const distanceToTop = radiusTimesCosine.negate().sub(this.safeSqrt(discriminant)).toConst()
    If(discriminant.greaterThanEqual(0).and(distanceToTop.greaterThan(0)), () => {
      camera.addAssign(viewDirection.mul(distanceToTop))
      radius.assign(this.topRadius)
      radiusTimesCosine.addAssign(distanceToTop)
    })

    const coordinates = this.viewCoordinates(camera, radius, radiusTimesCosine, viewDirection, sunDirection)
    const { viewZenithCosine, sunZenithCosine, viewSunCosine, rayIntersectsGround } = coordinates
    // Behind the camera's entry point (a point in space beyond the atmosphere): nothing in between.
    const distance = max(point.sub(camera).dot(viewDirection), 0).toConst()

    const transmittance = this.getTransmittance(textures.transmittance, radius, viewZenithCosine, distance, rayIntersectsGround).toConst()
    const atCamera = this.getCombinedScattering(textures.scattering, coordinates)

    const pointRadius = this.radiusAlongRay(radius, viewZenithCosine, distance).toConst()
    const atPoint = this.getCombinedScattering(textures.scattering, {
      radius: pointRadius,
      viewZenithCosine: this.clampCosine(radius.mul(viewZenithCosine).add(distance).div(pointRadius)),
      sunZenithCosine: this.clampCosine(radius.mul(sunZenithCosine).add(distance.mul(viewSunCosine)).div(pointRadius)),
      viewSunCosine,
      rayIntersectsGround,
    })

    const rayleigh = max(atCamera.rayleigh.sub(transmittance.mul(atPoint.rayleigh)), vec3(0))
    // Bruneton's fix for artefacts with the sun below the horizon.
    const mie = max(atCamera.mie.sub(transmittance.mul(atPoint.mie)), vec3(0)).mul(smoothstep(0, 0.01, sunZenithCosine))
    return { radiance: this.applyPhaseFunctions(rayleigh, mie, viewSunCosine), transmittance }
  }

  /** Sun irradiance (attenuated, on a surface facing the sun times the cosine) and sky irradiance on a surface. */
  getSunAndSkyIrradiance(textures: AtmosphereTextureSet, pointPosition: Vec3Node, normal: Vec3Node, sunDirection: Vec3Node): SunAndSkyIrradiance {
    const point = this.clampToGround(pointPosition).toConst()
    const radius = point.length().toConst()
    const sunZenithCosine = point.dot(sunDirection).div(radius).toConst()
    const skyFactor = normal.dot(point).div(radius).add(1).mul(0.5)
    return {
      sun: this.solarIrradiance.mul(this.getTransmittanceToSun(textures.transmittance, radius, sunZenithCosine)),
      sky: this.getIrradiance(textures.irradiance, radius, sunZenithCosine).mul(skyFactor),
    }
  }

  /** Radiance of the sun disk at the top of the atmosphere. */
  get solarRadiance(): Vec3Node {
    const solidAngle = PI * this.parameters.sunAngularRadiusRadians ** 2
    return this.solarIrradiance.div(solidAngle)
  }
}

/** The lookup textures read at runtime. */
export interface AtmosphereTextureSet {
  transmittance: Texture
  /** Rayleigh plus multiple scattering in RGB, single Mie red channel in alpha. */
  scattering: Texture
  /** Indirect (sky) irradiance on the ground. */
  irradiance: Texture
}
