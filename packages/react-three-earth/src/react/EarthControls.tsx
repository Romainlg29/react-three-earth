import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState } from 'react'

import { EarthControls as EarthControlsImpl, fitClippingPlanes, FlatMapControls } from '../core/EarthControls.js'
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
  const [globeControls] = useState(() => new EarthControlsImpl())
  const [flatMapControls] = useState(() => new FlatMapControls())

  useLayoutEffect(() => {
    globeControls.setScene(earth)
    globeControls.setCamera(camera)
    globeControls.attach(domElement)
    globeControls.enableDamping = enableDamping
    flatMapControls.setCamera(camera)
    flatMapControls.attach(domElement)
    flatMapControls.enableDamping = enableDamping
    return () => {
      globeControls.detach()
      flatMapControls.detach()
    }
  }, [globeControls, flatMapControls, earth, camera, domElement, enableDamping])

  useLayoutEffect(() => {
    flatMapControls.maximumTiltRadians = (maximumFlatMapTiltDegrees * Math.PI) / 180
  }, [flatMapControls, maximumFlatMapTiltDegrees])

  useLayoutEffect(
    () => () => {
      globeControls.dispose()
      flatMapControls.dispose()
    },
    [globeControls, flatMapControls],
  )

  // Before the Earth updates tiles, so tiles are chosen for this frame's camera.
  useFrame(
    ({ delta }) => {
      const view = earth.view
      const onGlobe = view.mode === '3d' && !view.transitioning
      const onFlatMap = view.mode === '2d' && !view.transitioning
      globeControls.enabled = onGlobe
      flatMapControls.enabled = onFlatMap
      if (onGlobe) {
        const tiles = earth.terrain?.tiles
        if (tiles !== undefined && globeControls.ellipsoidGroup !== tiles.group) {
          globeControls.setEllipsoid(tiles.ellipsoid, tiles.group)
        }
        globeControls.update(delta)
      } else if (onFlatMap) {
        flatMapControls.followView(view)
        flatMapControls.update(delta)
      } else if ('near' in camera) {
        // Mid-morph, keep the whole map and globe between the clipping planes.
        fitClippingPlanes(camera, camera.position.distanceTo(view.anchorPosition))
      }
    },
    { id: 'earth:controls', phase: 'update', before: 'earth:update' },
  )

  return null
}
