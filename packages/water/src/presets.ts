/** A ready-made sea: the parameters a preset sets, which explicit options override. */
export interface WaterPresetValues {
  readonly windSpeedMetersPerSecond: number
  readonly chlorophyllMilligramsPerCubicMeter: number
  readonly salinityPartsPerThousand: number
  /** A fixed colour instead of the water's optics (sRGB), or null for the optics. */
  readonly color: string | null
  /** A fixed roughness instead of the wind's, or null for the wind's. */
  readonly roughness: number | null
}

/**
 * The presets. `'map'` is the flat, matte sea of mapping libraries. The others are physical: the colour comes from the
 * water's optics, the gloss and whitecaps from the wind.
 */
export const WATER_PRESETS = {
  /** A flat light-blue sea, lit but matte, as street maps draw it. */
  map: { windSpeedMetersPerSecond: 0, chlorophyllMilligramsPerCubicMeter: 0.1, salinityPartsPerThousand: 35, color: '#a0c8f0', roughness: 1 },
  /** Still air over clear water: a sharp sky reflection and sun glint. */
  calm: { windSpeedMetersPerSecond: 1.5, chlorophyllMilligramsPerCubicMeter: 0.05, salinityPartsPerThousand: 35, color: null, roughness: null },
  /** A gentle breeze over open ocean. The default. */
  breeze: { windSpeedMetersPerSecond: 5, chlorophyllMilligramsPerCubicMeter: 0.1, salinityPartsPerThousand: 35, color: null, roughness: null },
  /** A fresh wind: a broad glint and the first whitecaps. */
  'open-ocean': { windSpeedMetersPerSecond: 10, chlorophyllMilligramsPerCubicMeter: 0.2, salinityPartsPerThousand: 35, color: null, roughness: null },
  /** A gale: about a tenth of the sea white with foam. */
  storm: { windSpeedMetersPerSecond: 20, chlorophyllMilligramsPerCubicMeter: 0.3, salinityPartsPerThousand: 35, color: null, roughness: null },
  /** Productive coastal water, rich in phytoplankton: green-blue. */
  coastal: { windSpeedMetersPerSecond: 4, chlorophyllMilligramsPerCubicMeter: 3, salinityPartsPerThousand: 33, color: null, roughness: null },
} as const satisfies Record<string, WaterPresetValues>

export type WaterPreset = keyof typeof WATER_PRESETS
