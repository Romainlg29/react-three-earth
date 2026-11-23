// @ts-nocheck -- ported TSL kept close to upstream for easy diffing; strict typing is a follow-up.
// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda),
// storybook-webgpu at b012ad06, itself ported to TSL from 3DTilesRendererJS (Apache-2.0).

// Ported to TSL from: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.14/src/three/plugins/fade/wrapFadeMaterial.js

import { Discard, Fn, If, output, screenCoordinate, uniform } from 'three/tsl'
import type { Node, NodeFrame, NodeMaterial } from 'three/webgpu'

import type { FadeParams } from './FadeMaterialManager.js'

const FADE_PARAMS = Symbol('FADE_PARAMS')

interface FadeParamsHost {
  [FADE_PARAMS]?: FadeParams
  defines?: Record<string, unknown>
}

function getFadeParams({ material }: NodeFrame): FadeParams | undefined {
  return (material as FadeParamsHost)[FADE_PARAMS]
}

const bayerDither2x2 = Fn(([v]) => {
  return v.y.mul(3).add(v.x.mul(2)).mod(4)
}).setLayout({
  name: 'bayerDither2x2',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})

const bayerDither4x4 = Fn(([v]) => {
  const P1 = v.mod(2)
  const P2 = v.mod(4).mul(0.5).floor()
  return bayerDither2x2(P1).mul(4).add(bayerDither2x2(P2))
}).setLayout({
  name: 'bayerDither4x4',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})

const fadeIn = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeIn.value ?? 0
})

const fadeOut = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeOut.value ?? 0
})

const FADE_OUTPUT_BASE = Symbol('FADE_OUTPUT_BASE')

/**
 * The output a material shows when it is not fading, in place of three's own (`output`): set by other
 * wrappers (the flat map's unroll), which the fade then dithers instead of replacing.
 */
export function setBaseOutputNode(material: NodeMaterial, node: Node): void {
  ;(material as { [FADE_OUTPUT_BASE]?: Node })[FADE_OUTPUT_BASE] = node
  const fading = (material as FadeParamsHost).defines?.FEATURE_FADE === 1
  material.outputNode = fading ? getFadeOutputNode(node) : node
  material.needsUpdate = true
}

const fadeOutputs = new Map<Node | null, Node>()
function getFadeOutputNode(base: Node | null): Node {
  let node = fadeOutputs.get(base)
  if (node === undefined) {
    node = createFadeOutputNode(base)
    fadeOutputs.set(base, node)
  }
  return node
}

const createFadeOutputNode = (base: Node | null) => Fn(() => {
  const bayerValue = bayerDither4x4(screenCoordinate.xy.mod(4).floor())
  const bayerBins = 16
  const dither = bayerValue.add(0.5).div(bayerBins)

  If(dither.greaterThanEqual(fadeIn), () => {
    Discard()
  })
  If(dither.lessThan(fadeOut), () => {
    Discard()
  })
  return base ?? output
})()

export function wrapFadeNodeMaterial(
  material: NodeMaterial & FadeParamsHost
): FadeParams {
  if (material[FADE_PARAMS] != null) {
    return material[FADE_PARAMS]
  }

  const params: FadeParams = {
    fadeIn: { value: 0 },
    fadeOut: { value: 0 },
    fadeTexture: { value: null }
  }
  material[FADE_PARAMS] = params

  let featureFade = 0

  // Use the same interface used for non-node materials:
  // Copies the descriptors, not the values, so the overlay wrapper's accessor survives whichever wraps first
  // (see wrapOverlaysNodeMaterial).
  material.defines = Object.defineProperties({}, Object.getOwnPropertyDescriptors(material.defines ?? {}))
  Object.defineProperty(material.defines, 'FEATURE_FADE', {
    configurable: true,
    enumerable: true,
    get() {
      return featureFade
    },
    set(value: number) {
      if (value !== featureFade) {
        featureFade = value
        const base = (material as { [FADE_OUTPUT_BASE]?: Node })[FADE_OUTPUT_BASE] ?? null
        material.outputNode = value === 1 ? getFadeOutputNode(base) : base
      }
    },
  })

  return params
}
