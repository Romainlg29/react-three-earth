// An example plugin for render passes: a vignette in the `display` stage (tone-mapped colour, before FXAA)
// and a soft glow of bright pixels in the `radiance` stage (linear HDR, after the atmosphere).
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { max, screenUV, smoothstep, uniform, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

export interface VignetteOptions {
  /** How dark the corners get: 0 leaves them, 1 makes them black. Default: 0.6. */
  strength?: number
}

export function vignette({ strength = 0.6 }: VignetteOptions = {}): EarthPlugin & { strength: { value: number } } {
  // A uniform: changing it needs no rebuild of the pipeline.
  const strengthUniform = uniform(strength)
  return {
    name: 'vignette',
    apiVersion: PLUGIN_API_VERSION,
    strength: strengthUniform,
    install(context) {
      context.registerRenderPass({
        name: 'vignette',
        stage: 'display',
        build: ({ color }) => {
          const distance = screenUV.sub(0.5).length().mul(Math.SQRT2) // 0 at the centre, 1 in the corners
          const darkening = smoothstep(0.35, 1, distance).mul(strengthUniform).oneMinus()
          return vec4(color.rgb.mul(darkening), color.a)
        },
      })
      // A cheap highlight lift: pixels brighter than 1 (linear) spill a little extra light. Pure nodes, fused.
      context.registerRenderPass({
        name: 'highlight-lift',
        stage: 'radiance',
        build: ({ color }) => {
          const excess = max(color.rgb.sub(vec3(1)), vec3(0)) as Node<'vec3'>
          return vec4(color.rgb.add(excess.mul(0.25)), color.a)
        },
      })
    },
  }
}
