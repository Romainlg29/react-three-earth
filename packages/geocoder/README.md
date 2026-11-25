# @earthkit/geocoder

Headless place search for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth): the user types
"Chamonix", picks a result with the arrow keys or a tap, and the camera flies there. A plugin built only on the
library's public API, with no UI and no CSS: your app renders the search box, and `useGeocoder` hands it the props of
an accessible combobox.

```sh
pnpm add @earthkit/geocoder @earthkit/globe three@0.187.0
```

```tsx no-check
import { Geocoder, PhotonProvider } from '@earthkit/geocoder'
import { useGeocoder } from '@earthkit/geocoder/react'
import { Earth } from '@earthkit/globe/react'

const geocoder = new Geocoder({ provider: new PhotonProvider({ url: 'https://photon.komoot.io' }), marker: true })
const plugins = [geocoder]

function SearchBox() {
  const { inputProps, listboxProps, getOptionProps, results } = useGeocoder(geocoder)
  return (
    <>
      <input {...inputProps} aria-label="Search places" />
      <ul {...listboxProps}>
        {results.map((result, index) => <li key={result.id} {...getOptionProps(index)}>{result.name}</li>)}
      </ul>
    </>
  )
}

function App() {
  return <Earth plugins={plugins}>{/* sources and layers */}</Earth>
}
```

Vanilla three.js: `earth.addPlugin(geocoder)`, then `geocoder.setQuery(input.value)` and `geocoder.handleKeyDown(event)`.

- **Providers**: Nominatim, Photon, Pelias, MapTiler (and Mapbox v5), the app's own GeoJSON searched in memory, or
  your own `GeocoderProvider`. Every URL comes from the app; there is no default service.
- **Search as you type**: debounced, older answers dropped and their requests aborted, answers cached, the view's
  centre sent as proximity. The public Nominatim server is asked only on Enter, as its policy requires.
- **Selection**: fits the camera to the place's extent or flies to its point, and can drop a `Marker`.
- **Reverse geocoding**: `reverseOnClick` names what is under each click.

## Agent skills

| Skill | Use when |
| --- | --- |
| `@earthkit/geocoder#geocode-places` | an app needs a place search box, providers, or reverse geocoding |

Load it with `npx @tanstack/intent@latest load @earthkit/geocoder#geocode-places`.

## License

MIT
