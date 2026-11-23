import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { Earth as EarthImpl } from '../core/Earth.js'
import type { MapViewChange } from '../core/EarthCamera.js'
import type { EarthPlugin } from '../plugins/plugin.js'
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
  /**
   * Where the camera starts, applied on the first frame (`earth.camera.jumpTo`). Read once at mount; move
   * the camera afterwards with `useEarthCamera()`. Default: the camera stays where it is.
   * @example <Earth initialView={{ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 11, pitchDegrees: -60 }}>
   */
  initialView?: MapViewChange
  /**
   * Plugins to install (`earth.addPlugin`). Compared by identity: create the array once, outside render or
   * in a `useMemo`, or every render reinstalls them. Plugins added or removed from the array are installed or
   * removed. Default: none.
   * @example const plugins = [sdfShapes()]  // module scope
   * <Earth plugins={plugins}>…</Earth>
   */
  plugins?: readonly EarthPlugin[]
  children?: ReactNode
}

/**
 * The root of a map. Its children render in the scene's own frame, which is Earth-centred, Earth-fixed
 * (ECEF) metres.
 *
  * Everything else (`<Terrain>`, `<Imagery>`, `<Atmosphere>`, `<EarthControls>`) goes inside it. */
export function Earth({ date, view = '3d', viewTransitionSeconds, initialView, plugins, children }: EarthProps) {
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const scene = useThree(state => state.scene)
  const invalidate = useThree(state => state.invalidate)
  const domElement = useThree(state => state.events.connected ?? state.renderer.domElement) as HTMLElement
  const canvas = useThree(state => state.renderer.domElement) as HTMLElement
  const [earth] = useState(() => new EarthImpl({ date, view, initialView }))

  useLayoutEffect(() => {
    earth.connect(renderer)
    scene.add(earth)
    return () => {
      scene.remove(earth)
    }
  }, [earth, renderer, scene])

  useLayoutEffect(() => {
    // `click`, `doubleclick`, `contextmenu` and `pointermove`, with the position on Earth.
    earth.attachPointerEvents(domElement, { canvas })
    return () => earth.detachPointerEvents()
  }, [earth, domElement, canvas])

  useLayoutEffect(() => {
    if (date !== undefined) earth.date = date
  }, [earth, date])

  useLayoutEffect(() => {
    earth.setView(view, { durationSeconds: viewTransitionSeconds })
    invalidate()
  }, [earth, view, viewTransitionSeconds, invalidate])

  useLayoutEffect(() => {
    // With frameloop="demand", changes made between frames (earth.camera.jumpTo, flyTo) still get drawn.
    const listener = () => invalidate()
    earth.addEventListener('framerequest', listener)
    return () => earth.removeEventListener('framerequest', listener)
  }, [earth, invalidate])

  useLayoutEffect(() => {
    if (plugins === undefined || plugins.length === 0) return
    for (const plugin of plugins) earth.addPlugin(plugin)
    return () => {
      for (const plugin of [...plugins].reverse()) earth.removePlugin(plugin)
    }
  }, [earth, plugins])

  useLayoutEffect(() => () => earth.dispose(), [earth])

  useFrame(
    ({ camera, invalidate }, deltaSeconds) => {
      // With frameloop="demand", a morph or a camera animation still gets every frame it needs.
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
