import type { Earth, PluginContext } from '@earthkit/globe'
import type { FeatureCollection } from 'geojson'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GeoJSONProvider, Geocoder, normalizeText, type GeocoderProvider, type GeocoderResult, type GeocoderSearchOptions } from '../src/index.js'

const places: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'geneva', properties: { name: 'Genève', alias: 'Geneva' }, geometry: { type: 'Point', coordinates: [6.14, 46.2] } },
    { type: 'Feature', id: 'chamonix', properties: { name: 'Chamonix-Mont-Blanc', region: 'Haute-Savoie' }, geometry: { type: 'Point', coordinates: [6.87, 45.92] } },
    { type: 'Feature', id: 'blanc', properties: { name: 'Mont Blanc' }, geometry: { type: 'Point', coordinates: [6.865, 45.833] } },
    { type: 'Feature', id: 'montreux', properties: { name: 'Montreux' }, geometry: { type: 'Point', coordinates: [6.91, 46.43] } },
    {
      type: 'Feature',
      id: 'lake',
      properties: { name: 'Lac Léman' },
      geometry: { type: 'Polygon', coordinates: [[[6.1, 46.2], [6.9, 46.2], [6.9, 46.5], [6.1, 46.5], [6.1, 46.2]]] },
    },
    { type: 'Feature', id: 'trail', properties: { name: 'Tour du Lac' }, geometry: { type: 'LineString', coordinates: [[6.5, 46.0], [6.6, 46.0]] } },
    { type: 'Feature', properties: { other: 'no name' }, geometry: { type: 'Point', coordinates: [0, 0] } },
  ],
}

const local = () => new GeoJSONProvider({ features: places, searchProperties: ['alias'], description: 'region' })

/** A provider that answers when told to, recording what it was asked. */
function controlledProvider(name: string, { autocomplete = true } = {}) {
  const calls: { query: string; options: GeocoderSearchOptions; resolve: (results: GeocoderResult[]) => void; reject: (error: unknown) => void }[] = []
  const provider: GeocoderProvider = {
    name,
    autocomplete,
    search: (query, options) =>
      new Promise((resolve, reject) => {
        calls.push({ query, options, resolve, reject })
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
  }
  return { provider, calls }
}

function result(name: string, extra: Partial<GeocoderResult> = {}): GeocoderResult {
  return { id: `test:${name}`, name, description: '', longitudeDegrees: 6, latitudeDegrees: 46, bounds: null, category: null, provider: 'test', raw: null, ...extra }
}

const key = (key: string) => ({ key, preventDefault: vi.fn() })

describe('normalizeText', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeText('  Genève-Cornavin ')).toBe('geneve cornavin')
    expect(normalizeText("L'Aiguille du Midi")).toBe('l aiguille du midi')
  })
})

describe('GeoJSONProvider', () => {
  const options = { limit: 10, autocomplete: true }

  it('finds names without accents or case, the closest match first', async () => {
    const results = await local().search('mont', options)
    // Names starting with it, then a word starting with it.
    expect(results.map(each => each.name)).toEqual(['Montreux', 'Mont Blanc', 'Chamonix-Mont-Blanc'])
    expect((await local().search('geneve', options))[0]?.name).toBe('Genève')
    expect((await local().search('GENEVA', options))[0]?.name).toBe('Genève')
    expect((await local().search('blanc mont', options)).map(each => each.name)).toEqual(['Mont Blanc', 'Chamonix-Mont-Blanc'])
  })

  it('breaks ties by distance to the proximity', async () => {
    // 'Montreux' and 'Mont Blanc' both start with 'mont': the one nearer the view wins.
    const nearMontreux = await local().search('mont', { ...options, proximity: { longitudeDegrees: 6.9, latitudeDegrees: 46.4 } })
    expect(nearMontreux.map(each => each.name)).toEqual(['Montreux', 'Mont Blanc', 'Chamonix-Mont-Blanc'])
    const nearBlanc = await local().search('mont', { ...options, proximity: { longitudeDegrees: 6.86, latitudeDegrees: 45.83 } })
    expect(nearBlanc.map(each => each.name)).toEqual(['Mont Blanc', 'Montreux', 'Chamonix-Mont-Blanc'])
  })

  it('makes results with the description, the bounds of non-points, and skips features with no name', async () => {
    const provider = local()
    expect(provider.size).toBe(6)
    const [chamonix] = await provider.search('chamonix', options)
    expect(chamonix).toMatchObject({ id: 'geojson:chamonix', description: 'Haute-Savoie', bounds: null, category: 'point', longitudeDegrees: 6.87 })
    const [lake] = await provider.search('leman', options)
    expect(lake).toMatchObject({ bounds: { westDegrees: 6.1, southDegrees: 46.2, eastDegrees: 6.9, northDegrees: 46.5 }, longitudeDegrees: 6.5, latitudeDegrees: 46.35 })
  })

  it('keeps to the bounds', async () => {
    const results = await local().search('mont', { ...options, bounds: { westDegrees: 6.8, southDegrees: 45.8, eastDegrees: 6.88, northDegrees: 46 } })
    expect(results.map(each => each.name)).toEqual(['Mont Blanc', 'Chamonix-Mont-Blanc'])
  })

  it('reverse geocodes: near points and lines first, then the polygons around', async () => {
    const onLake = await local().reverse({ longitudeDegrees: 6.15, latitudeDegrees: 46.205 }, { limit: 5 })
    expect(onLake.map(each => each.name)).toEqual(['Lac Léman'])
    const nearGeneva = await local().reverse({ longitudeDegrees: 6.1405, latitudeDegrees: 46.2 }, { limit: 5 })
    expect(nearGeneva.map(each => each.name)).toEqual(['Genève', 'Lac Léman'])
    const onTrail = await local().reverse({ longitudeDegrees: 6.55, latitudeDegrees: 46.001 }, { limit: 5 })
    expect(onTrail.map(each => each.name)).toEqual(['Tour du Lac'])
    expect(await local().reverse({ longitudeDegrees: 0, latitudeDegrees: 0 }, { limit: 5 })).toEqual([])
  })
})

describe('Geocoder', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('searches as you type after a pause, once', async () => {
    const { provider, calls } = controlledProvider('remote')
    const geocoder = new Geocoder({ provider, debounceMilliseconds: 200 })
    geocoder.setQuery('c')
    geocoder.setQuery('ch')
    geocoder.setQuery('cha')
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(199)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map(call => [call.query, call.options.autocomplete])).toEqual([['cha', true]])
    expect(geocoder.getState().status).toBe('loading')
    calls[0]!.resolve([result('Chamonix')])
    await vi.runAllTimersAsync()
    expect(geocoder.getState()).toMatchObject({ status: 'success', resultsQuery: 'cha', open: true, activeIndex: -1 })
    expect(geocoder.getState().results.map(each => each.name)).toEqual(['Chamonix'])
  })

  it('searches nothing below the minimum length, and clears the results', async () => {
    const { provider, calls } = controlledProvider('remote')
    const geocoder = new Geocoder({ provider, minimumQueryLength: 3 })
    geocoder.setQuery('ch ')
    await vi.runAllTimersAsync()
    expect(calls).toHaveLength(0)
    expect(geocoder.getState()).toMatchObject({ status: 'idle', results: [], open: false })
  })

  it('drops the answer to an older query and aborts its request', async () => {
    const { provider, calls } = controlledProvider('remote')
    const geocoder = new Geocoder({ provider })
    geocoder.setQuery('gen')
    await vi.runAllTimersAsync()
    geocoder.setQuery('gene')
    await vi.runAllTimersAsync()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.options.signal?.aborted).toBe(true)
    calls[1]!.resolve([result('Genève')])
    calls[0]!.resolve([result('Gennevilliers')])
    await vi.runAllTimersAsync()
    expect(geocoder.getState().results.map(each => each.name)).toEqual(['Genève'])
    expect(geocoder.getState().resultsQuery).toBe('gene')
  })

  it('asks providers that forbid autocomplete only on submit, and lists the results in provider order', async () => {
    const typed = controlledProvider('typed')
    const submitted = controlledProvider('submitted', { autocomplete: false })
    const geocoder = new Geocoder({ provider: [typed.provider, submitted.provider] })
    geocoder.setQuery('paris')
    await vi.runAllTimersAsync()
    expect([typed.calls.length, submitted.calls.length]).toEqual([1, 0])
    typed.calls[0]!.resolve([result('Paris, typed')])
    await vi.runAllTimersAsync()
    const searching = geocoder.search()
    expect([typed.calls.length, submitted.calls.length]).toEqual([2, 1])
    expect(typed.calls[1]!.options.autocomplete).toBe(false)
    submitted.calls[0]!.resolve([result('Paris, submitted')])
    typed.calls[1]!.resolve([result('Paris, typed again')])
    expect((await searching).map(each => each.name)).toEqual(['Paris, typed again', 'Paris, submitted'])
  })

  it('caches answers, so retyping a query asks nothing', async () => {
    const search = vi.fn(async (query: string) => [result(query)])
    const geocoder = new Geocoder({ provider: { name: 'counted', autocomplete: true, search } })
    for (const query of ['gen', 'gene', 'gen']) {
      geocoder.setQuery(query)
      await vi.runAllTimersAsync()
    }
    expect(search).toHaveBeenCalledTimes(2)
    expect(geocoder.getState().results[0]?.name).toBe('gen')
  })

  it('keeps the results of the providers that answered, and reports the one that failed', async () => {
    const failing: GeocoderProvider = { name: 'down', autocomplete: true, search: async () => Promise.reject(new Error('503')) }
    const geocoder = new Geocoder({ provider: [local(), failing] })
    const errors: string[] = []
    geocoder.addEventListener('error', event => errors.push(`${event.provider}: ${event.error.message}`))
    await geocoder.search('montreux')
    expect(geocoder.getState()).toMatchObject({ status: 'success', error: null })
    expect(geocoder.getState().results.map(each => each.name)).toEqual(['Montreux'])
    expect(errors).toEqual(['down: 503'])
    // Every provider failing is an error.
    const broken = new Geocoder({ provider: failing })
    await broken.search('montreux')
    expect(broken.getState()).toMatchObject({ status: 'error', open: false, results: [] })
    expect(broken.getState().error?.message).toBe('503')
  })

  it('moves the picked result with the arrow keys, wrapping, and selects it with Enter', async () => {
    const geocoder = new Geocoder({ provider: local() })
    await geocoder.search('mont')
    const selected: string[] = []
    geocoder.addEventListener('select', event => selected.push(event.result.name))
    const down = key('ArrowDown')
    expect(geocoder.handleKeyDown(down)).toBe(true)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(geocoder.getState().activeIndex).toBe(0)
    geocoder.handleKeyDown(key('ArrowDown'))
    geocoder.handleKeyDown(key('ArrowDown'))
    geocoder.handleKeyDown(key('ArrowDown'))
    expect(geocoder.getState().activeIndex).toBe(0)
    geocoder.handleKeyDown(key('ArrowUp'))
    expect(geocoder.getState().activeIndex).toBe(2)
    geocoder.handleKeyDown(key('Enter'))
    expect(selected).toEqual(['Chamonix-Mont-Blanc'])
    expect(geocoder.getState()).toMatchObject({ query: 'Chamonix-Mont-Blanc', open: false, activeIndex: -1, selected: { name: 'Chamonix-Mont-Blanc' } })
    // Other keys are the input's.
    expect(geocoder.handleKeyDown(key('a'))).toBe(false)
    expect(geocoder.handleKeyDown({ ...key('Enter'), isComposing: true })).toBe(false)
  })

  it('Enter with nothing picked searches with every provider and selects the best result', async () => {
    const geocoder = new Geocoder({ provider: local() })
    geocoder.setQuery('montreux')
    geocoder.handleKeyDown(key('Enter'))
    await vi.runAllTimersAsync()
    expect(geocoder.getState().selected?.name).toBe('Montreux')
  })

  it('Escape closes the list, then clears everything', async () => {
    const geocoder = new Geocoder({ provider: local() })
    await geocoder.search('mont')
    geocoder.select(0)
    geocoder.open()
    expect(geocoder.getState().open).toBe(true)
    geocoder.handleKeyDown(key('Escape'))
    expect(geocoder.getState()).toMatchObject({ open: false, query: 'Montreux' })
    const cleared = vi.fn()
    geocoder.addEventListener('clear', cleared)
    geocoder.handleKeyDown(key('Escape'))
    expect(geocoder.getState()).toMatchObject({ query: '', results: [], selected: null })
    expect(cleared).toHaveBeenCalledOnce()
    expect(geocoder.handleKeyDown(key('Escape'))).toBe(false)
  })

  it('notifies subscribers with a new state on each change only', async () => {
    const geocoder = new Geocoder({ provider: local() })
    const states = new Set()
    geocoder.subscribe(state => states.add(state))
    const first = geocoder.getState()
    geocoder.close()
    expect(geocoder.getState()).toBe(first)
    await geocoder.search('mont')
    expect(states.size).toBeGreaterThan(0)
    expect(geocoder.getState()).not.toBe(first)
  })

  it('refuses no provider or two with the same name, saying the fix', () => {
    expect(() => new Geocoder({ provider: [] })).toThrow(/no provider/)
    expect(() => new Geocoder({ provider: [local(), local()] })).toThrow(/two providers are named "geojson"/)
  })

  describe('on an earth', () => {
    function fakeEarth(zoom = 12) {
      const camera = {
        ready: true,
        readEllipsoidView: () => ({ longitudeDegrees: 6.86, latitudeDegrees: 45.83, zoom }),
        flyTo: vi.fn(async () => true),
        fitBounds: vi.fn(async () => true),
      }
      const earth = { camera, requestFrame: vi.fn(), pointerEventsElement: null } as unknown as Earth
      const listeners = new Map<string, (event: unknown) => void>()
      const disposers: (() => void)[] = []
      const context = {
        earth,
        addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        onDispose: (callback: () => void) => disposers.push(callback),
      } as unknown as PluginContext
      return { earth, camera, context, listeners, disposers }
    }

    it('fits the camera to a place with bounds, flies to a point at the point zoom', async () => {
      const { camera, context } = fakeEarth()
      const geocoder = new Geocoder({ provider: local(), pointZoom: 15, flyTo: { durationSeconds: 1 } })
      geocoder.install(context)
      await geocoder.search('leman')
      geocoder.select(0)
      expect(camera.fitBounds).toHaveBeenCalledWith({ westDegrees: 6.1, southDegrees: 46.2, eastDegrees: 6.9, northDegrees: 46.5 }, { paddingPixels: 48, maximumZoom: 17, durationSeconds: 1 })
      await geocoder.search('montreux')
      geocoder.select(0)
      expect(camera.flyTo).toHaveBeenCalledWith({ longitudeDegrees: 6.91, latitudeDegrees: 46.43, zoom: 15 }, { paddingPixels: 48, maximumZoom: 17, durationSeconds: 1 })
    })

    it('leaves the camera with flyTo: false', async () => {
      const { camera, context } = fakeEarth()
      const geocoder = new Geocoder({ provider: local(), flyTo: false })
      geocoder.install(context)
      await geocoder.search('montreux')
      geocoder.select(0)
      expect(camera.flyTo).not.toHaveBeenCalled()
    })

    it('ranks near the view once zoomed in, not from far out', async () => {
      const near = controlledProvider('near')
      const geocoder = new Geocoder({ provider: near.provider })
      geocoder.install(fakeEarth(12).context)
      void geocoder.search('x1')
      expect(near.calls[0]!.options.proximity).toEqual({ longitudeDegrees: 6.86, latitudeDegrees: 45.83 })
      const far = controlledProvider('far')
      const farGeocoder = new Geocoder({ provider: far.provider })
      farGeocoder.install(fakeEarth(3).context)
      void farGeocoder.search('x1')
      expect(far.calls[0]!.options.proximity).toBeNull()
    })

    it('reverse geocodes each click with reverseOnClick', async () => {
      const { context, listeners } = fakeEarth()
      const geocoder = new Geocoder({ provider: local(), reverseOnClick: true })
      geocoder.install(context)
      const answers: string[][] = []
      geocoder.addEventListener('reverse', event => answers.push(event.results.map(each => each.name)))
      listeners.get('click')!({ geographic: { longitudeDegrees: 6.1405, latitudeDegrees: 46.2, heightMeters: 400 } })
      listeners.get('click')!({ geographic: null })
      await vi.runAllTimersAsync()
      expect(answers).toEqual([['Genève', 'Lac Léman']])
      expect(geocoder.getState().reverse).toMatchObject({ status: 'success', position: { longitudeDegrees: 6.1405, latitudeDegrees: 46.2 } })
    })

    it('says which providers to add when none can reverse geocode', async () => {
      const geocoder = new Geocoder({ provider: { name: 'forward', autocomplete: true, search: async () => [] } })
      await expect(geocoder.reverse({ longitudeDegrees: 0, latitudeDegrees: 0 })).rejects.toThrow(/none of the providers \(forward\) can reverse geocode/)
    })

    it('warns with the fix when a marker has no element to go in', async () => {
      const { context } = fakeEarth()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const geocoder = new Geocoder({ provider: local(), marker: true })
      geocoder.install(context)
      await geocoder.search('montreux')
      geocoder.select(0)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pass `markerContainer`/))
      expect(geocoder.getMarker()).toBeNull()
      warn.mockRestore()
    })
  })
})
