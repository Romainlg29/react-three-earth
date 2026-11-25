import { describe, expect, it } from 'vitest'

import { GeocoderError, MapTilerProvider, NominatimProvider, PeliasProvider, PhotonProvider, buildUrl, type FetchFunction } from '../src/index.js'

/** A fetch that records the URLs and answers `body` (or a status). */
function fakeFetch(body: unknown, status = 200): FetchFunction & { urls: string[] } {
  const urls: string[] = []
  const fetch = async (url: string) => {
    urls.push(url)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Error' })
  }
  return Object.assign(fetch, { urls })
}

const searchOptions = { limit: 5, autocomplete: false }

describe('buildUrl', () => {
  it('joins the base and the path with one slash, and skips missing parameters', () => {
    expect(buildUrl('https://example.com/geo/', '/search', { q: 'a b', limit: 3, lang: undefined, x: null })).toBe('https://example.com/geo/search?q=a+b&limit=3')
    expect(buildUrl('https://example.com', '', {})).toBe('https://example.com')
  })
})

describe('NominatimProvider', () => {
  const place = {
    place_id: 1,
    osm_type: 'relation',
    osm_id: 79_227,
    lat: '45.9237',
    lon: '6.8694',
    display_name: 'Chamonix-Mont-Blanc, Bonneville, Haute-Savoie, France',
    name: 'Chamonix-Mont-Blanc',
    boundingbox: ['45.8', '46.0', '6.7', '7.0'],
    addresstype: 'town',
  }

  it('asks /search and reads the bounding box as south, north, west, east', async () => {
    const fetch = fakeFetch([place])
    const provider = new NominatimProvider({ url: 'https://nominatim.example', fetch, email: 'me@example.com' })
    const [result] = await provider.search('Chamonix', { ...searchOptions, language: 'fr', proximity: { longitudeDegrees: 6.8, latitudeDegrees: 45.9 } })
    const url = new URL(fetch.urls[0]!)
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('q')).toBe('Chamonix')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('accept-language')).toBe('fr')
    expect(url.searchParams.get('email')).toBe('me@example.com')
    expect(url.searchParams.get('viewbox')).toBe('5.8,46.9,7.8,44.9')
    expect(url.searchParams.has('bounded')).toBe(false)
    expect(result).toMatchObject({
      id: 'nominatim:relation/79227',
      name: 'Chamonix-Mont-Blanc',
      description: 'Bonneville, Haute-Savoie, France',
      longitudeDegrees: 6.8694,
      latitudeDegrees: 45.9237,
      bounds: { westDegrees: 6.7, southDegrees: 45.8, eastDegrees: 7, northDegrees: 46 },
      category: 'town',
      provider: 'nominatim',
    })
  })

  it('names an address by its number and road, not the number alone', async () => {
    const house = { osm_type: 'node', osm_id: 1, lat: '48.86', lon: '2.34', name: '', display_name: '12, Rue de Rivoli, Paris, France', address: { house_number: '12', road: 'Rue de Rivoli', city: 'Paris' } }
    const [result] = await new NominatimProvider({ url: 'https://nominatim.example', fetch: fakeFetch([house]) }).search('12 rue de rivoli', searchOptions)
    expect(result).toMatchObject({ name: '12 Rue de Rivoli', description: 'Paris, France', bounds: null })
  })

  it('stays out of search as you type by default, as the public server asks', () => {
    expect(new NominatimProvider({ url: 'https://nominatim.example' }).autocomplete).toBe(false)
    expect(new NominatimProvider({ url: 'https://nominatim.example', autocomplete: true }).autocomplete).toBe(true)
  })

  it('reverse geocodes one place, and none at sea', async () => {
    const fetch = fakeFetch(place)
    const provider = new NominatimProvider({ url: 'https://nominatim.example', fetch })
    expect(await provider.reverse({ longitudeDegrees: 6.87, latitudeDegrees: 45.92 }, { limit: 5, zoom: 25.4 })).toHaveLength(1)
    expect(new URL(fetch.urls[0]!).searchParams.get('zoom')).toBe('18')
    const sea = new NominatimProvider({ url: 'https://nominatim.example', fetch: fakeFetch({ error: 'Unable to geocode' }) })
    expect(await sea.reverse({ longitudeDegrees: -30, latitudeDegrees: 40 }, { limit: 5 })).toEqual([])
  })

  it('names the provider and the status when the service fails', async () => {
    const provider = new NominatimProvider({ url: 'https://nominatim.example', fetch: fakeFetch('busy', 429) })
    const error = await provider.search('x', searchOptions).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GeocoderError)
    expect(error).toMatchObject({ status: 429, provider: 'nominatim' })
  })
})

describe('PhotonProvider', () => {
  const answer = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [6.87, 45.92] },
        properties: { osm_type: 'R', osm_id: 79_227, name: 'Chamonix', state: 'Auvergne-Rhône-Alpes', country: 'France', extent: [6.7, 46.0, 7.0, 45.8], osm_value: 'town' },
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [2.3, 48.8] }, properties: { street: 'Rue de Rivoli', housenumber: '10', city: 'Paris', country: 'France' } },
    ],
  }

  it('asks /api with the proximity and the box, and reads the extent as west, north, east, south', async () => {
    const fetch = fakeFetch(answer)
    const provider = new PhotonProvider({ url: 'https://photon.example/', fetch })
    const results = await provider.search('cham', { ...searchOptions, autocomplete: true, proximity: { longitudeDegrees: 6, latitudeDegrees: 45 }, bounds: { westDegrees: 5, southDegrees: 44, eastDegrees: 8, northDegrees: 47 } })
    expect(fetch.urls[0]).toBe('https://photon.example/api?q=cham&limit=5&lon=6&lat=45&bbox=5%2C44%2C8%2C47')
    expect(results[0]).toMatchObject({ id: 'photon:R79227', name: 'Chamonix', description: 'Auvergne-Rhône-Alpes, France', bounds: { westDegrees: 6.7, southDegrees: 45.8, eastDegrees: 7, northDegrees: 46 }, category: 'town' })
    // An address with no name: the street and number name it.
    expect(results[1]).toMatchObject({ name: '10 Rue de Rivoli', description: 'Paris, France', bounds: null })
  })

  it('reverse geocodes through /reverse', async () => {
    const fetch = fakeFetch(answer)
    await new PhotonProvider({ url: 'https://photon.example', fetch }).reverse({ longitudeDegrees: 6.87, latitudeDegrees: 45.92 }, { limit: 1 })
    expect(fetch.urls[0]).toBe('https://photon.example/reverse?lon=6.87&lat=45.92&limit=1')
    await new PhotonProvider({ url: 'https://photon.example', fetch }).search('x', { ...searchOptions, language: 'fr-CH' })
    expect(new URL(fetch.urls[1]!).searchParams.get('lang')).toBe('fr')
  })

  it('says when the answer is not GeoJSON', async () => {
    const provider = new PhotonProvider({ url: 'https://photon.example', fetch: fakeFetch({ results: [] }) })
    await expect(provider.search('x', searchOptions)).rejects.toThrow(/not a GeoJSON FeatureCollection/)
  })
})

describe('PeliasProvider', () => {
  const answer = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', bbox: [6.7, 45.8, 7.0, 46.0], geometry: { type: 'Point', coordinates: [6.87, 45.92] }, properties: { gid: 'whosonfirst:locality:1', name: 'Chamonix', region: 'Haute-Savoie', country: 'France', layer: 'locality' } }],
  }

  it('uses /autocomplete while typing and /search on submit', async () => {
    const fetch = fakeFetch(answer)
    const provider = new PeliasProvider({ url: 'https://pelias.example/v1', apiKey: 'key', fetch })
    const [typed] = await provider.search('cham', { ...searchOptions, autocomplete: true })
    await provider.search('cham', searchOptions)
    expect(fetch.urls.map(url => new URL(url).pathname)).toEqual(['/v1/autocomplete', '/v1/search'])
    expect(new URL(fetch.urls[0]!).searchParams.get('api_key')).toBe('key')
    expect(typed).toMatchObject({ id: 'pelias:whosonfirst:locality:1', description: 'Haute-Savoie, France', category: 'locality', bounds: { westDegrees: 6.7, southDegrees: 45.8, eastDegrees: 7, northDegrees: 46 } })
  })
})

describe('MapTilerProvider', () => {
  const answer = {
    type: 'FeatureCollection',
    features: [{ id: 'municipality.1', type: 'Feature', text: 'Chamonix', place_name: 'Chamonix, Haute-Savoie, France', place_type: ['municipality'], center: [6.87, 45.92], bbox: [6.7, 45.8, 7.0, 46.0], geometry: { type: 'Point', coordinates: [6.87, 45.92] } }],
  }

  it('puts the query in the path and reads the Carmen format', async () => {
    const fetch = fakeFetch(answer)
    const provider = new MapTilerProvider({ url: 'https://maptiler.example/geocoding', key: 'abc', fetch })
    const [result] = await provider.search('Cham onix', { ...searchOptions, proximity: { longitudeDegrees: 6, latitudeDegrees: 45 } })
    const url = new URL(fetch.urls[0]!)
    expect(url.pathname).toBe('/geocoding/Cham%20onix.json')
    expect(url.searchParams.get('key')).toBe('abc')
    expect(url.searchParams.get('proximity')).toBe('6,45')
    expect(result).toMatchObject({ id: 'maptiler:municipality.1', name: 'Chamonix', description: 'Haute-Savoie, France', category: 'municipality' })
  })
})
