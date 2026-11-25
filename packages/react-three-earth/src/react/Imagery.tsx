import { useImperativeHandle, useLayoutEffect, useState, type ReactNode, type Ref } from 'react'

import { Imagery as ImageryImpl } from '../core/Imagery.js'
import type { ScreenClip } from '../core/screenClip.js'
import type { ImagerySource } from '../core/sources.js'
import { ImagerySourceContext, useEarth, useSourceRegistry } from './context.js'

export interface ImageryProps {
  /** 0 to 1. Changing it costs nothing: no reload, no shader rebuild. Default: 1. */
  opacity?: number
  /**
   * Keeps the layer to one side of a line across the canvas (`Imagery.screenClip`): its imagery, and a map style's
   * labels and 3D buildings. Compared by value, so an inline object is fine; changing it costs nothing. For a line that
   * moves every frame (a swipe slider), set `imagery.screenClip` through a callback `ref` instead of re-rendering. Default: null.
   * @example <Imagery screenClip={{ side: 'left', positionFraction: 0.5 }}>
   */
  screenClip?: ScreenClip | null
  /**
   * The vanilla `Imagery` once its sources are registered, null before and after. Changing the sources builds a new one,
   * which starts with the `screenClip` prop's clip: use a callback ref, which is called with it, to set its clip again.
   */
  ref?: Ref<ImageryImpl | null>
  /** Imagery source components, stacked bottom to top. */
  children?: ReactNode
}

/** A raster layer draped on the terrain. Several `<Imagery>` stack in the order they mount. */
export function Imagery({ opacity = 1, screenClip = null, ref, children }: ImageryProps) {
  const earth = useEarth()
  const [sources, setSources] = useState<ImagerySource[]>([])
  const registry = useSourceRegistry(setSources)
  const [imagery, setImagery] = useState<ImageryImpl | null>(null)

  useLayoutEffect(() => {
    if (sources.length === 0) return
    const next = new ImageryImpl({ sources, opacity })
    earth.addImagery(next)
    setImagery(next)
    return () => {
      earth.removeImagery(next)
      next.dispose()
      setImagery(null)
    }
    // opacity is applied below without rebuilding the layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earth, sources])

  useLayoutEffect(() => {
    if (imagery !== null) imagery.opacity = opacity
  }, [imagery, opacity])

  // By value: an inline object does not reset the clip on every render, nor undo one set through `ref`.
  const screenClipSide = screenClip?.side ?? null
  const screenClipPosition = screenClip?.positionFraction ?? null
  useLayoutEffect(() => {
    if (imagery === null) return
    imagery.screenClip = screenClipSide === null ? null : { side: screenClipSide, positionFraction: screenClipPosition! }
    earth.requestFrame()
  }, [earth, imagery, screenClipSide, screenClipPosition])

  useImperativeHandle<ImageryImpl | null, ImageryImpl | null>(ref, () => imagery, [imagery])

  return <ImagerySourceContext value={registry}>{children}</ImagerySourceContext>
}
