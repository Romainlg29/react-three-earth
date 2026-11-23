import { GLYPH_BUFFER } from './glyphs.js'
import { layoutPointLabel, type ShapedText } from './labels.js'
import type { Point } from './ShapeBuilder.js'
import type { Rgba } from './styleLayers.js'
import type { SymbolMesh } from './types.js'

/** `SymbolMesh.flags` bits. */
export const SYMBOL_ALLOW_OVERLAP = 1
export const SYMBOL_IGNORE_PLACEMENT = 2

/** One label facing the viewer, as the worker lays it out once per tile. */
export interface ScreenLabel {
  /** Anchor in tile units (0 to `TILE_EXTENT`, y down). */
  anchor: Point
  shaped: ShapedText
  /** `text-offset`, in pixels of a 24 px font. */
  offset: Point
  rotationRadians: number
  /** `text-size` at the tile's zoom and one zoom deeper, in pixels: the main thread interpolates at the camera's zoom. */
  sizePixels: number
  nextZoomSizePixels: number
  paddingPixels: number
  allowOverlap: boolean
  ignorePlacement: boolean
  /** The style layer's position among the style's layers: higher draws and places first. */
  layerIndex: number
  sortKey: number
  color: Rgba
  haloColor: Rgba
  haloWidthPixels: number
  /** Same text in the same layer: the main thread matches labels across tiles and zooms with it (fades, duplicates). */
  key: string
}

/**
 * Accumulates the labels of one tile that face the viewer. Glyph corners are in pixels of a 24 px font around the
 * label's anchor (y down, as on the screen), so the main thread scales them by the size it interpolates for the
 * camera's zoom and moves them to the anchor's screen position each frame.
 */
export class SymbolBuilder {
  protected readonly anchors: number[] = []
  protected readonly sizes: number[] = []
  protected readonly boxes: number[] = []
  protected readonly paddings: number[] = []
  protected readonly flags: number[] = []
  protected readonly layerIndices: number[] = []
  protected readonly sortKeys: number[] = []
  protected readonly keys: string[] = []
  protected readonly corners: number[] = []
  protected readonly uvs: number[] = []
  protected readonly labelIndices: number[] = []
  protected readonly colors: number[] = []
  protected readonly haloColors: number[] = []
  protected readonly haloWidths: number[] = []
  protected readonly indices: number[] = []

  get labelCount(): number {
    return this.keys.length
  }

  add(label: ScreenLabel): void {
    const { quads, boxes } = layoutPointLabel(label.shaped, { x: 0, y: 0 }, 1, label.offset, label.rotationRadians, 0)
    if (quads.length === 0) return
    const labelIndex = this.keys.length
    const box = boxes[0]!
    this.anchors.push(label.anchor.x, label.anchor.y)
    this.sizes.push(label.sizePixels, label.nextZoomSizePixels)
    this.boxes.push(box.minimumX, box.minimumY, box.maximumX, box.maximumY)
    this.paddings.push(label.paddingPixels)
    this.flags.push((label.allowOverlap ? SYMBOL_ALLOW_OVERLAP : 0) | (label.ignorePlacement ? SYMBOL_IGNORE_PLACEMENT : 0))
    this.layerIndices.push(label.layerIndex)
    this.sortKeys.push(label.sortKey)
    this.keys.push(label.key)
    for (const { corners, glyph } of quads) {
      const first = this.labelIndices.length
      const width = glyph.width + GLYPH_BUFFER * 2
      const height = glyph.height + GLYPH_BUFFER * 2
      const uv = [glyph.x, glyph.y, glyph.x + width, glyph.y, glyph.x + width, glyph.y + height, glyph.x, glyph.y + height]
      for (let corner = 0; corner < 4; corner++) {
        this.corners.push(corners[corner]!.x, corners[corner]!.y)
        this.uvs.push(uv[corner * 2]!, uv[corner * 2 + 1]!)
        this.labelIndices.push(labelIndex)
        this.colors.push(...label.color)
        this.haloColors.push(...label.haloColor)
        this.haloWidths.push(label.haloWidthPixels)
      }
      this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
    }
  }

  build(): SymbolMesh | null {
    if (this.keys.length === 0) return null
    const vertexCount = this.labelIndices.length
    return {
      anchors: new Float32Array(this.anchors),
      sizes: new Float32Array(this.sizes),
      boxes: new Float32Array(this.boxes),
      paddings: new Float32Array(this.paddings),
      flags: new Uint8Array(this.flags),
      layerIndices: new Uint16Array(this.layerIndices),
      sortKeys: new Float32Array(this.sortKeys),
      keys: this.keys,
      corners: new Float32Array(this.corners),
      uvs: new Float32Array(this.uvs),
      labelIndices: new Float32Array(this.labelIndices),
      colors: new Uint8Array(this.colors),
      haloColors: new Uint8Array(this.haloColors),
      haloWidths: new Float32Array(this.haloWidths),
      indices: vertexCount <= 65_535 ? new Uint16Array(this.indices) : new Uint32Array(this.indices),
    }
  }
}

/** Bytes a symbol mesh holds, for cache budgets. */
export function symbolMeshByteLength(mesh: SymbolMesh | null): number {
  if (mesh === null) return 0
  const arrays = [mesh.anchors, mesh.sizes, mesh.boxes, mesh.paddings, mesh.flags, mesh.layerIndices, mesh.sortKeys, mesh.corners, mesh.uvs, mesh.labelIndices, mesh.colors, mesh.haloColors, mesh.haloWidths, mesh.indices]
  return arrays.reduce((sum, array) => sum + array.byteLength, 0) + mesh.keys.reduce((sum, key) => sum + key.length * 2, 0)
}

/** Typed arrays of a symbol mesh, to transfer. */
export function symbolMeshBuffers(mesh: SymbolMesh | null): ArrayBufferLike[] {
  if (mesh === null) return []
  return [mesh.anchors, mesh.sizes, mesh.boxes, mesh.paddings, mesh.flags, mesh.layerIndices, mesh.sortKeys, mesh.corners, mesh.uvs, mesh.labelIndices, mesh.colors, mesh.haloColors, mesh.haloWidths, mesh.indices].map(array => array.buffer)
}
