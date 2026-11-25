import type { GeographicPosition } from '@earthkit/globe'

import type { GeocoderProvider, GeocoderResult, GeocoderReverseOptions, GeocoderSearchOptions } from '../types.js'
import { asNumber, asString, boundsParameter, buildUrl, featuresOf, fetchJson, languageParameter, pointOf, toBounds, type HttpProviderOptions } from './http.js'

export interface MapTilerProviderOptions extends HttpProviderOptions {
  /** Your MapTiler API key, sent as `key`. */
  key: string
  /** Whether search as you type may call it. Default: true. */
  autocomplete?: boolean
  /** Keep to these countries, ISO 3166-1 alpha-2 codes (`['fr', 'ch']`). */
  countryCodes?: readonly string[]
}

/**
 * MapTiler Geocoding (`url: 'https://api.maptiler.com/geocoding'`). Its answers use the Carmen GeoJSON format of
 * Mapbox's v5 geocoding API too, so the same adapter reads a Mapbox v5 endpoint given its own `url` and, through
 * `parameters`, `access_token`.
 */
export class MapTilerProvider implements GeocoderProvider {
  readonly name: string
  readonly autocomplete: boolean
  protected readonly options: MapTilerProviderOptions

  constructor(options: MapTilerProviderOptions) {
    this.options = options
    this.name = options.name ?? 'maptiler'
    this.autocomplete = options.autocomplete ?? true
  }

  async search(query: string, { signal, limit, autocomplete, language, proximity, bounds }: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const { countryCodes } = this.options
    const json = await this.fetch(
      buildUrl(this.options.url, `${encodeURIComponent(query)}.json`, {
        key: this.options.key,
        limit,
        autocomplete,
        language: languageParameter(language),
        proximity: proximity === null || proximity === undefined ? undefined : `${proximity.longitudeDegrees},${proximity.latitudeDegrees}`,
        bbox: boundsParameter(bounds),
        country: countryCodes === undefined || countryCodes.length === 0 ? undefined : countryCodes.join(','),
        ...this.options.parameters,
      }),
      signal,
    )
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature))
  }

  /** No `limit`: the service refuses one above 1 on a reverse search without a single `types`. */
  async reverse({ longitudeDegrees, latitudeDegrees }: GeographicPosition, { signal, language }: GeocoderReverseOptions): Promise<GeocoderResult[]> {
    const json = await this.fetch(buildUrl(this.options.url, `${longitudeDegrees},${latitudeDegrees}.json`, { key: this.options.key, language: languageParameter(language), ...this.options.parameters }), signal)
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature))
  }

  protected fetch(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    return fetchJson(this.name, url, { fetch: this.options.fetch, headers: this.options.headers, signal })
  }

  protected toResult(feature: Record<string, unknown>): GeocoderResult[] {
    const center = Array.isArray(feature.center) ? feature.center : null
    const longitude = center === null ? (pointOf(feature)?.[0] ?? null) : asNumber(center[0])
    const latitude = center === null ? (pointOf(feature)?.[1] ?? null) : asNumber(center[1])
    if (longitude === null || latitude === null) return []
    const point: [number, number] = [longitude, latitude]
    const name = asString(feature.text) ?? asString(feature.place_name) ?? ''
    const placeName = asString(feature.place_name) ?? name
    // `place_name` starts with the name: "Chamonix-Mont-Blanc, Haute-Savoie, France".
    const description = placeName.startsWith(`${name}, `) ? placeName.slice(name.length + 2) : placeName === name ? '' : placeName
    const bbox = Array.isArray(feature.bbox) ? feature.bbox : []
    const placeType = Array.isArray(feature.place_type) ? asString(feature.place_type[0]) : null
    return [
      {
        id: `${this.name}:${asString(feature.id) ?? `${point[0]},${point[1]}`}`,
        name,
        description,
        longitudeDegrees: point[0],
        latitudeDegrees: point[1],
        bounds: toBounds(bbox[0], bbox[1], bbox[2], bbox[3]),
        category: placeType,
        provider: this.name,
        raw: feature,
      },
    ]
  }
}
