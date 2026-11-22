import { useThree } from '@react-three/fiber/extension'
import { useRenderPipeline } from '@react-three/tsl'
import { useLayoutEffect, useRef, useState } from 'react'
import { AgXToneMapping, UnsignedByteType } from 'three'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { renderOutput, rtt } from 'three/tsl'
import type { WebGPURenderer } from 'three/webgpu'

import { Atmosphere as AtmosphereImpl, type AtmosphereOptions } from '../core/Atmosphere.js'
import { useEarth } from './context.js'

export interface AtmosphereProps extends AtmosphereOptions {
  /** Camera exposure applied before AgX tone mapping. Default: 10. */
  exposure?: number
  /**
   * Edge antialiasing after the atmosphere pass. The pass decides sky or ground per pixel from one depth
   * sample, which undoes the canvas's multisampling along silhouettes such as the planet's limb. `'fxaa'` is a
   * single cheap pass that smooths them again; it also softens fine text in imagery slightly. Default: `'fxaa'`.
   */
  antialiasing?: 'fxaa' | 'none'
}

/**
 * Sky, sunlight and aerial perspective. Takes over the canvas's render pipeline and sets AgX tone mapping
 * (restored on unmount). `parameters`, `cache` and `generationBudgetMillisecondsPerFrame` are read once, at mount: the lookup textures are generated
 * from the parameters (or loaded from the cache).
 * Create the canvas renderer with `reversedDepthBuffer: true` for clean haze at long range.
 */
export function Atmosphere({ exposure = 10, parameters, cache, generationBudgetMillisecondsPerFrame, antialiasing = 'fxaa' }: AtmosphereProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const camera = useThree(state => state.camera)
  const [atmosphere] = useState(() => new AtmosphereImpl({ parameters, cache, generationBudgetMillisecondsPerFrame }))

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

  const { rebuild } = useRenderPipeline(({ renderPipeline, passes }) => {
    const scenePass = passes.scenePass as unknown as { getTextureNode(name: string): never }
    const color = atmosphere.createAerialPerspective(
      scenePass.getTextureNode('output'),
      scenePass.getTextureNode('depth'),
      camera,
    )
    if (antialiasing === 'fxaa') {
      // FXAA works on display-referred (tone-mapped, sRGB) colour, so the output transform runs first, here.
      renderPipeline.outputColorTransform = false
      // 8 bits are enough for display-referred colour, a quarter of the default half-float target's memory.
      const displayColor = rtt(renderOutput(color as never), null, null, { type: UnsignedByteType })
      renderPipeline.outputNode = fxaa(displayColor) as never
    } else {
      renderPipeline.outputColorTransform = true
      renderPipeline.outputNode = color as never
    }
  })

  // The pipeline callback runs once; rebuild it when the antialiasing choice changes.
  const antialiasingRef = useRef(antialiasing)
  useLayoutEffect(() => {
    if (antialiasingRef.current === antialiasing) return
    antialiasingRef.current = antialiasing
    rebuild()
  }, [antialiasing, rebuild])

  return null
}
