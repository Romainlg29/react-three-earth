import { wrapLongitude, type LongitudeLatitude } from '@earthkit/draw'

import { geodesicLine, segmentLengthsMeters } from './geodesic.js'

/** One point of an elevation profile. */
export interface ElevationSample {
  /** Along the path from its start, following its geodesics. */
  distanceMeters: number
  longitudeDegrees: number
  latitudeDegrees: number
  /** The terrain's height there above the WGS84 ellipsoid, or null where no terrain is loaded. */
  heightMeters: number | null
}

/** The terrain's heights along a path, sampled at even steps. */
export interface ElevationProfile {
  /** From the start of the path to its end, evenly spaced (vertices fall between samples). */
  samples: ElevationSample[]
  /** The path's geodesic length. */
  lengthMeters: number
  /** Lowest and highest known height, or null when none is known. */
  minimumHeightMeters: number | null
  maximumHeightMeters: number | null
  /** Sum of the rises and of the drops between consecutive known samples (both positive). */
  ascentMeters: number
  descentMeters: number
  /** Every sample has a height. False while terrain along the path is not loaded yet. */
  complete: boolean
}

/** The terrain's height at a position, or null where it is not known. */
export type HeightQuery = (longitudeDegrees: number, latitudeDegrees: number) => number | null

export interface ElevationProfileOptions {
  /** Samples along the whole path, ends included. Default: 256. */
  sampleCount?: number
}

export const DEFAULT_PROFILE_SAMPLE_COUNT = 256

/**
 * The heights `heightAt` gives at `sampleCount` evenly spaced points along a path's geodesics, with the lowest,
 * highest, total ascent and descent. Pure: `Measure.elevationProfile` passes the loaded terrain as `heightAt`.
 */
export function elevationProfile(positions: readonly (readonly number[])[], heightAt: HeightQuery, { sampleCount = DEFAULT_PROFILE_SAMPLE_COUNT }: ElevationProfileOptions = {}): ElevationProfile {
  if (!Number.isInteger(sampleCount) || sampleCount < 2) throw new Error(`elevationProfile: sampleCount must be a whole number of 2 or more, got ${sampleCount}.`)
  const lengths = segmentLengthsMeters(positions)
  const lengthMeters = lengths.reduce((sum, length) => sum + length, 0)
  const samples: ElevationSample[] = []
  if (positions.length === 0) return summarise(samples, 0)
  if (positions.length === 1 || lengthMeters === 0) {
    const [longitude, latitude] = positions[0]!
    samples.push({ distanceMeters: 0, longitudeDegrees: longitude!, latitudeDegrees: latitude!, heightMeters: heightAt(longitude!, latitude!) })
    return summarise(samples, 0)
  }
  let segment = 0
  let segmentStartMeters = 0
  // Each segment's geodesic solved once, for all its samples.
  let line: ((distanceMeters: number) => LongitudeLatitude) | null = null
  let lineSegment = -1
  for (let index = 0; index < sampleCount; index++) {
    const distanceMeters = index === sampleCount - 1 ? lengthMeters : (lengthMeters * index) / (sampleCount - 1)
    // The segment this distance falls on (the last one holds the end).
    while (segment < lengths.length - 1 && distanceMeters > segmentStartMeters + lengths[segment]!) {
      segmentStartMeters += lengths[segment]!
      segment++
    }
    if (line === null || lineSegment !== segment) {
      line = geodesicLine(positions[segment]!, positions[segment + 1]!)
      lineSegment = segment
    }
    const position = line(distanceMeters - segmentStartMeters)
    const longitude = wrapLongitude(position[0])
    samples.push({ distanceMeters, longitudeDegrees: longitude, latitudeDegrees: position[1], heightMeters: heightAt(longitude, position[1]) })
  }
  return summarise(samples, lengthMeters)
}

function summarise(samples: ElevationSample[], lengthMeters: number): ElevationProfile {
  let minimum: number | null = null
  let maximum: number | null = null
  let ascent = 0
  let descent = 0
  let previous: number | null = null
  let complete = true
  for (const { heightMeters } of samples) {
    if (heightMeters === null) {
      complete = false
      continue
    }
    minimum = minimum === null ? heightMeters : Math.min(minimum, heightMeters)
    maximum = maximum === null ? heightMeters : Math.max(maximum, heightMeters)
    if (previous !== null) {
      const change = heightMeters - previous
      if (change > 0) ascent += change
      else descent -= change
    }
    previous = heightMeters
  }
  return { samples, lengthMeters, minimumHeightMeters: minimum, maximumHeightMeters: maximum, ascentMeters: ascent, descentMeters: descent, complete: complete && samples.length > 0 }
}
