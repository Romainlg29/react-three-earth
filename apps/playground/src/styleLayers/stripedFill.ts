// An example plugin for the material tier of custom style layer types: `striped-fill` reuses the built-in fill
// tessellation and only brings a shader, diagonal stripes of two colours, a fixed number of pixels wide.
import { PLUGIN_API_VERSION, type EarthPlugin } from 'react-three-earth'
import { fract, mix, step } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export function stripedFill(): EarthPlugin {
  return {
    name: 'striped-fill',
    apiVersion: PLUGIN_API_VERSION,
    install(context) {
      context.registerStyleLayerType({
        type: 'striped-fill',
        geometry: 'fill',
        paint: {
          'striped-fill-color': { type: 'color', default: '#3b82f6' },
          'striped-fill-stripe-color': { type: 'color', default: '#ffffff' },
          'striped-fill-stripe-width-pixels': { type: 'number', default: 6, dataDriven: false, minimum: 1 },
        },
        createMaterial: ({ paint, tile }) => {
          // Pixels along the diagonal, so the stripes keep their width at every zoom.
          const pixels = tile.position.x.add(tile.position.y).mul(tile.pixelsPerTileUnit)
          const stripe = step(0.5, fract(pixels.div(paint.number('striped-fill-stripe-width-pixels').mul(2))))
          const material = new MeshBasicNodeMaterial()
          material.colorNode = mix(paint.color('striped-fill-color'), paint.color('striped-fill-stripe-color'), stripe)
          return material
        },
      })
    },
  }
}
