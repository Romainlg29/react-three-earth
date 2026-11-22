import { Vector3 } from 'three'

import type { AtmosphereParameters } from './AtmosphereParameters.js'
import { getStandardAir } from './standardAtmosphere.js'

// The optics of the air, shared with flight effects. @aeronautic/core describes haze by the day's
// visibility (Koschmieder), with Ångström's spectral law, a single scattering albedo and a Henyey-Greenstein
// asymmetry; these are the same constants, so a scene built with `AtmosphereParameters.fromVisibility` and
// an effect built from the same visibility see one haze.

/** Koschmieder's constant: -ln(0.02), the eye's contrast threshold. Visibility = constant / extinction. */
export const KOSCHMIEDER_CONSTANT = 3.912
/** Wavelength at which visibility is defined, the eye's peak sensitivity. */
export const VISIBILITY_WAVELENGTH_NANOMETERS = 550
/** Ångström exponent of continental haze: aerosol extinction goes as wavelength^-exponent. */
export const ANGSTROM_EXPONENT = 1.3
/** Share of the light continental haze scatters rather than absorbs, at 550 nm. */
export const AEROSOL_SINGLE_SCATTERING_ALBEDO = 0.9
/** Asymmetry of haze's phase function: light is scattered mostly forwards. */
export const AEROSOL_PHASE_ASYMMETRY = 0.7

/** Relative density of air molecules at an altitude (CPU mirror of `AtmosphereModel.rayleighDensity`). */
export function getRayleighDensity(parameters: AtmosphereParameters, altitudeMeters: number): number {
  if (parameters.rayleighDensityProfile === 'exponential') {
    return Math.min(Math.max(Math.exp(-altitudeMeters / parameters.rayleighScaleHeightMeters), 0), 1)
  }
  return getStandardAir(altitudeMeters, parameters.temperatureOffsetKelvin).densityRatio
}

/** Relative aerosol density at an altitude (CPU mirror of `AtmosphereModel.mieDensity`). */
export function getMieDensity(parameters: AtmosphereParameters, altitudeMeters: number): number {
  return Math.min(Math.max(Math.exp(-altitudeMeters / parameters.mieScaleHeightMeters), 0), 1)
}

/** Relative ozone density at an altitude (CPU mirror of `AtmosphereModel.ozoneDensity`). */
export function getOzoneDensity(parameters: AtmosphereParameters, altitudeMeters: number): number {
  return Math.max(1 - Math.abs(altitudeMeters - parameters.ozoneCenterAltitudeMeters) / parameters.ozoneHalfWidthMeters, 0)
}

/**
 * Extinction of the air at one altitude, per metre, at the three wavelengths (red, green, blue).
 * Shaped like @aeronautic/core's `Extinction` (`rayleigh`, `aerosol`), so its `transmission` and the lights
 * and flares that take one can be handed the sky's own air.
 */
export interface AirExtinction {
  /** By air molecules, which scatter and do not absorb. */
  rayleigh: [number, number, number]
  /** By aerosols (haze), scattered and absorbed. */
  aerosol: [number, number, number]
  /** By ozone, which absorbs only. Not part of @aeronautic's shape; negligible near the ground. */
  ozone: [number, number, number]
}

/** The extinction of the air at an altitude, from the atmosphere's own profiles. */
export function getAirExtinction(parameters: AtmosphereParameters, altitudeMeters: number, target?: AirExtinction): AirExtinction {
  const result = target ?? { rayleigh: [0, 0, 0], aerosol: [0, 0, 0], ozone: [0, 0, 0] }
  const rayleighDensity = getRayleighDensity(parameters, altitudeMeters)
  const mieDensity = getMieDensity(parameters, altitudeMeters)
  const ozoneDensity = getOzoneDensity(parameters, altitudeMeters)
  const { rayleighScatteringPerMeter: rayleigh, mieExtinctionPerMeter: mie, ozoneAbsorptionPerMeter: ozone } = parameters
  result.rayleigh[0] = rayleigh.x * rayleighDensity
  result.rayleigh[1] = rayleigh.y * rayleighDensity
  result.rayleigh[2] = rayleigh.z * rayleighDensity
  result.aerosol[0] = mie.x * mieDensity
  result.aerosol[1] = mie.y * mieDensity
  result.aerosol[2] = mie.z * mieDensity
  result.ozone[0] = ozone.x * ozoneDensity
  result.ozone[1] = ozone.y * ozoneDensity
  result.ozone[2] = ozone.z * ozoneDensity
  return result
}

/**
 * Horizontal visibility (meteorological optical range) at an altitude: Koschmieder's constant over the
 * extinction in the green channel, whose wavelength is the visibility's 550 nm by default.
 */
export function getVisibilityMeters(parameters: AtmosphereParameters, altitudeMeters = 0): number {
  const air = getAirExtinction(parameters, altitudeMeters)
  return KOSCHMIEDER_CONSTANT / Math.max(air.rayleigh[1] + air.aerosol[1] + air.ozone[1], 1e-12)
}

/** What `getHazeForVisibility` takes. */
export interface HazeOptions {
  /** Ångström exponent. Default: `ANGSTROM_EXPONENT` (continental haze). */
  angstromExponent?: number
  /** Single scattering albedo. Default: `AEROSOL_SINGLE_SCATTERING_ALBEDO`. */
  singleScatteringAlbedo?: number
}

/** Mie coefficients at the ground, per metre at the three wavelengths. */
export interface Haze {
  mieExtinctionPerMeter: Vector3
  mieScatteringPerMeter: Vector3
}

/**
 * The aerosol coefficients at the ground that give a visibility there, as @aeronautic/core's `extinction`
 * works them out: the total extinction at 550 nm is Koschmieder's constant over the visibility, the air
 * molecules take their share and the haze the rest, spread over the wavelengths by Ångström's law (relative to 550 nm). A
 * visibility longer than clean air allows (about 290 km on a standard day) leaves no haze.
 *
 * @param visibilityMeters Meteorological optical range at the ground.
 * @param parameters For the wavelengths and the air molecules' scattering at the ground.
 */
export function getHazeForVisibility(visibilityMeters: number, parameters: AtmosphereParameters, options: HazeOptions = {}): Haze {
  const { angstromExponent = ANGSTROM_EXPONENT, singleScatteringAlbedo = AEROSOL_SINGLE_SCATTERING_ALBEDO } = options
  const wavelengths = parameters.wavelengthsNanometers
  // The green channel stands for the visibility's wavelength (550 nm by default), as in @aeronautic/core.
  const molecules = parameters.rayleighScatteringPerMeter.y * getRayleighDensity(parameters, 0)
  const total = KOSCHMIEDER_CONSTANT / Math.max(visibilityMeters, 1)
  const haze = Math.max(total - molecules, 0)
  const atWavelength = (nanometers: number): number => haze * (nanometers / VISIBILITY_WAVELENGTH_NANOMETERS) ** -angstromExponent
  const mieExtinctionPerMeter = new Vector3(atWavelength(wavelengths.x), atWavelength(wavelengths.y), atWavelength(wavelengths.z))
  return { mieExtinctionPerMeter, mieScatteringPerMeter: mieExtinctionPerMeter.clone().multiplyScalar(singleScatteringAlbedo) }
}
