import { useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useRef } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { AttributionControl as AttributionControlImpl } from '../controls/AttributionControl.js'
import { useEarth } from './context.js'

export interface AttributionControlProps {
  /**
   * `true` shows only a "ⓘ" button that expands the credits, `false` always shows them. Default: automatic,
   * compact while the container is narrower than 640 CSS pixels.
   */
  compact?: boolean
  /** Credits of your own, shown after the earth's. Text, or HTML where only `<a href="https://…">` links are kept. */
  customAttribution?: string | readonly string[]
  /** Where the control goes. Default: the element around the canvas. */
  container?: HTMLElement | null
}

/**
 * Shows the credits of the sources inside `<Earth>` in the bottom-right corner of the canvas, with links, and
 * follows them as sources come and go. Place it anywhere inside `<Earth>`.
 */
export function AttributionControl({ compact, customAttribution, container }: AttributionControlProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const control = useRef<AttributionControlImpl | null>(null)
  const customKey = typeof customAttribution === 'string' ? customAttribution : customAttribution?.join('\0')

  const parent = container ?? renderer.domElement.parentElement
  useLayoutEffect(() => {
    if (parent === null) return
    const created = new AttributionControlImpl({ earth, container: parent, compact, customAttribution })
    control.current = created
    return () => {
      control.current = null
      created.dispose()
    }
    // compact and customAttribution are applied below without rebuilding the DOM
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earth, parent])

  useLayoutEffect(() => control.current?.setCompact(compact), [compact])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => control.current?.setCustomAttribution(customAttribution), [customKey])

  return null
}
