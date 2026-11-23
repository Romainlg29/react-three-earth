import { useLayoutEffect } from 'react'

import { SdfShape as SdfShapeImpl, type SdfShapeOptions, type SdfShapesPlugin } from './sdfShapes'

export interface SdfShapeProps extends SdfShapeOptions {
  /** The `sdfShapes()` plugin given to `<Earth plugins>`. Shapes added before it is installed wait for it. */
  plugin: SdfShapesPlugin
}

/**
 * A raymarched signed-distance shape at a geographic position, drawn by the `sdfShapes()` plugin. Wraps the
 * vanilla `SdfShape`; changing any prop builds a new one.
 */
export function SdfShape({ plugin, position, headingDegrees, halfSizeMeters, distanceFunction, color, maximumMarchSteps }: SdfShapeProps) {
  const { longitudeDegrees, latitudeDegrees, heightMeters } = position
  const [x, y, z] = halfSizeMeters
  useLayoutEffect(() => {
    const shape = new SdfShapeImpl({ position: { longitudeDegrees, latitudeDegrees, heightMeters }, headingDegrees, halfSizeMeters: [x, y, z], distanceFunction, color, maximumMarchSteps })
    // Passed in rather than looked up: children's effects run before <Earth plugins> installs it, and add() queues.
    plugin.add(shape)
    return () => plugin.remove(shape)
  }, [plugin, longitudeDegrees, latitudeDegrees, heightMeters, headingDegrees, x, y, z, distanceFunction, color, maximumMarchSteps])
  return null
}
