import { useFrame, useThree } from '@react-three/fiber/extension'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { Earth as EarthImpl } from '../core/Earth.js'
import type { MapViewChange } from '../core/EarthCamera.js'
import type { EarthPlugin } from '../plugins/plugin.js'
import type { ViewMode } from '../view/ViewMorph.js'
import { EarthContext } from './context.js'
import { RenderPipelineClaimContext, RenderPipelineHost } from './RenderPipeline.js'

export interface EarthProps {
  /** Drives the sun, moon and stars. Default: now, fixed at mount. */
  date?: Date
  /**
   * `'3d'` shows the globe, `'2d'` a flat Web Mercator map of the same terrain and imagery. Changing it
   * morphs between them over `viewTransitionSeconds`; the first value applies at once. Default: the first map
   * style's root `projection` (`'mercator'` is `'2d'`), else '3d'.
   */
  view?: ViewMode
  /** Length of the globe-to-map transition, in which the map unrolls off the globe. Default: 1.8. */
  viewTransitionSeconds?: number
  /**
   * Where the camera starts, applied on the first frame (`earth.camera.jumpTo`). Read once at mount; move
   * the camera afterwards with `useEarthCamera()`. Default: the first map style's root `center`, `zoom`, `bearing`
   * and `pitch` when it loads, if nothing moved the camera before; otherwise the camera stays where it is.
   * @example <Earth initialView={{ longitudeDegrees: 2.35, latitudeDegrees: 48.86, zoom: 11, pitchDegrees: -60 }}>
   */
  initialView?: MapViewChange
  /**
   * Plugins to install (`earth.addPlugin`). Compared by identity: create the array once, outside render or
   * in a `useMemo`, or every render reinstalls them. When the array changes, plugins in both arrays stay
   * installed; new ones are installed and dropped ones removed. Default: none.
   * @example const plugins = [sdfShapes()]  // module scope
   * <Earth plugins={plugins}>…</Earth>
   */
  plugins?: readonly EarthPlugin[]
  /**
   * Whether `<Earth>` sets the canvas's render pipeline for plugins' render passes (`earth.renderPasses`)
   * while no `<Atmosphere>` or `<EarthRenderPipelineHost>` does, and only while passes are registered. False
   * leaves the pipeline to the app's own `useRenderPipeline`, which then builds the passes with an
   * `EarthRenderPipeline` (or calls `useClaimRenderPipeline()` from that component instead). Default: true.
   */
  renderPipeline?: boolean
  children?: ReactNode
}

/**
 * The root of a map. Its children render in the scene's own frame, which is Earth-centred, Earth-fixed
 * (ECEF) metres.
 *
  * Everything else (`<Terrain>`, `<Imagery>`, `<Atmosphere>`, `<EarthControls>`) goes inside it. */
export function Earth({ date, view, viewTransitionSeconds, initialView, plugins, renderPipeline = true, children }: EarthProps) {
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
    // Without `view`, the style's root `projection` (or the globe) stands.
    if (view === undefined) return
    earth.setView(view, { durationSeconds: viewTransitionSeconds })
    invalidate()
  }, [earth, view, viewTransitionSeconds, invalidate])

  useLayoutEffect(() => {
    // With frameloop="demand", changes made between frames (earth.camera.jumpTo, flyTo) still get drawn.
    const listener = () => invalidate()
    earth.addEventListener('framerequest', listener)
    return () => earth.removeEventListener('framerequest', listener)
  }, [earth, invalidate])

  // Plugins kept from one array to the next stay installed, with their state; only those added or dropped change.
  const installedPlugins = useRef<EarthPlugin[]>([])
  useLayoutEffect(() => {
    const next = plugins ?? []
    const installed = installedPlugins.current
    for (const plugin of [...installed].reverse()) if (!next.includes(plugin)) earth.removePlugin(plugin)
    const kept = installed.filter(plugin => next.includes(plugin))
    try {
      for (const plugin of next) {
        if (kept.includes(plugin)) continue
        earth.addPlugin(plugin)
        kept.push(plugin)
      }
    } finally {
      // A plugin that throws is not listed: those installed before it are still removed at unmount.
      installedPlugins.current = kept
    }
  }, [earth, plugins])
  useLayoutEffect(
    () => () => {
      for (const plugin of [...installedPlugins.current].reverse()) earth.removePlugin(plugin)
      installedPlugins.current = []
    },
    [earth],
  )

  useLayoutEffect(() => () => earth.dispose(), [earth])

  // Without an <Atmosphere> (or another claimant) in charge of the render pipeline, render passes still need
  // one: host it here, only while passes are registered (otherwise R3F renders the scene directly, as before).
  const [renderPipelineClaims, setRenderPipelineClaims] = useState(0)
  const claimRenderPipeline = useCallback(() => {
    setRenderPipelineClaims(count => count + 1)
    return () => setRenderPipelineClaims(count => count - 1)
  }, [])
  const subscribeRenderPasses = useCallback((listener: () => void) => earth.renderPasses.subscribe(listener), [earth])
  const renderPassCount = useSyncExternalStore(subscribeRenderPasses, () => earth.renderPasses.size)

  useFrame(
    ({ camera, invalidate }, deltaSeconds) => {
      // With frameloop="demand", a morph or a camera animation still gets every frame it needs.
      if (earth.update(camera, renderer, deltaSeconds)) invalidate()
    },
    { id: 'earth:update', phase: 'update' },
  )

  return (
    <EarthContext value={earth}>
      <RenderPipelineClaimContext value={claimRenderPipeline}>
        {children}
        {renderPipeline && renderPipelineClaims === 0 && renderPassCount > 0 ? <RenderPipelineHost /> : null}
      </RenderPipelineClaimContext>
    </EarthContext>
  )
}
