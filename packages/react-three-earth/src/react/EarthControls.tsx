import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState } from 'react'

import { EarthControls as EarthControlsImpl } from '../core/EarthControls.js'
import { useEarth } from './context.js'

export interface EarthControlsProps {
  /** Smooth the camera's motion after the pointer lets go. Default: true. */
  enableDamping?: boolean
}

/** Orbit, pan and zoom around the globe with mouse or touch. */
export function EarthControls({ enableDamping = true }: EarthControlsProps) {
  const earth = useEarth()
  const camera = useThree(state => state.camera)
  const domElement = useThree(state => state.events.connected ?? state.renderer.domElement) as HTMLElement
  const [controls] = useState(() => new EarthControlsImpl())

  useLayoutEffect(() => {
    controls.setScene(earth)
    controls.setCamera(camera)
    controls.attach(domElement)
    controls.enableDamping = enableDamping
    return () => controls.detach()
  }, [controls, earth, camera, domElement, enableDamping])

  useLayoutEffect(() => () => controls.dispose(), [controls])

  // Before the Earth updates tiles, so tiles are chosen for this frame's camera.
  useFrame(
    ({ delta }) => {
      const tiles = earth.terrain?.tiles
      if (tiles !== undefined && controls.ellipsoidGroup !== tiles.group) {
        controls.setEllipsoid(tiles.ellipsoid, tiles.group)
      }
      controls.update(delta)
    },
    { id: 'earth:controls', phase: 'update', before: 'earth:update' },
  )

  return null
}
