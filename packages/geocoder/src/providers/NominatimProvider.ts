import type { GeographicPosition } from '@earthkit/globe'

import type { GeocoderProvider, GeocoderResult, GeocoderReverseOptions, GeocoderSearchOptions } from '../types.js'
import { asNumber, asString, buildUrl, fetchJson, isRecord, joinDescription, languageParameter, toBounds, type HttpProviderOptions } from './http.js'

export interface NominatimProviderOptions extends HttpProviderOptions {
  /**
   * Whether search as you type may call it. Default: false, as the public server's usage policy forbids
   * autocomplete (https://operations.osmfoundation.org/policies/nominatim/); set true for your own server.
   */
  autocomplete?: boolean
  /** Your email, sent as `email` so the operator can reach you about heavy use, as the public server asks. */
  email?: string
  /** Keep to these countries, ISO 3166-1 alpha-2 codes (`['fr', 'ch']`). */
  countryCodes?: readonly string[]
}

/**
 * Nominatim (OpenStreetMap's geocoder): the public server at `https://nominatim.openstreetmap.org`, or your own.
 * The public server allows at most one request a second and no search as you type, which is why `autocomplete`
 * is false by default: the geocoder asks it only when the user presses Enter.
 */
export class NominatimProvider implements GeocoderProvider {
  readonly name: string
  readonly autocomplete: boolean
  protected readonly options: NominatimProviderOptions

  constructor(options: NominatimProviderOptions) {
    this.options = options
    this.name = options.name ?? 'nominatim'
    this.autocomplete = options.autocomplete ?? false
  }

  async search(query: string, { signal, limit, language, proximity, bounds }: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const { url, email, countryCodes, parameters } = this.options
    // Nominatim has no proximity bias: a box around the view only ranks places inside it first (`bounded=0`).
    const viewbox = bounds ?? (proximity === null || proximity === undefined ? null : { westDegrees: proximity.longitudeDegrees - 1, southDegrees: proximity.latitudeDegrees - 1, eastDegrees: proximity.longitudeDegrees + 1, northDegrees: proximity.latitudeDegrees + 1 })
    const json = await this.fetch(
      buildUrl(url, 'search', {
        q: query,
        format: 'jsonv2',
        limit,
        addressdetails: 1,
        'accept-language': languageParameter(language),
        countrycodes: countryCodes === undefined || countryCodes.length === 0 ? undefined : countryCodes.join(','),
        viewbox: viewbox === null ? undefined : `${viewbox.westDegrees},${viewbox.northDegrees},${viewbox.eastDegrees},${viewbox.southDegrees}`,
        bounded: bounds === null || bounds === undefined ? undefined : 1,
        email,
        ...parameters,
      }),
      signal,
    )
    return Array.isArray(json) ? json.flatMap(item => this.toResult(item)) : []
  }

  async reverse({ longitudeDegrees, latitudeDegrees }: GeographicPosition, { signal, language, zoom }: GeocoderReverseOptions): Promise<GeocoderResult[]> {
    const { url, email, parameters } = this.options
    const json = await this.fetch(
      buildUrl(url, 'reverse', {
        lat: latitudeDegrees,
        lon: longitudeDegrees,
        format: 'jsonv2',
        addressdetails: 1,
        zoom: zoom === undefined ? undefined : Math.max(3, Math.min(18, Math.round(zoom))),
        'accept-language': languageParameter(language),
        email,
        ...parameters,
      }),
      signal,
    )
    // Nothing there (the sea): `{ "error": "Unable to geocode" }`.
    return this.toResult(json)
  }

  protected fetch(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    return fetchJson(this.name, url, { fetch: this.options.fetch, headers: this.options.headers, signal })
  }

  /** A Nominatim place as a result: none when it has no position. */
  protected toResult(item: unknown): GeocoderResult[] {
    if (!isRecord(item)) return []
    const longitudeDegrees = asNumber(item.lon)
    const latitudeDegrees = asNumber(item.lat)
    if (longitudeDegrees === null || latitudeDegrees === null) return []
    const displayName = asString(item.display_name) ?? ''
    const parts = displayName.split(', ')
    const name = asString(item.name) ?? parts[0] ?? ''
    // `boundingbox` is south, north, west, east, as strings.
    const box = Array.isArray(item.boundingbox) ? item.boundingbox : []
    const osmType = asString(item.osm_type)
    const osmId = asString(item.osm_id)
    return [
      {
        id: `${this.name}:${osmType !== null && osmId !== null ? `${osmType}/${osmId}` : (asString(item.place_id) ?? displayName)}`,
        name,
        description: joinDescription(name, parts),
        longitudeDegrees,
        latitudeDegrees,
        bounds: toBounds(box[2], box[0], box[3], box[1]),
        category: asString(item.addresstype) ?? asString(item.type),
        provider: this.name,
        raw: item,
      },
    ]
  }
}
