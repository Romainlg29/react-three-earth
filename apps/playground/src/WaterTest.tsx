// Water mask test (`?test=water`): the terrain painted red on land and blue on water from `terrainWaterMask`, unlit, on
// the water fixture (the fixture ridges with the sea left in). `?terrain=dem` builds it from Terrarium tiles (water from
// elevation, seafloor drawn at sea level); otherwise from quantized-mesh tiles (water from their `watermask` extension).
// `?camera=` as in the map demo; `?view=2d` lays it on the flat map.
import { Canvas, useThree } from '@react-three/fiber'
import { setCameraView, terrainWaterMask, type Earth as EarthImpl, type ViewMode } from '@earthkit/globe'
import { Earth, QuantizedMeshSource, RasterDemSource, Terrain, useEarth } from '@earthkit/globe/react'
import { useLayoutEffect } from 'react'
import { color, mix } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

const params = new URLSearchParams(location.search)
const fromElevation = params.get('terrain') === 'dem'
const view: ViewMode = params.get('view') === '2d' ? '2d' : '3d'
const [longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees] = [-90, 0, 0, 400_000, 0, -90].map((fallback, index) => {
  const value = Number.parseFloat(params.get('camera')?.split(',')[index] ?? '')
  return Number.isFinite(value) ? value : fallback
}) as [number, number, number, number, number, number]

const waterColor = mix(color('#ff0000'), color('#0000ff'), terrainWaterMask)
const createMaterial = () => {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = waterColor
  return material
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
    setCameraView(camera, { longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees })
    window.earth = earth
  }, [camera, earth])
  return null
}

export function WaterTest() {
  return (
    <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL: params.has('webgl') }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={1}>
      <Earth view={view}>
        <InitialView />
        <Terrain createMaterial={createMaterial}>
          {fromElevation ? (
            <RasterDemSource url={`${import.meta.env.BASE_URL}fixtures/dem/{z}/{x}/{y}.png?water`} encoding="terrarium" maximumZoom={12} flattenBelowSeaLevel />
          ) : (
            <QuantizedMeshSource url={`${import.meta.env.BASE_URL}fixtures/terrain-water/`} />
          )}
        </Terrain>
      </Earth>
    </Canvas>
  )
}
