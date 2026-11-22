// Adapted from takram three-geospatial (MIT, (c) 2024 Shota Matsuda), storybook-webgpu at b012ad06.
import { TilesFadePlugin as TilesFadePluginBase } from '3d-tiles-renderer/three/plugins'

import { FadeMaterialManager } from './FadeMaterialManager.js'

/** 3DTilesRenderer's `TilesFadePlugin`, with the dithered fade written in TSL for node materials. */
export class TilesFadePlugin extends TilesFadePluginBase {
  declare protected _fadeMaterialManager: unknown

  constructor(...args: ConstructorParameters<typeof TilesFadePluginBase>) {
    super(...args)
    this._fadeMaterialManager = new FadeMaterialManager()
  }
}
