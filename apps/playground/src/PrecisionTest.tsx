// Centimetre test: two 2 mm cubes 1 cm apart, on the summit of Mount Fuji, seen from 5 cm away.
// At ECEF magnitudes (about 6.4e6 m), a 32-bit float only resolves about 0.5 m, so without
// camera-relative 64-bit matrices the cubes collapse onto each other or jitter.
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { setCameraView, toCartesian } from '@earthkit/globe'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Mesh, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

const params = new URLSearchParams(location.search)
const highPrecision = params.get('highPrecision') !== '0'
const point = { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 3776 }
const SEPARATION_METERS = 0.01

declare global {
  interface Window {
    precision?: {
      highPrecision: boolean
      /** Expected pixel centres from 64-bit CPU math, in CSS pixels. */
      expected(): { red: [number, number]; blue: [number, number] }
      /** Moves the camera east by this many metres. */
      nudge(meters: number): void
      frames: number
    }
  }
}

function Scene() {
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const camera = useThree(state => state.camera)
  const scene = useThree(state => state.scene)
  const size = useThree(state => state.size)
  const red = useRef<Mesh>(null)
  const blue = useRef<Mesh>(null)
  const frames = useRef(0)

  // Cubes sit either side of the summit along the camera's right axis, so they appear side by side.
  const { a, b, right } = useMemo(() => {
    setCameraView(camera, { ...point, distanceMeters: 0.05, headingDegrees: 0, pitchDegrees: -1 })
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const summit = toCartesian(point)
    return {
      a: summit.clone().addScaledVector(right, -SEPARATION_METERS / 2),
      b: summit.clone().addScaledVector(right, SEPARATION_METERS / 2),
      right,
    }
  }, [camera])

  useLayoutEffect(() => {
    renderer.highPrecision = highPrecision
    scene.background = new Color(0)
    red.current?.position.copy(a)
    blue.current?.position.copy(b)
    window.precision = {
      highPrecision,
      expected: () => {
        camera.updateMatrixWorld()
        const project = (v: Vector3): [number, number] => {
          const ndc = v.clone().project(camera)
          return [((ndc.x + 1) / 2) * size.width, ((1 - ndc.y) / 2) * size.height]
        }
        return { red: project(a), blue: project(b) }
      },
      nudge: meters => {
        camera.position.addScaledVector(right, meters)
        camera.updateMatrixWorld()
      },
      frames: 0,
    }
  }, [renderer, scene, camera, a, b, right, size])

  useFrame(() => {
    frames.current++
    if (window.precision) window.precision.frames = frames.current
  })

  return (
    <>
      <mesh ref={red}>
        <boxGeometry args={[0.002, 0.002, 0.002]} />
        <meshBasicNodeMaterial color="red" />
      </mesh>
      <mesh ref={blue}>
        <boxGeometry args={[0.002, 0.002, 0.002]} />
        <meshBasicNodeMaterial color="blue" />
      </mesh>
    </>
  )
}

export function PrecisionTest() {
  return (
    <Canvas renderer camera={{ fov: 50, near: 0.001, far: 10 }} dpr={1}>
      <Scene />
    </Canvas>
  )
}
