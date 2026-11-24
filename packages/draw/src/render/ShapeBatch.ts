import { BufferAttribute, BufferGeometry, CustomBlending, DoubleSide, DynamicDrawUsage, Mesh, OneFactor, OneMinusSrcAlphaFactor, NormalBlending, Vector2 } from 'three'
import { attribute, clamp, float, length, uniform, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

/** Floats per vertex: x, y, red, green, blue, alpha, offset x, offset y, radius. */
const STRIDE = 9
/** A radius that never clips: plain fills. */
const SOLID_RADIUS = 1e9

/**
 * Antialiased 2D shapes built on the CPU in pixels and drawn in one call: polygon fills, lines with round joins, and
 * circles. Used for draped regions (pixels of the region's texture, y up) and for the live overlay (CSS pixels of the
 * screen, y down). Each vertex carries its offset from the shape's centre line and the shape's radius, and the
 * fragment fades the last pixel, so edges are smooth without multisampling.
 */
export class ShapeBatch {
  protected data = new Float32Array(STRIDE * 3 * 256)
  protected vertexCount = 0
  readonly mesh: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  /** Size of the pixel space the shapes are built in: the target or the viewport. */
  readonly sizePixels = uniform(new Vector2(1, 1))
  protected capacity = 0

  /**
   * `flipY`: pixels count down from the top (screen space) rather than up from the bottom (texture space).
   * `premultipliedAlpha`: writes premultiplied colour, for a transparent target that is composited later (a draped
   * region); otherwise straight alpha blended over what is drawn (the screen).
   */
  constructor({ flipY, premultipliedAlpha = false }: { flipY: boolean; premultipliedAlpha?: boolean }) {
    const material = new MeshBasicNodeMaterial({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false, side: DoubleSide })
    if (premultipliedAlpha) {
      material.blending = CustomBlending
      material.blendSrc = OneFactor
      material.blendDst = OneMinusSrcAlphaFactor
      material.blendSrcAlpha = OneFactor
      material.blendDstAlpha = OneMinusSrcAlphaFactor
    }
    const pixel = attribute<'vec2'>('shapePixel', 'vec2')
    const ndc = pixel.div(this.sizePixels).mul(2).sub(1)
    material.vertexNode = vec4(ndc.x, flipY ? ndc.y.negate() : ndc.y, 0, 1)
    const color = attribute<'vec4'>('shapeColor', 'vec4')
    const offset = attribute<'vec2'>('shapeOffset', 'vec2')
    const radius = attribute<'float'>('shapeRadius', 'float')
    const coverage = clamp(radius.sub(length(offset)).add(0.5), float(0), float(1))
    const alpha = color.a.mul(coverage)
    material.colorNode = premultipliedAlpha ? vec4(color.rgb.mul(alpha), alpha) : vec4(color.rgb, alpha)
    this.mesh = new Mesh(new BufferGeometry(), material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1e9
  }

  get empty(): boolean {
    return this.vertexCount === 0
  }

  clear(): void {
    this.vertexCount = 0
  }

  protected vertex(x: number, y: number, color: readonly [number, number, number], alpha: number, offsetX: number, offsetY: number, radius: number): void {
    if ((this.vertexCount + 1) * STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    const data = this.data
    let index = this.vertexCount * STRIDE
    data[index++] = x
    data[index++] = y
    data[index++] = color[0]
    data[index++] = color[1]
    data[index++] = color[2]
    data[index++] = alpha
    data[index++] = offsetX
    data[index++] = offsetY
    data[index] = radius
    this.vertexCount++
  }

  /** A filled triangle. */
  triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: readonly [number, number, number], alpha: number): void {
    this.vertex(ax, ay, color, alpha, 0, 0, SOLID_RADIUS)
    this.vertex(bx, by, color, alpha, 0, 0, SOLID_RADIUS)
    this.vertex(cx, cy, color, alpha, 0, 0, SOLID_RADIUS)
  }

  /** A circle of `radius` pixels. */
  circle(x: number, y: number, radius: number, color: readonly [number, number, number], alpha: number): void {
    if (radius <= 0 || alpha <= 0) return
    const r = radius + 1 // a pixel of margin for the fade
    this.vertex(x - r, y - r, color, alpha, -r, -r, radius)
    this.vertex(x + r, y - r, color, alpha, r, -r, radius)
    this.vertex(x + r, y + r, color, alpha, r, r, radius)
    this.vertex(x - r, y - r, color, alpha, -r, -r, radius)
    this.vertex(x + r, y + r, color, alpha, r, r, radius)
    this.vertex(x - r, y + r, color, alpha, -r, r, radius)
  }

  /** A segment `width` pixels wide, with flat ends (joins are circles: see `polyline`). */
  segment(ax: number, ay: number, bx: number, by: number, width: number, color: readonly [number, number, number], alpha: number): void {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length === 0 || width <= 0 || alpha <= 0) return
    const half = width / 2
    const reach = half + 1
    const nx = (-dy / length) * reach
    const ny = (dx / length) * reach
    this.vertex(ax + nx, ay + ny, color, alpha, reach, 0, half)
    this.vertex(bx + nx, by + ny, color, alpha, reach, 0, half)
    this.vertex(bx - nx, by - ny, color, alpha, -reach, 0, half)
    this.vertex(ax + nx, ay + ny, color, alpha, reach, 0, half)
    this.vertex(bx - nx, by - ny, color, alpha, -reach, 0, half)
    this.vertex(ax - nx, ay - ny, color, alpha, -reach, 0, half)
  }

  /** A line through `points` (flat x, y pairs), with round joins and caps. */
  polyline(points: ArrayLike<number>, width: number, color: readonly [number, number, number], alpha: number): void {
    const count = points.length / 2
    for (let index = 0; index + 1 < count; index++) {
      this.segment(points[index * 2]!, points[index * 2 + 1]!, points[index * 2 + 2]!, points[index * 2 + 3]!, width, color, alpha)
    }
    // Round joins only where a line is thick enough for gaps to show.
    if (width < 2.5) return
    for (let index = 0; index < count; index++) this.circle(points[index * 2]!, points[index * 2 + 1]!, width / 2, color, alpha)
  }

  /** Uploads the shapes built since `clear` to the mesh. */
  /**
   * Uploads the shapes built since `clear` to the mesh. `fresh`: into a new geometry, returning the old one for the
   * caller to dispose once the GPU is done with it (for several draws in one frame, which must not share buffers).
   */
  upload({ fresh = false }: { fresh?: boolean } = {}): BufferGeometry | null {
    const needed = this.vertexCount
    let geometry = this.mesh.geometry
    let replaced: BufferGeometry | null = null
    if (fresh) {
      replaced = geometry
      this.capacity = 0
      geometry = this.mesh.geometry = new BufferGeometry()
    }
    if (needed > this.capacity || this.capacity === 0) {
      // GPU buffers cannot grow: a new geometry, twice as large as needed (exactly as large when fresh).
      geometry.dispose()
      this.capacity = fresh ? Math.max(needed, 3) : Math.max(256, needed * 2)
      geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.capacity * 3), 3))
      geometry.setAttribute('shapePixel', new BufferAttribute(new Float32Array(this.capacity * 2), 2))
      geometry.setAttribute('shapeColor', new BufferAttribute(new Float32Array(this.capacity * 4), 4))
      geometry.setAttribute('shapeOffset', new BufferAttribute(new Float32Array(this.capacity * 2), 2))
      geometry.setAttribute('shapeRadius', new BufferAttribute(new Float32Array(this.capacity), 1))
      for (const name of ['shapePixel', 'shapeColor', 'shapeOffset', 'shapeRadius']) (geometry.getAttribute(name) as BufferAttribute).setUsage(DynamicDrawUsage)
      this.mesh.geometry = geometry
    }
    const pixel = geometry.getAttribute('shapePixel') as BufferAttribute
    const color = geometry.getAttribute('shapeColor') as BufferAttribute
    const offset = geometry.getAttribute('shapeOffset') as BufferAttribute
    const radius = geometry.getAttribute('shapeRadius') as BufferAttribute
    const pixels = pixel.array as Float32Array
    const colors = color.array as Float32Array
    const offsets = offset.array as Float32Array
    const radii = radius.array as Float32Array
    const data = this.data
    for (let vertex = 0; vertex < needed; vertex++) {
      const source = vertex * STRIDE
      pixels[vertex * 2] = data[source]!
      pixels[vertex * 2 + 1] = data[source + 1]!
      colors[vertex * 4] = data[source + 2]!
      colors[vertex * 4 + 1] = data[source + 3]!
      colors[vertex * 4 + 2] = data[source + 4]!
      colors[vertex * 4 + 3] = data[source + 5]!
      offsets[vertex * 2] = data[source + 6]!
      offsets[vertex * 2 + 1] = data[source + 7]!
      radii[vertex] = data[source + 8]!
    }
    for (const attributeToUpload of [pixel, color, offset, radius]) {
      attributeToUpload.clearUpdateRanges()
      attributeToUpload.addUpdateRange(0, needed * attributeToUpload.itemSize)
      attributeToUpload.needsUpdate = true
    }
    geometry.setDrawRange(0, needed)
    this.mesh.visible = needed > 0
    return replaced
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
