import { describe, expect, it } from 'vitest'

import {
  getGreenwichMeanSiderealTime,
  getJulianDate,
  getSubsolarPoint,
  getSunDirectionECEF,
  getSunDirectionECI,
} from '../src/atmosphere/ephemeris.js'

const DEGREES_PER_RADIAN = 180 / Math.PI

function declinationDegrees(date: Date): number {
  return Math.asin(getSunDirectionECI(date).z) * DEGREES_PER_RADIAN
}

function rightAscensionDegrees(date: Date): number {
  const direction = getSunDirectionECI(date)
  return ((Math.atan2(direction.y, direction.x) * DEGREES_PER_RADIAN) + 360) % 360
}

/** Smallest difference between two angles, in degrees. */
function angleDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

describe('getJulianDate', () => {
  it('gives 2451545.0 at J2000.0', () => {
    expect(getJulianDate(new Date('2000-01-01T12:00:00Z'))).toBe(2_451_545)
  })
})

describe('getSunDirectionECI', () => {
  // Meeus, Astronomical Algorithms, example 25.a: 1992 October 13.0 TD.
  // Apparent right ascension 198.38083°, declination -7.78507°.
  it('matches Meeus example 25.a within 0.01°', () => {
    const date = new Date('1992-10-13T00:00:00Z')
    expect(angleDifference(rightAscensionDegrees(date), 198.38083)).toBeLessThan(0.01)
    expect(Math.abs(declinationDegrees(date) - -7.78507)).toBeLessThan(0.01)
  })

  // Solstice and equinox instants (USNO): the declination is ±obliquity or 0.
  it.each([
    ['2024-03-20T03:06:00Z', 0],
    ['2024-06-20T20:51:00Z', 23.4362],
    ['2024-09-22T12:44:00Z', 0],
    ['2024-12-21T09:20:00Z', -23.4362],
    ['2026-06-21T08:24:00Z', 23.4360],
    ['2026-12-21T20:50:00Z', -23.4360],
  ])('gives the declination at %s', (iso, expectedDegrees) => {
    expect(Math.abs(declinationDegrees(new Date(iso)) - expectedDegrees)).toBeLessThan(0.01)
  })

  it('returns a unit vector', () => {
    expect(getSunDirectionECI(new Date('2026-11-22T07:00:00Z')).length()).toBeCloseTo(1, 12)
  })
})

describe('getGreenwichMeanSiderealTime', () => {
  // Meeus examples 12.a and 12.b.
  it('matches Meeus example 12.a (1987-04-10 0h UT: 13h10m46.3668s)', () => {
    const degrees = getGreenwichMeanSiderealTime(new Date('1987-04-10T00:00:00Z')) * DEGREES_PER_RADIAN
    expect(angleDifference(degrees, (13 + 10 / 60 + 46.3668 / 3600) * 15)).toBeLessThan(1e-4)
  })

  it('matches Meeus example 12.b (1987-04-10 19:21 UT: 8h34m57.0896s)', () => {
    const degrees = getGreenwichMeanSiderealTime(new Date('1987-04-10T19:21:00Z')) * DEGREES_PER_RADIAN
    expect(angleDifference(degrees, (8 + 34 / 60 + 57.0896 / 3600) * 15)).toBeLessThan(1e-4)
  })
})

describe('getSubsolarPoint', () => {
  // At the March 2024 equinox, 03:06 UTC, the equation of time was -7.5 minutes (NOAA): solar noon at
  // Greenwich was 12:07:30, 9 h 01.5 min later, so the sun stood over longitude 135.4° E.
  it('puts the sun over the western Pacific at the March 2024 equinox', () => {
    const point = getSubsolarPoint(new Date('2024-03-20T03:06:00Z'))
    expect(Math.abs(point.latitudeDegrees)).toBeLessThan(0.01)
    expect(angleDifference(point.longitudeDegrees, 135.4)).toBeLessThan(0.1)
  })

  // Early November the equation of time peaks at +16.4 minutes: the sun crosses Greenwich at about 11:43:36 UTC.
  it('puts the sun over Greenwich at 11:43:36 UTC on 3 November 2026', () => {
    const point = getSubsolarPoint(new Date('2026-11-03T11:43:36Z'))
    expect(angleDifference(point.longitudeDegrees, 0)).toBeLessThan(0.05)
    expect(point.latitudeDegrees).toBeCloseTo(-15.1, 0)
  })

  it('places the sun low in the south-west from Fuji at 16:00 JST on 22 November 2026', () => {
    // Local east-north-up axes at 35.36° N, 138.73° E.
    const latitude = 35.3606 / DEGREES_PER_RADIAN
    const longitude = 138.7274 / DEGREES_PER_RADIAN
    const sun = getSunDirectionECEF(new Date('2026-11-22T07:00:00Z'))
    const east = -Math.sin(longitude) * sun.x + Math.cos(longitude) * sun.y
    const north = -Math.sin(latitude) * Math.cos(longitude) * sun.x - Math.sin(latitude) * Math.sin(longitude) * sun.y + Math.cos(latitude) * sun.z
    const up = Math.cos(latitude) * Math.cos(longitude) * sun.x + Math.cos(latitude) * Math.sin(longitude) * sun.y + Math.sin(latitude) * sun.z
    const elevationDegrees = Math.asin(up) * DEGREES_PER_RADIAN
    const azimuthDegrees = (Math.atan2(east, north) * DEGREES_PER_RADIAN + 360) % 360
    // Half an hour before sunset (16:31 JST): elevation about 5.5° (before refraction), azimuth about 240°.
    expect(elevationDegrees).toBeGreaterThan(4.5)
    expect(elevationDegrees).toBeLessThan(6.5)
    expect(azimuthDegrees).toBeGreaterThan(237)
    expect(azimuthDegrees).toBeLessThan(243)
  })
})
