// An example plugin for symbol effects: neon labels. Text and SDF icons of the style layers whose metadata says
// `"react-three-earth:symbol-effect": "neon"` draw as a bright core with a coloured outline in place of the halo.
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { Color } from 'three'
import { max, min, mix, smoothstep, uniform, vec4 } from 'three/tsl'

export interface NeonLabelsOptions {
  /** The text's colour (sRGB). Default: '#39ff14'. */
  coreColor?: string
  /** The outline's colour, drawn where the style's halo would be (sRGB). Default: '#ff2bd6'. */
  outlineColor?: string
}

export function neonLabels({ coreColor = '#39ff14', outlineColor = '#ff2bd6' }: NeonLabelsOptions = {}): EarthPlugin & { coreColor: { value: Color }; outlineColor: { value: Color } } {
  // Uniforms: changing a colour needs no new pipeline. Color converts the sRGB string to linear, as the inputs are.
  const core = uniform(new Color(coreColor))
  const outline = uniform(new Color(outlineColor))
  return {
    name: 'neon-labels',
    apiVersion: PLUGIN_API_VERSION,
    coreColor: core,
    outlineColor: outline,
    install(context) {
      context.registerSymbolEffect({
        name: 'neon',
        shade: ({ distance, edge, haloEdge, pixelWidth, fillColor }) => {
          const smoothing = pixelWidth.mul(0.7)
          const inside = smoothstep(edge.sub(smoothing), edge.add(smoothing), distance)
          // The halo's band (text-halo-width), or two pixels of outline when the layer has no halo.
          const outlineEdge = max(min(haloEdge, edge.sub(pixelWidth.mul(2))), 0.05)
          const outlined = smoothstep(outlineEdge.sub(smoothing), outlineEdge.add(smoothing), distance)
          return vec4(mix(outline, core, inside), max(inside, outlined).mul(fillColor.a))
        },
      })
    },
  }
}
