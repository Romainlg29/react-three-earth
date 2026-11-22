// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
import { ImageOverlayPlugin as ImageOverlayPluginBase } from '3d-tiles-renderer/three/plugins'
import { Mesh, type Color, type Object3D, type Texture } from 'three'

import { wrapOverlaysNodeMaterial } from './wrapOverlaysNodeMaterial.js'

interface ImageOverlay {
  color: Color
  opacity: number
  alphaMask: boolean
  alphaInvert: boolean
}

export interface OverlayParams {
  layerMaps: { value: Array<Texture | null> }
  layerInfo: { value: ImageOverlay[] }
}

/**
 * 3DTilesRenderer's `ImageOverlayPlugin` with its GLSL `onBeforeCompile` material patch replaced by a
 * TSL `colorNode`, so overlays render on `WebGPURenderer`.
 *
 * Relies on the base class's `_wrapMaterials` and `meshParams` internals: pinned to 3d-tiles-renderer 0.5.x.
 */
export class ImageOverlayPlugin extends ImageOverlayPluginBase {
  declare meshParams: Map<Object3D, OverlayParams>

  _wrapMaterials(scene: Object3D): void {
    scene.traverse(object => {
      if (object instanceof Mesh) {
        const params = wrapOverlaysNodeMaterial(object.material)
        this.meshParams.set(object, params)
      }
    })
  }
}
