// Pivot material adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06,
// itself ported from 3DTilesRendererJS's PivotPointMesh (Apache-2.0).
import { GlobeControls } from '3d-tiles-renderer'
import type { Material, Mesh } from 'three'
import {
  cameraProjectionMatrix,
  Fn,
  fwidth,
  modelViewMatrix,
  positionGeometry,
  screenDPR,
  screenSize,
  smoothstep,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { NodeMaterial } from 'three/webgpu'

function createPivotMaterial(): Material {
  const size = uniform(15).mul(screenDPR)
  const thickness = uniform(2).mul(screenDPR)
  const opacity = uniform(0.5)

  const material = new NodeMaterial()
  material.depthWrite = false
  material.depthTest = false
  material.transparent = true

  material.vertexNode = Fn(() => {
    const aspect = screenSize.x.div(screenSize.y)
    const offset = uv().mul(2).sub(1).toVar()
    offset.y.mulAssign(aspect)
    const screenPoint = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionGeometry, 1)).toVar()
    screenPoint.xy.addAssign(offset.mul(size.add(thickness)).mul(screenPoint.w).div(screenSize.x))
    return screenPoint
  })()

  material.outputNode = Fn(() => {
    const halfThickness = thickness.mul(0.5)
    const planeDimension = size.add(thickness)
    const ringOffset = planeDimension.sub(halfThickness).sub(2).div(planeDimension)
    const texelThickness = halfThickness.div(planeDimension)
    const distance = uv().mul(2).sub(1).length().sub(ringOffset).abs()
    const width = fwidth(distance).mul(0.5)
    const alpha = smoothstep(texelThickness.sub(width), texelThickness.add(width), distance)
    return vec4(1, 1, 1, opacity.mul(alpha.oneMinus()))
  })()

  return material
}

/**
 * 3DTilesRenderer's `GlobeControls` (orbit, pan, zoom to cursor, near/far planes fitted to the globe),
 * with its pivot marker drawn by a node material so it shows on `WebGPURenderer`.
 */
export class EarthControls extends GlobeControls {
  constructor(...args: ConstructorParameters<typeof GlobeControls>) {
    super(...args)
    const pivotMesh = (this as unknown as { pivotMesh: Mesh }).pivotMesh
    ;(pivotMesh.material as Material).dispose()
    pivotMesh.material = createPivotMaterial()
    pivotMesh.onBeforeRender = () => {}
  }
}
