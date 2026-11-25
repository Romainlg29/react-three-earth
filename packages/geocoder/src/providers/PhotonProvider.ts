import type { GeographicPosition } from '@earthkit/globe'

import type { GeocoderProvider, GeocoderResult, GeocoderReverseOptions, GeocoderSearchOptions } from '../types.js'
import { asString, boundsParameter, buildUrl, featuresOf, fetchJson, joinDescription, pointOf, toBounds, type HttpProviderOptions } from './http.js'

export interface PhotonProviderOptions extends HttpProviderOptions {
  /** Whether search as you type may call it. Default: true (Photon is built for it). */
  autocomplete?: boolean
}

/**
 * Photon (komoot's OpenStreetMap geocoder, built for search as you type): the public server at
 * `https://photon.komoot.io` for fair use, or your own. Its languages are those the server was built with
 * (the public one: English, German, French and the local names).
 */
export class PhotonProvider implements GeocoderProvider {
  readonly name: string
  readonly autocomplete: boolean
  protected readonly options: PhotonProviderOptions

  constructor(options: PhotonProviderOptions) {
    this.options = options
    this.name = options.name ?? 'photon'
    this.autocomplete = options.autocomplete ?? true
  }

  async search(query: string, { signal, limit, language, proximity, bounds }: GeocoderSearchOptions): Promise<GeocoderResult[]> {
    const json = await this.fetch(
      buildUrl(this.options.url, 'api', {
        q: query,
        limit,
        lang: photonLanguage(language),
        lon: proximity?.longitudeDegrees,
        lat: proximity?.latitudeDegrees,
        bbox: boundsParameter(bounds),
        ...this.options.parameters,
      }),
      signal,
    )
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature))
  }

  async reverse({ longitudeDegrees, latitudeDegrees }: GeographicPosition, { signal, limit, language }: GeocoderReverseOptions): Promise<GeocoderResult[]> {
    const json = await this.fetch(buildUrl(this.options.url, 'reverse', { lon: longitudeDegrees, lat: latitudeDegrees, limit, lang: photonLanguage(language), ...this.options.parameters }), signal)
    return featuresOf(this.name, json).flatMap(feature => this.toResult(feature))
  }

  protected fetch(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    return fetchJson(this.name, url, { fetch: this.options.fetch, headers: this.options.headers, signal })
  }

  protected toResult(feature: Record<string, unknown>): GeocoderResult[] {
    const point = pointOf(feature)
    const properties = (feature.properties ?? {}) as Record<string, unknown>
    if (point === null) return []
    const street = asString(properties.street)
    const houseNumber = asString(properties.housenumber)
    const address = street === null ? null : houseNumber === null ? street : `${houseNumber} ${street}`
    const name = asString(properties.name) ?? address ?? asString(properties.city) ?? ''
    // `extent` is west, north, east, south.
    const extent = Array.isArray(properties.extent) ? properties.extent : []
    const osmType = asString(properties.osm_type)
    const osmId = asString(properties.osm_id)
    return [
      {
        id: `${this.name}:${osmType ?? ''}${osmId ?? `${point[0]},${point[1]}`}`,
        name,
        description: joinDescription(name, [name === address ? null : address, properties.postcode, properties.city, properties.county, properties.state, properties.country]),
        longitudeDegrees: point[0],
        latitudeDegrees: point[1],
        bounds: toBounds(extent[0], extent[3], extent[2], extent[1]),
        category: asString(properties.osm_value) ?? asString(properties.type),
        provider: this.name,
        raw: feature,
      },
    ]
  }
}

/**
 * The language Photon takes: the primary subtag only (`'fr-CH'` → `'fr'`). A server answers 400 for a language it was
 * not built with (the public one: `en`, `de`, `fr`), so pick one it has in the geocoder's `language`.
 */
function photonLanguage(language: string | undefined): string | undefined {
  if (language === undefined || language === '') return undefined
  return language.split(/[-_]/)[0]?.toLowerCase()
}
