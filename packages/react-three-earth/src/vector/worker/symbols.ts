import { GLYPH_BUFFER, type AtlasGlyph } from './glyphs.js'
import { layoutPointLabel, type Box, type LineLabelPath, type ShapedText } from './labels.js'
import type { Point } from './ShapeBuilder.js'
import type { Rgba } from './styleLayers.js'
import type { SymbolMesh } from './types.js'

/** `SymbolMesh.flags` bits. */
export const SYMBOL_ALLOW_OVERLAP = 1
export const SYMBOL_IGNORE_PLACEMENT = 2
/** Laid along a line on the screen (`symbol-placement: line`), glyph by glyph. */
export const SYMBOL_LINE = 4
/** A line label turned around where its line runs right to left on the screen (`text-keep-upright`). */
export const SYMBOL_KEEP_UPRIGHT = 8
/** Has an icon (`icon-image`): its box is in `SymbolMesh.iconBoxes`, and variable anchors move only the text. */
export const SYMBOL_ICON = 16
/** An icon without text: `SymbolMesh.boxes` holds the icon's box. */
export const SYMBOL_ICON_ONLY = 32
/** `SymbolMesh.glyphIndices` of an icon's vertices: a colour image, or an SDF image tinted with `icon-color`. */
export const ICON_GLYPH_INDEX = -2
export const SDF_ICON_GLYPH_INDEX = -3

/** A label's icon, laid out by the worker once per tile. */
export interface ScreenLabelIcon {
  /** The icon's place in the style's image atlas, in atlas pixels. */
  rectangle: { x: number; y: number; width: number; height: number }
  /** Its corners around the label's anchor (top-left, top-right, bottom-right, bottom-left), in the label's units. */
  corners: Point[]
  /** Bounds of the corners. */
  box: Box
  sdf: boolean
  color: Rgba
  haloColor: Rgba
  haloWidthPixels: number
}

/** One label facing the viewer, as the worker lays it out once per tile. */
export interface ScreenLabel {
  /** Anchor in tile units (0 to `TILE_EXTENT`, y down). */
  anchor: Point
  /** The text, or null for an icon alone. */
  shaped: ShapedText | null
  icon?: ScreenLabelIcon
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
  /** The feature it labels: its source layer and index there (feature queries resolve hits with it). */
  sourceLayer: string
  featureIndex: number
  /**
   * `text-variable-anchor`: the label box's shift for each anchor in order, (x, y) in pixels of a 24 px font from
   * the box centred on the anchor point (the glyphs are laid out centred). Placement tries them in turn.
   */
  anchorShifts?: number[]
  /** Line placement: the stretch of line the glyphs follow, and the sharpest turn between glyphs (`text-max-angle`). */
  line?: LineLabelPath & { maximumAngleRadians: number; keepUpright: boolean }
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
  protected readonly sourceLayers: string[] = []
  protected readonly featureIndices: number[] = []
  protected readonly lineStarts: number[] = []
  protected readonly lineLengths: number[] = []
  protected readonly lineAnchors: number[] = []
  protected readonly maximumAngles: number[] = []
  protected readonly linePoints: number[] = []
  protected readonly glyphStarts: number[] = []
  protected readonly glyphCounts: number[] = []
  protected readonly glyphOffsets: number[] = []
  protected readonly glyphHalfWidths: number[] = []
  protected readonly glyphIndices: number[] = []
  protected readonly anchorShiftStarts: number[] = []
  protected readonly anchorShiftCounts: number[] = []
  protected readonly anchorShifts: number[] = []
  protected readonly iconBoxes: number[] = []
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
    if (label.line !== undefined) {
      this.addLineLabel(label, label.line)
      return
    }
    const { quads, boxes } = label.shaped === null ? { quads: [], boxes: [] } : layoutPointLabel(label.shaped, { x: 0, y: 0 }, 1, label.offset, label.rotationRadians, 0)
    const icon = label.icon
    const textBox = quads.length === 0 ? undefined : boxes[0]
    if (textBox === undefined && icon === undefined) return
    const labelIndex = this.keys.length
    // The text's box; an icon alone puts its own here.
    const box = textBox ?? icon!.box
    const flags = (label.allowOverlap ? SYMBOL_ALLOW_OVERLAP : 0) | (label.ignorePlacement ? SYMBOL_IGNORE_PLACEMENT : 0) | (icon === undefined ? 0 : SYMBOL_ICON) | (textBox === undefined ? SYMBOL_ICON_ONLY : 0)
    this.addLabelData(label, box.minimumX, box.minimumY, box.maximumX, box.maximumY, flags, icon?.box)
    this.lineStarts.push(0)
    this.lineLengths.push(0)
    this.lineAnchors.push(0)
    this.maximumAngles.push(0)
    this.glyphStarts.push(0)
    this.glyphCounts.push(0)
    // The icon first: drawn under its text.
    if (icon !== undefined) {
      const { x, y, width, height } = icon.rectangle
      this.addQuad(labelIndex, icon.sdf ? SDF_ICON_GLYPH_INDEX : ICON_GLYPH_INDEX, icon.corners, [x, y, x + width, y, x + width, y + height, x, y + height], icon.color, icon.haloColor, icon.haloWidthPixels)
    }
    for (const { corners, glyph } of quads) this.addGlyphQuad(label, labelIndex, -1, glyph, corners)
  }

  /**
   * A label along a line: each glyph's corners around its own advance centre on the baseline, and its distance
   * from the label's middle along the line, in pixels of a 24 px font. The main thread walks the projected line.
   */
  protected addLineLabel(label: ScreenLabel, line: NonNullable<ScreenLabel['line']>): void {
    const shaped = label.shaped
    if (shaped === null || shaped.glyphs.length === 0) return
    const labelIndex = this.keys.length
    const middle = (shaped.left + shaped.right) / 2
    this.addLabelData(label, shaped.left - middle, shaped.top, shaped.right - middle, shaped.bottom, SYMBOL_LINE | (line.keepUpright ? SYMBOL_KEEP_UPRIGHT : 0) | (label.allowOverlap ? SYMBOL_ALLOW_OVERLAP : 0) | (label.ignorePlacement ? SYMBOL_IGNORE_PLACEMENT : 0))
    this.lineStarts.push(this.linePoints.length / 2)
    this.lineLengths.push(line.points.length)
    this.lineAnchors.push(line.anchorIndex)
    this.maximumAngles.push(line.maximumAngleRadians)
    for (const { x, y } of line.points) this.linePoints.push(x, y)
    this.glyphStarts.push(this.glyphOffsets.length)
    this.glyphCounts.push(shaped.glyphs.length)
    for (const { glyph, x, y, scale, centerX } of shaped.glyphs) {
      const glyphIndex = this.glyphOffsets.length
      const width = (glyph.width + GLYPH_BUFFER * 2) * scale
      const height = (glyph.height + GLYPH_BUFFER * 2) * scale
      this.glyphOffsets.push(centerX - middle)
      // The advance, not the bitmap with its SDF buffer, so neighbouring labels pack as tightly as the text.
      this.glyphHalfWidths.push(Math.max((glyph.advance * scale) / 2, 1))
      const left = x - centerX
      this.addGlyphQuad(label, labelIndex, glyphIndex, glyph, [
        { x: left, y },
        { x: left + width, y },
        { x: left + width, y: y + height },
        { x: left, y: y + height },
      ])
    }
  }

  protected addLabelData(label: ScreenLabel, left: number, top: number, right: number, bottom: number, flags: number, iconBox?: Box): void {
    this.iconBoxes.push(iconBox?.minimumX ?? 0, iconBox?.minimumY ?? 0, iconBox?.maximumX ?? 0, iconBox?.maximumY ?? 0)
    this.anchors.push(label.anchor.x, label.anchor.y)
    this.sizes.push(label.sizePixels, label.nextZoomSizePixels)
    this.boxes.push(left, top, right, bottom)
    this.paddings.push(label.paddingPixels)
    this.flags.push(flags)
    this.layerIndices.push(label.layerIndex)
    this.sortKeys.push(label.sortKey)
    this.keys.push(label.key)
    this.sourceLayers.push(label.sourceLayer)
    this.featureIndices.push(label.featureIndex)
    const shifts = label.anchorShifts ?? []
    this.anchorShiftStarts.push(this.anchorShifts.length / 2)
    this.anchorShiftCounts.push(shifts.length / 2)
    for (const shift of shifts) this.anchorShifts.push(shift)
  }

  protected addGlyphQuad(label: ScreenLabel, labelIndex: number, glyphIndex: number, glyph: AtlasGlyph, corners: readonly Point[]): void {
    const width = glyph.width + GLYPH_BUFFER * 2
    const height = glyph.height + GLYPH_BUFFER * 2
    const uv = [glyph.x, glyph.y, glyph.x + width, glyph.y, glyph.x + width, glyph.y + height, glyph.x, glyph.y + height]
    this.addQuad(labelIndex, glyphIndex, corners, uv, label.color, label.haloColor, label.haloWidthPixels)
  }

  /** One quad: corners in the label's units, `uv` in pixels of its atlas (four corners, x then y). */
  protected addQuad(labelIndex: number, glyphIndex: number, corners: readonly Point[], uv: readonly number[], color: Rgba, haloColor: Rgba, haloWidthPixels: number): void {
    const first = this.labelIndices.length
    for (let corner = 0; corner < 4; corner++) {
      this.corners.push(corners[corner]!.x, corners[corner]!.y)
      this.uvs.push(uv[corner * 2]!, uv[corner * 2 + 1]!)
      this.labelIndices.push(labelIndex)
      this.glyphIndices.push(glyphIndex)
      this.colors.push(...color)
      this.haloColors.push(...haloColor)
      this.haloWidths.push(haloWidthPixels)
    }
    this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
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
      sourceLayers: this.sourceLayers,
      featureIndices: new Uint32Array(this.featureIndices),
      lineStarts: new Uint32Array(this.lineStarts),
      lineLengths: new Uint16Array(this.lineLengths),
      lineAnchors: new Uint16Array(this.lineAnchors),
      maximumAngles: new Float32Array(this.maximumAngles),
      linePoints: new Float32Array(this.linePoints),
      glyphStarts: new Uint32Array(this.glyphStarts),
      glyphCounts: new Uint16Array(this.glyphCounts),
      glyphOffsets: new Float32Array(this.glyphOffsets),
      glyphHalfWidths: new Float32Array(this.glyphHalfWidths),
      anchorShiftStarts: new Uint32Array(this.anchorShiftStarts),
      anchorShiftCounts: new Uint8Array(this.anchorShiftCounts),
      anchorShifts: new Float32Array(this.anchorShifts),
      iconBoxes: new Float32Array(this.iconBoxes),
      glyphIndices: new Float32Array(this.glyphIndices),
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
  const arrays = [mesh.anchors, mesh.sizes, mesh.boxes, mesh.paddings, mesh.flags, mesh.layerIndices, mesh.sortKeys, mesh.featureIndices, mesh.lineStarts, mesh.lineLengths, mesh.lineAnchors, mesh.maximumAngles, mesh.linePoints, mesh.glyphStarts, mesh.glyphCounts, mesh.glyphOffsets, mesh.glyphHalfWidths, mesh.anchorShiftStarts, mesh.anchorShiftCounts, mesh.anchorShifts, mesh.iconBoxes, mesh.glyphIndices, mesh.corners, mesh.uvs, mesh.labelIndices, mesh.colors, mesh.haloColors, mesh.haloWidths, mesh.indices]
  return arrays.reduce((sum, array) => sum + array.byteLength, 0) + [...mesh.keys, ...mesh.sourceLayers].reduce((sum, key) => sum + key.length * 2, 0)
}

/** Typed arrays of a symbol mesh, to transfer. */
export function symbolMeshBuffers(mesh: SymbolMesh | null): ArrayBufferLike[] {
  if (mesh === null) return []
  return [mesh.anchors, mesh.sizes, mesh.boxes, mesh.paddings, mesh.flags, mesh.layerIndices, mesh.sortKeys, mesh.featureIndices, mesh.lineStarts, mesh.lineLengths, mesh.lineAnchors, mesh.maximumAngles, mesh.linePoints, mesh.glyphStarts, mesh.glyphCounts, mesh.glyphOffsets, mesh.glyphHalfWidths, mesh.anchorShiftStarts, mesh.anchorShiftCounts, mesh.anchorShifts, mesh.iconBoxes, mesh.glyphIndices, mesh.corners, mesh.uvs, mesh.labelIndices, mesh.colors, mesh.haloColors, mesh.haloWidths, mesh.indices].map(array => array.buffer)
}
