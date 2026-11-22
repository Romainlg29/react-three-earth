import { Canvas } from '@react-three/fiber'
import { setCameraView, type Earth as EarthImpl } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  Imagery,
  MapStyleSource,
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
// `?map=vector` drapes a MapLibre style (vector tiles) instead of raster imagery.
const mapStyleUrl = params.get('map') === 'vector' ? (useFixtures ? '/fixtures/style.json' : import.meta.env.VITE_MAP_STYLE_URL) : undefined
if (params.get('map') === 'vector' && mapStyleUrl === undefined) console.warn('Set VITE_MAP_STYLE_URL in apps/playground/.env for ?map=vector; showing raster imagery.')

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
    // `?distance=` (metres) and `?pitch=` (degrees) move the view, for close-up checks.
    const distanceMeters = Number(params.get('distance') ?? 60_000)
    const pitchDegrees = Number(params.get('pitch') ?? -25)
    setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters, headingDegrees: -40, pitchDegrees })
    window.earth = earth // agents and tests read earth.inspect()
  }, [camera, earth])
  return null
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
            {mapStyleUrl !== undefined ? <MapStyleSource url={mapStyleUrl} /> : <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />}
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
        {useFixtures
          ? 'Synthetic test tiles'
          : mapStyleUrl !== undefined
            ? 'Terrain: Re:Earth Terrain, Mapterhorn. Map: see the style\'s attribution'
            : 'Terrain: Re:Earth Terrain, Mapterhorn. Imagery: © OpenStreetMap contributors'}
      </div>
    </>
  )
}
