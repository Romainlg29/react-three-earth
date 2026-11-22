import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState } from 'react'

import { EarthViewControls } from '../core/EarthControls.js'
import { useEarth } from './context.js'

export interface EarthControlsProps {
  /** Smooth the camera's motion after the pointer lets go. Default: true. */
  enableDamping?: boolean
  /** On the flat map, the steepest tilt away from looking straight down, in degrees. Default: 0. */
  maximumFlatMapTiltDegrees?: number
}

/**
 * Orbit, pan and zoom around the globe with mouse or touch; pan, zoom and rotate on the flat map
 * (`<Earth view="2d">`). Input is ignored while the view morphs.
 */
export function EarthControls({ enableDamping = true, maximumFlatMapTiltDegrees = 0 }: EarthControlsProps) {
  const earth = useEarth()
  const camera = useThree(state => state.camera)
  const domElement = useThree(state => state.events.connected ?? state.renderer.domElement) as HTMLElement
  const [controls] = useState(() => new EarthViewControls(earth))

  useLayoutEffect(() => {
    controls.setCamera(camera)
    controls.attach(domElement)
    controls.enableDamping = enableDamping
    return () => controls.detach()
  }, [controls, camera, domElement, enableDamping])

  useLayoutEffect(() => {
    controls.flatMap.maximumTiltRadians = (maximumFlatMapTiltDegrees * Math.PI) / 180
  }, [controls, maximumFlatMapTiltDegrees])

  useLayoutEffect(() => () => controls.dispose(), [controls])

  // Before the Earth updates tiles, so tiles are chosen for this frame's camera.
  useFrame(({ delta }) => controls.update(delta), { id: 'earth:controls', phase: 'update', before: 'earth:update' })

  return null
}
