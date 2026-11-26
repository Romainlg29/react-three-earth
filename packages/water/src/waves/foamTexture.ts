import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three'

/** The foam's bubbly cells across one tile of the foam texture. */
export const FOAM_TEXTURE_CELLS = 16
/** The foam texture's texels a side. */
export const FOAM_TEXTURE_SIZE = 256
/** Lattice cells across a tile for the swirl's first octave: it warps the cells, about 5 cells a feature. */
const SWIRL_PERIOD = 3

/**
 * The foam's pattern as a tiling texture, built once on the CPU so that a fragment reads it in one lookup instead of
 * evaluating cellular and fractal noise (which cost most of the sea's frame on a CPU renderer). Per texel:
 *
 * - red: the density at which foam covers the texel, 0 to 1: low between the bubbles (thinning foam clears their
 *   middles first, into a web, then wisps), high in their middles;
 * - green: smooth noise, 0.5 on average, for the streaks the wind blows the foam into.
 *
 * `FOAM_TEXTURE_CELLS` cells across a tile; every channel tiles seamlessly, and the mipmaps average the pattern away
 * with distance.
 */
export function createFoamTexture(size = FOAM_TEXTURE_SIZE): DataTexture {
  const texture = new DataTexture(createFoamTextureData(size), size, size, RGBAFormat, UnsignedByteType)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  texture.name = 'WaveFoamPattern'
  return texture
}

const foamTextureData = new Map<number, Uint8Array>()

/** The foam texture's texels (RGBA, 8 bits), worked out once per size and shared: about a tenth of a second's work. */
export function createFoamTextureData(size = FOAM_TEXTURE_SIZE): Uint8Array {
  const cached = foamTextureData.get(size)
  if (cached !== undefined) return cached
  const data = new Uint8Array(size * size * 4)
  const points = cellPoints(FOAM_TEXTURE_CELLS, 1)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const u = column / size
      const v = row / size
      const swirl = fractalNoise(u, v, SWIRL_PERIOD, 3, 7)
      // The cells, warped by the swirl (in cells), as the procedural foam was.
      const cells = worley(u * FOAM_TEXTURE_CELLS + swirl * 1.5, v * FOAM_TEXTURE_CELLS + swirl * 1.5, FOAM_TEXTURE_CELLS, points)
      const pattern = (1 - cells) * 0.75 + swirl * 0.2 + 0.1
      const streak = fractalNoise(u, v, 2, 2, 13)
      const offset = (row * size + column) * 4
      data[offset] = toByte(pattern)
      data[offset + 1] = toByte(streak * 0.5 + 0.5)
      data[offset + 2] = 0
      data[offset + 3] = 255
    }
  }
  foamTextureData.set(size, data)
  return data
}

function toByte(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 255)
}

/** A seeded random number from 0 to 1 for integer coordinates (a hash, so the texture is the same everywhere). */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** One feature point per cell of a `cells`-wide grid, within the cell. */
function cellPoints(cells: number, seed: number): Float32Array {
  const points = new Float32Array(cells * cells * 2)
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      points[(y * cells + x) * 2] = x + hash(x, y, seed)
      points[(y * cells + x) * 2 + 1] = y + hash(x, y, seed + 1)
    }
  }
  return points
}

/** The distance to the nearest feature point, in cells, 0 to about 1, wrapping over `cells`. */
function worley(x: number, y: number, cells: number, points: Float32Array): number {
  const cellX = Math.floor(x)
  const cellY = Math.floor(y)
  let nearest = Infinity
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const neighbourX = cellX + dx
      const neighbourY = cellY + dy
      const wrappedX = ((neighbourX % cells) + cells) % cells
      const wrappedY = ((neighbourY % cells) + cells) % cells
      const index = (wrappedY * cells + wrappedX) * 2
      const pointX = points[index]! + (neighbourX - wrappedX)
      const pointY = points[index + 1]! + (neighbourY - wrappedY)
      nearest = Math.min(nearest, Math.hypot(pointX - x, pointY - y))
    }
  }
  return Math.min(nearest, 1)
}

/** Gradient noise on a lattice `period` cells across the tile, wrapping, about -1 to 1. */
function gradientNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period
  const y = v * period
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const corner = (cx: number, cy: number): number => {
    const wx = ((cx % period) + period) % period
    const wy = ((cy % period) + period) % period
    const angle = hash(wx, wy, seed) * 2 * Math.PI
    return Math.cos(angle) * (x - cx) + Math.sin(angle) * (y - cy)
  }
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
  const sx = fade(fx)
  const sy = fade(fy)
  const bottom = corner(x0, y0) + (corner(x0 + 1, y0) - corner(x0, y0)) * sx
  const top = corner(x0, y0 + 1) + (corner(x0 + 1, y0 + 1) - corner(x0, y0 + 1)) * sx
  return (bottom + (top - bottom) * sy) * Math.SQRT2
}

/** `octaves` of gradient noise, each twice the frequency and half the amplitude of the last, about -1 to 1. */
function fractalNoise(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0
  let amplitude = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave++) {
    sum += gradientNoise(u, v, period * 2 ** octave, seed + octave) * amplitude
    total += amplitude
    amplitude /= 2
  }
  return sum / total
}
