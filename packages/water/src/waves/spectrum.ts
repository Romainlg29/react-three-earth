/**
 * The sea state as a wave spectrum: how much of the surface's height variance each wavelength and direction holds, from
 * the wind (speed, direction, fetch) and the water (temperature and salinity, through gravity-capillary dispersion).
 */

export const GRAVITY_METERS_PER_SECOND_SQUARED = 9.81

export interface SeaStateOptions {
  /** Wind speed 10 m above the sea, m/s. */
  windSpeedMetersPerSecond: number
  /** The direction the wind blows from, degrees clockwise from north (270: a westerly, waves running east). */
  windDirectionDegrees: number
  /** The distance the wind has blown over open water, km: short fetch, short steep waves. */
  fetchKilometers: number
  temperatureCelsius: number
  salinityPartsPerThousand: number
}

/** Seawater density, kg/m³: UNESCO's equation of state reduced to its leading terms (within 0.1 % from 0 to 30 °C). */
export function seawaterDensity(temperatureCelsius: number, salinityPartsPerThousand: number): number {
  const temperature = temperatureCelsius
  const fresh = 999.842594 + 6.793952e-2 * temperature - 9.09529e-3 * temperature ** 2 + 1.001685e-4 * temperature ** 3
  return fresh + (0.824493 - 4.0899e-3 * temperature) * salinityPartsPerThousand
}

/** Surface tension of seawater, N/m: pure water's (Vargaftik 1983, linearised) plus salt's small rise (Sharqawy 2010). */
export function seawaterSurfaceTension(temperatureCelsius: number, salinityPartsPerThousand: number): number {
  return 0.0757 - 1.53e-4 * temperatureCelsius + 2.1e-5 * salinityPartsPerThousand
}

/**
 * Angular frequency of a deep-water wave of wavenumber `k` (rad/m), rad/s: gravity waves plus the capillary term that
 * takes over below about 2 cm, `ω² = g k + (σ/ρ) k³`.
 */
export function angularFrequency(wavenumber: number, surfaceTensionOverDensity: number): number {
  return Math.sqrt(GRAVITY_METERS_PER_SECOND_SQUARED * wavenumber + surfaceTensionOverDensity * wavenumber ** 3)
}

/** `dω/dk` of `angularFrequency`. */
export function groupVelocity(wavenumber: number, surfaceTensionOverDensity: number): number {
  const frequency = angularFrequency(wavenumber, surfaceTensionOverDensity)
  return frequency === 0 ? 0 : (GRAVITY_METERS_PER_SECOND_SQUARED + 3 * surfaceTensionOverDensity * wavenumber ** 2) / (2 * frequency)
}

/**
 * The JONSWAP frequency spectrum (Hasselmann et al. 1973), m²·s: a sea growing under a steady wind over a fetch.
 * Peak frequency and Phillips constant from the fetch (`ωp = 22 (g²/(U F))^(1/3)`, `α = 0.076 (U²/(F g))^0.22`), peak
 * enhancement 3.3. Zero in still air.
 */
export function jonswapSpectrum(frequency: number, windSpeedMetersPerSecond: number, fetchMeters: number): number {
  if (frequency <= 0 || windSpeedMetersPerSecond <= 0) return 0
  const gravity = GRAVITY_METERS_PER_SECOND_SQUARED
  const peakFrequency = 22 * (gravity ** 2 / (windSpeedMetersPerSecond * fetchMeters)) ** (1 / 3)
  const phillips = 0.076 * (windSpeedMetersPerSecond ** 2 / (fetchMeters * gravity)) ** 0.22
  const width = frequency <= peakFrequency ? 0.07 : 0.09
  const peakEnhancement = 3.3 ** Math.exp(-((frequency - peakFrequency) ** 2) / (2 * width ** 2 * peakFrequency ** 2))
  return phillips * gravity ** 2 * frequency ** -5 * Math.exp(-1.25 * (peakFrequency / frequency) ** 4) * peakEnhancement
}

/** Spreading exponent of `directionalSpreading`: most energy within about 40° of downwind. */
const SPREADING_EXPONENT = 8
const SPREADING_NORMALISATION = (() => {
  // ∫ cos^(2s)(θ/2) dθ over a turn, by the midpoint rule: the spreading then integrates to 1.
  const steps = 4096
  let sum = 0
  for (let step = 0; step < steps; step++) {
    const angle = -Math.PI + ((step + 0.5) / steps) * 2 * Math.PI
    sum += Math.cos(angle / 2) ** (2 * SPREADING_EXPONENT)
  }
  return 1 / (sum * ((2 * Math.PI) / steps))
})()

/**
 * How the energy spreads around the wind's direction (Longuet-Higgins et al. 1963, `cos^2s(Δθ/2)`), per radian,
 * integrating to 1 over a turn. `angleFromDownwind` in radians.
 */
export function directionalSpreading(angleFromDownwind: number): number {
  return SPREADING_NORMALISATION * Math.abs(Math.cos(angleFromDownwind / 2)) ** (2 * SPREADING_EXPONENT)
}

export interface SeaStateConstants {
  surfaceTensionOverDensity: number
  fetchMeters: number
  /** The direction the waves run to, radians counter-clockwise from east (the wavenumber plane's x axis). */
  downwindRadians: number
}

export function seaStateConstants(options: SeaStateOptions): SeaStateConstants {
  const density = seawaterDensity(options.temperatureCelsius, options.salinityPartsPerThousand)
  const tension = seawaterSurfaceTension(options.temperatureCelsius, options.salinityPartsPerThousand)
  // From the compass (clockwise from north, where the wind comes from) to the plane (counter-clockwise from east, where it goes).
  const downwindCompassRadians = ((options.windDirectionDegrees + 180) * Math.PI) / 180
  return { surfaceTensionOverDensity: tension / density, fetchMeters: options.fetchKilometers * 1000, downwindRadians: Math.PI / 2 - downwindCompassRadians }
}

/**
 * The wavenumber spectrum per unit area of the plane, m⁴: height variance per `dkx dky` at `(kx, ky)` (rad/m, x east,
 * y north). From the frequency spectrum through the dispersion relation, spread around the wind.
 */
export function wavenumberSpectrum(kx: number, ky: number, options: SeaStateOptions, constants = seaStateConstants(options)): number {
  const wavenumber = Math.hypot(kx, ky)
  if (wavenumber === 0) return 0
  const frequency = angularFrequency(wavenumber, constants.surfaceTensionOverDensity)
  const perFrequency = jonswapSpectrum(frequency, options.windSpeedMetersPerSecond, constants.fetchMeters)
  const perWavenumber = perFrequency * groupVelocity(wavenumber, constants.surfaceTensionOverDensity)
  const angle = Math.atan2(ky, kx) - constants.downwindRadians
  // Polar to Cartesian: dkx dky = k dk dθ.
  return (perWavenumber * directionalSpreading(angle)) / wavenumber
}

/** Significant wave height, m: four times the root of the height variance over the given wavenumbers. */
export function significantWaveHeight(options: SeaStateOptions, maximumWavenumber = 50): number {
  const constants = seaStateConstants(options)
  const steps = 4000
  let variance = 0
  for (let step = 0; step < steps; step++) {
    const wavenumber = ((step + 0.5) / steps) * maximumWavenumber
    const frequency = angularFrequency(wavenumber, constants.surfaceTensionOverDensity)
    variance += jonswapSpectrum(frequency, options.windSpeedMetersPerSecond, constants.fetchMeters) * groupVelocity(wavenumber, constants.surfaceTensionOverDensity) * (maximumWavenumber / steps)
  }
  return 4 * Math.sqrt(variance)
}
