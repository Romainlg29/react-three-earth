// @ts-nocheck -- ported TSL kept close to upstream for easy diffing; strict typing is a follow-up.
// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda),
// storybook-webgpu at b012ad06, itself ported to TSL from 3DTilesRendererJS (Apache-2.0).

// Ported to TSL from: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.14/src/three/plugins/fade/wrapFadeMaterial.js

import { Discard, Fn, If, output, screenCoordinate, uniform } from 'three/tsl'
import type { NodeFrame, NodeMaterial } from 'three/webgpu'

import { geospatial } from '../compat/takram.js'

const { FnLayout } = geospatial

import type { FadeParams } from './FadeMaterialManager.js'

const FADE_PARAMS = Symbol('FADE_PARAMS')

interface FadeParamsHost {
  [FADE_PARAMS]?: FadeParams
  defines?: Record<string, unknown>
}

function getFadeParams({ material }: NodeFrame): FadeParams | undefined {
  return (material as FadeParamsHost)[FADE_PARAMS]
}

const bayerDither2x2 = FnLayout({
  name: 'bayerDither2x2',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})(([v]) => {
  return v.y.mul(3).add(v.x.mul(2)).mod(4)
})

const bayerDither4x4 = FnLayout({
  name: 'bayerDither4x4',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})(([v]) => {
  const P1 = v.mod(2)
  const P2 = v.mod(4).mul(0.5).floor()
  return bayerDither2x2(P1).mul(4).add(bayerDither2x2(P2))
})

const fadeIn = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeIn.value ?? 0
})

const fadeOut = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeOut.value ?? 0
})

const outputNode = Fn(() => {
  const bayerValue = bayerDither4x4(screenCoordinate.xy.mod(4).floor())
  const bayerBins = 16
  const dither = bayerValue.add(0.5).div(bayerBins)

  If(dither.greaterThanEqual(fadeIn), () => {
    Discard()
  })
  If(dither.lessThan(fadeOut), () => {
    Discard()
  })
  return output
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
  material.defines = {
    ...material.defines,

    get FEATURE_FADE() {
      return featureFade
    },

    set FEATURE_FADE(value: number) {
      if (value !== featureFade) {
        featureFade = value
        material.outputNode = value === 1 ? outputNode : null
      }
    }
  }

  return params
}
