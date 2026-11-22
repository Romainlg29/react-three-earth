/**
 * Axis-aligned rectangles in normalised Web Mercator space, the space terrain regions and vector tiles are
 * laid out in: x from 0 (180° W) to 1 (180° E), y from 0 (south edge, about 85.05° S) to 1 (north edge).
 * Worker-safe: no three.js.
 */

/** A rectangle in normalised Web Mercator space (y grows to the north). */
export interface MercatorRectangle {
  minimumX: number
  minimumY: number
  maximumX: number
  maximumY: number
}

/** A longitude-latitude box; the same shape as `GeographicBounds` in `core/camera.ts`. */
interface Bounds {
  westDegrees: number
  southDegrees: number
  eastDegrees: number
  northDegrees: number
}

const MAXIMUM_LATITUDE_DEGREES = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI

/** Zero-size bounds (a point or a line) are widened by this much, so they touch the tiles they lie on. */
const POINT_HALF_SIZE = 1e-12

function longitudeToX(longitudeDegrees: number): number {
  return (longitudeDegrees + 180) / 360
}

/** Latitudes past the projection's edge clamp to it (0 or 1). */
function latitudeToY(latitudeDegrees: number): number {
  if (latitudeDegrees >= MAXIMUM_LATITUDE_DEGREES) return 1
  if (latitudeDegrees <= -MAXIMUM_LATITUDE_DEGREES) return 0
  const latitude = (latitudeDegrees * Math.PI) / 180
  return 0.5 + Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI)
}

/** Wraps a longitude to [-180, 180). */
function wrapLongitude(longitudeDegrees: number): number {
  return ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180
}

/**
 * Converts geographic bounds to one rectangle, or two when they cross the antimeridian. The span runs east
 * from `westDegrees` to `eastDegrees` (across the antimeridian when west is greater); longitudes outside
 * [-180, 180) wrap. Bounds 360° wide or more span every longitude.
 */
export function boundsToMercatorRectangles({ westDegrees, southDegrees, eastDegrees, northDegrees }: Bounds): MercatorRectangle[] {
  for (const [name, value] of Object.entries({ westDegrees, southDegrees, eastDegrees, northDegrees })) {
    if (!Number.isFinite(value)) throw new Error(`invalidate: \`${name}\` is ${value}; pass finite degrees, or no bounds to redraw everything.`)
  }
  if (southDegrees > northDegrees) {
    throw new Error(`invalidate: southDegrees (${southDegrees}) is north of northDegrees (${northDegrees}); swap them.`)
  }
  const pointY = southDegrees === northDegrees ? POINT_HALF_SIZE : 0
  const minimumY = latitudeToY(southDegrees) - pointY
  const maximumY = latitudeToY(northDegrees) + pointY
  const crossesWithoutWrapping = westDegrees > eastDegrees
  const spanDegrees = crossesWithoutWrapping ? eastDegrees + 360 - westDegrees : eastDegrees - westDegrees
  if (spanDegrees >= 360) return [{ minimumX: 0, minimumY, maximumX: 1, maximumY }]
  const pointX = spanDegrees === 0 ? POINT_HALF_SIZE : 0
  const west = longitudeToX(wrapLongitude(westDegrees)) - pointX
  const east = west + spanDegrees / 360 + 2 * pointX
  if (east <= 1) return [{ minimumX: west, minimumY, maximumX: east, maximumY }]
  return [
    { minimumX: west, minimumY, maximumX: 1, maximumY },
    { minimumX: 0, minimumY, maximumX: east - 1, maximumY },
  ]
}

/** Whether two rectangles overlap; rectangles that only share an edge do not. */
export function rectanglesOverlap(a: MercatorRectangle, b: MercatorRectangle): boolean {
  return a.minimumX < b.maximumX && b.minimumX < a.maximumX && a.minimumY < b.maximumY && b.minimumY < a.maximumY
}

/** The rectangle of tile x, y (rows from the north) at zoom z. */
export function tileRectangle(x: number, y: number, z: number): MercatorRectangle {
  const size = 1 / 2 ** z
  return { minimumX: x * size, minimumY: 1 - (y + 1) * size, maximumX: (x + 1) * size, maximumY: 1 - y * size }
}

/** Whether tile x, y, z overlaps any of the rectangles; `null` stands for everywhere. */
export function tileOverlaps(x: number, y: number, z: number, rectangles: readonly MercatorRectangle[] | null): boolean {
  if (rectangles === null) return true
  const tile = tileRectangle(x, y, z)
  return rectangles.some(rectangle => rectanglesOverlap(tile, rectangle))
}
