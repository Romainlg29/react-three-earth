import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { Earth as EarthImpl } from '../core/Earth.js'
import { EarthContext } from './context.js'

export interface EarthProps {
  /** Drives the sun, moon and stars. Default: now, fixed at mount. */
  date?: Date
  children?: ReactNode
}

/**
 * The root of a map. Its children render in the scene's own frame, which is Earth-centred, Earth-fixed
 * (ECEF) metres.
 *
  * Everything else (`<Terrain>`, `<Imagery>`, `<Atmosphere>`, `<EarthControls>`) goes inside it. */
export function Earth({ date, children }: EarthProps) {
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const scene = useThree(state => state.scene)
  const [earth] = useState(() => new EarthImpl({ date }))

  useLayoutEffect(() => {
    earth.connect(renderer)
    scene.add(earth)
    return () => {
      scene.remove(earth)
    }
  }, [earth, renderer, scene])

  useLayoutEffect(() => {
    if (date !== undefined) earth.date = date
  }, [earth, date])

  useLayoutEffect(() => () => earth.dispose(), [earth])

  useFrame(
    ({ camera }) => {
      earth.update(camera, renderer)
    },
    { id: 'earth:update', phase: 'update' },
  )

  return (
    <EarthContext value={earth}>
      {children}
    </EarthContext>
  )
}
