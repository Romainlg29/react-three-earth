import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, FloatType, Mesh, NearestFilter, NoColorSpace, NormalBlending, RGBAFormat, Vector2 } from 'three'
import { attribute, cos, float, Fn, fwidth, int, ivec2, max, select, sin, smoothstep, texture, textureLoad, uniform, varying, vec2, vec4 } from 'three/tsl'
import { sRGBTransferEOTF } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import type { SymbolEffectDefinition, SymbolEffectInputs } from '../../plugins/symbolEffects.js'
import type { GlyphAtlasTexture, ImageAtlasTexture } from '../VectorTileMeshes.js'
import { GLYPH_EDGE } from '../worker/glyphs.js'
import type { SymbolMesh } from '../worker/types.js'

/** Labels per row of the state texture. */
export const SYMBOL_STATE_WIDTH = 1024

/**
 * Where each label shows this frame, one RGBA float texel per label slot: anchor on the screen (CSS pixels), scale
 * (text size / 24) and opacity (0 hides it). Written on the CPU after placement, read by the vertex shader, so a frame
 * uploads 16 bytes per label rather than every glyph's vertices. Slots are handed out in ranges, one per tile.
 */
export class SymbolStateTexture {
  texture: DataTexture
  data: Float32Array
  /** The node materials read; follows `texture` when it grows. */
  readonly node: ReturnType<typeof texture>
  /** Free slot ranges, sorted by start, never adjacent. */
  protected readonly free: Array<{ start: number; count: number }> = []
  protected rows = 1
  protected dirty = true

  constructor() {
    this.data = new Float32Array(SYMBOL_STATE_WIDTH * 4)
    this.texture = this.createTexture()
    this.free.push({ start: 0, count: SYMBOL_STATE_WIDTH })
    this.node = texture(this.texture)
  }

  get capacity(): number {
    return this.rows * SYMBOL_STATE_WIDTH
  }

  /** Reserves `count` consecutive slots, growing the texture when none fit. Returns the first slot. */
  allocate(count: number): number {
    for (;;) {
      const index = this.free.findIndex(range => range.count >= count)
      if (index !== -1) {
        const range = this.free[index]!
        const start = range.start
        range.start += count
        range.count -= count
        if (range.count === 0) this.free.splice(index, 1)
        return start
      }
      this.grow()
    }
  }

  /** Returns slots to the pool; they read as hidden until reused. */
  release(start: number, count: number): void {
    if (count <= 0) return
    this.data.fill(0, start * 4, (start + count) * 4)
    this.dirty = true
    let index = this.free.findIndex(range => range.start > start)
    if (index === -1) index = this.free.length
    this.free.splice(index, 0, { start, count })
    // Merge with the neighbours.
    const next = this.free[index + 1]
    if (next !== undefined && start + count === next.start) {
      this.free[index]!.count += next.count
      this.free.splice(index + 1, 1)
    }
    const previous = this.free[index - 1]
    if (previous !== undefined && previous.start + previous.count === start) {
      previous.count += this.free[index]!.count
      this.free.splice(index, 1)
    }
  }

  write(slot: number, xPixels: number, yPixels: number, scale: number, opacity: number): void {
    const offset = slot * 4
    const data = this.data
    // Compared as stored: float32.
    if (data[offset] === Math.fround(xPixels) && data[offset + 1] === Math.fround(yPixels) && data[offset + 2] === Math.fround(scale) && data[offset + 3] === Math.fround(opacity)) return
    data[offset] = xPixels
    data[offset + 1] = yPixels
    data[offset + 2] = scale
    data[offset + 3] = opacity
    this.dirty = true
  }

  hide(slot: number): void {
    if (this.data[slot * 4 + 3] === 0) return
    this.data[slot * 4 + 3] = 0
    this.dirty = true
  }

  /** Sends the state to the GPU when a value changed since the last upload. */
  upload(): void {
    if (!this.dirty) return
    this.texture.needsUpdate = true
    this.dirty = false
  }

  dispose(): void {
    this.texture.dispose()
  }

  protected grow(): void {
    const previousCapacity = this.capacity
    this.rows *= 2
    const data = new Float32Array(this.capacity * 4)
    data.set(this.data)
    this.data = data
    this.texture.dispose()
    this.texture = this.createTexture()
    this.node.value = this.texture
    const last = this.free.at(-1)
    if (last !== undefined && last.start + last.count === previousCapacity) last.count += this.capacity - previousCapacity
    else this.free.push({ start: previousCapacity, count: this.capacity - previousCapacity })
  }

  protected createTexture(): DataTexture {
    const state = new DataTexture(this.data, SYMBOL_STATE_WIDTH, this.rows, RGBAFormat, FloatType)
    state.colorSpace = NoColorSpace
    state.minFilter = NearestFilter
    state.magFilter = NearestFilter
    state.generateMipmaps = false
    state.flipY = false
    state.name = 'MapStyleSymbolState'
    state.needsUpdate = true
    return state
  }
}

/** Per-object value of `symbolSlotBase`: the first state slot of the tile the mesh draws. */
export interface SymbolMeshUserData {
  symbolSlotBase?: number
  /** The first slot of the tile's line label glyphs in the glyph state texture. */
  symbolGlyphSlotBase?: number
}

function linearColor(name: string) {
  const color = attribute<'vec4'>(name, 'vec4')
  return vec4(sRGBTransferEOTF(color.rgb) as unknown as Node<'vec3'>, color.a)
}

/**
 * Runs a plugin's `shade` when the renderer builds the shader. One that throws or returns no colour node falls back
 * to the standard look with an error naming the effect, rather than failing the frame for the whole map.
 */
function shadeWithEffect(effect: SymbolEffectDefinition, inputs: SymbolEffectInputs): Node<'vec4'> {
  try {
    const color = effect.shade(inputs) as unknown
    if (color !== null && typeof color === 'object' && (color as { isNode?: boolean }).isNode === true) return color as Node<'vec4'>
    console.error(`Symbol effect "${effect.name}": \`shade\` returned ${String(color)}, not a node; return a vec4 colour such as \`vec4(rgb, alpha)\`. Drawing the standard look.`)
  } catch (error) {
    console.error(`Symbol effect "${effect.name}": \`shade\` threw; fix it in the plugin that registers it. Drawing the standard look.`, error)
  }
  return inputs.standardColor
}

/**
 * The material of every label mesh of one style source: each glyph corner is moved to its label's anchor on the
 * screen (from the state texture) at the label's scale, or for a label along a line to its glyph's own place and
 * angle (from the glyph state texture), so the CPU never touches vertices after a tile loads. SDF text
 * with a halo, as the draped text. Drawn in the scene pass without depth test, over the terrain, so the atmosphere
 * hazes it like the ground behind it. `luminance` scales colours as the flat map's imagery (`ViewMorph.flatMapLuminance`)
 * so labels keep their style colours under the exposure; `opacity` is the imagery layer's. With `effect`, its
 * `shade` turns the distance into colour for text and SDF icons instead of the fill over its halo.
 */
export function createSymbolMaterial(atlas: GlyphAtlasTexture, imageAtlas: ImageAtlasTexture, state: SymbolStateTexture, glyphState: SymbolStateTexture, viewportPixels: { value: Vector2 }, luminance: { value: number }, opacity: { readonly value: number } = { value: 1 }, effect: SymbolEffectDefinition | null = null): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false, side: DoubleSide })
  material.name = effect === null ? 'MapStyleSymbols' : `MapStyleSymbols:${effect.name}`
  const viewport = uniform(viewportPixels.value).onRenderUpdate(() => viewportPixels.value) as unknown as Node<'vec2'>
  const slotBase = uniform(0).onObjectUpdate(({ object }) => (object?.userData as SymbolMeshUserData | undefined)?.symbolSlotBase ?? 0) as unknown as Node<'float'>
  const glyphSlotBase = uniform(0).onObjectUpdate(({ object }) => (object?.userData as SymbolMeshUserData | undefined)?.symbolGlyphSlotBase ?? 0) as unknown as Node<'float'>
  const brightness = uniform(1).onRenderUpdate(() => luminance.value) as unknown as Node<'float'>
  const layerOpacity = uniform(1).onRenderUpdate(() => opacity.value) as unknown as Node<'float'>

  // Two texels a label: its anchor, scale and opacity, then its text's shift from the anchor (variable anchors) and
  // its icon's scale relative to the label's.
  const slot = int(attribute<'float'>('labelIndex', 'float').mul(2).add(slotBase))
  const shiftSlot = slot.add(1)
  const width = int(SYMBOL_STATE_WIDTH)
  const labelState = textureLoad(state.node as never, ivec2(slot.mod(width), slot.div(width)), 0) as unknown as Node<'vec4'>
  const shiftState = textureLoad(state.node as never, ivec2(shiftSlot.mod(width), shiftSlot.div(width)), 0) as unknown as Node<'vec4'>
  const shift = shiftState.xy
  // A glyph of a label along a line: at its own place on the screen, turned with the line there. -1: a point
  // label's text (shifted), -2 and -3: its icon (at the point, at its own scale).
  const glyphIndex = attribute<'float'>('glyphIndex', 'float')
  const quadScale = select(glyphIndex.lessThan(-1.5), labelState.z.mul(shiftState.z), labelState.z)
  const corner = attribute<'vec3'>('position', 'vec3').xy.mul(quadScale)
  const glyphSlot = int(max(glyphIndex, float(0)).add(glyphSlotBase))
  const glyph = textureLoad(glyphState.node as never, ivec2(glyphSlot.mod(width), glyphSlot.div(width)), 0) as unknown as Node<'vec4'>
  const cosine = cos(glyph.z)
  const sine = sin(glyph.z)
  const turned = vec2(corner.x.mul(cosine).sub(corner.y.mul(sine)), corner.x.mul(sine).add(corner.y.mul(cosine)))
  const pointText = labelState.xy.add(corner).add(shift)
  const icon = labelState.xy.add(corner)
  const pixels = select(glyphIndex.lessThan(-1.5), icon, select(glyphIndex.lessThan(0), pointText, glyph.xy.add(turned)))
  const ndc = vec2(pixels.x.div(viewport.x).mul(2).sub(1), float(1).sub(pixels.y.div(viewport.y).mul(2)))
  // Hidden labels collapse outside the clip volume.
  material.vertexNode = vec4(select(labelState.w.greaterThan(0), ndc, vec2(4, 4)), 0, 1)

  const labelOpacity = varying(labelState.w)
  const labelScale = varying(quadScale)
  const kind = varying(glyphIndex)
  const haloEdge = varying(max(float(GLYPH_EDGE).sub(attribute<'float'>('haloWidth', 'float').div(max(quadScale, float(1e-3)).mul(8))), float(0.05)))
  material.colorNode = Fn(() => {
    const uv = attribute<'vec2'>('atlasUv', 'vec2')
    const isIcon = kind.lessThan(-1.5)
    const isColorIcon = isIcon.and(kind.greaterThan(-2.5))
    // Icons read the style's image atlas (premultiplied): an SDF icon's distance is in its alpha.
    const image = imageAtlas.node.sample(uv.div(imageAtlas.size)) as unknown as Node<'vec4'>
    const distance = select(isIcon, image.a, (atlas.node.sample(uv.div(atlas.size)) as unknown as Node<'vec4'>).r)
    const smoothing = max(fwidth(distance).mul(0.7), float(1 / 255))
    const edge = float(GLYPH_EDGE)
    const fill = linearColor('fillColor')
    const halo = linearColor('haloColor')
    const fillAlpha = fill.a.mul(smoothstep(edge.sub(smoothing), edge.add(smoothing), distance))
    const haloAlpha = halo.a.mul(smoothstep(haloEdge.sub(smoothing), haloEdge.add(smoothing), distance)).mul(fillAlpha.oneMinus())
    const alpha = fillAlpha.add(haloAlpha)
    const rgb = fill.rgb.mul(fillAlpha).add(halo.rgb.mul(haloAlpha)).div(max(alpha, float(1e-4)))
    const standardColor = vec4(rgb, alpha)
    const shaded = effect === null ? standardColor : shadeWithEffect(effect, { distance, edge, haloEdge, distancePerPixel: max(fwidth(distance), float(1e-4)), fillColor: fill, haloColor: halo, isIcon: select(isIcon, float(1), float(0)), scale: labelScale, standardColor })
    const sdfColor = vec4(shaded.rgb.mul(brightness), shaded.a.mul(labelOpacity).mul(layerOpacity))
    // A colour icon: its own colours (straight, linear), faded by icon-opacity (the fill colour's alpha).
    const straight = sRGBTransferEOTF(image.rgb.div(max(image.a, float(1 / 255)))) as unknown as Node<'vec3'>
    const colorIcon = vec4(straight.mul(brightness), image.a.mul(fill.a).mul(labelOpacity).mul(layerOpacity))
    return select(isColorIcon, colorIcon, sdfColor)
  })()
  return material
}

/** The GPU mesh of one tile's labels. Positions hold each glyph corner around its anchor; the material places it. */
export function createSymbolTileMesh(symbols: SymbolMesh, material: MeshBasicNodeMaterial): Mesh {
  const geometry = new BufferGeometry()
  const vertexCount = symbols.labelIndices.length
  const positions = new Float32Array(vertexCount * 3)
  for (let index = 0; index < vertexCount; index++) {
    positions[index * 3] = symbols.corners[index * 2]!
    positions[index * 3 + 1] = symbols.corners[index * 2 + 1]!
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('atlasUv', new BufferAttribute(symbols.uvs, 2))
  geometry.setAttribute('labelIndex', new BufferAttribute(symbols.labelIndices, 1))
  geometry.setAttribute('glyphIndex', new BufferAttribute(symbols.glyphIndices, 1))
  geometry.setAttribute('fillColor', new BufferAttribute(symbols.colors, 4, true))
  geometry.setAttribute('haloColor', new BufferAttribute(symbols.haloColors, 4, true))
  geometry.setAttribute('haloWidth', new BufferAttribute(symbols.haloWidths, 1))
  geometry.setIndex(new BufferAttribute(symbols.indices, 1))
  const mesh = new Mesh(geometry, material)
  mesh.name = 'MapStyleSymbolTile'
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.renderOrder = 1_000_000
  // Screen-space quads: never a raycast hit (terrain queries raycast the scene graph).
  mesh.raycast = () => {}
  return mesh
}
