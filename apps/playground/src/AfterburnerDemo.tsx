import { volume_pass, type VolumePass } from '@aeronautic/core'
import { VolumePassContext } from '@aeronautic/core/react'
import type { AfterburnerHooks } from '@aeronautic/afterburner'
import { Afterburner, AfterburnerBatch, type AfterburnerBatchHandle } from '@aeronautic/afterburner/react'
import { Canvas, useThree } from '@react-three/fiber'
import { useFrame } from '@react-three/fiber/extension'
import { useRenderPipeline } from '@react-three/tsl'
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { AtmosphereParameters, setCameraView, toCartesian, type Earth as EarthImpl } from '@earthkit/globe'
import { Atmosphere, Earth, EarthControls, Imagery, QuantizedMeshSource, RasterTileSource, Terrain, useAtmosphere, useEarth } from '@earthkit/globe/react'
import { FloatType, RenderTarget, Vector3 } from 'three'
import { Fn, screenCoordinate, select, uniform, vec4 } from 'three/tsl'
import { NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu'

import { createAerialPerspectiveHook, getAfterburnerLighting, type AfterburnerLighting } from './aeronautic/atmosphereBridge'

const params = new URLSearchParams(location.search)
const useFixtures = params.has('fixtures')
const terrainUrl = useFixtures ? '/fixtures/terrain/' : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
const withPlume = params.get('plume') !== '0'
const imageryUrl = useFixtures ? '/fixtures/imagery/{z}/{x}/{y}.png' : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')

/** A nozzle 3 km up, west of Fuji, its exhaust streaming east. */
const NOZZLE = { longitudeDegrees: 138.6, latitudeDegrees: 35.33, heightMeters: 3000 }
const NOZZLE_POSITION = toCartesian(NOZZLE)
const EAST = new Vector3(-Math.sin((NOZZLE.longitudeDegrees * Math.PI) / 180), Math.cos((NOZZLE.longitudeDegrees * Math.PI) / 180), 0)

/** A hazy day: 40 km visibility, the haze worked out as @aeronautic/core does. */
const ATMOSPHERE_PARAMETERS = AtmosphereParameters.fromVisibility(40_000)

declare global {
  interface Window {
    earth?: EarthImpl
    afterburnerDemo?: {
      frames: number
      lighting: AfterburnerLighting | null
      /** Sunlight and skylight at the nozzle from the CPU and from the shaders, for the browser checks. */
      compareIlluminance?: () => Promise<{ cpu: number[]; gpu: number[] }>
    }
  }
}

/** Renders the shader illuminance at the nozzle into a 2×1 target and reads it back, next to the CPU's. */
function IlluminanceProbe() {
  const atmosphere = useAtmosphere()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  useLayoutEffect(() => {
    const target = new RenderTarget(2, 1, { type: FloatType, depthBuffer: false })
    const position = uniform(NOZZLE_POSITION.clone().divideScalar(1000))
    const { sun, sky } = atmosphere.getSunAndSkyIlluminanceNode(position)
    const material = new NodeMaterial()
    material.fragmentNode = Fn(() => vec4(select(screenCoordinate.x.lessThan(1), sun, sky), 1))()
    const quad = new QuadMesh(material)
    const compareIlluminance = async () => {
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      quad.render(renderer)
      renderer.setRenderTarget(previous)
      const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 2, 1)) as Float32Array
      const cpu = atmosphere.getSunAndSkyIlluminance(NOZZLE_POSITION)
      return { cpu: [...cpu.sun.toArray(), ...cpu.sky.toArray()], gpu: [...pixels.slice(0, 3), ...pixels.slice(4, 7)] }
    }
    if (window.afterburnerDemo) window.afterburnerDemo.compareIlluminance = compareIlluminance
    return () => {
      material.dispose()
      target.dispose()
    }
  }, [atmosphere, renderer])
  return null
}

function InitialView() {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    // Abeam the plume, a little below it, looking north at the terrain and the horizon
    setCameraView(camera, { ...NOZZLE, heightMeters: NOZZLE.heightMeters + 3, distanceMeters: 28, headingDegrees: -20, pitchDegrees: -4 })
    window.earth = earth
    window.afterburnerDemo = { frames: 0, lighting: null }
  }, [camera, earth])
  useFrame(() => {
    if (window.afterburnerDemo) window.afterburnerDemo.frames++
  })
  return null
}

/**
 * The canvas's render pipeline, owned by @aeronautic's volume pass: the opaque scene goes through the
 * atmosphere's aerial perspective (its backdrop), the plumes are drawn at half resolution over it.
 */
function VolumePipeline({ children }: { children: ReactNode }) {
  const atmosphere = useAtmosphere()
  const scene = useThree(state => state.scene)
  const camera = useThree(state => state.camera)
  const split: VolumePass = useMemo(
    () => volume_pass(scene, camera, { resolutionScale: 0.5, backdropNode: atmosphere.createBackdropNode(camera) }),
    [atmosphere, scene, camera],
  )
  useRenderPipeline(({ renderPipeline }) => {
    renderPipeline.outputNode = split.output as never
  })
  // The pass owns two render targets (the scene and the volumes) besides the backdrop's
  useEffect(
    () => () => {
      split.scenePass.dispose()
      split.volumePass.dispose()
    },
    [split],
  )
  return <VolumePassContext value={split}>{children}</VolumePassContext>
}

/** An afterburner lit by the atmosphere's sun and sky at its position, and hazed by the air in front of it. */
function AtmosphericAfterburner() {
  const atmosphere = useAtmosphere()
  const batch = useRef<AfterburnerBatchHandle>(null)
  const hooks: AfterburnerHooks = useMemo(() => ({ radiance: createAerialPerspectiveHook(atmosphere) }), [atmosphere])
  const lighting = useMemo<Partial<AfterburnerLighting>>(() => ({}), [])
  useFrame(() => {
    // Cheap: a 500-step integral on the CPU, and uniform writes
    getAfterburnerLighting(atmosphere, NOZZLE_POSITION, lighting)
    batch.current?.updateProfile(lighting as AfterburnerLighting)
    if (window.afterburnerDemo) window.afterburnerDemo.lighting = { ...(lighting as AfterburnerLighting) }
  })
  return (
    <AfterburnerBatch ref={batch} preset="afterburner" hooks={hooks} source={null}>
      <Afterburner position={NOZZLE_POSITION} direction={[EAST.x, EAST.y, EAST.z]} throttle={1.1} source={null} params={{ nozzleRadiusM: 0.55 }} />
    </AfterburnerBatch>
  )
}

export function AfterburnerDemo() {
  return (
    <Canvas renderer={{ antialias: true, reversedDepthBuffer: true }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
      <Earth date={new Date('2026-11-22T03:00:00Z')}>
        <InitialView />
        <Terrain>
          <QuantizedMeshSource url={terrainUrl} />
        </Terrain>
        <Imagery>
          <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} />
        </Imagery>
        <Atmosphere parameters={ATMOSPHERE_PARAMETERS} renderPipeline={false}>
          <IlluminanceProbe />
          <VolumePipeline>{withPlume ? <AtmosphericAfterburner /> : null}</VolumePipeline>
        </Atmosphere>
        <EarthControls />
      </Earth>
    </Canvas>
  )
}
