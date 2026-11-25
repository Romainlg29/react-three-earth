import { encodePng } from './png.ts'
import { fixtureHeightMeters, fixtureWaterHeightMeters } from './quantizedMesh.ts'

/**
 * The fixture terrain's heights with round hills every 0.1° (about 11 km) on top: the terrain alone is too smooth for
 * hillshade to show at map scales.
 */
export function demHeightMeters(longitudeDegrees: number, latitudeDegrees: number): number {
  // Round hills 0.08° wide, centred on multiples of 0.1°.
  const dx = longitudeDegrees - Math.round(longitudeDegrees / 0.1) * 0.1
  const dy = latitudeDegrees - Math.round(latitudeDegrees / 0.1) * 0.1
  const distance = Math.hypot(dx, dy)
  const hill = distance < 0.04 ? Math.cos((Math.PI * distance) / 0.08) ** 2 : 0
  return fixtureHeightMeters(longitudeDegrees, latitudeDegrees) + 1200 * hill
}

/**
 * A Terrarium-encoded elevation tile (256 pixels, Web Mercator XYZ) of `demHeightMeters` (`fixtureHeightMeters`, the
 * quantized-mesh terrain's, without `hills`; `fixtureWaterHeightMeters` with `water`), sampled at pixel centres: `height + 32768 = R × 256 + G + B / 256`.
 */
export function terrariumTile(z: number, x: number, y: number, { hills = true, water = false }: { hills?: boolean; water?: boolean } = {}): Uint8Array {
  const height = water ? fixtureWaterHeightMeters : hills ? demHeightMeters : fixtureHeightMeters
  const size = 256
  return encodePng(size, size, (px, py) => {
    const longitude = ((x + (px + 0.5) / size) / 2 ** z) * 360 - 180
    const n = Math.PI - (2 * Math.PI * (y + (py + 0.5) / size)) / 2 ** z
    const latitude = (180 / Math.PI) * Math.atan(Math.sinh(n))
    const value = height(longitude, latitude) + 32768
    const red = Math.floor(value / 256)
    const green = Math.floor(value) % 256
    const blue = Math.floor((value - Math.floor(value)) * 256)
    return [red, green, blue]
  })
}
