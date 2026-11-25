# @earthkit/water

A physically based sea for [`@earthkit/globe`](https://github.com/Romainlg29/react-three-earth), as a plugin. Wherever
the terrain is water, over the imagery and any terrain style:

- the colour comes from the water's optics (absorption and scattering of seawater, phytoplankton, dissolved matter), so
  clear ocean is deep blue and productive coasts green-blue, with the seafloor through shallow water;
- the gloss comes from the wind (Cox & Munk), so under `<Atmosphere>` the sea mirrors the sky and the sun's glint widens
  as the wind rises, and whitecaps pale a gale;
- near the camera, waves from a JONSWAP spectrum (wind speed, direction and fetch), simulated by FFT;
- on the flat map, the sea takes a map colour.

```sh
pnpm add @earthkit/water @earthkit/globe three@0.187.0
```

```tsx no-check
import { Atmosphere, Earth, QuantizedMeshSource, Terrain } from '@earthkit/globe/react'
import { Water } from '@earthkit/water/react'

function App() {
  return (
    <Earth>
      <Terrain>
        <QuantizedMeshSource url="https://example.com/terrain" />
      </Terrain>
      <Atmosphere />
      <Water preset="open-ocean" />
    </Earth>
  )
}
```

- Presets: `map` (flat light blue, as street maps), `calm`, `breeze` (default), `open-ocean`, `storm`, `coastal`.
- Settings: `windSpeedMetersPerSecond`, `windDirectionDegrees`, `fetchKilometers`, `temperatureCelsius`, `waves`,
  `chlorophyllMilligramsPerCubicMeter`, `salinityPartsPerThousand`,
  `depthFromElevation`, `imageryOpacity`, `flatMapColor`, and `color` / `roughness` for a stylised sea. Changing them
  updates uniforms only.
- Vanilla: `earth.addPlugin(new Water({ preset: 'calm' }))`, `water.setSettings(...)`.
- The terrain source must say where the water is: a quantized-mesh server with the water mask, or `RasterDemSource`
  (heights at or below sea level).

## Agent skill

`water` (in `skills/`): presets, the physical settings, the flat map and imagery, common mistakes.

## License

MIT
