import type { GeographicPosition } from '@earthkit/globe'

import type { GeocoderProvider, GeocoderResult, GeocoderReverseOptions, GeocoderSearchOptions } from '../types.js'
import { asString, buildUrl, featuresOf, fetchJson, joinDescription, languageParameter, pointOf, toBounds, type HttpProviderOptions } from './http.js'

export interface PeliasProviderOptions extends HttpProviderOptions {
  /** Sent as `api_key`, for hosted Pelias services (geocode.earth, openrouteservice). */
  apiKey?: string
  /** Whether search as you type may call it (through its `/autocomplete` endpoint). Default: true. */
  autocomplete?: boolean
}

/**
 * Pelias: geocode.earth (`url: 'https://api.geocode.earth/v1'`), openrouteservice
 * (`'https://api.openrouteservice.org/geocode'`) or your own. Search as you type uses its `/autocomplete` endpoint,
 * a submitted search its `/search`.
 */
export class PeliasProvider implements GeocoderProvider {
  readonly name: string
  readonly autocomplete: boolean
  protected readonly options: PeliasProviderOptions

  constructor(options: PeliasProviderOptions) {
    this.options = options
    this.name = options.name ?? 'pelias'
    this.autocomplete = options.autocomplete ?? true
  }

  async search(query: string, { signal, limit, autocomplete, language, proximity, bounds }: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const json = await this.fetch(
      buildUrl(this.options.url, autocomplete ? 'autocomplete' : 'search', {
        text: query,
        size: limit,
        lang: languageParameter(language),
        'focus.point.lon': proximity?.longitudeDegrees,
        'focus.point.lat': proximity?.latitudeDegrees,
        'boundary.rect.min_lon': bounds?.westDegrees,
        'boundary.rect.min_lat': bounds?.southDegrees,
        'boundary.rect.max_lon': bounds?.eastDegrees,
        'boundary.rect.max_lat': bounds?.northDegrees,
        api_key: this.options.apiKey,
        ...this.options.parameters,
      }),
      signal,
    )
    // `/autocomplete` ignores `size` and returns up to 10.
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature)).slice(0, limit)
  }

  async reverse({ longitudeDegrees, latitudeDegrees }: GeographicPosition, { signal, limit, language }: GeocoderReverseOptions): Promise<GeocoderResult[]> {
    const json = await this.fetch(
      buildUrl(this.options.url, 'reverse', { 'point.lon': longitudeDegrees, 'point.lat': latitudeDegrees, size: limit, lang: languageParameter(language), api_key: this.options.apiKey, ...this.options.parameters }),
      signal,
    )
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature))
  }

  protected fetch(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    return fetchJson(this.name, url, { fetch: this.options.fetch, headers: this.options.headers, signal })
  }

  protected toResult(feature: Record<string, unknown>): GeocoderResult[] {
    const point = pointOf(feature)
    if (point === null) return []
    const properties = (feature.properties ?? {}) as Record<string, unknown>
    const name = asString(properties.name) ?? asString(properties.label) ?? ''
    const bbox = Array.isArray(feature.bbox) ? feature.bbox : []
    return [
      {
        id: `${this.name}:${asString(properties.gid) ?? asString(properties.id) ?? `${point[0]},${point[1]}`}`,
        name,
        description: joinDescription(name, [properties.locality, properties.region, properties.country]),
        longitudeDegrees: point[0],
        latitudeDegrees: point[1],
        bounds: toBounds(bbox[0], bbox[1], bbox[2], bbox[3]),
        category: asString(properties.layer),
        provider: this.name,
        raw: feature,
      },
    ]
  }
}
