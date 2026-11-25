import { usePlugin } from '@earthkit/globe/react'
import { useImperativeHandle, useLayoutEffect, useState, type Ref } from 'react'

import { Water as WaterImpl, type WaterOptions } from '../Water.js'

export interface WaterProps extends WaterOptions {
  /** The `Water` plugin, for `water.state` or `setSettings` outside React. */
  ref?: Ref<WaterImpl>
}

/**
 * A physically based sea on the terrain, inside `<Earth>`: installs a `Water` plugin while mounted and applies its props
 * as they change (uniforms only, no reload). `name` is read once.
 *
 * ```tsx
 * <Earth>
 *   <Terrain><QuantizedMeshSource url={url} /></Terrain>
 *   <Atmosphere />
 *   <Water preset="open-ocean" />
 * </Earth>
 * ```
 */
export function Water({ ref, name, ...settings }: WaterProps) {
  const [water] = useState(() => new WaterImpl({ name, ...settings }))
  usePlugin(water)
  const key = JSON.stringify(settings)
  useLayoutEffect(() => {
    water.setSettings(settings)
  }, [water, key])
  useImperativeHandle(ref, () => water, [water])
  return null
}
