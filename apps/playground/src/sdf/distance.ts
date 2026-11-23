// Signed distance functions in TSL, in metres, in a shape's local frame (x east, y north, z up).
// Compose them, then hand the result to `SdfShape`. Each function value is a TSL graph builder: create them
// once (module scope), since every distinct function compiles its own pipeline.
import { abs, float, length, max, min, mix, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** A signed distance in metres from a point (metres, local frame): negative inside, positive outside. */
export type DistanceFunction = (point: Node<'vec3'>) => Node<'float'>

type Vector = readonly [number, number, number]

export function sphere(radiusMeters: number): DistanceFunction {
  return point => length(point).sub(radiusMeters)
}

/** A box with rounded edges; `halfSizeMeters` includes the rounding. */
export function roundedBox(halfSizeMeters: Vector, roundingMeters = 0): DistanceFunction {
  const inner = vec3(...halfSizeMeters.map(value => value - roundingMeters) as unknown as Vector)
  return point => {
    const q = abs(point).sub(inner)
    return length(max(q, 0)).add(min(max(q.x, max(q.y, q.z)), 0)).sub(roundingMeters)
  }
}

/** A capsule along z, from -halfLengthMeters to +halfLengthMeters, with this radius. */
export function capsule(radiusMeters: number, halfLengthMeters: number): DistanceFunction {
  return point => {
    const z = point.z.clamp(-halfLengthMeters, halfLengthMeters)
    return length(vec3(point.x, point.y, point.z.sub(z))).sub(radiusMeters)
  }
}

/** A ring in the horizontal plane. */
export function torus(majorRadiusMeters: number, minorRadiusMeters: number): DistanceFunction {
  return point => length(vec2(length(point.xy).sub(majorRadiusMeters), point.z)).sub(minorRadiusMeters)
}

export function translate(shape: DistanceFunction, offsetMeters: Vector): DistanceFunction {
  const offset = vec3(...offsetMeters)
  return point => shape(point.sub(offset))
}

export function union(...shapes: DistanceFunction[]): DistanceFunction {
  return point => shapes.map(shape => shape(point)).reduce((a, b) => min(a, b))
}

/** Union with a smooth blend of `blendMeters` where the shapes meet (polynomial smooth minimum). */
export function smoothUnion(a: DistanceFunction, b: DistanceFunction, blendMeters: number): DistanceFunction {
  return point => {
    const distanceA = a(point)
    const distanceB = b(point)
    const h = float(0.5).add(float(0.5).mul(distanceB.sub(distanceA)).div(blendMeters)).clamp(0, 1)
    return mix(distanceB, distanceA, h).sub(float(blendMeters).mul(h).mul(float(1).sub(h)))
  }
}

/** `shape` with `cut` carved out. */
export function subtract(shape: DistanceFunction, cut: DistanceFunction): DistanceFunction {
  return point => max(shape(point), cut(point).negate())
}
