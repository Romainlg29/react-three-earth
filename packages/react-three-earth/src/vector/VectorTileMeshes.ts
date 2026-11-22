import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  NoColorSpace,
  NormalBlending,
  RedFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
} from 'three'
import { attribute, Discard, float, Fn, fwidth, If, max, positionGeometry, smoothstep, sRGBTransferEOTF, texture, uniform, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import { GLYPH_EDGE } from './worker/glyphs.js'
import { TILE_EXTENT, type AtlasUpdate, type TileBucket } from './worker/types.js'

/**
 * Colours arrive as sRGB bytes; three's materials work in linear space and the composite target encodes
 * back to sRGB, so decode here (8-bit linear would band in the darks).
 */
function linearColor(name: string) {
  const color = attribute<'vec4'>(name, 'vec4')
  return vec4(sRGBTransferEOTF(color.rgb) as unknown as Node<'vec3'>, color.a)
}

function createMaterial(): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false, side: DoubleSide })
}

/**
 * Fills, lines and circles: one colour per vertex. Fragments outside the tile square are dropped, so a
 * tile's buffer zone never paints over its neighbour, and each tile can be drawn as one mesh per layer group.
 */
export function createShapeMaterial(): MeshBasicNodeMaterial {
  const material = createMaterial()
  material.colorNode = Fn(() => {
    const local = positionGeometry
    If(local.x.lessThan(0).or(local.x.greaterThan(TILE_EXTENT)).or(local.y.lessThan(0)).or(local.y.greaterThan(TILE_EXTENT)), () => {
      Discard()
    })
    return linearColor('color')
  })()
  return material
}

/** A single-colour quad over the whole composite; set `color` (straight-alpha sRGB, 0 to 1) before drawing. */
export function createBackgroundMaterial(): { material: MeshBasicNodeMaterial; color: Vector4 } {
  const color = new Vector4()
  const node = uniform(color)
  const material = createMaterial()
  material.colorNode = vec4(sRGBTransferEOTF(node.xyz) as unknown as Node<'vec3'>, node.w)
  return { material, color }
}

/** The main thread's copy of the worker's glyph atlas: one channel of signed distance, 1024 wide. */
export class GlyphAtlasTexture {
  texture: DataTexture
  /** Atlas size in pixels, to turn glyph pixel coordinates into texture coordinates. */
  readonly size = uniform(new Vector2(1, 1))
  /** The texture node read by text materials; its value follows `texture` when the atlas grows. */
  readonly node: ReturnType<typeof texture>
  protected data = new Uint8Array(1)

  constructor() {
    this.texture = this.createTexture(1, 1)
    this.node = texture(this.texture)
  }

  apply(update: AtlasUpdate): void {
    const { width, height } = update
    if (width !== this.texture.image.width || height !== this.texture.image.height) {
      const data = new Uint8Array(width * height)
      const previousWidth = this.texture.image.width
      for (let row = 0; row < Math.min(this.texture.image.height, height); row++) {
        data.set(this.data.subarray(row * previousWidth, row * previousWidth + Math.min(previousWidth, width)), row * width)
      }
      this.data = data
      this.texture.dispose()
      this.texture = this.createTexture(width, height)
      this.node.value = this.texture
      this.size.value.set(width, height)
    }
    for (const glyph of update.glyphs) {
      for (let row = 0; row < glyph.height; row++) {
        this.data.set(glyph.data.subarray(row * glyph.width, (row + 1) * glyph.width), (glyph.y + row) * width + glyph.x)
      }
    }
    if (update.glyphs.length > 0) this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }

  protected createTexture(width: number, height: number): DataTexture {
    if (this.data.length !== width * height) this.data = new Uint8Array(width * height)
    const atlas = new DataTexture(this.data, width, height, RedFormat, UnsignedByteType)
    atlas.colorSpace = NoColorSpace
    atlas.minFilter = LinearFilter
    atlas.magFilter = LinearFilter
    atlas.generateMipmaps = false
    atlas.flipY = false
    atlas.unpackAlignment = 1
    atlas.name = 'MapStyleGlyphAtlas'
    atlas.needsUpdate = true
    return atlas
  }
}

/**
 * SDF text with a halo, in one pass: coverage of the glyph and of the halo come from the same distance
 * sample, antialiased over one screen pixel (`fwidth`), and the glyph is composited over its halo.
 */
export function createTextMaterial(atlas: GlyphAtlasTexture): MeshBasicNodeMaterial {
  const material = createMaterial()
  material.colorNode = Fn(() => {
    const distance = (atlas.node.sample(attribute<'vec2'>('atlasUv', 'vec2').div(atlas.size)) as unknown as Node<'vec4'>).r
    const width = max(fwidth(distance).mul(0.7), float(1 / 255))
    const edge = float(GLYPH_EDGE)
    const haloEdge = attribute<'float'>('haloEdge', 'float')
    const fill = linearColor('fillColor')
    const halo = linearColor('haloColor')
    const fillAlpha = fill.a.mul(smoothstep(edge.sub(width), edge.add(width), distance))
    const haloAlpha = halo.a.mul(smoothstep(haloEdge.sub(width), haloEdge.add(width), distance)).mul(fillAlpha.oneMinus())
    const alpha = fillAlpha.add(haloAlpha)
    const rgb = fill.rgb.mul(fillAlpha).add(halo.rgb.mul(haloAlpha)).div(max(alpha, float(1e-4)))
    return vec4(rgb, alpha)
  })()
  return material
}

/** A bucket's GPU objects: one shape mesh per layer group (sharing buffers) and one text mesh. */
export class BucketMeshes {
  readonly shapes: Array<{ group: number; mesh: Mesh }> = []
  readonly text: Mesh | null = null
  protected readonly geometries: BufferGeometry[] = []

  constructor(bucket: TileBucket, shapeMaterial: MeshBasicNodeMaterial, textMaterial: MeshBasicNodeMaterial) {
    const { shapes, text } = bucket
    if (shapes !== null) {
      const position = new BufferAttribute(toVector3(shapes.positions), 3)
      const color = new BufferAttribute(shapes.colors, 4, true)
      const index = new BufferAttribute(shapes.indices, 1)
      for (const { group, start, count } of shapes.groups) {
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', position)
        geometry.setAttribute('color', color)
        geometry.setIndex(index)
        geometry.setDrawRange(start, count)
        this.geometries.push(geometry)
        this.shapes.push({ group, mesh: createMesh(geometry, shapeMaterial) })
      }
    }
    if (text !== null) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(toVector3(text.positions), 3))
      geometry.setAttribute('atlasUv', new BufferAttribute(text.uvs, 2))
      geometry.setAttribute('fillColor', new BufferAttribute(text.colors, 4, true))
      geometry.setAttribute('haloColor', new BufferAttribute(text.haloColors, 4, true))
      geometry.setAttribute('haloEdge', new BufferAttribute(text.haloEdges, 1))
      geometry.setIndex(new BufferAttribute(text.indices, 1))
      this.geometries.push(geometry)
      this.text = createMesh(geometry, textMaterial)
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
  }
}

function createMesh(geometry: BufferGeometry, material: MeshBasicNodeMaterial): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = true
  return mesh
}

/** Pads (x, y) pairs to (x, y, 0): three's position attribute is a vec3. */
function toVector3(pairs: Float32Array): Float32Array {
  const result = new Float32Array((pairs.length / 2) * 3)
  for (let source = 0, target = 0; source < pairs.length; source += 2, target += 3) {
    result[target] = pairs[source]!
    result[target + 1] = pairs[source + 1]!
  }
  return result
}
