import type { WaveProbe } from './WaveProbe.js'

/** A hull to float: where it lies, where its bow points and its size. Its four corners are sampled. */
export interface WaveBuoyancyHull {
  longitudeDegrees: number
  latitudeDegrees: number
  /** Where the bow points, degrees clockwise from north. */
  headingDegrees: number
  /** From stern to bow, metres. */
  lengthMeters: number
  /** From port to starboard, metres. */
  beamMeters: number
}

export interface WaveBuoyancyOptions {
  /**
   * How long the hull takes to follow the sea, seconds: a heavy boat lags and smooths out the short chop, a light one
   * rides every wave. The time constant of an exponential follow. Default: `WAVE_BUOYANCY_RESPONSE_SECONDS`.
   */
  responseSeconds?: number
  /** How deep the hull sits, metres: its waterline lies this far above `heightMeters`. Default: 0. */
  draftMeters?: number
}

/** How the sea holds a hull, as of the last update. */
export interface WaveBuoyancyState {
  /** The hull's keel height above the WGS84 ellipsoid, metres: the mean of its corners' sea, less the draft. */
  heightMeters: number
  /** Bow up, radians (pitch about the hull's beam). */
  pitchRadians: number
  /** Starboard up, radians (roll about the hull's length). */
  rollRadians: number
  /** False until the first reading of all four corners lands. */
  ready: boolean
}

/** How long a hull takes to follow the sea unless told otherwise, seconds. */
export const WAVE_BUOYANCY_RESPONSE_SECONDS = 0.35

/** The hull's corners, in its frame: metres starboard and forward, as fractions of beam and length. */
const CORNERS = [
  [-0.5, 0.5],
  [0.5, 0.5],
  [-0.5, -0.5],
  [0.5, -0.5],
] as const

const EQUATORIAL_RADIUS_METERS = 6378137
const ECCENTRICITY_SQUARED = 0.00669437999014

/**
 * Floats a hull on the waves from four probes at its corners (bow port, bow starboard, stern port, stern starboard): the
 * mean of their heights gives its heave, the bow against the stern its pitch, starboard against port its roll, each
 * followed with a lag of `responseSeconds` so the hull rides the swell rather than every ripple. The probes read what
 * the wave mesh draws, a frame or two late.
 *
 * Create it with `water.createBuoyancy(hull)`, which updates it every frame; `dispose` stops it.
 */
export class WaveBuoyancy {
  readonly state: WaveBuoyancyState = { heightMeters: 0, pitchRadians: 0, rollRadians: 0, ready: false }
  readonly probe: WaveProbe
  readonly responseSeconds: number
  readonly draftMeters: number
  protected hullValue: WaveBuoyancyHull
  protected readonly onDispose: (buoyancy: WaveBuoyancy) => void
  protected disposed = false

  constructor(probe: WaveProbe, hull: WaveBuoyancyHull, { responseSeconds = WAVE_BUOYANCY_RESPONSE_SECONDS, draftMeters = 0 }: WaveBuoyancyOptions = {}, onDispose: (buoyancy: WaveBuoyancy) => void = () => {}) {
    if (!(responseSeconds >= 0) || !Number.isFinite(responseSeconds)) throw new Error(`WaveBuoyancy: responseSeconds must be a finite number of 0 or more, got ${responseSeconds}.`)
    if (!Number.isFinite(draftMeters)) throw new Error(`WaveBuoyancy: draftMeters must be a finite number, got ${draftMeters}.`)
    if (probe.capacity < 4) throw new Error(`WaveBuoyancy: its probe holds ${probe.capacity} points; it needs 4, one per corner.`)
    this.probe = probe
    this.responseSeconds = responseSeconds
    this.draftMeters = draftMeters
    this.onDispose = onDispose
    this.hullValue = hull
    this.setHull(hull)
  }

  get hull(): Readonly<WaveBuoyancyHull> {
    return this.hullValue
  }

  /** Moves, turns or resizes the hull: its corners are sampled anew, and the state follows from the next reading. */
  setHull(hull: WaveBuoyancyHull): void {
    if (this.disposed) throw new Error('WaveBuoyancy: it was disposed; create another with `water.createBuoyancy()`.')
    const { longitudeDegrees, latitudeDegrees, headingDegrees, lengthMeters, beamMeters } = hull
    if (![longitudeDegrees, latitudeDegrees, headingDegrees].every(Number.isFinite)) {
      throw new Error(`WaveBuoyancy: the hull needs finite longitudeDegrees, latitudeDegrees and headingDegrees, got ${longitudeDegrees}, ${latitudeDegrees}, ${headingDegrees}.`)
    }
    if (!(lengthMeters > 0) || !(beamMeters > 0) || !Number.isFinite(lengthMeters) || !Number.isFinite(beamMeters)) {
      throw new Error(`WaveBuoyancy: the hull needs a positive lengthMeters and beamMeters, got ${lengthMeters} and ${beamMeters}.`)
    }
    this.hullValue = { ...hull }
    this.probe.setPoints(hullCorners(hull))
  }

  /** Follows the corners' latest reading over `deltaSeconds`. `Water` calls it every frame. */
  update(deltaSeconds: number): void {
    if (this.disposed) return
    const [bowPort, bowStarboard, sternPort, sternStarboard] = this.probe.samples
    if (bowPort === undefined || bowStarboard === undefined || sternPort === undefined || sternStarboard === undefined) return
    if (!bowPort.ready || !bowStarboard.ready || !sternPort.ready || !sternStarboard.ready) return
    const { lengthMeters, beamMeters } = this.hullValue
    const bow = (bowPort.heightMeters + bowStarboard.heightMeters) / 2
    const stern = (sternPort.heightMeters + sternStarboard.heightMeters) / 2
    const port = (bowPort.heightMeters + sternPort.heightMeters) / 2
    const starboard = (bowStarboard.heightMeters + sternStarboard.heightMeters) / 2
    const height = (bow + stern) / 2 - this.draftMeters
    const pitch = Math.atan2(bow - stern, lengthMeters)
    const roll = Math.atan2(starboard - port, beamMeters)
    const { state } = this
    // The first reading places the hull; after it, an exponential follow (exact for any frame time).
    const follow = state.ready && this.responseSeconds > 0 ? 1 - Math.exp(-Math.max(deltaSeconds, 0) / this.responseSeconds) : 1
    state.heightMeters += (height - state.heightMeters) * follow
    state.pitchRadians += (pitch - state.pitchRadians) * follow
    state.rollRadians += (roll - state.rollRadians) * follow
    state.ready = true
  }

  /** Stops sampling and frees the probe. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.probe.dispose()
    this.onDispose(this)
  }
}

/**
 * A hull's four corners as geographic points: bow port, bow starboard, stern port, stern starboard. Offsets in metres
 * turn into degrees with the ellipsoid's radii of curvature at the hull's latitude.
 */
export function hullCorners({ longitudeDegrees, latitudeDegrees, headingDegrees, lengthMeters, beamMeters }: WaveBuoyancyHull): Array<{ longitudeDegrees: number; latitudeDegrees: number }> {
  const heading = (headingDegrees * Math.PI) / 180
  const latitude = (latitudeDegrees * Math.PI) / 180
  const sine = Math.sin(latitude)
  const denominator = 1 - ECCENTRICITY_SQUARED * sine * sine
  const meridianRadius = (EQUATORIAL_RADIUS_METERS * (1 - ECCENTRICITY_SQUARED)) / denominator ** 1.5
  const parallelRadius = (EQUATORIAL_RADIUS_METERS / Math.sqrt(denominator)) * Math.cos(latitude)
  return CORNERS.map(([starboardShare, forwardShare]) => {
    const starboard = starboardShare * beamMeters
    const forward = forwardShare * lengthMeters
    const east = forward * Math.sin(heading) + starboard * Math.cos(heading)
    const north = forward * Math.cos(heading) - starboard * Math.sin(heading)
    return {
      longitudeDegrees: longitudeDegrees + ((east / Math.max(parallelRadius, 1e-6)) * 180) / Math.PI,
      latitudeDegrees: latitudeDegrees + ((north / meridianRadius) * 180) / Math.PI,
    }
  })
}
