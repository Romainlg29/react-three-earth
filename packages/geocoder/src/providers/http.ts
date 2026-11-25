import type { GeographicBounds } from '@earthkit/globe'

import { GeocoderError, type FetchFunction } from '../types.js'

/** The options every HTTP provider takes. */
export interface HttpProviderOptions {
  /**
   * The service's base URL, which the provider adds its paths to (`'https://photon.komoot.io'`). Required: this
   * package makes no request to a URL the app did not give.
   */
  url: string
  /** Replaces the provider's `name`, to install two of the same kind. */
  name?: string
  /** Called instead of the global `fetch`: for tests, a proxy, or headers. */
  fetch?: FetchFunction
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** Extra query parameters on every request, for options this adapter does not name. */
  parameters?: Record<string, string>
}

/** Query parameters, skipping undefined and null values. */
export type QueryParameters = Record<string, string | number | boolean | null | undefined>

/** `base` + `path` + `?parameters`, with exactly one slash between the base and the path. */
export function buildUrl(base: string, path: string, parameters: QueryParameters): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) search.set(key, String(value))
  const query = search.toString()
  const trimmedBase = base.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedPath === '' ? trimmedBase : `${trimmedBase}/${trimmedPath}`}${query === '' ? '' : `?${query}`}`
}

/** GETs JSON, throwing a `GeocoderError` that names the provider and the status. Lets an `AbortError` through as is. */
export async function fetchJson(provider: string, url: string, { fetch = globalThis.fetch, headers, signal }: { fetch?: FetchFunction; headers?: Record<string, string>; signal?: AbortSignal }): Promise<unknown> {
  if (typeof fetch !== 'function') throw new GeocoderError(`${provider}: no fetch here; pass one in the provider's \`fetch\` option.`, provider)
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal })
  if (!response.ok) throw new GeocoderError(`${provider}: the service answered ${response.status} ${response.statusText} for ${url}; check the provider's \`url\` and key.`, provider, response.status)
  try {
    return await response.json()
  } catch {
    throw new GeocoderError(`${provider}: the answer from ${url} is not JSON; check that \`url\` points at the service's API.`, provider, response.status)
  }
}

/** The parameter the providers that take one (Photon, Pelias, MapTiler) use for a box: west, south, east, north. */
export function boundsParameter(bounds: GeographicBounds | null | undefined): string | undefined {
  if (bounds === null || bounds === undefined) return undefined
  return `${bounds.westDegrees},${bounds.southDegrees},${bounds.eastDegrees},${bounds.northDegrees}`
}

/** A box from four numbers, or null when any is missing or the box is empty. */
export function toBounds(west: unknown, south: unknown, east: unknown, north: unknown): GeographicBounds | null {
  const values = [west, south, east, north].map(value => (typeof value === 'string' ? Number.parseFloat(value) : value))
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null
  const [westDegrees, southDegrees, eastDegrees, northDegrees] = values as [number, number, number, number]
  if (northDegrees < southDegrees) return null
  if (westDegrees === eastDegrees && southDegrees === northDegrees) return null
  return { westDegrees, southDegrees, eastDegrees, northDegrees }
}

/** The parts of a place's label that are not its name, deduplicated: `'Haute-Savoie, France'`. */
export function joinDescription(name: string, parts: ReadonlyArray<unknown>): string {
  const seen = new Set([name])
  const kept: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string' || part === '' || seen.has(part)) continue
    seen.add(part)
    kept.push(part)
  }
  return kept.join(', ')
}

/** A language tag a service takes: `'fr-CH'` stays, `undefined` drops the parameter. */
export function languageParameter(language: string | undefined): string | undefined {
  return language === undefined || language === '' ? undefined : language
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null
}

export function asNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

/** The features of a GeoJSON answer (Photon, Pelias, MapTiler), or a `GeocoderError` naming the provider. */
export function featuresOf(provider: string, json: unknown): Record<string, unknown>[] {
  if (!isRecord(json) || !Array.isArray(json.features)) throw new GeocoderError(`${provider}: the answer is not a GeoJSON FeatureCollection; check that \`url\` points at the service's API.`, provider)
  return json.features.filter(isRecord)
}

/** A GeoJSON point feature's longitude and latitude, or null. */
export function pointOf(feature: Record<string, unknown>): [number, number] | null {
  const geometry = feature.geometry
  if (!isRecord(geometry) || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null
  const longitude = asNumber(geometry.coordinates[0])
  const latitude = asNumber(geometry.coordinates[1])
  return longitude === null || latitude === null ? null : [longitude, latitude]
}
