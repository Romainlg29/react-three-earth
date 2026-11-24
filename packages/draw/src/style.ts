import { Color } from 'three'

import type { DrawFeature, DrawStyle, DrawStyleInput, DrawStyleState } from './types.js'

export const DEFAULT_DRAW_STYLE: Readonly<DrawStyle> = {
  fillColor: '#3b82f6',
  fillOpacity: 0.25,
  lineColor: '#3b82f6',
  lineOpacity: 1,
  lineWidthPixels: 3,
  pointColor: '#3b82f6',
  pointRadiusPixels: 6,
  pointOutlineColor: '#ffffff',
  pointOutlineWidthPixels: 2,
  solidOpacity: 0.85,
  vertexColor: '#ffffff',
  vertexRadiusPixels: 5,
  vertexOutlineColor: '#3b82f6',
  vertexOutlineWidthPixels: 2,
}

/** The full style of a feature: the input's values over the defaults. */
export function resolveStyle(input: DrawStyleInput | undefined, feature: DrawFeature, state: DrawStyleState): DrawStyle {
  if (input === undefined) return DEFAULT_DRAW_STYLE
  const values = typeof input === 'function' ? input(feature, state) : input
  return { ...DEFAULT_DRAW_STYLE, ...values }
}

const colors = new Map<string, readonly [number, number, number]>()
const scratch = new Color()

/** A CSS colour in the renderer's linear working space, cached. */
export function linearColor(css: string): readonly [number, number, number] {
  let color = colors.get(css)
  if (color === undefined) {
    scratch.set(css)
    color = [scratch.r, scratch.g, scratch.b]
    if (colors.size > 256) colors.clear()
    colors.set(css, color)
  }
  return color
}
