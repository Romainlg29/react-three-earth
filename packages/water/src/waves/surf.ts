import { float, max, pow, sqrt, tanh } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { GRAVITY_METERS_PER_SECOND_SQUARED } from './spectrum.js'

/** The surf's height in open water off the coast, as a share of the wind sea's significant wave height. */
export const SURF_HEIGHT_SHARE = 0.6
/** The shortest and longest surf period, seconds: the wind sea's peak period clamped to them. */
export const SURF_MINIMUM_PERIOD_SECONDS = 4
export const SURF_MAXIMUM_PERIOD_SECONDS = 16
/**
 * The seafloor's slope away from the shore where the terrain gives no depth (1 in 33, a sandy beach's): the depth the
 * surf shoals and breaks over is then the distance to the shore times it.
 */
export const SURF_BEACH_SLOPE = 0.03
/** The shallowest depth the surf's sums take, metres: the swash's, where the formulas run to infinity. */
const SHALLOWEST_METERS = 0.2

/** Deep water's wavenumber for waves of a period, rad/m: `ω² / g`. */
export function deepWavenumber(periodSeconds: number): number {
  return (2 * Math.PI / periodSeconds) ** 2 / GRAVITY_METERS_PER_SECOND_SQUARED
}

/**
 * The wavenumber of waves of deep-water wavenumber `deep` in water `depthMeters` deep, rad/m: Eckart's (1952) explicit
 * approximation of the dispersion relation, `k0 / √tanh(k0 h)`, within 5 %. Shallower water, shorter waves.
 */
export function shallowWavenumber(deep: number, depthMeters: number): number {
  return deep / Math.sqrt(Math.tanh(deep * Math.max(depthMeters, SHALLOWEST_METERS)))
}

/**
 * How much taller waves stand at `kh` (wavenumber times depth) than in deep water, from their energy flux (Green's law in
 * the shallows): about 0.91 at its least (kh ≈ 1.3), then growing as the water shallows.
 */
export function shoalingCoefficient(kh: number): number {
  const clamped = Math.min(Math.max(kh, 0.01), 10)
  const t = Math.tanh(clamped)
  return 1 / Math.sqrt(t * (1 + (2 * clamped) / Math.sinh(2 * clamped)))
}

/**
 * The surf's phase from the shore, `∫ k dx`, over a seafloor sloping at `slope` from the shore, for waves of deep-water
 * wavenumber `deep`, `distanceMeters` from it, radians. With `u = k0 s x`, `∫ k dx = F(u) / s` and
 * `F(u) = ∫ du / √tanh(u)`, approximated within 2 % as `u + 2√u / (1 + (1.55 √u)^1.75)^(1/1.75)` (2√u in the shallows,
 * u + 1.3 in deep water). Its rate of change along the distance is the local wavenumber: the waves shorten as they
 * near the shore and their crests never bunch or pull apart.
 */
export function surfPhase(deep: number, distanceMeters: number, slope = SURF_BEACH_SLOPE): number {
  const u = Math.max(deep * slope * distanceMeters, 0)
  const root = Math.sqrt(u)
  return (u + (2 * root) / (1 + (1.55 * root) ** 1.75) ** (1 / 1.75)) / slope
}

/** `shallowWavenumber` on the GPU. */
export function shallowWavenumberNode(deep: Node<'float'>, depthMeters: Node<'float'>): Node<'float'> {
  // Bounded: tanh(10) is 1 to a float, and past it some GPUs' tanh overflows to NaN (e^x over e^x).
  return deep.div(sqrt(tanh(deep.mul(max(depthMeters, SHALLOWEST_METERS)).min(10)))) as unknown as Node<'float'>
}

/** `shoalingCoefficient` on the GPU. */
export function shoalingCoefficientNode(kh: Node<'float'>): Node<'float'> {
  const clamped = kh.clamp(0.01, 10)
  // sinh(2x) = (e^2x − e^−2x) / 2, bounded at 10: no overflow in half the range of a float.
  const twice = clamped.mul(2)
  const sinh = twice.exp().sub(twice.negate().exp()).mul(0.5)
  return float(1).div(sqrt(tanh(clamped).mul(float(1).add(twice.div(sinh))))) as unknown as Node<'float'>
}

/** `surfPhase` on the GPU, with the slope `SURF_BEACH_SLOPE`. */
export function surfPhaseNode(deep: Node<'float'>, distanceMeters: Node<'float'>): Node<'float'> {
  const u = max(deep.mul(distanceMeters).mul(SURF_BEACH_SLOPE), 0)
  const root = sqrt(u)
  const shallows = root.mul(2).div(pow(float(1).add(pow(root.mul(1.55).max(1e-6), 1.75)), 1 / 1.75))
  return u.add(shallows).div(SURF_BEACH_SLOPE) as unknown as Node<'float'>
}

