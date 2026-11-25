// @ts-check
// The `sdf-glow` worker module: loaded by the vector tile worker with import(), so it is plain, self-contained
// JavaScript (no imports at run time). For each line segment it emits one quad, the segment's rectangle widened
// by the glow radius, carrying both endpoints; the material computes the exact distance to the segment.

/** @typedef {import('@earthkit/globe/plugin-worker').WorkerLayerTypeFactory} WorkerLayerTypeFactory */

/** @type {WorkerLayerTypeFactory} */
export const sdfGlow = host => ({
  createTileBuilder({ layer, zoom, unitsPerPixel }) {
    /** @type {number[]} */ const positions = []
    /** @type {number[]} */ const starts = []
    /** @type {number[]} */ const ends = []
    /** @type {number[]} */ const colors = []
    /** @type {number[]} */ const radii = []
    /** @type {number[]} */ const intensities = []
    /** @type {number[]} */ const indices = []

    /** One quad: corners in tile units, the segment's endpoints and the feature's paint on each vertex. */
    const addQuad = (corners, start, end, paint) => {
      const first = positions.length / 2
      for (const [x, y] of corners) {
        positions.push(x, y)
        starts.push(start.x, start.y)
        ends.push(end.x, end.y)
        colors.push(...paint.color)
        radii.push(paint.radiusPixels)
        intensities.push(paint.intensity)
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
    }

    return {
      addFeature(feature, geometry) {
        const radiusPixels = host.clampReach(layer.evaluate('paint', 'sdf-glow-radius-pixels', zoom, feature))
        if (!(radiusPixels > 0)) return
        const paint = {
          color: layer.evaluateColor('sdf-glow-color', zoom, feature),
          intensity: layer.evaluate('paint', 'sdf-glow-intensity', zoom, feature),
          radiusPixels,
        }
        const radius = radiusPixels * unitsPerPixel
        for (const ring of geometry) {
          if (feature.type === 1 || ring.length === 1) {
            for (const point of ring) {
              addQuad([[point.x - radius, point.y - radius], [point.x + radius, point.y - radius], [point.x + radius, point.y + radius], [point.x - radius, point.y + radius]], point, point, paint)
            }
            continue
          }
          for (let index = 1; index < ring.length; index++) {
            const start = ring[index - 1]
            const end = ring[index]
            const length = Math.hypot(end.x - start.x, end.y - start.y)
            if (length === 0) continue
            // Along the segment and across it, both one radius long.
            const alongX = ((end.x - start.x) / length) * radius
            const alongY = ((end.y - start.y) / length) * radius
            const acrossX = -alongY
            const acrossY = alongX
            addQuad(
              [
                [start.x - alongX + acrossX, start.y - alongY + acrossY],
                [end.x + alongX + acrossX, end.y + alongY + acrossY],
                [end.x + alongX - acrossX, end.y + alongY - acrossY],
                [start.x - alongX - acrossX, start.y - alongY - acrossY],
              ],
              start,
              end,
              paint,
            )
          }
        }
      },
      finish() {
        if (indices.length === 0) return null
        return {
          attributes: {
            position: { array: Float32Array.from(positions), itemSize: 2 },
            segmentStart: { array: Float32Array.from(starts), itemSize: 2 },
            segmentEnd: { array: Float32Array.from(ends), itemSize: 2 },
            'sdf-glow-color': { array: Uint8Array.from(colors), itemSize: 4, normalized: true },
            'sdf-glow-radius-pixels': { array: Float32Array.from(radii), itemSize: 1 },
            'sdf-glow-intensity': { array: Float32Array.from(intensities), itemSize: 1 },
          },
          indices: Uint32Array.from(indices),
        }
      },
    }
  },
})
