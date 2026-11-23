import type { RenderedSourceFeature } from '../vector/worker/types.js'
import type { MapStyleSource } from './sources.js'
import type { GeographicPosition } from './camera.js'
import type { ScreenPosition } from './projection.js'
import type { MercatorPoint } from '../vector/worker/types.js'

export type { FeatureGeometry, MercatorPoint, SourceFeature, RenderedSourceFeature } from '../vector/worker/types.js'
export type { RenderedFeatureQueryOptions, SourceFeatureQueryOptions } from '../vector/MapStyleOverlay.js'

/** A feature `earth.queryRenderedFeatures` found, with the `MapStyleSource` that drew it. */
export interface RenderedFeature extends RenderedSourceFeature {
  /**
   * The source whose style drew the feature: call `feature.mapStyleSource.setFeatureState(feature, state)` to
   * highlight it (the feature carries `source`, `sourceLayer` and `id`).
   */
  mapStyleSource: MapStyleSource
}

/**
 * Where to look for features on the screen, in CSS pixels from the canvas's top-left corner: a point, or a box
 * given by two opposite corners.
 */
export type ScreenQueryGeometry = ScreenPosition | readonly [ScreenPosition, ScreenPosition]

/** Points sampled along each edge of a box query, corners included, to follow its outline on the ground. */
const BOX_SAMPLES_PER_EDGE = 4

const MAXIMUM_LATITUDE_DEGREES = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI

/** A geographic position in normalised Web Mercator (y grows to the north, clamped to the projection's edge). */
export function geographicToMercator({ longitudeDegrees, latitudeDegrees }: GeographicPosition): MercatorPoint {
  const latitude = (Math.min(Math.max(latitudeDegrees, -MAXIMUM_LATITUDE_DEGREES), MAXIMUM_LATITUDE_DEGREES) * Math.PI) / 180
  return { x: (longitudeDegrees + 180) / 360, y: 0.5 + Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI) }
}

/**
 * The ground under a screen point or box, in normalised Web Mercator: one point, or the box's outline (its edges
 * sampled, as perspective and the globe bend it). Points on the sky are left out; null when nothing of it hits the
 * ground. Longitudes are unwrapped along the outline, so a box over the antimeridian stays one polygon.
 */
export function screenToMercatorQuery(
  geometry: ScreenQueryGeometry,
  unproject: (screen: ScreenPosition) => GeographicPosition | null,
): MercatorPoint[] | null {
  if (!Array.isArray(geometry)) {
    const position = unproject(geometry as ScreenPosition)
    return position === null ? null : [geographicToMercator(position)]
  }
  const [first, second] = geometry as readonly [ScreenPosition, ScreenPosition]
  const left = Math.min(first.xPixels, second.xPixels)
  const right = Math.max(first.xPixels, second.xPixels)
  const top = Math.min(first.yPixels, second.yPixels)
  const bottom = Math.max(first.yPixels, second.yPixels)
  if (right - left < 1 && bottom - top < 1) return screenToMercatorQuery({ xPixels: left, yPixels: top }, unproject)
  const corners: ScreenPosition[] = [
    { xPixels: left, yPixels: top },
    { xPixels: right, yPixels: top },
    { xPixels: right, yPixels: bottom },
    { xPixels: left, yPixels: bottom },
  ]
  const points: MercatorPoint[] = []
  for (let corner = 0; corner < 4; corner++) {
    const from = corners[corner]!
    const to = corners[(corner + 1) % 4]!
    for (let step = 0; step < BOX_SAMPLES_PER_EDGE; step++) {
      const t = step / BOX_SAMPLES_PER_EDGE
      const position = unproject({ xPixels: from.xPixels + (to.xPixels - from.xPixels) * t, yPixels: from.yPixels + (to.yPixels - from.yPixels) * t })
      if (position === null) continue
      const point = geographicToMercator(position)
      const previous = points.at(-1)
      if (previous !== undefined) point.x += Math.round(previous.x - point.x) // unwrap across the antimeridian
      points.push(point)
    }
  }
  return points.length >= 3 ? points : null
}
