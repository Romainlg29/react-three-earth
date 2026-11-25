---
name: geocode-places
description: >
  Use when an earthkit app needs a place search box, like maplibre-gl-geocoder or mapbox-gl-geocoder: the user types
  "Chamonix", picks a result, the camera flies there and a marker drops on it. Covers search as you type (debounce,
  stale answers, cache), keyboard selection and an accessible combobox (useGeocoder), providers (Nominatim, Photon,
  Pelias, MapTiler, Mapbox v5, or your own), searching the app's own GeoJSON offline, reverse geocoding a click (what
  is here?), and the public Nominatim server's no-autocomplete rule.
metadata:
  purpose: 'Documents @earthkit/geocoder: the Geocoder plugin (state, actions, events, flying, marker, reverse), useGeocoder, useGeocoderState and useGeocoderEvent, the bundled providers and the GeocoderProvider interface.'
  type: framework
  framework: 'react'
  library: '@earthkit/geocoder'
  library_version: '0.0.0'
sources:
  - 'Romainlg29/react-three-earth:packages/geocoder/src/Geocoder.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/types.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/text.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/http.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/NominatimProvider.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/PhotonProvider.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/PeliasProvider.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/MapTilerProvider.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/providers/GeoJSONProvider.ts'
  - 'Romainlg29/react-three-earth:packages/geocoder/src/react/index.ts'
  - 'Romainlg29/react-three-earth:apps/playground/src/examples/GeocoderExample.tsx'
requires:
  - '@earthkit/globe#getting-started'
  - '@earthkit/globe#camera-and-events'
  - '@earthkit/globe#markers-and-popups'
---

# Geocode places

Read `@earthkit/globe#getting-started` first. `@earthkit/geocoder` turns text into places and places into camera moves.
The library knows no place names: a provider does, either a geocoding service the app names (every URL comes from the
app) or the app's own GeoJSON, searched in memory. It is headless, like the map controls: no input, no list, no CSS.
The app renders the search box from the state, and `useGeocoder` hands it the props of an accessible combobox.

| maplibre-gl-geocoder / mapbox-gl-geocoder | @earthkit/geocoder |
| --- | --- |
| `new MaplibreGeocoder(api, { maplibregl })`, `map.addControl(geocoder)` | `new Geocoder({ provider })`, `earth.addPlugin(geocoder)` or `<Earth plugins={[geocoder]}>` |
| `forwardGeocode(config)` in `api` | a `GeocoderProvider` (`search`, optional `reverse`), or a bundled one |
| `localGeocoder` | `new GeoJSONProvider({ features })`, listed first in `provider: [...]` |
| `geocoder.query('Paris')` | `geocoder.search('Paris')` (no selection) or `geocoder.submit('Paris')` (selects the best) |
| `geocoder.clear()` | `geocoder.clear()` |
| `results`, `result`, `clear`, `error` events | `results`, `select`, `clear`, `error`, `reverse` events |
| `flyTo`, `marker`, `proximity`, `bbox`, `limit`, `minLength`, `debounceSearch`, `language` | `flyTo`, `marker`, `proximity`, `bounds`, `limit`, `minimumQueryLength`, `debounceMilliseconds`, `language` |
| `reverseGeocode: true` | `reverseOnClick: true`, or `geocoder.reverse(position)` |

## Setup

```tsx
import { Canvas } from '@react-three/fiber'
import { Earth, EarthControls, QuantizedMeshSource, Terrain } from '@earthkit/globe/react'
import { Geocoder, PhotonProvider } from '@earthkit/geocoder'
import { useGeocoder } from '@earthkit/geocoder/react'
import { useMemo } from 'react'

function SearchBox({ geocoder }: { geocoder: Geocoder }) {
  const { inputProps, listboxProps, getOptionProps, results, status } = useGeocoder(geocoder)
  return (
    <div className="search">
      <input {...inputProps} placeholder="Search places" aria-label="Search places" />
      <ul {...listboxProps} aria-label="Places">
        {results.map((result, index) => (
          <li key={result.id} {...getOptionProps(index)}>
            <strong>{result.name}</strong> <span>{result.description}</span>
          </li>
        ))}
      </ul>
      {status === 'error' && <p role="status">The search service did not answer.</p>}
    </div>
  )
}

export function App() {
  // Once: a new Geocoder every render would reinstall the plugin and drop its state.
  const geocoder = useMemo(() => new Geocoder({ provider: new PhotonProvider({ url: 'https://photon.komoot.io' }), marker: true }), [])
  const plugins = useMemo(() => [geocoder], [geocoder])
  return (
    <>
      <Canvas>
        <Earth plugins={plugins}>
          <Terrain>
            <QuantizedMeshSource url="https://example.com/terrain/layer.json" />
          </Terrain>
          <EarthControls />
        </Earth>
      </Canvas>
      <SearchBox geocoder={geocoder} />
    </>
  )
}
```

The search box can live outside the canvas: `useGeocoder` only needs the `Geocoder`. `inputProps` wires typing,
Down / Up (pick a result, wrapping), Enter (select the picked result, or with none picked search every provider and
select the best), Escape (close the list, then clear), focus and blur; `getOptionProps` wires hover and clicks (its
`onMouseDown` keeps the focus in the input so the click lands). Style `[aria-selected='true']` for the picked result.

Vanilla:

```ts
import type { Earth } from '@earthkit/globe'
import { Geocoder, PhotonProvider } from '@earthkit/geocoder'

declare const earth: Earth
declare const input: HTMLInputElement
declare function renderList(names: string[], activeIndex: number, open: boolean): void

const geocoder = new Geocoder({ provider: new PhotonProvider({ url: 'https://photon.komoot.io' }) })
earth.addPlugin(geocoder)
input.addEventListener('input', () => geocoder.setQuery(input.value))
input.addEventListener('keydown', event => geocoder.handleKeyDown(event))
geocoder.subscribe(state => {
  if (input.value !== state.query) input.value = state.query
  renderList(state.results.map(result => result.name), state.activeIndex, state.open)
})
```

## Core Patterns

### Pick a provider

Every provider takes the service's `url` (required), and optionally `name`, `fetch` (tests, proxies), `headers` and
extra `parameters`.

| Provider | `url` | Search as you type | Reverse | Notes |
| --- | --- | --- | --- | --- |
| `PhotonProvider` | `https://photon.komoot.io` or your own | yes | yes | OpenStreetMap, free for fair use, no key |
| `NominatimProvider` | `https://nominatim.openstreetmap.org` or your own | no by default | yes | 1 request a second, no autocomplete on the public server: asked on Enter only. `email`, `countryCodes` |
| `PeliasProvider` | `https://api.geocode.earth/v1`, openrouteservice, your own | yes (`/autocomplete`) | yes | `apiKey` |
| `MapTilerProvider` | `https://api.maptiler.com/geocoding` | yes | yes | `key`, `countryCodes`; reads Mapbox v5 answers too |
| `GeoJSONProvider` | none: in memory | yes | yes | the app's own features; `nameProperty`, `searchProperties`, `description` |

```ts
import { GeoJSONProvider, Geocoder, NominatimProvider, PhotonProvider } from '@earthkit/geocoder'
import type { FeatureCollection } from 'geojson'

declare const stores: FeatureCollection

const geocoder = new Geocoder({
  provider: [
    // Listed in this order: the app's stores above the world's places.
    new GeoJSONProvider({ name: 'stores', features: stores, nameProperty: 'title', searchProperties: ['city', 'code'] }),
    new PhotonProvider({ url: 'https://photon.komoot.io' }),
    // Only on Enter, as its policy asks.
    new NominatimProvider({ url: 'https://nominatim.openstreetmap.org', email: 'maps@example.com' }),
  ],
  limit: 5,
  language: 'fr',
})
```

Several providers are asked together; their results are listed in provider order, each up to `limit`. One that fails
fires `error` and the others still show; `status` is `'error'` only when every provider failed.

### Write a provider

Anything with `name`, `autocomplete` and `search` (and optionally `reverse`) works: a company search API, a database,
a what3words lookup. Pass `options.signal` to `fetch`, so a newer query aborts the request.

```ts
import type { GeocoderProvider, GeocoderResult } from '@earthkit/geocoder'

const assetSearch: GeocoderProvider = {
  name: 'assets',
  autocomplete: true,
  async search(query, { signal, limit }) {
    const response = await fetch(`/api/assets?q=${encodeURIComponent(query)}&limit=${limit}`, { signal })
    const assets: { id: string; label: string; site: string; lon: number; lat: number }[] = await response.json()
    return assets.map(
      (asset): GeocoderResult => ({
        id: `assets:${asset.id}`,
        name: asset.label,
        description: asset.site,
        longitudeDegrees: asset.lon,
        latitudeDegrees: asset.lat,
        bounds: null,
        category: 'asset',
        provider: 'assets',
        raw: asset,
      }),
    )
  },
}
```

`bounds` (west, south, east, north; west greater than east crosses the antimeridian) makes selection fit the place; a
null `bounds` flies to the point at `pointZoom`.

### Search as you type, done right

`setQuery` (what `inputProps.onChange` calls) waits for a pause in typing (`debounceMilliseconds`, 250), then asks the
providers whose `autocomplete` is true. A newer query aborts the older requests and drops their answers, answers are
cached (`cacheSize`, 64), and queries shorter than `minimumQueryLength` (2) clear the list. Old results stay listed
while the next search runs, so the list does not flicker; `resultsQuery` tells which query they answer.

From `proximityMinimumZoom` (9) in, the view's centre is sent as `proximity`, so "Main Street" finds the one nearby;
farther out the world ranks the same. `bounds` keeps to a box. `proximity: false` turns the bias off.

### Selection, camera and marker

`select(indexOrResult)` (Enter, a click) puts the name in the box, closes the list, fits the camera to the place's
`bounds` (padding 48 px, zoom up to 17) or flies to its point at zoom `pointZoom` (16), and fires `select`. Change the
move with `flyTo: { durationSeconds: 2, paddingPixels: 80, maximumZoom: 14 }` (`fitBounds` and `flyTo` options), or
turn it off with `flyTo: false` and move the camera yourself in the `select` event.

`marker: true` drops the default pin on the selection (removed on `clear` or the next selection);
`marker: result => ({ color: '#e11d48', popup })` customises it. Or draw your own from the state:

```tsx
import { Marker } from '@earthkit/globe/react'
import type { Geocoder } from '@earthkit/geocoder'
import { useGeocoderState } from '@earthkit/geocoder/react'

// Inside <Earth>.
function SelectedPlace({ geocoder }: { geocoder: Geocoder }) {
  const selected = useGeocoderState(geocoder, state => state.selected)
  if (selected === null) return null
  return (
    <Marker longitudeDegrees={selected.longitudeDegrees} latitudeDegrees={selected.latitudeDegrees}>
      <div className="place-pin">{selected.name}</div>
    </Marker>
  )
}
```

### Reverse geocoding

`reverseOnClick: true` looks up every click on the map; `geocoder.reverse(position)` does it on demand (a long press,
a draggable marker's `dragend`). Results land in `state.reverse` (`status`, `position`, `results`, most precise first)
and the `reverse` event. Providers pick the detail from the map's zoom where they can (Nominatim). `GeoJSONProvider`
finds points and lines within `reverseToleranceMeters` (500) and the polygons containing the position, smallest first.

```tsx
import type { Geocoder } from '@earthkit/geocoder'
import { useGeocoderState } from '@earthkit/geocoder/react'

function WhatIsHere({ geocoder }: { geocoder: Geocoder }) {
  const reverse = useGeocoderState(geocoder, state => state.reverse)
  if (reverse.status === 'idle') return <p>Click the map.</p>
  return <p role="status">{reverse.status === 'loading' ? 'Looking up…' : (reverse.results[0]?.name ?? 'Nothing named here.')}</p>
}
```

### Events

```ts
import type { Geocoder } from '@earthkit/geocoder'

declare const geocoder: Geocoder

geocoder.addEventListener('select', ({ result }) => console.log('picked', result.name, result.raw))
geocoder.addEventListener('error', ({ provider, error }) => console.warn(provider, error.message))
```

In React, `useGeocoderEvent(geocoder, 'select', handler)` listens while mounted.

## Common Mistakes

### HIGH: Search as you type on the public Nominatim server

Its usage policy forbids autocomplete and allows one request a second; breaking it gets the app blocked.
`NominatimProvider` is asked only on Enter by default. Keep it so, put Photon (or your own Nominatim with
`autocomplete: true`) in front for typing, and set `email`.

### HIGH: A new `Geocoder` or plugins array every render

`<Earth plugins={[new Geocoder(...)]}>` reinstalls the plugin on each render and loses the query and results. Create
it once (`useMemo`, a ref, or module scope) and keep the array stable.

### HIGH: Expecting an input or CSS

Nothing is rendered. Spread `useGeocoder`'s `inputProps`, `listboxProps` and `getOptionProps(index)` on your own
elements, and style them. Writing your own `onKeyDown` instead? Call `geocoder.handleKeyDown(event)` from it, or the
arrow keys and Enter do nothing.

### MEDIUM: Hiding the list with CSS on a state of your own

The list's visibility is `listboxProps.hidden` (open, with results). Closing it yourself while `state.open` is true
leaves `aria-expanded` wrong for screen readers; call `geocoder.close()`.

### MEDIUM: Expecting the library to know a URL

There is no default service: `url` is required on every HTTP provider, so the app decides where queries go (and its
privacy notice can say so).

## Completion

- Typing shows results after a short pause; fast typing sends one request per pause, and an older answer never
  replaces a newer one.
- Down / Up pick a result (`aria-activedescendant` follows), Enter selects it, Escape closes then clears.
- Selecting flies the camera to the place (fits its extent) and, with `marker`, drops a pin.
- The app's own GeoJSON places show above the service's results.
- With `reverseOnClick`, a click on the map names what is there.
- No search as you type reaches the public Nominatim server.
