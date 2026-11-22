import { Canvas } from '@react-three/fiber'
import { setCameraView, type CameraView, type Earth as EarthImpl } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  Imagery,
  MapStyleSource,
  PerformanceStats,
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
// `?map=vector` drapes a MapLibre style (vector tiles) instead of raster imagery.
const mapStyleUrl = params.get('map') === 'vector' ? (useFixtures ? '/fixtures/style.json' : import.meta.env.VITE_MAP_STYLE_URL) : undefined
if (params.get('map') === 'vector' && mapStyleUrl === undefined) console.warn('Set VITE_MAP_STYLE_URL in apps/playground/.env for ?map=vector; showing raster imagery.')
// The atmosphere's lookup textures are cached between page loads, in dev too: the cache key holds
// ATMOSPHERE_PRECOMPUTE_VERSION, which a unit test makes you bump when the generating shaders change.
// `?nocache` always generates them, for timing generation on a device.
const atmosphereCache = !params.has('nocache')
// `?atmosphereBudget=<milliseconds>` (or Infinity) sets the GPU time per frame spent generating them.
const atmosphereBudget = params.has('atmosphereBudget') ? Number(params.get('atmosphereBudget')) : undefined
const showStatistics = params.get('stats') !== '0'
const defaultDate = new Date('2026-11-22T07:00:00Z')
const requestedDate = new Date(params.get('date') ?? Number.NaN)
const date = Number.isNaN(requestedDate.getTime()) ? defaultDate : requestedDate

/**
 * Mount Fuji from the south-east, late afternoon. Override with
 * `?camera=longitude,latitude,height,distance,heading,pitch` (degrees and meters), e.g. from space:
 * `?camera=138.7,35.4,0,8000000,0,-20`.
 */
function readCameraView(): CameraView {
  const defaults = [138.7274, 35.3606, 2000, 60_000, -40, -25] as const
  const given = params.get('camera')?.split(',') ?? []
  // Empty or non-numeric fields keep their default
  const [longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees] = defaults.map((fallback, index) => {
    const value = Number.parseFloat(given[index] ?? '')
    return Number.isFinite(value) ? value : fallback
  }) as [number, number, number, number, number, number]
  return { longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees }
}

declare global {
  interface Window {
    earth?: EarthImpl
  }
}

function InitialView() {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    setCameraView(camera, readCameraView())
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
  return text === '' ? null : <div style={{ position: 'absolute', bottom: 8, left: 8, opacity: 0.8 }}>{text}</div>
}

export function MapDemo() {
  return (
    <>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL: params.has('webgl'), trackTimestamp: showStatistics }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth date={date}>
          <InitialView />
          {showStatistics ? <PerformanceStats /> : null}
          <Terrain>
            <QuantizedMeshSource url={terrainUrl} />
          </Terrain>
          <Imagery>
            {mapStyleUrl !== undefined ? <MapStyleSource url={mapStyleUrl} /> : <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />}
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
        {useFixtures
          ? 'Synthetic test tiles'
          : mapStyleUrl !== undefined
            ? 'Terrain: Re:Earth Terrain, Mapterhorn. Map: see the style\'s attribution'
            : 'Terrain: Re:Earth Terrain, Mapterhorn. Imagery: © OpenStreetMap contributors'}
      </div>
    </>
  )
}
