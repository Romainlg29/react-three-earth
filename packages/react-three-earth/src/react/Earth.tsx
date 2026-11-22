import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { Earth as EarthImpl } from '../core/Earth.js'
import type { ViewMode } from '../view/ViewMorph.js'
import { EarthContext } from './context.js'

export interface EarthProps {
  /** Drives the sun, moon and stars. Default: now, fixed at mount. */
  date?: Date
  /**
   * `'3d'` shows the globe, `'2d'` a flat Web Mercator map of the same terrain and imagery. Changing it
   * morphs between them over `viewTransitionSeconds`; the first value applies at once. Default: '3d'.
   */
  view?: ViewMode
  /** Length of the globe-to-map transition (dive, swap, rise). Default: 2.4. */
  viewTransitionSeconds?: number
  children?: ReactNode
}

/**
 * The root of a map. Its children render in the scene's own frame, which is Earth-centred, Earth-fixed
 * (ECEF) metres.
 *
  * Everything else (`<Terrain>`, `<Imagery>`, `<Atmosphere>`, `<EarthControls>`) goes inside it. */
export function Earth({ date, view = '3d', viewTransitionSeconds, children }: EarthProps) {
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const scene = useThree(state => state.scene)
  const invalidate = useThree(state => state.invalidate)
  const [earth] = useState(() => new EarthImpl({ date, view }))

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

  useLayoutEffect(() => {
    earth.setView(view, { durationSeconds: viewTransitionSeconds })
    invalidate()
  }, [earth, view, viewTransitionSeconds, invalidate])

  useLayoutEffect(() => () => earth.dispose(), [earth])

  useFrame(
    ({ camera, invalidate }, deltaSeconds) => {
      // With frameloop="demand", a morph still gets every frame it needs.
      if (earth.update(camera, renderer, deltaSeconds)) invalidate()
    },
    { id: 'earth:update', phase: 'update' },
  )

  return (
    <EarthContext value={earth}>
      {children}
    </EarthContext>
  )
}
