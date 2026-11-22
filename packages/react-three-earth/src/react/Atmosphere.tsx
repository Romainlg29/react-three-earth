import { useThree } from '@react-three/fiber/extension'
import { useRenderPipeline } from '@react-three/tsl'
import { createContext, use, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AgXToneMapping } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { Atmosphere as AtmosphereImpl, type AtmosphereOptions } from '../core/Atmosphere.js'
import { useEarth } from './context.js'

export interface AtmosphereProps extends AtmosphereOptions {
  /** Camera exposure applied before AgX tone mapping. Default: 10. */
  exposure?: number
  /**
   * Whether the atmosphere sets the canvas's render pipeline output (the scene with aerial perspective and
   * the sky). False leaves the pipeline to the children, which build it from `useAtmosphere()`: for
   * example with `createBackdropNode` as the `backdropNode` of @aeronautic/core's `volume_pass`.
   * Default: true.
   */
  renderPipeline?: boolean
  /** Rendered inside the atmosphere: `useAtmosphere()` returns it there. */
  children?: ReactNode
}

const AtmosphereContext = createContext<AtmosphereImpl | null>(null)

/**
 * The vanilla `Atmosphere` of the nearest `<Atmosphere>`, for children that build their own render pipeline
 * or light effects with it. Reading it never causes a React render.
 */
export function useAtmosphere(): AtmosphereImpl {
  const atmosphere = use(AtmosphereContext)
  if (atmosphere === null) throw new Error('useAtmosphere: call it inside <Atmosphere>.')
  return atmosphere
}

/**
 * Sky, sunlight and aerial perspective. Takes over the canvas's render pipeline (unless `renderPipeline` is
 * false) and sets AgX tone mapping (restored on unmount). `parameters` is read once, at mount: the lookup
 * textures are generated from it. Create the canvas renderer with `reversedDepthBuffer: true` for clean
 * haze at long range.
 */
export function Atmosphere({ exposure = 10, parameters, renderPipeline = true, children }: AtmosphereProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const [atmosphere] = useState(() => new AtmosphereImpl({ parameters }))

  const invalidate = useThree(state => state.invalidate)
  // Read through a ref, so a new invalidate function never reinstalls the atmosphere
  const invalidateRef = useRef(invalidate)
  useLayoutEffect(() => {
    invalidateRef.current = invalidate
  }, [invalidate])

  useLayoutEffect(() => {
    const uninstall = atmosphere.install(renderer)
    // With frameloop="demand", nothing else would redraw once the lookup textures are ready.
    void atmosphere.ready?.then(ready => {
      if (ready) invalidateRef.current()
    })
    earth.setAtmosphere(atmosphere)
    return () => {
      earth.setAtmosphere(null)
      uninstall()
    }
  }, [atmosphere, earth, renderer])

  useLayoutEffect(() => {
    const previousToneMapping = renderer.toneMapping
    const previousExposure = renderer.toneMappingExposure
    renderer.toneMapping = AgXToneMapping
    renderer.toneMappingExposure = exposure
    return () => {
      renderer.toneMapping = previousToneMapping
      renderer.toneMappingExposure = previousExposure
    }
  }, [renderer, exposure])

  useLayoutEffect(() => () => atmosphere.dispose(), [atmosphere])

  return (
    <AtmosphereContext value={atmosphere}>
      {renderPipeline ? <AtmosphereRenderPipeline atmosphere={atmosphere} /> : null}
      {children}
    </AtmosphereContext>
  )
}

/** Sets the render pipeline's output to the scene with aerial perspective and the sky. */
function AtmosphereRenderPipeline({ atmosphere }: { atmosphere: AtmosphereImpl }) {
  const camera = useThree(state => state.camera)
  useRenderPipeline(({ renderPipeline, passes }) => {
    const scenePass = passes.scenePass as unknown as { getTextureNode(name: string): never }
    renderPipeline.outputNode = atmosphere.createAerialPerspective(
      scenePass.getTextureNode('output'),
      scenePass.getTextureNode('depth'),
      camera,
    ) as never
  })
  return null
}
