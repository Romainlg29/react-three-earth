// Pivot material adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06,
// itself ported from 3DTilesRendererJS's PivotPointMesh (Apache-2.0).
import { EnvironmentControls, GlobeControls } from '3d-tiles-renderer'
import { Group, type Camera, type Material, type Mesh } from 'three'
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

import type { ViewMorph } from '../view/ViewMorph.js'

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
    replacePivotMaterial(this)
  }
}

function replacePivotMaterial(controls: object): void {
  const pivotMesh = (controls as { pivotMesh: Mesh }).pivotMesh
  ;(pivotMesh.material as Material).dispose()
  pivotMesh.material = createPivotMaterial()
  pivotMesh.onBeforeRender = () => {}
}

/**
 * Pan, zoom and rotate over the flat map (`Earth.setView('2d')`): 3DTilesRenderer's `EnvironmentControls`
 * on the map plane, looking straight down by default. Call `followView` before `update` each frame, so the
 * plane follows the map's anchor. Like `EarthControls`, it fits the camera's near and far planes.
 */
export class FlatMapControls extends EnvironmentControls {
  /** Steepest tilt away from looking straight down, in radians. Default: 0 (a flat 2D map). */
  maximumTiltRadians = 0

  constructor(camera: Camera | null = null, domElement: HTMLElement | null = null) {
    // The map is not raycast: drags and zooms land on the map plane (the fallback plane).
    super(new Group(), camera as never, domElement as never)
    this.useFallbackPlane = true
    this.minAltitude = 0
    this.minDistance = 2
    replacePivotMaterial(this)
  }

  /** Takes the map plane and its up direction from the view morph. */
  followView(view: ViewMorph): void {
    this.up.copy(view.anchorUp)
    this.fallbackPlane.setFromNormalAndCoplanarPoint(view.anchorUp, view.anchorPosition)
    this.maxAltitude = this.maximumTiltRadians
  }

  override update(deltaTime?: number): void {
    super.update(deltaTime)
    const camera = this.camera as (Camera & { near: number; far: number; updateProjectionMatrix?: () => void }) | null
    if (camera === null || !('near' in camera)) return
    fitClippingPlanes(camera, this.fallbackPlane.distanceToPoint(camera.position))
  }
}

/** Near and far planes for a camera at this height above the map: the whole visible map, with depth to spare. */
export function fitClippingPlanes(camera: Camera & { near: number; far: number; updateProjectionMatrix?: () => void }, heightMeters: number): void {
  const height = Math.max(Math.abs(heightMeters), 1)
  const near = Math.max(0.1, height * 1e-3)
  const far = Math.max(height * 100, 1e8)
  if (camera.near === near && camera.far === far) return
  camera.near = near
  camera.far = far
  camera.updateProjectionMatrix?.()
}
