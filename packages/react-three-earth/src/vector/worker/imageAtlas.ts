import type { ImageAtlasEntryUpdate, ImageAtlasUpdate, StyleImage } from './types.js'

/** Wrapped copy of each image's edges around it, so linear filtering of a repeated pattern never reads a neighbour. */
export const IMAGE_ATLAS_PADDING = 1

const ATLAS_WIDTH = 1024
const ATLAS_MAXIMUM_HEIGHT = 4096

/** Where an image sits in the atlas: the top-left of its pixels (inside the padding), in atlas pixels. */
export interface AtlasImageRectangle {
  x: number
  y: number
  width: number
  height: number
}

interface Slot {
  /** Top-left of the padded slot. */
  x: number
  y: number
  /** Padded size. */
  width: number
  height: number
}

/**
 * Packs style images (sprites and `addImage` images) into one RGBA atlas, premultiplied, with a shelf packer.
 * Like the glyph atlas it only grows, so meshes made earlier keep their coordinates; it records what changed
 * so the main thread can mirror it. A removed image's slot is reused by the next image that fits in it, and an
 * image replaced at the same size is rewritten in place.
 *
 * Images are padded with a wrapped copy of their opposite edges: right for patterns, which repeat. Icons
 * (screen-space symbols) will need a transparent padding instead.
 */
export class ImageAtlas {
  width = ATLAS_WIDTH
  height = 64
  protected readonly shelves: Array<{ y: number; height: number; x: number }> = []
  protected readonly slots = new Map<string, Slot>()
  protected readonly freeSlots: Slot[] = []
  protected readonly updates: ImageAtlasEntryUpdate[] = []
  protected sizeChanged = true
  protected warnedFull = false

  /** The image's place, or null if it is not packed. */
  get(id: string): AtlasImageRectangle | null {
    const slot = this.slots.get(id)
    if (slot === undefined) return null
    return { x: slot.x + IMAGE_ATLAS_PADDING, y: slot.y + IMAGE_ATLAS_PADDING, width: slot.width - IMAGE_ATLAS_PADDING * 2, height: slot.height - IMAGE_ATLAS_PADDING * 2 }
  }

  /**
   * Packs an image under `id`, replacing what was there: in place when the size is the same. Returns its
   * place, or null if the atlas is full.
   */
  add(id: string, image: StyleImage): AtlasImageRectangle | null {
    const width = image.width + IMAGE_ATLAS_PADDING * 2
    const height = image.height + IMAGE_ATLAS_PADDING * 2
    let slot = this.slots.get(id)
    if (slot !== undefined && (slot.width !== width || slot.height !== height)) {
      this.remove(id)
      slot = undefined
    }
    if (slot === undefined) {
      const allocated = this.takeFreeSlot(width, height) ?? this.allocate(width, height)
      if (allocated === null) {
        if (!this.warnedFull) console.warn(`MapStyleSource: the image atlas is full (${ATLAS_WIDTH} × ${ATLAS_MAXIMUM_HEIGHT}); image "${id}" is skipped. Use smaller pattern images.`)
        this.warnedFull = true
        return null
      }
      slot = allocated
      this.slots.set(id, slot)
    }
    this.updates.push({ x: slot.x, y: slot.y, width, height, data: padAndPremultiply(image) })
    return this.get(id)
  }

  /** Frees an image's slot for reuse. Meshes that still point at it must be rebuilt. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (slot === undefined) return
    this.slots.delete(id)
    this.freeSlots.push(slot)
  }

  /** Changes since the last call, or null if none. */
  takeUpdate(): ImageAtlasUpdate | null {
    if (this.updates.length === 0 && !this.sizeChanged) return null
    const update = { width: this.width, height: this.height, images: this.updates.splice(0) }
    this.sizeChanged = false
    return update
  }

  /** The smallest freed slot the image fits in; the slot keeps its size (the rest stays unused). */
  protected takeFreeSlot(width: number, height: number): Slot | null {
    let best = -1
    for (let index = 0; index < this.freeSlots.length; index++) {
      const slot = this.freeSlots[index]!
      if (slot.width < width || slot.height < height) continue
      if (best === -1 || slot.width * slot.height < this.freeSlots[best]!.width * this.freeSlots[best]!.height) best = index
    }
    if (best === -1) return null
    const [slot] = this.freeSlots.splice(best, 1)
    return { x: slot!.x, y: slot!.y, width, height }
  }

  protected allocate(width: number, height: number): Slot | null {
    if (width > this.width) return null
    let best: (typeof this.shelves)[number] | undefined
    for (const shelf of this.shelves) {
      if (shelf.height >= height && shelf.height <= height * 1.5 && this.width - shelf.x >= width) {
        if (best === undefined || shelf.height < best.height) best = shelf
      }
    }
    if (best === undefined) {
      const top = this.shelves.reduce((bottom, shelf) => Math.max(bottom, shelf.y + shelf.height), 0)
      while (top + height > this.height) {
        if (this.height * 2 > ATLAS_MAXIMUM_HEIGHT) return null
        this.height *= 2
        this.sizeChanged = true
      }
      best = { y: top, height, x: 0 }
      this.shelves.push(best)
    }
    const slot = { x: best.x, y: best.y, width, height }
    best.x += width
    return slot
  }
}

/**
 * The image with its edges wrapped around it (`IMAGE_ATLAS_PADDING` pixels), premultiplied by alpha so linear
 * filtering does not darken transparent edges.
 */
export function padAndPremultiply(image: StyleImage): Uint8Array {
  const padding = IMAGE_ATLAS_PADDING
  const width = image.width + padding * 2
  const height = image.height + padding * 2
  const output = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    const sourceRow = (((row - padding) % image.height) + image.height) % image.height
    for (let column = 0; column < width; column++) {
      const sourceColumn = (((column - padding) % image.width) + image.width) % image.width
      const source = (sourceRow * image.width + sourceColumn) * 4
      const target = (row * width + column) * 4
      const alpha = image.data[source + 3]!
      output[target] = Math.round((image.data[source]! * alpha) / 255)
      output[target + 1] = Math.round((image.data[source + 1]! * alpha) / 255)
      output[target + 2] = Math.round((image.data[source + 2]! * alpha) / 255)
      output[target + 3] = alpha
    }
  }
  return output
}
