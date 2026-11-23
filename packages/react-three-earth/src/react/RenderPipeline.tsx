import { useRenderPipeline } from '@react-three/tsl'
import { createContext, useLayoutEffect, useState } from 'react'
import type { PassNode } from 'three/webgpu'

import type { Atmosphere } from '../core/Atmosphere.js'
import { EarthRenderPipeline, type EarthRenderPipelineAntialiasing } from '../core/EarthRenderPipeline.js'
import { useEarth } from './context.js'

/**
 * Lets a child of `<Earth>` (`<Atmosphere>`) take charge of the canvas's render pipeline: it hosts an
 * `EarthRenderPipeline` itself, or leaves the pipeline to the app (`renderPipeline={false}`). Returns a
 * function that gives the charge back. While nobody holds it, `<Earth>` hosts a pipeline once render passes
 * are registered.
 */
export const RenderPipelineClaimContext = createContext<(() => () => void) | null>(null)

export interface EarthRenderPipelineHostProps {
  /** Composited in the `radiance` stage. */
  atmosphere: Atmosphere | null
  antialiasing?: EarthRenderPipelineAntialiasing
}

/**
 * Plugs a vanilla `EarthRenderPipeline` into R3F's render pipeline: `useRenderPipeline` owns the pipeline and
 * the scene pass, and the earth pipeline builds the output node from the pass's colour and depth.
 */
export function EarthRenderPipelineHost({ atmosphere, antialiasing = 'fxaa' }: EarthRenderPipelineHostProps) {
  const earth = useEarth()
  const [pipeline] = useState(() => new EarthRenderPipeline(earth, { atmosphere, antialiasing }))

  // Runs again when the scene or the camera changes, with a new scene pass.
  const { rebuild } = useRenderPipeline(({ renderPipeline, passes, camera }) => {
    pipeline.attach(renderPipeline, passes.scenePass as unknown as PassNode, camera)
  })

  useLayoutEffect(() => {
    pipeline.atmosphere = atmosphere
    pipeline.antialiasing = antialiasing
  }, [pipeline, atmosphere, antialiasing])

  useLayoutEffect(() => {
    // Under StrictMode the clean-up below runs, then this again, without the pipeline callback: rebuild through it.
    if (!pipeline.isAttached) rebuild()
    return () => pipeline.dispose()
  }, [pipeline, rebuild])

  return null
}
