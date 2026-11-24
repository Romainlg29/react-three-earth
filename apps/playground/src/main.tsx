import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AfterburnerDemo } from './AfterburnerDemo'
import { AtmosphereTest } from './AtmosphereTest'
import { CityExample } from './examples/CityExample'
import { EmbeddedExample } from './examples/EmbeddedExample'
import { HeatmapExample } from './examples/HeatmapExample'
import { OverlayExample } from './examples/OverlayExample'
import { PeaksExample } from './examples/PeaksExample'
import { TerrainExample } from './examples/TerrainExample'
import { WorldLabelsExample } from './examples/WorldLabelsExample'
import { MapDemo } from './MapDemo'
import { PrecisionTest } from './PrecisionTest'

const params = new URLSearchParams(location.search)
const test = params.get('test')

const scenes = { precision: PrecisionTest, afterburner: AfterburnerDemo, atmosphere: AtmosphereTest }
// `?example=<name>`: the gallery's focused examples (src/examples/), on live data or `?fixtures`.
const examples = { city: CityExample, labels: WorldLabelsExample, geojson: PeaksExample, heatmap: HeatmapExample, terrain: TerrainExample, overlay: OverlayExample, embedded: EmbeddedExample }
const Scene = examples[params.get('example') as keyof typeof examples] ?? scenes[test as keyof typeof scenes] ?? MapDemo

// `?strict` renders under React's StrictMode, which runs every effect twice.
createRoot(document.getElementById('root')!).render(params.has('strict') ? <StrictMode><Scene /></StrictMode> : <Scene />)
