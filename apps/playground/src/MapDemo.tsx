import { Canvas } from '@react-three/fiber'
import { setCameraView, type Earth as EarthImpl, type ViewMode } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  Imagery,
  QuantizedMeshSource,
  RasterTileSource,
  Terrain,
  useEarth,
  useEarthFrame,
} from 'react-three-earth/react'
import { useLayoutEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'

const params = new URLSearchParams(location.search)
const useFixtures = params.has('fixtures')
const terrainUrl = useFixtures ? '/fixtures/terrain/' : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
const imageryUrl = useFixtures ? '/fixtures/imagery/{z}/{x}/{y}.png' : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
const withAtmosphere = params.get('atmosphere') !== '0'
const initialDistanceMeters = Number(params.get('distance') ?? 60_000)
const initialView: ViewMode = params.get('view') === '2d' ? '2d' : '3d'

declare global {
  interface Window {
    earth?: EarthImpl
    setView?: (view: ViewMode) => void
  }
}

/** Mount Fuji from the south-east, late afternoon. */
function InitialView() {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    setCameraView(camera, { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 2000, distanceMeters: initialDistanceMeters, headingDegrees: -40, pitchDegrees: initialDistanceMeters > 1e6 ? -90 : -25 })
    window.earth = earth // agents and tests read earth.inspect()
  }, [camera, earth])
  return null
}

/** Plain lights for the atmosphere-off check, faded out on the flat map like the atmosphere's sun. */
function PlainLights() {
  const [lights] = useState(() => ({ ambient: { current: null as { intensity: number } | null }, sun: { current: null as { intensity: number } | null } }))
  useEarthFrame(earth => {
    const lit = 1 - earth.view.morph
    if (lights.ambient.current) lights.ambient.current.intensity = 0.6 * lit
    if (lights.sun.current) lights.sun.current.intensity = 2 * lit
  })
  return (
    <>
      <ambientLight ref={lights.ambient as never} intensity={0.6} />
      <directionalLight ref={lights.sun as never} position={[1e7, 0, 1e7]} intensity={2} />
    </>
  )
}

export function MapDemo() {
  const [view, setView] = useState<ViewMode>(initialView)
  window.setView = setView // tests switch the view like the button does
  return (
    <>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth date={new Date('2026-11-22T07:00:00Z')} view={view}>
          <InitialView />
          <Terrain>
            <QuantizedMeshSource url={terrainUrl} />
          </Terrain>
          <Imagery>
            <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />
          </Imagery>
          {withAtmosphere ? (
            <Atmosphere />
          ) : (
            <PlainLights />
          )}
          <EarthControls />
        </Earth>
      </Canvas>
      <button
        type="button"
        onClick={() => setView(view === '3d' ? '2d' : '3d')}
        style={{ position: 'absolute', top: 8, right: 8, padding: '6px 12px', font: 'inherit', cursor: 'pointer' }}
      >
        {view === '3d' ? 'Flat map (2D)' : 'Globe (3D)'}
      </button>
      <div style={{ position: 'absolute', bottom: 8, right: 8, opacity: 0.7 }}>
        {useFixtures ? 'Synthetic test tiles' : 'Terrain: Re:Earth Terrain, Mapterhorn. Imagery: © OpenStreetMap contributors'}
      </div>
    </>
  )
}
