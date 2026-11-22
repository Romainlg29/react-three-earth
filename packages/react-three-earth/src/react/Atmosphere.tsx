import { useThree } from '@react-three/fiber/extension'
import { useRenderPipeline } from '@react-three/tsl'
import { useLayoutEffect, useRef, useState } from 'react'
import { AgXToneMapping } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { Atmosphere as AtmosphereImpl, type AtmosphereOptions } from '../core/Atmosphere.js'
import { useEarth } from './context.js'

export interface AtmosphereProps extends AtmosphereOptions {
  /** Camera exposure applied before AgX tone mapping. Default: 10. */
  exposure?: number
}

/**
 * Sky, sunlight and aerial perspective. Takes over the canvas's render pipeline and sets AgX tone mapping
 * (restored on unmount). `parameters` is read once, at mount: the lookup textures are generated from it.
 * Create the canvas renderer with `reversedDepthBuffer: true` for clean haze at long range.
 */
export function Atmosphere({ exposure = 10, parameters }: AtmosphereProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const camera = useThree(state => state.camera)
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
