import { createRoot } from 'react-dom/client'

import { AtmosphereTest } from './AtmosphereTest'
import { MapDemo } from './MapDemo'
import { PrecisionTest } from './PrecisionTest'

const test = new URLSearchParams(location.search).get('test')

const scenes = { precision: PrecisionTest, atmosphere: AtmosphereTest }
const Scene = scenes[test as keyof typeof scenes] ?? MapDemo

createRoot(document.getElementById('root')!).render(<Scene />)
