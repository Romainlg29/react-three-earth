interface TilesetJson {
  asset: { version: string }
}

interface TilesRendererWithPreprocess {
  preprocessTileset(json: TilesetJson, url: string, parent?: unknown): void
}

/**
 * Silences a false warning from 3DTilesRenderer.
 *
 * Its QuantizedMeshPlugin synthesizes the root tileset from `layer.json` and labels it 3D Tiles 1.1,
 * which makes TilesRenderer warn that 1.1 has "limited support" on every quantized-mesh terrain.
 * The synthesized tileset uses no 1.1 feature, so this relabels that root as 1.0 before the check.
 * Only installed alongside QuantizedMeshPlugin, whose root tileset is always the synthesized one.
 */
export class QuantizedMeshVersionPlugin {
  readonly name = 'QUANTIZED_MESH_VERSION_PLUGIN'

  init(tiles: TilesRendererWithPreprocess): void {
    const preprocessTileset = tiles.preprocessTileset.bind(tiles)
    tiles.preprocessTileset = (json, url, parent = null) => {
      if (parent === null && json.asset.version === '1.1') json.asset.version = '1.0'
      preprocessTileset(json, url, parent)
    }
  }
}
