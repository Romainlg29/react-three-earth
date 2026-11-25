// Puts @aeronautic's effects in earthkit's atmosphere: one sun, one air, one haze.
//
// - Light: an effect's smoke is lit by the sunlight and skylight at its own position
//   (`atmosphere.getSunAndSkyIlluminance`), converted to @aeronautic's radiance unit.
// - Haze: the plume is seen through the air between it and the camera (`createAerialPerspectiveAlongRay`),
//   as the terrain behind it is (the volume pass's backdrop is `atmosphere.createBackdropNode`).
// - Air: the plume's altitude and day come from the same standard atmosphere as the sky's density. For an
//   effect that takes the air's extinction (@aeronautic's `Extinction`), pass
//   `atmosphere.parameters.getAirExtinction(altitudeMeters)`, not `extinction(visibility, …)`: the sky's haze
//   thins with altitude, @aeronautic's visibility-based haze does not.
// - Units: one-point CPU lighting suits a nozzle; an effect kilometres long (a contrail) should read
//   `atmosphere.getSunAndSkyIlluminanceNode` per sample, with the same unit conversion.
import type { AfterburnerHooks, AfterburnerProfile } from '@aeronautic/afterburner'
import type { Atmosphere, SunAndSkyIlluminance } from '@earthkit/globe'
import { Vector3 } from 'three'
import { dot, float, max, vec3 } from 'three/tsl'

/**
 * @aeronautic's radiance unit: its blackbody is normalised to a luminance of 1 at 2000 K. A 2000 K blackbody's
 * luminance is 683 lm/W × ∫ B(λ, 2000 K) V(λ) dλ ≈ 4.65 × 10⁵ cd/m² (the old candela was 60 cd/cm² at 2042 K).
 */
export const AERONAUTIC_RADIANCE_UNIT_CANDELAS_PER_SQUARE_METER = 4.65e5

const LUMINANCE = new Vector3(0.2126, 0.7152, 0.0722)

/** What an afterburner batch's profile takes from the atmosphere. */
export type AfterburnerLighting = Pick<AfterburnerProfile, 'exposure' | 'adaptation' | 'sunLight' | 'skyLight' | 'altitudeM' | 'temperatureOffsetK'> & {
  sunDirection: [number, number, number]
}

const scratch: SunAndSkyIlluminance = { sun: new Vector3(), sky: new Vector3(), skyAvailable: false }
const up = new Vector3()

/**
 * The profile fields that light a plume at an ECEF position with the atmosphere's sun and sky, physically:
 *
 * - `exposure` converts @aeronautic's radiance unit to the scene's (the renderer's tone-mapping exposure then
 *   applies to both alike), so a flame is as bright against the sky as it is in nature.
 * - `sunLight` is the sunlight reaching the plume over 4π: the particles' scattered radiance per metre for an
 *   isotropic phase function (@aeronautic normalises its phase to 1 for isotropic scattering).
 * - `skyLight` is the mean radiance of the sky dome and the lit ground below (albedo from the atmosphere).
 *
 * - `adaptation` is 0: a physical exposure has no per-flame metering.
 *
 * Both lights are luminances: @aeronautic's smoke takes one grey value, so a sunset's colour reaches the
 * smoke only through its brightness. Until the atmosphere is ready the skylight is 0 (see
 * `Atmosphere.getSunAndSkyIlluminance`).
 */
export function getAfterburnerLighting(atmosphere: Atmosphere, positionMeters: Vector3, target: Partial<AfterburnerLighting> = {}): AfterburnerLighting {
  const parameters = atmosphere.parameters
  const sceneUnitsPerRadianceUnit = AERONAUTIC_RADIANCE_UNIT_CANDELAS_PER_SQUARE_METER * parameters.getLuminanceScale()
  const { sun, sky } = atmosphere.getSunAndSkyIlluminance(positionMeters, scratch)
  const sunDirection = atmosphere.sunDirectionECEF
  const radii = parameters.ellipsoidRadiiMeters
  up.set(positionMeters.x / radii.x ** 2, positionMeters.y / radii.y ** 2, positionMeters.z / radii.z ** 2).normalize()
  const sunLuminance = sun.dot(LUMINANCE)
  const skyLuminance = sky.dot(LUMINANCE)
  const groundLuminance = parameters.groundAlbedo.dot(LUMINANCE) * (sunLuminance * Math.max(up.dot(sunDirection), 0) + skyLuminance)

  const result = target as AfterburnerLighting
  result.exposure = sceneUnitsPerRadianceUnit
  // No auto-exposure for a dim burner: it would brighten the flame (and its lit smoke) above the scene.
  result.adaptation = 0
  result.sunLight = sunLuminance / (4 * Math.PI * sceneUnitsPerRadianceUnit)
  result.skyLight = (skyLuminance + groundLuminance) / (2 * Math.PI * sceneUnitsPerRadianceUnit)
  result.sunDirection = [sunDirection.x, sunDirection.y, sunDirection.z]
  result.altitudeM = getHeightAboveEllipsoid(positionMeters, radii)
  result.temperatureOffsetK = parameters.temperatureOffsetKelvin
  return result
}

/** Height above the ellipsoid along the radial direction: within centimetres of the geodetic height near the ground. */
function getHeightAboveEllipsoid(positionMeters: Vector3, radii: Vector3): number {
  const radius = positionMeters.length()
  const x = positionMeters.x / radius
  const y = positionMeters.y / radius
  const z = positionMeters.z / radius
  return radius - 1 / Math.sqrt((x * x) / radii.x ** 2 + (y * y) / radii.y ** 2 + (z * z) / radii.z ** 2)
}

/**
 * An afterburner `radiance` hook that hazes the plume with the air between it and the camera, at the middle
 * of the plume's span on the pixel's ray. The plume's light arrives through the air's transmittance, and the
 * air in front of it adds its own light where the plume covers what is behind (premultiplied).
 * Assumes the plume's frame is in metres (an unscaled nozzle, @aeronautic's convention).
 */
export function createAerialPerspectiveHook(atmosphere: Atmosphere): NonNullable<AfterburnerHooks['radiance']> {
  const alongRay = atmosphere.createAerialPerspectiveAlongRay()
  return (rgb, pixel) => {
    const distanceMeters = max(pixel.span.x.add(pixel.span.y).mul(0.5), 0)
    const { transmittance, radiance } = alongRay(distanceMeters)
    const coverage = float(1).sub(dot(pixel.transmittance, vec3(0.2126, 0.7152, 0.0722)))
    return rgb.mul(transmittance).add(radiance.mul(coverage))
  }
}
