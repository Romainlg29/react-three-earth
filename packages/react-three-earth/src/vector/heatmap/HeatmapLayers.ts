// The `heatmap` layer type, main-thread side: a layer type definition drawn by the custom layer path (an additive
// offscreen layer, like a plugin's), plus what makes it per layer: the intensity of each draw, and the colour ramp
// and opacity of each composite. One per `MapStyleOverlay`.
import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, type Object3D } from 'three'
import { attribute, clamp, dot, exp, float, max, sRGBTransferEOTF, texture, uniform, vec2, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import type { StyleLayerTypeDefinition } from '../../plugins/styleLayerTypes.js'
import type { HeatmapLayerSummary } from '../worker/types.js'
import { HEATMAP_COLOR_RAMP_SIZE, HEATMAP_GAUSS_COEFFICIENT, HEATMAP_MAXIMUM_REACH_PIXELS } from './heatmapKernel.js'
import { HEATMAP_LAYER_TYPE } from './heatmapWorker.js'

/** What a heatmap draw or composite reads from its object. */
interface HeatmapDrawValues {
  intensity: number
  /** The layer's row in the colour ramp atlas. */
  rampRow: number
  opacity: number
}

function drawValues(object: Object3D | null | undefined): HeatmapDrawValues {
  return (object?.userData.heatmap as HeatmapDrawValues | undefined) ?? { intensity: 1, rampRow: 0, opacity: 1 }
}

/** The heatmap layers of one map style overlay: the layer type's definition and its per-layer values. */
export class HeatmapLayers {
  readonly definition: StyleLayerTypeDefinition
  /** Every layer's colour ramp, one row each (256 densities across). */
  protected rampAtlas = createRampAtlas(1)
  protected readonly rampNode = texture(this.rampAtlas)
  protected readonly rampRows = uniform(1)
  protected layers: readonly HeatmapLayerSummary[] = []
  protected readonly rows = new Map<string, number>()

  constructor() {
    const rampNode = this.rampNode
    const rampRows = this.rampRows
    this.definition = {
      type: HEATMAP_LAYER_TYPE,
      worker: { moduleUrl: 'built-in:heatmap', exportName: 'heatmap' },
      maximumReachPixels: HEATMAP_MAXIMUM_REACH_PIXELS,
      offscreen: {
        blending: 'additive',
        composite: ({ layer }) => {
          const density = clamp(layer.r, 0, 1)
          const row = uniform(0).onObjectUpdate(({ object }) => drawValues(object).rampRow)
          const opacity = uniform(1).onObjectUpdate(({ object }) => drawValues(object).opacity)
          // Texel centres: density 0 at the first, 1 at the last.
          const u = density.mul((HEATMAP_COLOR_RAMP_SIZE - 1) / HEATMAP_COLOR_RAMP_SIZE).add(0.5 / HEATMAP_COLOR_RAMP_SIZE)
          const color = rampNode.sample(vec2(u, row.add(0.5).div(rampRows))) as unknown as Node<'vec4'>
          const straight = color.rgb.div(max(color.a, float(1e-4)))
          return vec4(sRGBTransferEOTF(straight) as unknown as Node<'vec3'>, color.a.mul(opacity)) as unknown as Node<'vec4'>
        },
      },
      // MapLibre's kernel: weight × intensity × a Gaussian of the distance in radii, summed by additive blending.
      createMaterial: ({ tile }) => {
        const center = attribute<'vec2'>('heatmapCenter', 'vec2')
        const weight = attribute<'float'>('heatmapWeight', 'float')
        const radiusPixels = attribute<'float'>('heatmapRadius', 'float')
        const intensity = uniform(1).onObjectUpdate(({ object }) => drawValues(object).intensity)
        const offset = tile.position.sub(center).mul(tile.pixelsPerTileUnit).div(radiusPixels)
        const density = weight.mul(intensity).mul(HEATMAP_GAUSS_COEFFICIENT).mul(exp(dot(offset, offset).mul(-4.5)))
        const material = new MeshBasicNodeMaterial()
        material.colorNode = vec4(density, 0, 0, 1)
        return material
      },
    }
  }

  /** Takes the layers of a new style summary (a no-op when they did not change). */
  setLayers(layers: readonly HeatmapLayerSummary[] | undefined): void {
    layers ??= []
    if (layers === this.layers) return
    const sameRamps = sameColorRamps(layers, this.layers)
    this.layers = layers
    this.rows.clear()
    layers.forEach((layer, row) => this.rows.set(layer.id, row))
    // Every summary from the worker is a new copy: keep the atlas unless a ramp changed.
    if (sameRamps) return
    const atlas = createRampAtlas(Math.max(layers.length, 1))
    layers.forEach((layer, row) => atlas.image.data!.set(layer.colorRamp, row * HEATMAP_COLOR_RAMP_SIZE * 4))
    atlas.needsUpdate = true
    this.rampAtlas.dispose()
    this.rampAtlas = atlas
    this.rampNode.value = atlas
    this.rampRows.value = atlas.image.height
  }

  /** Sets the per-draw values of a placed heatmap mesh of `layerId` drawn at `zoom`. */
  prepareDraw(object: Object3D, layerId: string, zoom: number): void {
    object.userData.heatmap = this.valuesAt(layerId, zoom)
  }

  /** Points the composite at `layerId`'s ramp and opacity at `zoom`. */
  prepareComposite(object: Object3D, layerId: string, zoom: number): void {
    object.userData.heatmap = this.valuesAt(layerId, zoom)
  }

  /** How far the heatmap layers reach past their points at `zoom`, in pixels. */
  reachPixelsAt(zoom: number): number {
    let reach = 0
    for (const layer of this.layers) reach = Math.max(reach, atZoom(layer.reachPixelsByZoom, zoom, 0))
    return reach
  }

  dispose(): void {
    this.rampAtlas.dispose()
  }

  protected valuesAt(layerId: string, zoom: number): HeatmapDrawValues {
    const row = this.rows.get(layerId)
    const layer = row === undefined ? undefined : this.layers[row]
    if (layer === undefined) return { intensity: 0, rampRow: 0, opacity: 0 }
    return { intensity: atZoom(layer.intensityByZoom, zoom, 1), rampRow: row!, opacity: atZoom(layer.opacityByZoom, zoom, 1) }
  }
}

function sameColorRamps(a: readonly HeatmapLayerSummary[], b: readonly HeatmapLayerSummary[]): boolean {
  if (a.length !== b.length) return false
  return a.every((layer, index) => {
    const other = b[index]!
    if (layer.id !== other.id || layer.colorRamp.length !== other.colorRamp.length) return false
    for (let byte = 0; byte < layer.colorRamp.length; byte++) if (layer.colorRamp[byte] !== other.colorRamp[byte]) return false
    return true
  })
}

function atZoom(values: readonly number[], zoom: number, fallback: number): number {
  return values[Math.min(Math.max(Math.round(zoom), 0), values.length - 1)] ?? fallback
}

function createRampAtlas(rows: number): DataTexture {
  const atlas = new DataTexture(new Uint8Array(HEATMAP_COLOR_RAMP_SIZE * rows * 4), HEATMAP_COLOR_RAMP_SIZE, rows, RGBAFormat, UnsignedByteType)
  atlas.minFilter = LinearFilter
  atlas.magFilter = LinearFilter
  atlas.generateMipmaps = false
  atlas.name = 'HeatmapColorRamps'
  atlas.needsUpdate = true
  return atlas
}
