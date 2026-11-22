// The International Standard Atmosphere (ISO 2533:1975, identical to the U.S. Standard Atmosphere 1976 below
// 86 km), shared by the sky's air density and by flight effects such as @aeronautic's: the same layers, the
// same constants, so a plume and the haze around it breathe the same air.

/** Standard sea-level temperature. */
export const SEA_LEVEL_TEMPERATURE_KELVIN = 288.15
/** Standard sea-level pressure. */
export const SEA_LEVEL_PRESSURE_PASCALS = 101_325
/** Specific gas constant of dry air, J/(kg·K). */
export const DRY_AIR_GAS_CONSTANT = 287.05
/** Standard gravity. */
export const STANDARD_GRAVITY_METERS_PER_SECOND_SQUARED = 9.806_65
/** Highest altitude the layers describe; above it the air is taken as isothermal. */
export const STANDARD_ATMOSPHERE_CEILING_METERS = 86_000

/** g / R, kelvin per metre: the hydrostatic constant of every layer. */
const HYDROSTATIC_KELVIN_PER_METER = STANDARD_GRAVITY_METERS_PER_SECOND_SQUARED / DRY_AIR_GAS_CONSTANT

/** One layer: its base altitude and temperature lapse rate (positive when warming upwards). */
export interface StandardAtmosphereLayer {
  baseAltitudeMeters: number
  lapseRateKelvinPerMeter: number
  /** Standard temperature at the base. */
  baseTemperatureKelvin: number
  /** Standard pressure at the base, as a share of sea level's. */
  basePressureRatio: number
}

const LAYER_DEFINITIONS: readonly (readonly [baseAltitudeMeters: number, lapseRateKelvinPerMeter: number])[] = [
  [0, -0.0065],
  [11_000, 0],
  [20_000, 0.001],
  [32_000, 0.0028],
  [47_000, 0],
  [51_000, -0.0028],
  [71_000, -0.002],
  [STANDARD_ATMOSPHERE_CEILING_METERS, 0],
]

function pressureRatioAcross(baseTemperatureKelvin: number, lapseRateKelvinPerMeter: number, riseMeters: number): number {
  if (lapseRateKelvinPerMeter === 0) return Math.exp((-HYDROSTATIC_KELVIN_PER_METER * riseMeters) / baseTemperatureKelvin)
  const topTemperature = baseTemperatureKelvin + lapseRateKelvinPerMeter * riseMeters
  return (topTemperature / baseTemperatureKelvin) ** (-HYDROSTATIC_KELVIN_PER_METER / lapseRateKelvinPerMeter)
}

/** The layers with their base temperatures and pressures worked out, lowest first. */
export const STANDARD_ATMOSPHERE_LAYERS: readonly StandardAtmosphereLayer[] = /*#__PURE__*/ (() => {
  const layers: StandardAtmosphereLayer[] = []
  let baseTemperatureKelvin = SEA_LEVEL_TEMPERATURE_KELVIN
  let basePressureRatio = 1
  LAYER_DEFINITIONS.forEach(([baseAltitudeMeters, lapseRateKelvinPerMeter], index) => {
    layers.push({ baseAltitudeMeters, lapseRateKelvinPerMeter, baseTemperatureKelvin, basePressureRatio })
    const next = LAYER_DEFINITIONS[index + 1]
    if (next === undefined) return
    const rise = next[0] - baseAltitudeMeters
    basePressureRatio *= pressureRatioAcross(baseTemperatureKelvin, lapseRateKelvinPerMeter, rise)
    baseTemperatureKelvin += lapseRateKelvinPerMeter * rise
  })
  return layers
})()

/** The standard atmosphere at one altitude, on a day `temperatureOffsetKelvin` warmer than the standard one. */
export interface StandardAir {
  /** Temperature, the day's offset included. */
  temperatureKelvin: number
  pressurePascals: number
  /** Pressure as a share of the standard sea level's. */
  pressureRatio: number
  densityKilogramsPerCubicMeter: number
  /** Density as a share of the standard sea level's (1.225 kg/m³). */
  densityRatio: number
}

/**
 * The International Standard Atmosphere at an altitude. The pressure is the standard one; a warmer day
 * warms the air at that pressure, so it is thinner (as @aeronautic/core's `moist_air`, without the vapour).
 * Below sea level the sea-level values are returned.
 *
 * @param altitudeMeters Height above sea level (taken as the ellipsoid; the geoid is ignored).
 * @param temperatureOffsetKelvin How much warmer the day is than the standard one, at every altitude.
 */
export function getStandardAir(altitudeMeters: number, temperatureOffsetKelvin = 0, target: Partial<StandardAir> = {}): StandardAir {
  const height = Math.max(altitudeMeters, 0)
  let layer = STANDARD_ATMOSPHERE_LAYERS[0]!
  for (const candidate of STANDARD_ATMOSPHERE_LAYERS) {
    if (candidate.baseAltitudeMeters <= height) layer = candidate
  }
  const rise = height - layer.baseAltitudeMeters
  const standardTemperature = layer.baseTemperatureKelvin + layer.lapseRateKelvinPerMeter * rise
  const pressureRatio = layer.basePressureRatio * pressureRatioAcross(layer.baseTemperatureKelvin, layer.lapseRateKelvinPerMeter, rise)
  const temperatureKelvin = Math.max(standardTemperature + temperatureOffsetKelvin, 1)
  const densityRatio = (pressureRatio * SEA_LEVEL_TEMPERATURE_KELVIN) / temperatureKelvin
  const result = target as StandardAir
  result.temperatureKelvin = temperatureKelvin
  result.pressurePascals = pressureRatio * SEA_LEVEL_PRESSURE_PASCALS
  result.pressureRatio = pressureRatio
  result.densityRatio = densityRatio
  result.densityKilogramsPerCubicMeter = (densityRatio * SEA_LEVEL_PRESSURE_PASCALS) / (DRY_AIR_GAS_CONSTANT * SEA_LEVEL_TEMPERATURE_KELVIN)
  return result
}
