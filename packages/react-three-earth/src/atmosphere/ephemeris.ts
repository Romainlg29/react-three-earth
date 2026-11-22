import { Vector3 } from 'three'

// Low-precision solar ephemeris, accurate to about 0.01° between 1950 and 2050:
// - Sun position: Astronomical Almanac, "Low precision formulas for the Sun" (section C).
// - Earth rotation: Greenwich mean sidereal time, IAU 1982 (Meeus, Astronomical Algorithms, eq. 12.4).
// Nutation, polar motion and the difference between UT1, UTC and TT are ignored: each is below 0.005°.

const MILLISECONDS_PER_DAY = 86_400_000
/** Julian date of the Unix epoch, 1970-01-01T00:00Z. */
const JULIAN_DATE_UNIX_EPOCH = 2_440_587.5
/** Julian date of the J2000.0 epoch, 2000-01-01T12:00 (TT, taken here as UTC). */
const JULIAN_DATE_J2000 = 2_451_545
const DAYS_PER_JULIAN_CENTURY = 36_525
const RADIANS_PER_DEGREE = Math.PI / 180

/** Julian date (fractional days since noon UTC, 1 January 4713 BC) of a date. */
export function getJulianDate(date: Date): number {
  return date.getTime() / MILLISECONDS_PER_DAY + JULIAN_DATE_UNIX_EPOCH
}

/** Days since J2000.0. */
function getDaysSinceJ2000(date: Date): number {
  return getJulianDate(date) - JULIAN_DATE_J2000
}

function wrapDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

/** The sun's apparent ecliptic longitude and the obliquity of the ecliptic, in radians. */
export function getSunEclipticCoordinates(date: Date): { eclipticLongitudeRadians: number; obliquityRadians: number; distanceAstronomicalUnits: number } {
  const days = getDaysSinceJ2000(date)
  const meanLongitudeDegrees = 280.46 + 0.9856474 * days
  const meanAnomaly = wrapDegrees(357.528 + 0.9856003 * days) * RADIANS_PER_DEGREE
  const eclipticLongitudeDegrees = meanLongitudeDegrees + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)
  return {
    eclipticLongitudeRadians: wrapDegrees(eclipticLongitudeDegrees) * RADIANS_PER_DEGREE,
    obliquityRadians: (23.439 - 4e-7 * days) * RADIANS_PER_DEGREE,
    distanceAstronomicalUnits: 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2 * meanAnomaly),
  }
}

/**
 * Unit vector towards the sun in the Earth-centred inertial frame of date (equator and equinox of date:
 * +X to the vernal equinox, +Z to the north celestial pole).
 */
export function getSunDirectionECI(date: Date, target = new Vector3()): Vector3 {
  const { eclipticLongitudeRadians: longitude, obliquityRadians: obliquity } = getSunEclipticCoordinates(date)
  return target.set(Math.cos(longitude), Math.cos(obliquity) * Math.sin(longitude), Math.sin(obliquity) * Math.sin(longitude))
}

/** Greenwich mean sidereal time: the angle from the vernal equinox to the Greenwich meridian, in radians. */
export function getGreenwichMeanSiderealTime(date: Date): number {
  const days = getDaysSinceJ2000(date)
  const centuries = days / DAYS_PER_JULIAN_CENTURY
  const degrees = 280.46061837 + 360.98564736629 * days + 0.000387933 * centuries ** 2 - centuries ** 3 / 38_710_000
  return wrapDegrees(degrees) * RADIANS_PER_DEGREE
}

/** Rotates a vector from the inertial frame of date to Earth-centred, Earth-fixed (ECEF) axes, in place. */
export function rotateECIToECEF(vector: Vector3, date: Date): Vector3 {
  const angle = getGreenwichMeanSiderealTime(date)
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return vector.set(cosine * vector.x + sine * vector.y, -sine * vector.x + cosine * vector.y, vector.z)
}

/** Unit vector towards the sun in Earth-centred, Earth-fixed (ECEF) axes, for a date. */
export function getSunDirectionECEF(date: Date, target = new Vector3()): Vector3 {
  return rotateECIToECEF(getSunDirectionECI(date, target), date)
}

/** Geographic point where the sun is at the zenith, in degrees (geocentric latitude, which is the declination). */
export function getSubsolarPoint(date: Date): { latitudeDegrees: number; longitudeDegrees: number } {
  const direction = getSunDirectionECEF(date)
  return {
    latitudeDegrees: Math.asin(direction.z) / RADIANS_PER_DEGREE,
    longitudeDegrees: Math.atan2(direction.y, direction.x) / RADIANS_PER_DEGREE,
  }
}
