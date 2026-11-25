import { terrainAspectRadians, terrainElevationMeters, terrainSlopeDegrees } from '@earthkit/globe'
import { color, cos, float, mix, smoothstep } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

// Built once at module level: every terrain tile shares the nodes, so the shader compiles once.

/** Lowland green through dry grass and bare earth, by elevation. */
const lowland = mix(color('#4f7f45'), color('#9fb46a'), smoothstep(0, 1200, terrainElevationMeters))
const upland = mix(lowland, color('#c4ad7e'), smoothstep(1200, 2400, terrainElevationMeters))
/** Bare rock where the ground is steeper than about 30°. */
const rocky = mix(upland, color('#8a8580'), smoothstep(28, 38, terrainSlopeDegrees))
/** Snow above about 3000 m, except on cliffs too steep to hold it. */
const snowCover = smoothstep(2800, 3200, terrainElevationMeters).mul(float(1).sub(smoothstep(40, 50, terrainSlopeDegrees)))
const snowy = mix(rocky, color('#f4f6fa'), snowCover)
/** North faces a little cooler and darker than south faces, more so the steeper they are (aspect 0 is north). */
const northness = cos(terrainAspectRadians).mul(smoothstep(0, 30, terrainSlopeDegrees))
const stylizedColor = snowy.mul(float(1).sub(northness.mul(0.12)))

/**
 * A terrain material coloured by elevation, slope and aspect: a stylised look for a globe with no imagery. Imagery
 * layers, when there are some, blend over it.
 */
export const createStylizedTerrainMaterial = () => {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.colorNode = stylizedColor
  return material
}
