import { Matrix4, Vector3, type Camera, type Object3D } from 'three'
import { cameraFar, cameraNear, Fn, uniform, viewZToLogarithmicDepth, viewZToPerspectiveDepth, viewZToReversedPerspectiveDepth } from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

import type { ViewMorph } from '../view/ViewMorph.js'

const inverseWorld = new Matrix4()
const cameraWorld = new Vector3()

/** The camera's position in an object's local frame, computed in 64-bit on the CPU. */
export function getLocalCameraPosition(object: Object3D, camera: Camera, target = new Vector3()): Vector3 {
  cameraWorld.setFromMatrixPosition(camera.matrixWorld)
  return target.copy(cameraWorld).applyMatrix4(inverseWorld.copy(object.matrixWorld).invert())
}

/**
 * A TSL `vec3` uniform: the camera's position in the local frame of the object being drawn, computed per
 * object in 64-bit on the CPU. Planet-scale ECEF coordinates (millions of metres) lose about half a metre in
 * a shader's 32-bit floats; this vector is small near the object, so a ray built from it and `positionLocal`
 * (`normalize(positionLocal.sub(cameraPosition))`) is exact anywhere on Earth. One node can be shared by every
 * object using the material.
 */
export function createLocalCameraPositionNode(): UniformNode<'vec3', Vector3> {
  const node = uniform(new Vector3())
  return node.onObjectUpdate(({ object, camera }) => {
    if (object !== null && object !== undefined && camera !== null && camera !== undefined) getLocalCameraPosition(object, camera, node.value)
    return node.value
  }) as UniformNode<'vec3', Vector3>
}

/**
 * The depth-buffer value of a view-space depth (`viewZ`, negative in front of the camera), for a material's
 * `depthNode`, matching how the renderer was created: reversed (`reversedDepthBuffer: true`, recommended
 * with the atmosphere), logarithmic, or standard. Lets a raymarched surface write its true depth, so terrain
 * hides it, it hides terrain, and the atmosphere's aerial perspective hazes it. Writing depth turns off early
 * depth rejection for the draw: keep such meshes tight around what they show.
 */
export const depthFromViewZ = Fn(([viewZ]: [Node<'float'>], builder: { renderer: { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean } }) => {
  const { reversedDepthBuffer = false, logarithmicDepthBuffer = false } = builder.renderer
  if (reversedDepthBuffer) return viewZToReversedPerspectiveDepth(viewZ, cameraNear, cameraFar)
  if (logarithmicDepthBuffer) return viewZToLogarithmicDepth(viewZ, cameraNear, cameraFar)
  return viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar)
}) as unknown as (viewZ: Node<'float'>) => Node<'float'>

/**
 * The light an object emits on the flat map so it keeps its colour there: `color × morph ×
 * view.flatMapLuminance`, as flat terrain does. On the map the atmosphere's sun fades out, so a lit object
 * would turn dark; use this as the material's `emissiveNode` (or add it to yours).
 * @example material.emissiveNode = createFlatMapEmissionNode(material.colorNode, earth.view)
 */
export function createFlatMapEmissionNode(colorNode: Node, view: ViewMorph): Node<'vec3'> {
  const emission = uniform(0).onRenderUpdate(() => view.morph * view.flatMapLuminance)
  return (colorNode as Node<'vec4'>).rgb.mul(emission) as Node<'vec3'>
}
