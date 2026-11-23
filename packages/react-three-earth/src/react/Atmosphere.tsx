import { useThree } from '@react-three/fiber/extension'
import { createContext, use, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AgXToneMapping } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import { Atmosphere as AtmosphereImpl, type AtmosphereOptions } from '../core/Atmosphere.js'
import { useEarth } from './context.js'
import { RenderPipelineHost, useClaimRenderPipeline } from './RenderPipeline.js'

/** AgX compresses highlights: imagery emitted at about 1.6 comes out close to its own colours. */
const FLAT_MAP_LUMINANCE_UNDER_AGX = 1.6

export interface AtmosphereProps extends AtmosphereOptions {
  /** Camera exposure applied before AgX tone mapping. Default: 10. */
  exposure?: number
  /**
   * Edge antialiasing after the atmosphere pass. The pass decides sky or ground per pixel from one depth
   * sample, which undoes the canvas's multisampling along silhouettes such as the planet's limb. `'fxaa'` is a
   * single cheap pass that smooths them again; it also softens fine text in imagery slightly. It runs last in
   * the pipeline's `display` stage, after plugins' display passes. Ignored when `renderPipeline` is false.
   * Default: `'fxaa'`.
   */
  antialiasing?: 'fxaa' | 'none'
  /**
   * Whether the atmosphere sets the canvas's render pipeline output: an `EarthRenderPipeline` with the scene,
   * aerial perspective and the sky, and the render passes plugins register (`earth.renderPasses`). False
   * leaves the pipeline to the children, which build it from `useAtmosphere()`: for example with
   * `createBackdropNode` as the `backdropNode` of @aeronautic/core's `volume_pass`, or with their own
   * `EarthRenderPipeline` for the plugins' passes. Default: true.
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
 * false) and sets AgX tone mapping (restored on unmount). `parameters`, `cache` and
 * `generationBudgetMillisecondsPerFrame` are read once, at mount: the lookup textures are generated from the
 * parameters (or loaded from the cache). Create the canvas renderer with `reversedDepthBuffer: true` for clean
 * haze at long range.
 */
export function Atmosphere({
  exposure = 10,
  parameters,
  cache,
  generationBudgetMillisecondsPerFrame,
  antialiasing = 'fxaa',
  renderPipeline = true,
  children,
}: AtmosphereProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
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
    const previousFlatMapLuminance = earth.view.flatMapLuminance
    renderer.toneMapping = AgXToneMapping
    renderer.toneMappingExposure = exposure
    // The flat map shows imagery unlit: undo the exposure so it keeps its colours.
    earth.view.flatMapLuminance = FLAT_MAP_LUMINANCE_UNDER_AGX / exposure
    return () => {
      renderer.toneMapping = previousToneMapping
      renderer.toneMappingExposure = previousExposure
      earth.view.flatMapLuminance = previousFlatMapLuminance
    }
  }, [renderer, exposure, earth])

  useLayoutEffect(() => () => atmosphere.dispose(), [atmosphere])

  // The atmosphere decides the render pipeline (its own, or the app's): <Earth> does not host one meanwhile.
  useClaimRenderPipeline()

  return (
    <AtmosphereContext value={atmosphere}>
      {renderPipeline ? <RenderPipelineHost atmosphere={atmosphere} antialiasing={antialiasing} /> : null}
      {children}
    </AtmosphereContext>
  )
}
