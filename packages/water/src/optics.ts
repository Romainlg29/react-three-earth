/**
 * The colour of a water body from its inherent optical properties, in the manner of ocean colour remote sensing:
 * absorption and backscattering of seawater, phytoplankton and coloured dissolved matter per wavelength, turned into the
 * light the water sends back up (Lee et al. 2002), averaged over the red, green and blue bands. "Case 1" waters: the
 * open ocean and clear coasts, where phytoplankton drives the colour. Sediment-laden river mouths are not modelled.
 */

/** Wavelengths of the tables, nanometres: 400 to 700 every 10. */
const WAVELENGTHS = Array.from({ length: 31 }, (_, index) => 400 + index * 10)

/** Absorption of pure water, per metre (Pope & Fry 1997), at `WAVELENGTHS`. */
const PURE_WATER_ABSORPTION = [
  0.00663, 0.00473, 0.00454, 0.00495, 0.00635, 0.00922, 0.00979, 0.0106, 0.0127, 0.015, 0.0204, 0.0325, 0.0409, 0.0434, 0.0474, 0.0565,
  0.0619, 0.0695, 0.0896, 0.1351, 0.2224, 0.2644, 0.2755, 0.2916, 0.3108, 0.34, 0.41, 0.439, 0.465, 0.516, 0.624,
]

/** Scattering of pure water at 500 nm, per metre (Morel 1974); seawater of salinity 35 scatters about 30 % more. */
const PURE_WATER_SCATTERING_500 = 0.00222
const SEAWATER_SCATTERING_SALINITY = 35

/** Phytoplankton absorption at 440 nm per chlorophyll, per metre: `0.06 × C^0.65` (Prieur & Sathyendranath 1981). */
function phytoplanktonAbsorption440(chlorophyll: number): number {
  return 0.06 * chlorophyll ** 0.65
}

/** The shape of phytoplankton absorption, 1 at 440 nm: the chlorophyll peaks in the blue and at 675 nm. */
function phytoplanktonShape(wavelength: number): number {
  const shape = (λ: number) => Math.exp(-(((λ - 440) / 40) ** 2)) + 0.35 * Math.exp(-(((λ - 495) / 55) ** 2)) + 0.45 * Math.exp(-(((λ - 675) / 15) ** 2))
  return shape(wavelength) / shape(440)
}

export interface WaterOpticsOptions {
  /** Chlorophyll concentration, mg/m³: 0.03 in the clearest gyres, 0.1 to 0.3 in open ocean, 1 to 10 on productive coasts. */
  chlorophyllMilligramsPerCubicMeter: number
  /** Salinity, grams per kilogram (practical salinity units): 35 for the ocean, 0 for fresh water. */
  salinityPartsPerThousand: number
}

/** A water body's colour and clarity, per band (red, green, blue). */
export interface WaterOptics {
  /** Reflectance of deep water seen from above, as a diffuse albedo in linear RGB. */
  deepAlbedo: [number, number, number]
  /** How fast downwelling light fades with depth, per metre: light reaching depth z is `exp(-k × z)`. */
  diffuseAttenuationPerMeter: [number, number, number]
}

const BANDS = [
  [600, 700],
  [500, 590],
  [400, 490],
] as const

/** The optical properties at one wavelength: absorption and backscattering, per metre. */
export function inherentOpticalProperties(
  wavelength: number,
  { chlorophyllMilligramsPerCubicMeter: chlorophyll, salinityPartsPerThousand: salinity }: WaterOpticsOptions,
): { absorptionPerMeter: number; backscatteringPerMeter: number } {
  const index = Math.round((wavelength - 400) / 10)
  const water = PURE_WATER_ABSORPTION[Math.min(Math.max(index, 0), PURE_WATER_ABSORPTION.length - 1)]!
  const phytoplankton440 = chlorophyll > 0 ? phytoplanktonAbsorption440(chlorophyll) : 0
  const phytoplankton = phytoplankton440 * phytoplanktonShape(wavelength)
  // Coloured dissolved organic matter covaries with phytoplankton in case 1 waters (Morel & Maritorena 2001).
  const dissolved = 0.2 * phytoplankton440 * Math.exp(-0.014 * (wavelength - 440))

  const waterScattering = PURE_WATER_SCATTERING_500 * (1 + (0.3 * salinity) / SEAWATER_SCATTERING_SALINITY) * (wavelength / 500) ** -4.32
  let particleBackscattering = 0
  if (chlorophyll > 0) {
    // Morel & Maritorena 2001: particle scattering, its backscattered share and its spectral slope from chlorophyll.
    const logChlorophyll = Math.log10(chlorophyll)
    const scattering550 = 0.416 * chlorophyll ** 0.766
    const slope = chlorophyll < 2 ? 0.5 * (logChlorophyll - 0.3) : 0
    const backscatteredShare = 0.002 + 0.01 * (0.5 - 0.25 * logChlorophyll)
    particleBackscattering = backscatteredShare * scattering550 * (wavelength / 550) ** slope
  }
  return { absorptionPerMeter: water + phytoplankton + dissolved, backscatteringPerMeter: 0.5 * waterScattering + particleBackscattering }
}

/** The colour and clarity of a water body (see the module comment for the model). */
export function computeWaterOptics(options: WaterOpticsOptions): WaterOptics {
  const deepAlbedo: [number, number, number] = [0, 0, 0]
  const diffuseAttenuationPerMeter: [number, number, number] = [0, 0, 0]
  BANDS.forEach(([from, to], band) => {
    const inBand = WAVELENGTHS.filter(wavelength => wavelength >= from && wavelength <= to)
    let albedo = 0
    let attenuation = 0
    for (const wavelength of inBand) {
      const { absorptionPerMeter: a, backscatteringPerMeter: backscattering } = inherentOpticalProperties(wavelength, options)
      const u = backscattering / (a + backscattering)
      // Subsurface remote-sensing reflectance (Lee et al. 2002), taken through the surface, then as a diffuse albedo.
      const below = u * (0.0949 + 0.0794 * u)
      const above = (0.52 * below) / (1 - 1.7 * below)
      albedo += Math.PI * above
      // Diffuse attenuation for a high sun (Gordon 1989).
      attenuation += 1.0395 * (a + backscattering)
    }
    deepAlbedo[band] = albedo / inBand.length
    diffuseAttenuationPerMeter[band] = attenuation / inBand.length
  })
  return { deepAlbedo, diffuseAttenuationPerMeter }
}

/**
 * The surface's roughness from the wind, for a `MeshStandardNodeMaterial`: the slopes of the waves too small to draw,
 * from Cox & Munk's (1954) mean square slope `0.003 + 0.00512 U`, as the GGX distribution's width (roughness² = alpha
 * ≈ the Beckmann width). 0.23 in still air, 0.41 at 5 m/s, 0.48 at 10 m/s, 0.57 at 20 m/s.
 */
export function surfaceRoughness(windSpeedMetersPerSecond: number): number {
  const meanSquareSlope = 0.003 + 0.00512 * Math.max(windSpeedMetersPerSecond, 0)
  return meanSquareSlope ** 0.25
}

/**
 * The share of the sea covered by whitecaps: `3.84e-6 × U^3.41` (Monahan & O'Muircheartaigh 1980), none in light
 * winds. About 0.1 % at 6 m/s, 1 % at 10 m/s, 10 % at 20 m/s.
 */
export function whitecapCoverage(windSpeedMetersPerSecond: number): number {
  if (windSpeedMetersPerSecond < 3) return 0
  return Math.min(3.84e-6 * windSpeedMetersPerSecond ** 3.41, 1)
}
