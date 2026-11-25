import type { GeographicBounds, GeographicPosition } from '@earthkit/globe'

/** A place a provider found, the same shape whichever service it came from. */
export interface GeocoderResult {
  /** Unique within its provider: `'nominatim:relation/7444'`, `'geojson:12'`. */
  id: string
  /** The place's own name, for the first line of a result: `'Chamonix-Mont-Blanc'`. */
  name: string
  /** Where it is, for a second line, without the name: `'Haute-Savoie, Auvergne-Rhône-Alpes, France'`. May be empty. */
  description: string
  /** The point to show: the place's centre or entrance, as the provider gives it. */
  longitudeDegrees: number
  latitudeDegrees: number
  /** The place's extent, to fit the camera to; null for a point (an address, a peak). */
  bounds: GeographicBounds | null
  /** What kind of place it is, in the provider's words (`'city'`, `'peak'`, `'street'`), or null. */
  category: string | null
  /** The `name` of the provider that found it. */
  provider: string
  /** The provider's own item (a Nominatim place, a GeoJSON feature), for fields this shape leaves out. */
  raw: unknown
}

/** What a search asks a provider for. */
export interface GeocoderSearchOptions {
  /** Aborted when a newer search replaces this one: pass it to `fetch`. */
  signal?: AbortSignal
  /** The most results to return. */
  limit: number
  /** True while the user types (search as you type), false for a search the user submitted (Enter). */
  autocomplete: boolean
  /** Preferred language of the names, a BCP 47 tag (`'fr'`), or undefined for the provider's default. */
  language?: string
  /** Rank places near this point first (the view's centre), or null. */
  proximity?: GeographicPosition | null
  /** Keep to places inside this box, or null for anywhere. */
  bounds?: GeographicBounds | null
}

/** What a reverse search asks a provider for. */
export interface GeocoderReverseOptions {
  signal?: AbortSignal
  /** The most results to return. */
  limit: number
  language?: string
  /** The map's zoom when the user clicked, for providers that pick the detail from it (a building up close, a city far out). */
  zoom?: number
}

/**
 * A geocoding service, or a local index: turns text into places, and optionally a position into places. Ship your own
 * by implementing this interface; `NominatimProvider`, `PhotonProvider`, `PeliasProvider`, `MapTilerProvider` and
 * `GeoJSONProvider` are examples.
 */
export interface GeocoderProvider {
  /** Names the results' `provider` and the cache entries. Unique among the providers of a `Geocoder`. */
  readonly name: string
  /**
   * Whether search as you type may call it. False for a service whose terms forbid autocomplete (the public
   * Nominatim server): it is then asked only when the user submits (Enter, `geocoder.search()`).
   */
  readonly autocomplete: boolean
  /** Places matching `query`, best first. Rejects on a network or service error. */
  search(query: string, options: GeocoderSearchOptions): Promise<GeocoderResult[]>
  /** Places at a position, the most precise first (the building, then the street, the town…). */
  reverse?(position: GeographicPosition, options: GeocoderReverseOptions): Promise<GeocoderResult[]>
}

/** The `fetch` a provider calls: the global one by default, or a stand-in for tests, proxies and auth headers. */
export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>

/** A service answered with an error, or something that was not the expected JSON. */
export class GeocoderError extends Error {
  /** The HTTP status, or null for an error that was not one (invalid JSON). */
  readonly status: number | null
  /** The provider that failed. */
  readonly provider: string

  constructor(message: string, provider: string, status: number | null = null) {
    super(message)
    this.name = 'GeocoderError'
    this.provider = provider
    this.status = status
  }
}
