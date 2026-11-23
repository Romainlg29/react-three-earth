import { describe, expect, it } from 'vitest'

import { squareToQuad, unwrapCorners, validateCorners, type GeoreferencedCorners } from '../src/tiles/imagery/GeoreferencedImageOverlay.js'

/** Applies the row-major projective matrix to a unit-square point. */
function apply(matrix: number[], u: number, v: number): [number, number] {
  const [a, b, c, d, e, f, g, h] = matrix as [number, number, number, number, number, number, number, number]
  const w = g * u + h * v + 1
  return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]
}

describe('squareToQuad', () => {
  it('maps the unit square corners onto the quad corners', () => {
    const quad = [
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.1 },
      { x: 0.8, y: 0.7 },
      { x: 0.2, y: 0.9 },
    ]
    const matrix = squareToQuad(quad)!
    for (const [index, [u, v]] of [[0, 0], [1, 0], [1, 1], [0, 1]].entries()) {
      const [x, y] = apply(matrix, u!, v!)
      expect(x).toBeCloseTo(quad[index]!.x, 12)
      expect(y).toBeCloseTo(quad[index]!.y, 12)
    }
  })

  it('is affine for a parallelogram', () => {
    const matrix = squareToQuad([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 1 }, { x: 1, y: 1 }])!
    expect(matrix[6]).toBe(0)
    expect(matrix[7]).toBe(0)
    expect(apply(matrix, 0.5, 0.5)[0]).toBeCloseTo(1.5, 12)
  })

  it('rejects a collapsed quad', () => {
    expect(squareToQuad([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }])).toBeNull()
  })
})

describe('corners', () => {
  const corners: GeoreferencedCorners = [[-1, 1], [1, 1], [1, -1], [-1, -1]]

  it('accepts four finite corners', () => {
    expect(() => validateCorners(corners, 'ImageSource')).not.toThrow()
  })

  it('states the fix for anything else', () => {
    expect(() => validateCorners([[0, 0]], 'ImageSource')).toThrow(/four \[longitudeDegrees, latitudeDegrees\] corners/)
    expect(() => validateCorners([[0, 0], [1, 0], [1, 1], [0, 95]], 'VideoSource')).toThrow(/VideoSource/)
    expect(() => validateCorners([[0, 0], [1, 0], [1, Number.NaN], [0, 1]], 'ImageSource')).toThrow()
  })

  it('bounds a picture inside the world', () => {
    const { bounds } = unwrapCorners(corners)
    expect(bounds).toEqual({ westDegrees: -1, southDegrees: -1, eastDegrees: 1, northDegrees: 1 })
  })

  it('makes longitudes continuous across the antimeridian, with west greater than east', () => {
    const { longitudes, bounds } = unwrapCorners([[179, 1], [-179, 1], [-179, -1], [179, -1]])
    expect(longitudes).toEqual([179, 181, 181, 179])
    expect(bounds.westDegrees).toBe(179)
    expect(bounds.eastDegrees).toBe(-179)
    expect(bounds.westDegrees).toBeGreaterThan(bounds.eastDegrees)
  })
})

describe('convexity', () => {
  it('rejects crossing or folded corners with the fix', () => {
    expect(() => validateCorners([[0, 1], [1, -1], [1, 1], [0, -1]], 'ImageSource')).toThrow(/convex/)
    expect(() => validateCorners([[0, 1], [2, 1], [1, 0.5], [0, -1]], 'ImageSource')).toThrow(/convex/)
  })
})
