import type { Tile } from '3d-tiles-renderer'
import { DataTexture, LinearFilter, Mesh, RedFormat, Texture, UnsignedByteType, Vector2, type Object3D } from 'three'
import { clamp, float, fwidth, max, select, texture, uniform, uv, vec2 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { terrainElevationMeters } from './terrainSurface.js'

/** Where a terrain mesh's water comes from: nowhere, a mask texture, or its elevation. */
const WaterMaskMode = { None: 0, Texture: 1, Elevation: 2 } as const
type WaterMaskMode = (typeof WaterMaskMode)[keyof typeof WaterMaskMode]

/** What the water mask node reads of the mesh being drawn. */
export interface TerrainWaterMaskState {
  readonly mode: WaterMaskMode
  /** The mask, rows from the north: 1 water, 0 land. Shared with the tiles split from this one. */
  readonly texture: Texture | null
  /** Takes the mesh's `uv` (0 to 1 west to east and south to north) into the mask: `uv × scale + offset`. */
  readonly uvScale: Vector2
  readonly uvOffset: Vector2
  /** Elevation mode: heights at or below it are water, metres. */
  readonly seaLevelMeters: number
}

const WATER_MASK_STATE = Symbol('WATER_MASK_STATE')
type WaterMaskMesh = Object3D & { [WATER_MASK_STATE]?: TerrainWaterMaskState }

/** The state the node reads for `object`, if a water mask plugin set one. For tests and plugins. */
export function getTerrainWaterMaskState(object: Object3D): TerrainWaterMaskState | undefined {
  return (object as WaterMaskMesh)[WATER_MASK_STATE]
}

const emptyTexture = new Texture()
const zero = new Vector2(0, 0)
const one = new Vector2(1, 1)

const modeUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getTerrainWaterMaskState(object)?.mode ?? 0)))
const seaLevelUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getTerrainWaterMaskState(object)?.seaLevelMeters ?? 0)))
const uvScaleUniform = uniform(new Vector2(1, 1)).onObjectUpdate(({ object }, self) => {
  self.value = (object === null ? undefined : getTerrainWaterMaskState(object)?.uvScale) ?? one
})
const uvOffsetUniform = uniform(new Vector2()).onObjectUpdate(({ object }, self) => {
  self.value = (object === null ? undefined : getTerrainWaterMaskState(object)?.uvOffset) ?? zero
})
// Not mergeable: three would merge it with any texture node holding the same placeholder, and sample one tile's
// mask for every tile (as the imagery layers' textures, `wrapOverlaysNodeMaterial`).
const maskTexture = texture(emptyTexture).onObjectUpdate(({ object }, self) => {
  self.value = (object === null ? undefined : getTerrainWaterMaskState(object)?.texture) ?? emptyTexture
})
maskTexture.mergeable = false

const maskUv = uv().mul(uvScaleUniform).add(uvOffsetUniform)
// The texture's first row is the tile's north edge, uploaded at v = 0 on both backends: v runs north to south.
const textureWater = maskTexture.sample(vec2(maskUv.x, float(1).sub(maskUv.y))).r
// Heights at or below sea level, antialiased over about a pixel. A quarter metre of slack keeps a sea encoded at exactly
// the sea level (Terrain-RGB's oceans) all water, where the heights do not change across the pixel.
const elevationWater = clamp(
  seaLevelUniform.add(0.25).sub(terrainElevationMeters).div(max(fwidth(terrainElevationMeters), 1e-3)).add(0.5),
  0,
  1,
)

/**
 * How much of the terrain at the fragment is water: 1 sea or lake, 0 land, between the two along coasts. From the
 * terrain source: the tiles' water mask for `QuantizedMeshSource` (the `watermask` extension, when the server has
 * it), heights at or below `seaLevelMeters` for `RasterDemSource`; 0 where the source gives none. For terrain
 * materials (`createMaterial`), as `terrainElevationMeters`.
 * @example material.colorNode = mix(landColor, waterColor, terrainWaterMask)
 */
export const terrainWaterMask: Node<'float'> = select(
  modeUniform.equal(WaterMaskMode.Texture),
  textureWater,
  select(modeUniform.equal(WaterMaskMode.Elevation), elevationWater, float(0)),
) as unknown as Node<'float'>

/**
 * The height of the water's surface at the fragment, metres above the WGS84 ellipsoid, where `terrainWaterMask` says
 * water: the source's `seaLevelMeters` for water from elevation (`RasterDemSource`, whose seafloor lies below it, drawn
 * or flattened), the terrain's own height where a tile's mask says water (quantized mesh, which draws its sea and lakes
 * at their surface). On land, the terrain's height. For anything drawn on the water (a sea mesh), rather than the
 * terrain's drawn height, which is the seafloor's where the source draws it. As loaded: multiply by the terrain's
 * `exaggeration` for the height it is drawn at. Under a mask the level is the mesh's own height, so a quantized mesh that
 * draws its seafloor under the mask (bathymetry) gives the seafloor here, not the sea.
 */
export const terrainWaterLevelMeters: Node<'float'> = select(modeUniform.equal(WaterMaskMode.Elevation), seaLevelUniform, terrainElevationMeters) as unknown as Node<'float'>

export interface TerrainWaterMaskPluginOptions {
  /** Read the quantized-mesh tiles' `watermask` extension. Tiles without one are land. */
  tileMasks?: boolean
  /** Water wherever the terrain's elevation is at or below this many metres. Ignored where a tile has a mask. */
  seaLevelMeters?: number | null
}

interface ClassicMaterialWithMask {
  roughnessMap?: (Texture & { image: { data: Uint8Array; width: number } }) | null
}

/**
 * Gives every terrain tile mesh what `terrainWaterMask` reads. Sources register it (`QuantizedMeshSource`,
 * `RasterDemSource`). Runs before `TileMaterialReplacementPlugin`, which drops the loader's material: 3DTilesRenderer's
 * quantized-mesh loader puts the decoded mask on its `roughnessMap` (inverted: 0 water, 255 land).
 */
export class TerrainWaterMaskPlugin {
  readonly name = 'TERRAIN_WATER_MASK_PLUGIN'
  /** Before `TileMaterialReplacementPlugin` (-1000), which disposes the loader's material. */
  readonly priority = -1001
  /** The state of each loaded tile, for the tiles split from it. */
  protected readonly states = new WeakMap<Tile, TerrainWaterMaskState>()
  /** Masks this plugin made for a tile, disposed with it or with the plugin. Split tiles share their parent's. */
  protected readonly ownedTextures = new Map<Tile, DataTexture>()
  protected readonly tileMasks: boolean
  protected readonly seaLevelMeters: number | null

  constructor({ tileMasks = false, seaLevelMeters = null }: TerrainWaterMaskPluginOptions = {}) {
    if (seaLevelMeters !== null && !Number.isFinite(seaLevelMeters)) {
      throw new Error(`TerrainWaterMaskPlugin: seaLevelMeters must be a finite number or null (no water from elevation), got ${seaLevelMeters}.`)
    }
    this.tileMasks = tileMasks
    this.seaLevelMeters = seaLevelMeters
  }

  processTileModel(scene: Object3D, tile: Tile): void {
    const state = this.stateFor(scene, tile)
    this.states.set(tile, state)
    scene.traverse(object => {
      if (object instanceof Mesh) (object as WaterMaskMesh)[WATER_MASK_STATE] = state
    })
  }

  disposeTile(tile: Tile): void {
    this.ownedTextures.get(tile)?.dispose()
    this.ownedTextures.delete(tile)
    this.states.delete(tile)
  }

  /** The tile's mask, for the terrain's memory budget: it sits on no material, so the tile renderer does not see it. */
  calculateBytesUsed(tile: Tile): number {
    const image = this.ownedTextures.get(tile)?.image as { width: number; height: number } | undefined
    return image === undefined ? 0 : image.width * image.height
  }

  /** Frees every mask: the tile renderer unregisters plugins before unloading its tiles, so `disposeTile` misses them. */
  dispose(): void {
    for (const texture of this.ownedTextures.values()) texture.dispose()
    this.ownedTextures.clear()
  }

  protected stateFor(scene: Object3D, tile: Tile): TerrainWaterMaskState {
    const fallback = this.fallbackState()
    if (!this.tileMasks) return fallback

    // A tile past the data's deepest level, cut from its parent's mesh: its `uv` spans the quadrant, so it reads the
    // quadrant of the parent's mask.
    const split = /quantized_tile_split\?bottom=(true|false)&left=(true|false)/.exec(tileUri(tile) ?? '')
    if (split !== null) {
      const parent = tile.parent === null ? undefined : this.states.get(tile.parent)
      if (parent?.texture == null) return fallback
      const [, bottom, left] = split
      const scale = parent.uvScale.clone().multiplyScalar(0.5)
      const offset = new Vector2(left === 'true' ? 0 : 0.5, bottom === 'true' ? 0 : 0.5).multiply(parent.uvScale).add(parent.uvOffset)
      return { ...parent, uvScale: scale, uvOffset: offset }
    }

    const map = findLoaderMask(scene)
    if (map !== null) {
      const texture = toMaskTexture(map)
      this.ownedTextures.set(tile, texture)
      return { mode: WaterMaskMode.Texture, texture, uvScale: one.clone(), uvOffset: zero.clone(), seaLevelMeters: 0 }
    }

    // A tile the imagery split from its parent (`ImageOverlayPlugin`): same mesh, cut up, its `uv` still the parent's.
    const parent = tile.parent === null ? undefined : this.states.get(tile.parent)
    if (parent?.texture != null && isVirtualChild(tile)) return parent
    return fallback
  }

  protected fallbackState(): TerrainWaterMaskState {
    return this.seaLevelMeters === null
      ? { mode: WaterMaskMode.None, texture: null, uvScale: one.clone(), uvOffset: zero.clone(), seaLevelMeters: 0 }
      : { mode: WaterMaskMode.Elevation, texture: null, uvScale: one.clone(), uvOffset: zero.clone(), seaLevelMeters: this.seaLevelMeters }
  }
}

function tileUri(tile: Tile): string | undefined {
  return (tile as unknown as { content?: { uri?: string } | null }).content?.uri
}

function isVirtualChild(tile: Tile): boolean {
  const parent = tile.parent as unknown as { children: Tile[]; internal?: { virtualChildCount?: number } } | null
  if (parent === null) return false
  const virtualCount = parent.internal?.virtualChildCount ?? 0
  return parent.children.indexOf(tile) >= parent.children.length - virtualCount
}

function findLoaderMask(scene: Object3D): NonNullable<ClassicMaterialWithMask['roughnessMap']> | null {
  let found: NonNullable<ClassicMaterialWithMask['roughnessMap']> | null = null
  scene.traverse(object => {
    if (found !== null || !(object instanceof Mesh) || Array.isArray(object.material)) return
    const map = (object.material as ClassicMaterialWithMask).roughnessMap
    if (map?.image?.data instanceof Uint8Array) found = map
  })
  return found
}

/**
 * The loader's mask (two channels, 0 water and 255 land, rows from the north) as a one-channel texture of water (255),
 * rows from the north, with no flip: both backends upload the first row at v = 0.
 */
export function toMaskTexture(map: { image: { data: Uint8Array; width: number } }): DataTexture {
  const { data, width } = map.image
  const water = new Uint8Array(width * width)
  for (let index = 0; index < water.length; index++) water[index] = 255 - data[index * 2]!
  const result = new DataTexture(water, width, width, RedFormat, UnsignedByteType)
  result.minFilter = LinearFilter
  result.magFilter = LinearFilter
  result.generateMipmaps = false
  result.flipY = false
  result.needsUpdate = true
  return result
}
