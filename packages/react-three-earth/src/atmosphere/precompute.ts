// Ported to TSL from Eric Bruneton's "Precomputed Atmospheric Scattering: a New Implementation" (2017),
// atmosphere/functions.glsl (Compute* functions), https://github.com/ebruneton/precomputed_atmospheric_scattering
// Copyright (c) 2017 Eric Bruneton, BSD 3-Clause licence; the full notice is in AtmosphereModel.ts.
//
// Each function builds the body of one lookup-texture pass. They run inside a TSL `Fn`, once per texel.

import type { Texture } from 'three'
import { bool, cos, float, If, Loop, max, select, sin, sqrt, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { AtmosphereModel, ScatteringCoordinates } from './AtmosphereModel.js'

type FloatNode = Node<'float'>
type Vec2Node = Node<'vec2'>
type Vec3Node = Node<'vec3'>

/** Scattering of the previous order, read when computing the next one. */
export interface PreviousOrderTextures {
  /** Single Rayleigh scattering, without phase function (order 1). */
  singleRayleigh: Texture
  /** Single Mie scattering, without phase function (order 1). */
  singleMie: Texture
  /** Multiple scattering of the previous order, phase functions applied (orders 2 and up). */
  multiple: Texture
}

/** Trapezoidal rule weight of sample `index` out of `sampleCount + 1`. */
function trapezoidWeight(index: Node<'int'>, sampleCount: number): FloatNode {
  return select(index.equal(0).or(index.equal(sampleCount)), float(0.5), float(1))
}

export function computeTransmittanceTexel(model: AtmosphereModel, fragmentCoordinate: Vec2Node): Vec3Node {
  const size = model.parameters.textureSizesTexels.transmittance
  const { radius, viewZenithCosine } = model.radiusAndCosineFromTransmittanceTextureUv(fragmentCoordinate.div(vec2(size.x, size.y)))
  return model.computeTransmittanceToTopAtmosphereBoundary(radius, viewZenithCosine)
}

/** Sun irradiance on the ground, averaged over the sun disk when it straddles the horizon. */
export function computeDirectIrradianceTexel(model: AtmosphereModel, transmittance: Texture, fragmentCoordinate: Vec2Node): Vec3Node {
  const size = model.parameters.textureSizesTexels.irradiance
  const { radius, sunZenithCosine } = model.radiusAndSunCosineFromIrradianceTextureUv(fragmentCoordinate.div(vec2(size.x, size.y)))
  const alpha = model.parameters.sunAngularRadiusRadians
  const averageCosine = select(
    sunZenithCosine.lessThan(-alpha),
    float(0),
    select(sunZenithCosine.greaterThan(alpha), sunZenithCosine, sunZenithCosine.add(alpha).pow2().div(4 * alpha)),
  )
  return model.solarIrradianceWattsPerSquareMeterNanometer.mul(model.getTransmittanceToTopAtmosphereBoundary(transmittance, radius, sunZenithCosine)).mul(averageCosine)
}

/** Single Rayleigh and Mie scattering along a view ray, without phase functions. */
export function computeSingleScattering(
  model: AtmosphereModel,
  transmittance: Texture,
  { radius, viewZenithCosine, sunZenithCosine, viewSunCosine, rayIntersectsGround }: ScatteringCoordinates,
): { rayleigh: Vec3Node; mie: Vec3Node } {
  const sampleCount = 50
  const stepLength = model.distanceToNearestAtmosphereBoundary(radius, viewZenithCosine, rayIntersectsGround).div(sampleCount).toConst()
  const rayleighSum = vec3(0).toVar()
  const mieSum = vec3(0).toVar()
  Loop({ start: 0, end: sampleCount, type: 'int', condition: '<=' }, ({ i }) => {
    const distance = float(i).mul(stepLength).toConst()
    const sampleRadius = model.radiusAlongRay(radius, viewZenithCosine, distance).toConst()
    const sampleSunCosine = model.clampCosine(radius.mul(sunZenithCosine).add(distance.mul(viewSunCosine)).div(sampleRadius))
    const pathTransmittance = model
      .getTransmittance(transmittance, radius, viewZenithCosine, distance, rayIntersectsGround)
      .mul(model.getTransmittanceToSun(transmittance, sampleRadius, sampleSunCosine))
      .mul(trapezoidWeight(i, sampleCount))
      .toConst()
    const altitude = sampleRadius.sub(model.bottomRadiusKilometers).toConst()
    rayleighSum.addAssign(pathTransmittance.mul(model.rayleighDensity(altitude)))
    mieSum.addAssign(pathTransmittance.mul(model.mieDensity(altitude)))
  })
  return {
    rayleigh: rayleighSum.mul(stepLength).mul(model.solarIrradianceWattsPerSquareMeterNanometer).mul(model.rayleighScatteringPerKilometer),
    mie: mieSum.mul(stepLength).mul(model.solarIrradianceWattsPerSquareMeterNanometer).mul(model.mieScatteringPerKilometer),
  }
}

/** Scattered radiance of a given order arriving from a direction, phase functions applied. */
export function getScatteringOfOrder(
  model: AtmosphereModel,
  textures: PreviousOrderTextures,
  coordinates: ScatteringCoordinates,
  order: number,
): Vec3Node {
  if (order === 1) {
    const rayleigh = model.getScattering(textures.singleRayleigh, coordinates).rgb
    const mie = model.getScattering(textures.singleMie, coordinates).rgb
    return rayleigh.mul(model.rayleighPhaseFunction(coordinates.viewSunCosine)).add(mie.mul(model.miePhaseFunction(coordinates.viewSunCosine)))
  }
  return model.getScattering(textures.multiple, coordinates).rgb
}

/**
 * Radiance scattered at a point towards a direction, from light of the previous order arriving from all
 * directions, including light reflected by the ground. Integrated over `angularSamples` zenith by
 * `2 * angularSamples` azimuth directions.
 */
export function computeScatteringDensity(
  model: AtmosphereModel,
  transmittance: Texture,
  previous: PreviousOrderTextures,
  groundIrradiance: Texture,
  { radius, viewZenithCosine, sunZenithCosine, viewSunCosine }: ScatteringCoordinates,
  order: number,
  angularSamples: number,
): Vec3Node {
  const viewDirection = vec3(sqrt(float(1).sub(viewZenithCosine.pow2())), 0, viewZenithCosine).toConst()
  const sunX = select(
    viewDirection.x.equal(0),
    float(0),
    viewSunCosine.sub(viewZenithCosine.mul(sunZenithCosine)).div(viewDirection.x),
  ).toConst()
  const sunY = sqrt(max(float(1).sub(sunX.pow2()).sub(sunZenithCosine.pow2()), 0))
  const sunDirection = vec3(sunX, sunY, sunZenithCosine).toConst()

  const angleStep = Math.PI / angularSamples
  const altitude = radius.sub(model.bottomRadiusKilometers).toConst()
  const rayleighScatteringPerKilometer = model.rayleighScatteringPerKilometer.mul(model.rayleighDensity(altitude)).toConst()
  const mieScatteringPerKilometer = model.mieScatteringPerKilometer.mul(model.mieDensity(altitude)).toConst()

  const density = vec3(0).toVar()
  Loop({ start: 0, end: angularSamples, type: 'int' }, ({ i: zenithIndex }) => {
    const theta = float(zenithIndex).add(0.5).mul(angleStep).toConst()
    const cosTheta = cos(theta).toConst()
    const sinTheta = sin(theta).toConst()
    const hitsGround = model.rayIntersectsGround(radius, cosTheta).toConst()

    // Light reflected by the ground below, if this direction sees it.
    const distanceToGround = select(hitsGround, model.distanceToBottomAtmosphereBoundary(radius, cosTheta), float(0)).toConst()
    const groundReflectance = vec3(0).toVar()
    If(hitsGround, () => {
      groundReflectance.assign(
        model.getTransmittance(transmittance, radius, cosTheta, distanceToGround, hitsGround).mul(model.groundAlbedo).mul(1 / Math.PI),
      )
    })

    Loop({ start: 0, end: 2 * angularSamples, type: 'int' }, ({ i: azimuthIndex }) => {
      const phi = float(azimuthIndex).add(0.5).mul(angleStep).toConst()
      const incidentDirection = vec3(cos(phi).mul(sinTheta), sin(phi).mul(sinTheta), cosTheta).toConst()
      const solidAngle = sinTheta.mul(angleStep * angleStep)

      const incidentRadiance = getScatteringOfOrder(
        model,
        previous,
        {
          radius,
          viewZenithCosine: cosTheta,
          sunZenithCosine,
          viewSunCosine: sunDirection.dot(incidentDirection),
          rayIntersectsGround: hitsGround,
        },
        order - 1,
      ).toVar()

      If(hitsGround, () => {
        const groundNormal = vec3(0, 0, radius).add(incidentDirection.mul(distanceToGround)).normalize()
        const irradiance = model.getIrradiance(groundIrradiance, float(model.bottomRadiusKilometers), groundNormal.dot(sunDirection))
        incidentRadiance.addAssign(groundReflectance.mul(irradiance))
      })

      const scatteringCosine = viewDirection.dot(incidentDirection).toConst()
      const phaseWeighted = rayleighScatteringPerKilometer
        .mul(model.rayleighPhaseFunction(scatteringCosine))
        .add(mieScatteringPerKilometer.mul(model.miePhaseFunction(scatteringCosine)))
      density.addAssign(incidentRadiance.mul(phaseWeighted).mul(solidAngle))
    })
  })
  return density
}

/** Multiple scattering of one order along a view ray: the scattering density integrated with transmittance. */
export function computeMultipleScattering(
  model: AtmosphereModel,
  transmittance: Texture,
  scatteringDensity: Texture,
  { radius, viewZenithCosine, sunZenithCosine, viewSunCosine, rayIntersectsGround }: ScatteringCoordinates,
): Vec3Node {
  const sampleCount = 50
  const stepLength = model.distanceToNearestAtmosphereBoundary(radius, viewZenithCosine, rayIntersectsGround).div(sampleCount).toConst()
  const sum = vec3(0).toVar()
  Loop({ start: 0, end: sampleCount, type: 'int', condition: '<=' }, ({ i }) => {
    const distance = float(i).mul(stepLength).toConst()
    const sampleRadius = model.radiusAlongRay(radius, viewZenithCosine, distance).toConst()
    const sampleDensity = model.getScattering(scatteringDensity, {
      radius: sampleRadius,
      viewZenithCosine: model.clampCosine(radius.mul(viewZenithCosine).add(distance).div(sampleRadius)),
      sunZenithCosine: model.clampCosine(radius.mul(sunZenithCosine).add(distance.mul(viewSunCosine)).div(sampleRadius)),
      viewSunCosine,
      rayIntersectsGround,
    }).rgb
    const pathTransmittance = model.getTransmittance(transmittance, radius, viewZenithCosine, distance, rayIntersectsGround)
    sum.addAssign(sampleDensity.mul(pathTransmittance).mul(trapezoidWeight(i, sampleCount)))
  })
  return sum.mul(stepLength)
}

/** Sky irradiance on a horizontal surface from scattering of one order, integrated over the upper hemisphere. */
export function computeIndirectIrradiance(
  model: AtmosphereModel,
  previous: PreviousOrderTextures,
  radius: FloatNode,
  sunZenithCosine: FloatNode,
  order: number,
): Vec3Node {
  const sampleCount = 32
  const angleStep = Math.PI / sampleCount
  const sunDirection = vec3(sqrt(float(1).sub(sunZenithCosine.pow2())), 0, sunZenithCosine).toConst()
  const result = vec3(0).toVar()
  Loop({ start: 0, end: sampleCount / 2, type: 'int' }, ({ i: zenithIndex }) => {
    const theta = float(zenithIndex).add(0.5).mul(angleStep).toConst()
    const cosTheta = cos(theta).toConst()
    const sinTheta = sin(theta).toConst()
    Loop({ start: 0, end: 2 * sampleCount, type: 'int' }, ({ i: azimuthIndex }) => {
      const phi = float(azimuthIndex).add(0.5).mul(angleStep).toConst()
      const direction = vec3(cos(phi).mul(sinTheta), sin(phi).mul(sinTheta), cosTheta).toConst()
      const solidAngle = sinTheta.mul(angleStep * angleStep)
      const radiance = getScatteringOfOrder(
        model,
        previous,
        { radius, viewZenithCosine: cosTheta, sunZenithCosine, viewSunCosine: direction.dot(sunDirection), rayIntersectsGround: bool(false) },
        order,
      )
      result.addAssign(radiance.mul(cosTheta).mul(solidAngle))
    })
  })
  return result
}
