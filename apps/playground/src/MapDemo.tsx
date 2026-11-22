import { Canvas } from '@react-three/fiber'
import { setCameraView, type CameraView, type Earth as EarthImpl } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  Imagery,
  PerformanceStats,
  QuantizedMeshSource,
  RasterTileSource,
  Terrain,
  useEarth,
} from 'react-three-earth/react'
import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'

const params = new URLSearchParams(location.search)
const useFixtures = params.has('fixtures')
const terrainUrl = useFixtures ? '/fixtures/terrain/' : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
const imageryUrl = useFixtures ? '/fixtures/imagery/{z}/{x}/{y}.png' : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
const withAtmosphere = params.get('atmosphere') !== '0'
const showStatistics = params.get('stats') !== '0'
const date = new Date(params.get('date') ?? '2026-11-22T07:00:00Z')

/**
 * Mount Fuji from the south-east, late afternoon. Override with
 * `?camera=longitude,latitude,height,distance,heading,pitch` (degrees and meters), e.g. from space:
 * `?camera=138.7,35.4,0,8000000,0,-20`.
 */
function readCameraView(): CameraView {
  const values = params.get('camera')?.split(',').map(Number) ?? []
  const [longitudeDegrees = 138.7274, latitudeDegrees = 35.3606, heightMeters = 2000, distanceMeters = 60_000, headingDegrees = -40, pitchDegrees = -25] = values
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

export function MapDemo() {
  return (
    <>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, trackTimestamp: showStatistics }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth date={date}>
          <InitialView />
          {showStatistics ? <PerformanceStats /> : null}
          <Terrain>
            <QuantizedMeshSource url={terrainUrl} />
          </Terrain>
          <Imagery>
            <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />
          </Imagery>
          {withAtmosphere ? (
            <Atmosphere />
          ) : (
            <>
              <ambientLight intensity={0.6} />
              <directionalLight position={[1e7, 0, 1e7]} intensity={2} />
            </>
          )}
          <EarthControls />
        </Earth>
      </Canvas>
      <div style={{ position: 'absolute', bottom: 8, right: 8, opacity: 0.7 }}>
        {useFixtures ? 'Synthetic test tiles' : 'Terrain: Re:Earth Terrain, Mapterhorn. Imagery: © OpenStreetMap contributors'}
      </div>
    </>
  )
}
