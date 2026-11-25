// An example plugin for the geometry tier of custom style layer types: `sdf-glow`, a soft halo around lines and
// points, exact at any region resolution. The worker module (sdfGlowWorker.js) emits one quad per segment; the
// material computes the distance to the segment (the capsule SDF). Quads draw into an offscreen target with
// maximum blending, so joins and overlaps never double up, and the target is composited once per region.
import { PLUGIN_API_VERSION, type EarthPlugin } from '@earthkit/globe'
import { attribute, clamp, dot, float, length, max, smoothstep, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export interface SdfGlowOptions {
  /** The plugin's worker module. Default: sdfGlowWorker.js next to this file. */
  workerModuleUrl?: URL | string
}

export function sdfGlow({ workerModuleUrl = new URL('./sdfGlowWorker.js', import.meta.url) }: SdfGlowOptions = {}): EarthPlugin {
  return {
    name: 'sdf-glow',
    apiVersion: PLUGIN_API_VERSION,
    install(context) {
      context.registerStyleLayerType({
        type: 'sdf-glow',
        paint: {
          'sdf-glow-color': { type: 'color', default: '#ffffff' },
          'sdf-glow-radius-pixels': { type: 'number', default: 12, minimum: 0 },
          'sdf-glow-intensity': { type: 'number', default: 1, minimum: 0, maximum: 1 },
        },
        worker: { moduleUrl: workerModuleUrl, exportName: 'sdfGlow' },
        maximumReachPixels: 64,
        // Overlaps keep the strongest glow (alpha = strength).
        offscreen: { blending: 'maximum' },
        createMaterial: ({ paint, tile }) => {
          const start = attribute<'vec2'>('segmentStart', 'vec2')
          const along = attribute<'vec2'>('segmentEnd', 'vec2').sub(start)
          const offset = tile.position.sub(start)
          const t = clamp(dot(offset, along).div(max(dot(along, along), 1e-6)), 0, 1)
          const distancePixels = length(offset.sub(along.mul(t))).mul(tile.pixelsPerTileUnit)
          const radiusPixels = max(paint.number('sdf-glow-radius-pixels'), 1e-3)
          const strength = float(1).sub(smoothstep(0, radiusPixels, distancePixels)).mul(paint.number('sdf-glow-intensity'))
          const color = paint.color('sdf-glow-color')
          const material = new MeshBasicNodeMaterial()
          material.colorNode = vec4(color.rgb, strength.mul(color.a))
          return material
        },
      })
    },
  }
}
