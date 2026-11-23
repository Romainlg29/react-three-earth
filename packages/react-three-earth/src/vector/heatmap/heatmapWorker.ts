// The `heatmap` layer type, worker side. It runs through the same path as a plugin's geometry tier: a
// `WorkerLayerType` that turns each tile's points into kernel quads, drawn by the main thread into an additive
// offscreen target and coloured by `heatmap-color` when composited. Only the property specifications differ:
// they are the style specification's own, so `heatmap-density` and validation work as in MapLibre.
import { latest, type Color } from '@maplibre/maplibre-gl-style-spec'

import type { WorkerLayerType, WorkerLayerTypeHost, WorkerPoint } from '../../plugins/pluginWorker.js'
import type { WorkerLayerTypeDescriptor } from '../../plugins/styleLayerTypes.js'
import type { CompiledStyleLayer } from '../worker/styleLayers.js'
import type { HeatmapLayerSummary } from '../worker/types.js'
import { HEATMAP_COLOR_RAMP_SIZE, HEATMAP_MAXIMUM_REACH_PIXELS, heatmapExtentRadii } from './heatmapKernel.js'

export const HEATMAP_LAYER_TYPE = 'heatmap'

/** The descriptor the built-in type has in the worker (never posted: the worker always has it). */
export const HEATMAP_DESCRIPTOR: WorkerLayerTypeDescriptor = {
  type: HEATMAP_LAYER_TYPE,
  paint: {},
  layout: {},
  geometry: null,
  module: null,
  maximumReachPixels: HEATMAP_MAXIMUM_REACH_PIXELS,
  revision: 0,
}

const specification = latest as unknown as Record<string, Record<string, never>>

/** The style specification's heatmap properties. */
export const HEATMAP_SPECIFICATIONS = {
  paint: specification.paint_heatmap ?? {},
  layout: specification.layout_heatmap ?? {},
}

/**
 * Per point (every vertex of the feature's geometry, as MapLibre's circle buckets read it): one quad as wide as the
 * kernel reaches, carrying the point, its weight and its radius in pixels. Points in the tile's buffer are left to
 * the neighbouring tile that owns them: densities add up, so a point drawn by two tiles would count twice.
 */
export function createHeatmapWorkerLayerType(host: WorkerLayerTypeHost): WorkerLayerType {
  return {
    createTileBuilder({ layer, zoom, unitsPerPixel }) {
      // The quad's size needs the intensity; the shader multiplies by the intensity at the drawn zoom.
      const intensity = Math.max(layer.evaluate<number>('paint', 'heatmap-intensity', zoom), 0)
      const positions: number[] = []
      const centers: number[] = []
      const weights: number[] = []
      const radii: number[] = []
      const addPoint = (point: WorkerPoint, weight: number, radiusPixels: number, halfSize: number) => {
        for (const [dx, dy] of CORNERS) {
          positions.push(point.x + dx * halfSize, point.y + dy * halfSize)
          centers.push(point.x, point.y)
          weights.push(weight)
          radii.push(radiusPixels)
        }
      }
      return {
        addFeature(feature, geometry) {
          const weight = layer.evaluate<number>('paint', 'heatmap-weight', zoom, feature)
          const radiusPixels = layer.evaluate<number>('paint', 'heatmap-radius', zoom, feature)
          if (!(weight > 0) || !(radiusPixels > 0)) return
          const extentPixels = host.clampReach(radiusPixels * heatmapExtentRadii(weight * intensity))
          if (!(extentPixels > 0)) return
          const halfSize = extentPixels * unitsPerPixel
          for (const ring of geometry) for (const point of ring) if (host.isInsideTile(point)) addPoint(point, weight, radiusPixels, halfSize)
        },
        finish() {
          const quads = positions.length / 8
          if (quads === 0) return null
          const indices = quads * 4 > 65_535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6)
          for (let quad = 0; quad < quads; quad++) indices.set([0, 1, 2, 0, 2, 3].map(corner => quad * 4 + corner), quad * 6)
          return {
            attributes: {
              position: { array: Float32Array.from(positions), itemSize: 2 },
              heatmapCenter: { array: Float32Array.from(centers), itemSize: 2 },
              heatmapWeight: { array: Float32Array.from(weights), itemSize: 1 },
              heatmapRadius: { array: Float32Array.from(radii), itemSize: 1 },
            },
            indices,
          }
        },
      }
    },
  }
}

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const

/**
 * What the main thread needs of a heatmap layer to colour it: its `heatmap-color` ramp (premultiplied RGBA bytes,
 * sRGB, densities 0 to 1), and its zoom-only paint per integer zoom.
 */
export function summarizeHeatmapLayer(layer: CompiledStyleLayer, maximumZoom: number): HeatmapLayerSummary {
  const colorRamp = new Uint8Array(HEATMAP_COLOR_RAMP_SIZE * 4)
  const byte = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 255)
  for (let index = 0; index < HEATMAP_COLOR_RAMP_SIZE; index++) {
    // The style specification's colours are premultiplied already.
    const color = layer.evaluateWithGlobals<Color | undefined>('paint', 'heatmap-color', { zoom: 0, heatmapDensity: index / (HEATMAP_COLOR_RAMP_SIZE - 1) })
    if (color !== undefined) colorRamp.set([byte(color.r), byte(color.g), byte(color.b), byte(color.a)], index * 4)
  }
  const zooms = Array.from({ length: maximumZoom + 1 }, (_, zoom) => zoom)
  // A radius or weight read from the features could be anything: those layers reach as far as the region ring.
  const featureDependent = layer.isFeatureDependent('paint', 'heatmap-radius') || layer.isFeatureDependent('paint', 'heatmap-weight')
  const reachAt = (zoom: number) => {
    if (featureDependent) return HEATMAP_MAXIMUM_REACH_PIXELS
    const weightTimesIntensity = layer.evaluate<number>('paint', 'heatmap-weight', zoom) * Math.max(layer.evaluate<number>('paint', 'heatmap-intensity', zoom), 0)
    return Math.min(layer.evaluate<number>('paint', 'heatmap-radius', zoom) * heatmapExtentRadii(weightTimesIntensity), HEATMAP_MAXIMUM_REACH_PIXELS)
  }
  return {
    id: layer.id,
    colorRamp,
    opacityByZoom: zooms.map(zoom => layer.evaluate<number>('paint', 'heatmap-opacity', zoom)),
    intensityByZoom: zooms.map(zoom => layer.evaluate<number>('paint', 'heatmap-intensity', zoom)),
    reachPixelsByZoom: zooms.map(reachAt),
  }
}
