import { Canvas } from '@react-three/fiber'
import { setCameraView, type Earth as EarthImpl } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  Imagery,
  QuantizedMeshSource,
  RasterTileSource,
  Terrain,
  useEarth,
} from 'react-three-earth/react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'

const params = new URLSearchParams(location.search)
const useFixtures = params.has('fixtures')
const terrainUrl = useFixtures ? `${import.meta.env.BASE_URL}fixtures/terrain/` : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
const imageryUrl = useFixtures ? `${import.meta.env.BASE_URL}fixtures/imagery/{z}/{x}/{y}.png` : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
const withAtmosphere = params.get('atmosphere') !== '0'
// `?nocache` always generates the atmosphere's lookup textures, for timing generation on a device. The
// dev server never caches them, so that edits to the atmosphere's shaders always show.
const atmosphereCache = import.meta.env.PROD && !params.has('nocache')
// `?atmosphereBudget=<milliseconds>` (or Infinity) sets the GPU time per frame spent generating them.
const atmosphereBudget = params.has('atmosphereBudget') ? Number(params.get('atmosphereBudget')) : undefined

declare global {
  interface Window {
    earth?: EarthImpl
  }
}

/** Mount Fuji from the south-east, late afternoon. */
function InitialView() {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: 60_000, headingDegrees: -40, pitchDegrees: -25 })
    window.earth = earth // agents and tests read earth.inspect()
  }, [camera, earth])
  return null
}

/** How the atmosphere's lookup textures were made, for reading timings off a phone. */
function AtmosphereStatus() {
  const [text, setText] = useState('')
  useEffect(() => {
    const startMilliseconds = performance.now()
    const interval = setInterval(() => {
      const atmosphere = window.earth?.inspect().atmosphere
      if (atmosphere == null) return setText('')
      if (!atmosphere.ready) return setText(`Atmosphere: generating… ${((performance.now() - startMilliseconds) / 1000).toFixed(0)} s`)
      const seconds = ((atmosphere.generationTimeMilliseconds ?? 0) / 1000).toFixed(2)
      setText(`Atmosphere: ${atmosphere.loadedFromCache ? 'loaded from cache' : 'generated'} in ${seconds} s, ${atmosphere.generationFrames} frames`)
      clearInterval(interval)
    }, 250)
    return () => clearInterval(interval)
  }, [])
  return text === '' ? null : <div style={{ position: 'absolute', top: 8, left: 8, opacity: 0.8 }}>{text}</div>
}

export function MapDemo() {
  return (
    <>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth date={new Date('2026-11-22T07:00:00Z')}>
          <InitialView />
          <Terrain>
            <QuantizedMeshSource url={terrainUrl} />
          </Terrain>
          <Imagery>
            <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />
          </Imagery>
          {withAtmosphere ? (
            <Atmosphere cache={atmosphereCache} generationBudgetMillisecondsPerFrame={atmosphereBudget} />
          ) : (
            <>
              <ambientLight intensity={0.6} />
              <directionalLight position={[1e7, 0, 1e7]} intensity={2} />
            </>
          )}
          <EarthControls />
        </Earth>
      </Canvas>
      {withAtmosphere && <AtmosphereStatus />}
      <div style={{ position: 'absolute', bottom: 8, right: 8, opacity: 0.7 }}>
        {useFixtures ? 'Synthetic test tiles' : 'Terrain: Re:Earth Terrain, Mapterhorn. Imagery: © OpenStreetMap contributors'}
      </div>
    </>
  )
}
