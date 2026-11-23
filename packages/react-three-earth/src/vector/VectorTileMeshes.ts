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
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
  type PixelFormat,
} from 'three'
import {
  attribute,
  Discard,
  float,
  floor,
  Fn,
  fract,
  fwidth,
  If,
  int,
  ivec2,
  max,
  mix,
  mod,
  positionGeometry,
  select,
  smoothstep,
  sRGBTransferEOTF,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
  vertexStage,
} from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import { GLYPH_EDGE } from './worker/glyphs.js'
import { TILE_EXTENT, type AtlasUpdate, type CustomLayerMesh, type FeatureColorUpdate, type ImageAtlasUpdate, type TileBucket } from './worker/types.js'

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
 *
 * With a feature colour table, vertices whose `colorSlot` is not 0 read their colour from the table instead
 * (looked up per vertex): feature-state changes only update the table.
 */
export function createShapeMaterial(colorTable?: FeatureColorTexture): MeshBasicNodeMaterial {
  const material = createMaterial()
  const color = shapeColor(colorTable)
  material.colorNode = Fn(() => {
    discardOutsideTile()
    return color
  })()
  return material
}

/** The linear vertex colour of a shape, or its slot's colour in the table when it has one. */
function shapeColor(colorTable: FeatureColorTexture | undefined): Node<'vec4'> {
  if (colorTable === undefined) return linearColor('color') as unknown as Node<'vec4'>
  const slot = attribute<'float'>('colorSlot', 'float')
  const width = float(colorTable.width)
  const entry = colorTable.node.load(ivec2(int(mod(slot, width)), int(floor(slot.div(width))))) as unknown as Node<'vec4'>
  const own = attribute<'vec4'>('color', 'vec4')
  const chosen = vertexStage(select(slot.greaterThan(0.5), entry, own))
  return vec4(sRGBTransferEOTF(chosen.rgb) as unknown as Node<'vec3'>, chosen.a) as unknown as Node<'vec4'>
}

/** Drops fragments outside the tile square. Call inside `Fn`. */
export function discardOutsideTile(): void {
  const local = positionGeometry
  If(local.x.lessThan(0).or(local.x.greaterThan(TILE_EXTENT)).or(local.y.lessThan(0)).or(local.y.greaterThan(TILE_EXTENT)), () => {
    Discard()
  })
}

/**
 * The main thread's copy of the worker's feature colour table: one RGBA texel per slot, `width` slots per row,
 * straight-alpha sRGB. Grows by rows; changed slots are written in place and uploaded once per batch.
 */
export class FeatureColorTexture {
  readonly width = 1024
  texture: DataTexture
  /** The texture node read by shape materials; its value follows `texture` when the table grows. */
  readonly node: ReturnType<typeof texture>
  protected data: Uint8Array
  protected dirty = false

  constructor() {
    this.data = new Uint8Array(this.width * 4)
    this.texture = this.createTexture(1)
    this.node = texture(this.texture)
  }

  get rows(): number {
    return this.texture.image.height
  }

  apply(update: FeatureColorUpdate): void {
    if (update.height > this.rows) {
      const data = new Uint8Array(this.width * update.height * 4)
      data.set(this.data)
      this.data = data
      this.texture.dispose()
      this.texture = this.createTexture(update.height)
      this.node.value = this.texture
    }
    update.slots.forEach((slot, index) => this.data.set(update.colors.subarray(index * 4, index * 4 + 4), slot * 4))
    this.dirty = true
  }

  /** Uploads the table if colours changed since the last upload. Call before drawing. */
  upload(): void {
    if (!this.dirty) return
    this.texture.needsUpdate = true
    this.dirty = false
  }

  dispose(): void {
    this.texture.dispose()
  }

  protected createTexture(rows: number): DataTexture {
    const table = new DataTexture(this.data, this.width, rows, RGBAFormat, UnsignedByteType)
    table.colorSpace = NoColorSpace
    table.generateMipmaps = false
    table.flipY = false
    table.name = 'MapStyleFeatureColors'
    table.needsUpdate = true
    return table
  }
}

/** A single-colour quad over the whole composite; set `color` (straight-alpha sRGB, 0 to 1) before drawing. */
export function createBackgroundMaterial(): { material: MeshBasicNodeMaterial; color: Vector4 } {
  const color = new Vector4()
  const node = uniform(color)
  const material = createMaterial()
  material.colorNode = vec4(sRGBTransferEOTF(node.xyz) as unknown as Node<'vec3'>, node.w)
  return { material, color }
}

/** A rectangle of new pixels for a mirrored atlas, rows from the top, tightly packed. */
interface AtlasPixels {
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array
}

/**
 * The main thread's copy of an atlas the worker packs (glyphs, images): it grows when the worker's does,
 * keeping what it holds, and uploads once per batch of changes.
 */
export class MirroredAtlasTexture {
  texture: DataTexture
  /** Atlas size in pixels, to turn pixel coordinates into texture coordinates. */
  readonly size = uniform(new Vector2(1, 1))
  /** The texture node read by materials; its value follows `texture` when the atlas grows. */
  readonly node: ReturnType<typeof texture>
  protected data = new Uint8Array(1)
  protected dirty = false

  constructor(
    protected readonly channels: 1 | 4,
    protected readonly name: string,
  ) {
    this.data = new Uint8Array(channels)
    this.texture = this.createTexture(1, 1)
    this.node = texture(this.texture)
  }

  protected applyPixels(width: number, height: number, entries: readonly AtlasPixels[]): void {
    const channels = this.channels
    if (width !== this.texture.image.width || height !== this.texture.image.height) {
      const data = new Uint8Array(width * height * channels)
      const previousWidth = this.texture.image.width
      const rowBytes = Math.min(previousWidth, width) * channels
      for (let row = 0; row < Math.min(this.texture.image.height, height); row++) {
        data.set(this.data.subarray(row * previousWidth * channels, row * previousWidth * channels + rowBytes), row * width * channels)
      }
      this.data = data
      this.texture.dispose()
      this.texture = this.createTexture(width, height)
      this.node.value = this.texture
      this.size.value.set(width, height)
    }
    for (const entry of entries) {
      const entryRowBytes = entry.width * channels
      for (let row = 0; row < entry.height; row++) {
        this.data.set(entry.data.subarray(row * entryRowBytes, (row + 1) * entryRowBytes), ((entry.y + row) * width + entry.x) * channels)
      }
    }
    if (entries.length > 0) this.dirty = true
  }

  /** Uploads the atlas if pixels arrived since the last upload. Call before drawing: one upload per batch. */
  upload(): void {
    if (!this.dirty) return
    this.texture.needsUpdate = true
    this.dirty = false
  }

  dispose(): void {
    this.texture.dispose()
  }

  protected createTexture(width: number, height: number): DataTexture {
    if (this.data.length !== width * height * this.channels) this.data = new Uint8Array(width * height * this.channels)
    const format: PixelFormat = this.channels === 1 ? RedFormat : RGBAFormat
    const atlas = new DataTexture(this.data, width, height, format, UnsignedByteType)
    atlas.colorSpace = NoColorSpace
    atlas.minFilter = LinearFilter
    atlas.magFilter = LinearFilter
    atlas.generateMipmaps = false
    atlas.flipY = false
    atlas.unpackAlignment = this.channels === 1 ? 1 : 4
    atlas.name = this.name
    atlas.needsUpdate = true
    return atlas
  }
}

/** The main thread's copy of the worker's glyph atlas: one channel of signed distance, 1024 wide. */
export class GlyphAtlasTexture extends MirroredAtlasTexture {
  constructor() {
    super(1, 'MapStyleGlyphAtlas')
  }

  apply(update: AtlasUpdate): void {
    this.applyPixels(update.width, update.height, update.glyphs)
  }
}

/** The main thread's copy of the worker's image atlas (patterns): RGBA, sRGB, premultiplied. */
export class ImageAtlasTexture extends MirroredAtlasTexture {
  constructor() {
    super(4, 'MapStyleImageAtlas')
  }

  apply(update: ImageAtlasUpdate): void {
    this.applyPixels(update.width, update.height, update.images)
  }
}

/**
 * The colour of a repeated pattern image: `rectangle` is its place in the atlas (x, y, width, height in atlas
 * pixels), `coordinates` the position in the repeated image, in image pixels. Straight alpha, linear.
 */
function samplePattern(atlas: ImageAtlasTexture, rectangle: Node<'vec4'>, coordinates: Node<'vec2'>) {
  const size = max(rectangle.zw, vec2(1, 1))
  const texel = rectangle.xy.add(fract(coordinates.div(size)).mul(size))
  const sample = atlas.node.sample(texel.div(atlas.size)) as unknown as Node<'vec4'>
  const straight = sample.rgb.div(max(sample.a, float(1 / 255)))
  return vec4(sRGBTransferEOTF(straight) as unknown as Node<'vec3'>, sample.a)
}

/**
 * Fills, lines and circles of a tile that has patterns: like `createShapeMaterial`, and vertices with a
 * pattern rectangle take the pattern's colour, times the vertex colour's alpha (the opacity).
 */
export function createPatternShapeMaterial(atlas: ImageAtlasTexture, colorTable?: FeatureColorTexture): MeshBasicNodeMaterial {
  const material = createMaterial()
  const shape = shapeColor(colorTable)
  material.colorNode = Fn(() => {
    discardOutsideTile()
    const color = shape as unknown as ReturnType<typeof linearColor>
    // Normalised 16-bit attribute: back to atlas pixels.
    const rectangle = attribute<'vec4'>('pattern', 'vec4').mul(65535)
    const pattern = samplePattern(atlas, rectangle, attribute<'vec2'>('patternCoordinates', 'vec2'))
    return mix(color, vec4(pattern.rgb, pattern.a.mul(color.a)), step(0.5, rectangle.z))
  })()
  return material
}

/**
 * `background-pattern` over the whole composite. Set the uniforms before drawing: `rectangle` (atlas pixels),
 * `origin` (image pixels at the composite's top-left corner, reduced into the image), `span` (image pixels
 * across the composite) and `opacity`.
 */
export function createBackgroundPatternMaterial(atlas: ImageAtlasTexture) {
  const rectangle = new Vector4()
  const origin = new Vector2()
  const span = new Vector2()
  const opacity = uniform(1)
  const material = createMaterial()
  material.colorNode = Fn(() => {
    // The composite's y grows to the north; image rows grow to the south.
    const coordinates = uniform(origin).add(vec2(uv().x, uv().y.oneMinus()).mul(uniform(span)))
    const pattern = samplePattern(atlas, uniform(rectangle), coordinates)
    return vec4(pattern.rgb, pattern.a.mul(opacity))
  })()
  return { material, rectangle, origin, span, opacity }
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

/** The shape materials a bucket picks from: with or without patterns, with or without feature colour slots. */
export interface ShapeMaterials {
  plain: MeshBasicNodeMaterial
  slotted?: MeshBasicNodeMaterial
  patterned?: MeshBasicNodeMaterial
  slottedPatterned?: MeshBasicNodeMaterial
}

function chooseShapeMaterial(materials: ShapeMaterials, patterned: boolean, slotted: boolean): MeshBasicNodeMaterial {
  if (patterned && slotted) return materials.slottedPatterned ?? materials.patterned ?? materials.slotted ?? materials.plain
  if (patterned) return materials.patterned ?? materials.plain
  if (slotted) return materials.slotted ?? materials.plain
  return materials.plain
}

/** A custom layer's mesh in a bucket. Its material is the layer type's, set when it is drawn. */
export interface CustomLayerDraw {
  layerType: string
  group: number
  mesh: Mesh
}

/** A bucket's GPU objects: one shape mesh per layer group (sharing buffers), custom layer meshes and one text mesh. */
export class BucketMeshes {
  readonly shapes: Array<{ group: number; mesh: Mesh }> = []
  readonly custom: CustomLayerDraw[] = []
  readonly text: Mesh | null = null
  protected readonly geometries: BufferGeometry[] = []

  constructor(bucket: TileBucket, shapeMaterials: ShapeMaterials, textMaterial: MeshBasicNodeMaterial) {
    const { shapes, text } = bucket
    if (shapes !== null) {
      const position = new BufferAttribute(toVector3(shapes.positions), 3)
      const color = new BufferAttribute(shapes.colors, 4, true)
      const slots = shapes.colorSlots == null ? null : new BufferAttribute(shapes.colorSlots, 1)
      const index = new BufferAttribute(shapes.indices, 1)
      const patterned = shapes.patterns != null && shapes.patternCoordinates != null
      const pattern = patterned ? new BufferAttribute(shapes.patterns!, 4, true) : null
      const patternCoordinates = patterned ? new BufferAttribute(shapes.patternCoordinates!, 2) : null
      for (const { group, start, count } of shapes.groups) {
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', position)
        geometry.setAttribute('color', color)
        if (slots !== null) geometry.setAttribute('colorSlot', slots)
        if (pattern !== null && patternCoordinates !== null) {
          geometry.setAttribute('pattern', pattern)
          geometry.setAttribute('patternCoordinates', patternCoordinates)
        }
        geometry.setIndex(index)
        geometry.setDrawRange(start, count)
        this.geometries.push(geometry)
        this.shapes.push({ group, mesh: createMesh(geometry, chooseShapeMaterial(shapeMaterials, patterned, slots !== null)) })
      }
    }
    for (const layer of bucket.layers) {
      const geometry = createCustomLayerGeometry(layer)
      this.geometries.push(geometry)
      this.custom.push({ layerType: layer.layerType, group: layer.group, mesh: createMesh(geometry, shapeMaterials.plain) })
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

  protected readonly copies = new Map<Mesh, Mesh[]>()

  /** The mesh itself for the first placement in a draw, a lasting copy (same geometry) for each further one. */
  placement(mesh: Mesh, index: number): Mesh {
    if (index === 0) return mesh
    let copies = this.copies.get(mesh)
    if (copies === undefined) this.copies.set(mesh, (copies = []))
    while (copies.length < index) copies.push(mesh.clone())
    return copies[index - 1]!
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

/** The GPU geometry of one custom layer mesh from the worker. Positions are padded to vec3. */
export function createCustomLayerGeometry(mesh: CustomLayerMesh): BufferGeometry {
  const geometry = new BufferGeometry()
  for (const { name, array, itemSize, normalized } of mesh.attributes) {
    if (name === 'position') {
      const positions = new Float32Array((array.length / 2) * 3)
      for (let source = 0, target = 0; source < array.length; source += 2, target += 3) {
        positions[target] = array[source]!
        positions[target + 1] = array[source + 1]!
      }
      geometry.setAttribute('position', new BufferAttribute(positions, 3))
    } else {
      geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized))
    }
  }
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  return geometry
}
