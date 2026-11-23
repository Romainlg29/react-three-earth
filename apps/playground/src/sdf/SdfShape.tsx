import { useEarth } from 'react-three-earth/react'
import { useLayoutEffect, useState } from 'react'

import { SdfShape as SdfShapeImpl, type SdfShapeOptions, type SdfShapesPlugin } from './sdfShapes'

export type SdfShapeProps = SdfShapeOptions

/**
 * A raymarched signed-distance shape at a geographic position. Needs the `sdfShapes()` plugin in
 * `<Earth plugins>`. Wraps the vanilla `SdfShape`; changing any prop builds a new one.
 */
export function SdfShape({ position, headingDegrees, halfSizeMeters, distanceFunction, color, maximumMarchSteps }: SdfShapeProps) {
  const earth = useEarth()
  const { longitudeDegrees, latitudeDegrees, heightMeters } = position
  const [x, y, z] = halfSizeMeters
  const [shape, setShape] = useState<SdfShapeImpl | null>(null)
  useLayoutEffect(() => {
    const created = new SdfShapeImpl({ position: { longitudeDegrees, latitudeDegrees, heightMeters }, headingDegrees, halfSizeMeters: [x, y, z], distanceFunction, color, maximumMarchSteps })
    setShape(created)
    return () => setShape(current => (current === created ? null : current))
  }, [longitudeDegrees, latitudeDegrees, heightMeters, headingDegrees, x, y, z, distanceFunction, color, maximumMarchSteps])
  useLayoutEffect(() => {
    if (shape === null) return
    const plugin = earth.plugins.get<SdfShapesPlugin>('sdf-shapes')
    if (plugin === undefined) throw new Error('<SdfShape> needs the sdfShapes() plugin: <Earth plugins={[sdfShapes()]}>.')
    plugin.add(shape)
    return () => plugin.remove(shape)
  }, [earth, shape])
  return null
}
