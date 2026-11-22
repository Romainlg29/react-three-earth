import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AfterburnerDemo } from './AfterburnerDemo'
import { AtmosphereTest } from './AtmosphereTest'
import { MapDemo } from './MapDemo'
import { PrecisionTest } from './PrecisionTest'

const params = new URLSearchParams(location.search)
const test = params.get('test')

const scenes = { precision: PrecisionTest, afterburner: AfterburnerDemo, atmosphere: AtmosphereTest }
const Scene = scenes[test as keyof typeof scenes] ?? MapDemo

// `?strict` renders under React's StrictMode, which runs every effect twice.
createRoot(document.getElementById('root')!).render(params.has('strict') ? <StrictMode><Scene /></StrictMode> : <Scene />)
