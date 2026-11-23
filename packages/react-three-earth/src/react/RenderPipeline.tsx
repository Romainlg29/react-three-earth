import { useRenderPipeline } from '@react-three/tsl'
import { createContext, use, useLayoutEffect, useRef, useState } from 'react'
import type { PassNode } from 'three/webgpu'

import type { Atmosphere } from '../core/Atmosphere.js'
import { EarthRenderPipeline, type EarthRenderPipelineAntialiasing } from '../core/EarthRenderPipeline.js'
import { useEarth } from './context.js'

/**
 * Lets a child of `<Earth>` take charge of the canvas's render pipeline. Returns a function that gives the
 * charge back. While nobody holds it, `<Earth>` hosts a pipeline once render passes are registered.
 */
export const RenderPipelineClaimContext = createContext<(() => () => void) | null>(null)

/**
 * Tells the nearest `<Earth>` that this component sets the canvas's render pipeline (its own
 * `useRenderPipeline`), so `<Earth>` never hosts one for plugins' render passes. Build the passes into yours
 * with an `EarthRenderPipeline`, or they do not run. `<Atmosphere>` and `<EarthRenderPipelineHost>` claim
 * the pipeline themselves.
 * @example
 * function MyEffects() {
 *   useClaimRenderPipeline()
 *   useRenderPipeline(({ renderPipeline, passes }) => { … })
 *   return null
 * }
 */
export function useClaimRenderPipeline(): void {
  const claimRenderPipeline = use(RenderPipelineClaimContext)
  useLayoutEffect(() => claimRenderPipeline?.(), [claimRenderPipeline])
}

export interface EarthRenderPipelineHostProps {
  /** Composited in the `radiance` stage. Default: null. */
  atmosphere?: Atmosphere | null
  antialiasing?: EarthRenderPipelineAntialiasing
}

/**
 * Plugs a vanilla `EarthRenderPipeline` into R3F's render pipeline: `useRenderPipeline` owns the pipeline and
 * the scene pass, and the earth pipeline builds the output node from the pass's colour and depth, with the
 * render passes plugins register. Claims the pipeline, so `<Earth>` does not host a second one.
 */
export function EarthRenderPipelineHost(props: EarthRenderPipelineHostProps) {
  useClaimRenderPipeline()
  return <RenderPipelineHost {...props} />
}

/** `EarthRenderPipelineHost` without the claim: `<Earth>` hosts this one while nobody else holds the pipeline. */
export function RenderPipelineHost({ atmosphere = null, antialiasing = 'fxaa' }: EarthRenderPipelineHostProps) {
  const earth = useEarth()
  const [pipeline] = useState(() => new EarthRenderPipeline(earth, { atmosphere, antialiasing }))
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Runs again when the scene or the camera changes, with a new scene pass.
  const { rebuild } = useRenderPipeline(({ renderPipeline, passes, camera }) => {
    pipeline.attach(renderPipeline, passes.scenePass as unknown as PassNode, camera)
  })

  useLayoutEffect(() => {
    pipeline.atmosphere = atmosphere
    pipeline.antialiasing = antialiasing
  }, [pipeline, atmosphere, antialiasing])

  useLayoutEffect(() => {
    if (pendingDispose.current !== null) {
      // StrictMode's clean-up and set-up again: keep the pipeline.
      clearTimeout(pendingDispose.current)
      pendingDispose.current = null
    }
    // Under StrictMode the set-up runs again without the pipeline callback: rebuild through it.
    if (!pipeline.isAttached) rebuild()
    return () => {
      pipeline.detach()
      // `useRenderPipeline` releases the pipeline one task later and may render it until then: free its targets
      // (FXAA's) after that, or a render would allocate them again and leak them.
      pendingDispose.current = setTimeout(() => {
        pendingDispose.current = null
        pipeline.dispose()
      })
    }
  }, [pipeline, rebuild])

  return null
}
