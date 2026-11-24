import type { Feature, LineString, Point, Polygon } from 'geojson'

/** A longitude and a latitude, in degrees: a GeoJSON position. */
export type LongitudeLatitude = [longitudeDegrees: number, latitudeDegrees: number]

/** The geometries a `Draw` holds. */
export type DrawGeometry = Point | LineString | Polygon

/** A feature a `Draw` holds: a GeoJSON feature with a string id. */
export type DrawFeature<G extends DrawGeometry = DrawGeometry> = Feature<G> & { id: string }

/**
 * How features look on the map. Colours are CSS colours (`'#ff6a00'`, `'rgb(…)'` without alpha); opacities go from 0
 * to 1. Sizes are CSS pixels.
 */
export interface DrawStyle {
  /** Inside of polygons. Default: '#3b82f6'. */
  fillColor: string
  /** Default: 0.25. */
  fillOpacity: number
  /** Lines and polygon outlines. Default: '#3b82f6'. */
  lineColor: string
  /** Default: 1. */
  lineOpacity: number
  /** Default: 3. */
  lineWidthPixels: number
  /** Points. Default: '#3b82f6'. */
  pointColor: string
  /** Default: 6. */
  pointRadiusPixels: number
  /** Ring around points. Default: '#ffffff'. */
  pointOutlineColor: string
  /** Default: 2. */
  pointOutlineWidthPixels: number
  /**
   * 3D features (extruded shapes, spheres, polygons at an altitude) are drawn as solids in `fillColor` at this opacity,
   * with edges in `lineColor`. Default: 0.85.
   */
  solidOpacity: number
  /** Vertex handles of the feature being drawn or edited. Default: '#ffffff'. */
  vertexColor: string
  /** Default: 5. */
  vertexRadiusPixels: number
  /** Ring around vertex handles. Default: '#3b82f6'. */
  vertexOutlineColor: string
  /** Default: 2. */
  vertexOutlineWidthPixels: number
}

/** What a style function knows about the feature it styles. */
export interface DrawStyleState {
  /** The feature is selected. */
  selected: boolean
  /** The feature is being drawn (not finished yet). */
  drawing: boolean
}

/**
 * A style for every feature, or a function that picks one per feature (from its properties, or whether it is
 * selected). Missing values come from the defaults.
 */
export type DrawStyleInput = Partial<DrawStyle> | ((feature: DrawFeature, state: DrawStyleState) => Partial<DrawStyle>)

/** A pointer event a mode receives, in screen pixels and on the ground. */
export interface DrawPointerEvent {
  /** CSS pixels from the canvas's top-left corner. */
  screen: { xPixels: number; yPixels: number }
  /** The ground under the pointer (terrain where loaded), or null on sky. */
  geographic: { longitudeDegrees: number; latitudeDegrees: number; heightMeters: number } | null
  /** `'mouse'`, `'touch'` or `'pen'`. */
  pointerType: string
  originalEvent: MouseEvent
}
