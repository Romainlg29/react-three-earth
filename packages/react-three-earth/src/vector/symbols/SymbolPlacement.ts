/**
 * Global label placement on the screen: one collision grid for every tile, duplicates across tiles and zooms
 * dropped, and opacity fades that follow a label from one tile to its replacement. Pure: no three.js, so it is
 * unit tested in Node.
 */

/** A label that could be drawn this frame, projected to the screen. Reused from frame to frame. */
export interface PlacementCandidate {
  /** Same text in the same style layer (`SymbolMesh.keys`). */
  key: string
  /** Anchor on the screen, in CSS pixels from the top-left corner. */
  xPixels: number
  yPixels: number
  /** Collision box on the screen, padding included. */
  minimumXPixels: number
  minimumYPixels: number
  maximumXPixels: number
  maximumYPixels: number
  /** The style layer's index: higher places first. */
  layerIndex: number
  sortKey: number
  allowOverlap: boolean
  ignorePlacement: boolean
  /** Breaks ties: lower places first. Keep it stable between frames (tile, then label in the tile). */
  order: number
  /** Written by `place`: the label's fade state, or null when it duplicates a label placed before it. */
  fade: SymbolFade | null
  /** Written by `place`: whether it won its place on the screen this time. */
  placed: boolean
  /** Scratch: the fade state matched before sorting. */
  match: SymbolFade | null
}

/** The opacity of one label on the screen, carried across tiles and zooms. */
export interface SymbolFade {
  readonly key: string
  /** Last screen position of the label it belongs to: a label in a new tile picks up the fade state at its place. */
  xPixels: number
  yPixels: number
  /** 0 to 1, drawn. */
  opacity: number
  /** Where `opacity` heads: 1 once placed, 0 once it collides or leaves. */
  target: 0 | 1
  /** Placement that last matched it to a label; another label matching it in the same placement is a duplicate. */
  claimedBy: number
}

export interface SymbolPlacementOptions {
  /** Seconds a label takes to fade in or out (MapLibre's `fadeDuration` is 0.3 s). 0 switches at once. Default: 0.3. */
  fadeDurationSeconds?: number
  /** A label in a new tile takes over the fade state of the same text within this distance. Default: 24. */
  matchTolerancePixels?: number
  /** Side of a collision grid cell, in pixels. Default: 64. */
  cellSizePixels?: number
}

/** Boxes placed on the screen, bucketed in a grid of cells (MapLibre's `GridIndex`). */
export class CollisionGrid {
  protected readonly cellSizePixels: number
  protected columns = 0
  protected rows = 0
  /** Per cell, the indices of its boxes in `boxes`. */
  protected cells: number[][] = []
  /** Four numbers per box. */
  protected readonly boxes: number[] = []

  constructor(cellSizePixels = 64) {
    this.cellSizePixels = cellSizePixels
  }

  /** Empties the grid for a screen of this size. */
  reset(widthPixels: number, heightPixels: number): void {
    const columns = Math.max(1, Math.ceil(widthPixels / this.cellSizePixels))
    const rows = Math.max(1, Math.ceil(heightPixels / this.cellSizePixels))
    if (columns !== this.columns || rows !== this.rows) {
      this.columns = columns
      this.rows = rows
      this.cells = Array.from({ length: columns * rows }, () => [])
    } else for (const cell of this.cells) cell.length = 0
    this.boxes.length = 0
  }

  /** True when the box overlaps a box already inserted. */
  hits(minimumX: number, minimumY: number, maximumX: number, maximumY: number): boolean {
    const [fromColumn, toColumn, fromRow, toRow] = this.cellRange(minimumX, minimumY, maximumX, maximumY)
    const boxes = this.boxes
    for (let row = fromRow; row <= toRow; row++) {
      for (let column = fromColumn; column <= toColumn; column++) {
        for (const index of this.cells[row * this.columns + column]!) {
          if (minimumX < boxes[index + 2]! && boxes[index]! < maximumX && minimumY < boxes[index + 3]! && boxes[index + 1]! < maximumY) return true
        }
      }
    }
    return false
  }

  insert(minimumX: number, minimumY: number, maximumX: number, maximumY: number): void {
    const index = this.boxes.length
    this.boxes.push(minimumX, minimumY, maximumX, maximumY)
    const [fromColumn, toColumn, fromRow, toRow] = this.cellRange(minimumX, minimumY, maximumX, maximumY)
    for (let row = fromRow; row <= toRow; row++) for (let column = fromColumn; column <= toColumn; column++) this.cells[row * this.columns + column]!.push(index)
  }

  protected cellRange(minimumX: number, minimumY: number, maximumX: number, maximumY: number): [number, number, number, number] {
    const clampColumn = (value: number) => Math.min(this.columns - 1, Math.max(0, Math.floor(value / this.cellSizePixels)))
    const clampRow = (value: number) => Math.min(this.rows - 1, Math.max(0, Math.floor(value / this.cellSizePixels)))
    return [clampColumn(minimumX), clampColumn(maximumX), clampRow(minimumY), clampRow(maximumY)]
  }
}

/**
 * Places labels on the whole screen and fades them. `place` decides which labels show (run it a few times a second
 * while the camera moves, and once after it stops); `fade` moves each label's opacity towards that decision every
 * frame.
 */
export class SymbolPlacement {
  readonly fadeDurationSeconds: number
  protected readonly matchTolerancePixels: number
  protected readonly grid: CollisionGrid
  /** Fade states by key. A key holds several when the same text shows at several places (road names). */
  protected readonly fades = new Map<string, SymbolFade[]>()
  protected placementCount = 0

  constructor({ fadeDurationSeconds = 0.3, matchTolerancePixels = 24, cellSizePixels = 64 }: SymbolPlacementOptions = {}) {
    this.fadeDurationSeconds = fadeDurationSeconds
    this.matchTolerancePixels = matchTolerancePixels
    this.grid = new CollisionGrid(cellSizePixels)
  }

  /** Fade states held, for inspection and tests. */
  get fadeCount(): number {
    let count = 0
    for (const list of this.fades.values()) count += list.length
    return count
  }

  /**
   * Decides which candidates show. Top style layers first, then by `symbol-sort-key`, then labels already showing
   * (so equal labels do not swap places as tiles change), then `order`. A candidate whose box hits a box placed
   * before it is hidden unless it allows overlap; one that ignores placement leaves no box. A candidate with the
   * same key as a label already matched within `matchTolerancePixels` is a duplicate (the same label from an
   * overlapping tile of another zoom) and gets no fade state. Labels outside the screen are not placed.
   */
  place(candidates: PlacementCandidate[], widthPixels: number, heightPixels: number): void {
    const placement = ++this.placementCount
    this.grid.reset(widthPixels, heightPixels)
    for (const candidate of candidates) candidate.match = this.findFade(candidate)
    candidates.sort(
      (a, b) =>
        b.layerIndex - a.layerIndex ||
        a.sortKey - b.sortKey ||
        visibleRank(b.match) - visibleRank(a.match) ||
        a.order - b.order,
    )
    for (const fade of this.allFades()) fade.target = 0
    for (const candidate of candidates) {
      let fade = candidate.match
      // A match taken by a label placed earlier in this pass: look for a free one, else this label repeats it.
      if (fade !== null && fade.claimedBy === placement) fade = this.findFade(candidate, placement)
      if (fade === null && this.hasClaimedMatch(candidate, placement)) {
        candidate.fade = null
        candidate.placed = false
        continue
      }
      fade ??= this.createFade(candidate)
      fade.claimedBy = placement
      fade.xPixels = candidate.xPixels
      fade.yPixels = candidate.yPixels
      candidate.fade = fade
      const onScreen = candidate.maximumXPixels > 0 && candidate.minimumXPixels < widthPixels && candidate.maximumYPixels > 0 && candidate.minimumYPixels < heightPixels
      const placed = onScreen && (candidate.allowOverlap || !this.grid.hits(candidate.minimumXPixels, candidate.minimumYPixels, candidate.maximumXPixels, candidate.maximumYPixels))
      if (placed && !candidate.ignorePlacement) this.grid.insert(candidate.minimumXPixels, candidate.minimumYPixels, candidate.maximumXPixels, candidate.maximumYPixels)
      candidate.placed = placed
      fade.target = placed ? 1 : 0
    }
  }

  /**
   * Moves every opacity towards its target. Fade states that are hidden and no longer matched by any label are
   * dropped. Returns true while any opacity is still changing.
   */
  fade(deltaSeconds: number): boolean {
    const step = this.fadeDurationSeconds > 0 ? Math.max(0, deltaSeconds) / this.fadeDurationSeconds : Infinity
    let changing = false
    for (const [key, list] of this.fades) {
      for (let index = list.length - 1; index >= 0; index--) {
        const fade = list[index]!
        if (fade.target === 1) fade.opacity = Math.min(1, fade.opacity + step)
        else fade.opacity = Math.max(0, fade.opacity - step)
        if (fade.opacity !== fade.target) changing = true
        else if (fade.opacity === 0 && fade.claimedBy !== this.placementCount) list.splice(index, 1)
      }
      if (list.length === 0) this.fades.delete(key)
    }
    return changing
  }

  /** Forgets every fade state: labels fade in from nothing. */
  clear(): void {
    this.fades.clear()
  }

  protected *allFades(): Iterable<SymbolFade> {
    for (const list of this.fades.values()) yield* list
  }

  /** The nearest fade state of the same key within the tolerance, skipping those claimed in `placement`. */
  protected findFade(candidate: PlacementCandidate, placement = -1): SymbolFade | null {
    const list = this.fades.get(candidate.key)
    if (list === undefined) return null
    let best: SymbolFade | null = null
    let bestDistance = this.matchTolerancePixels
    for (const fade of list) {
      if (fade.claimedBy === placement) continue
      const distance = Math.hypot(fade.xPixels - candidate.xPixels, fade.yPixels - candidate.yPixels)
      if (distance <= bestDistance) {
        best = fade
        bestDistance = distance
      }
    }
    return best
  }

  protected hasClaimedMatch(candidate: PlacementCandidate, placement: number): boolean {
    const list = this.fades.get(candidate.key)
    if (list === undefined) return false
    return list.some(fade => fade.claimedBy === placement && Math.hypot(fade.xPixels - candidate.xPixels, fade.yPixels - candidate.yPixels) <= this.matchTolerancePixels)
  }

  protected createFade(candidate: PlacementCandidate): SymbolFade {
    const fade: SymbolFade = { key: candidate.key, xPixels: candidate.xPixels, yPixels: candidate.yPixels, opacity: 0, target: 0, claimedBy: -1 }
    let list = this.fades.get(candidate.key)
    if (list === undefined) this.fades.set(candidate.key, (list = []))
    list.push(fade)
    return fade
  }
}

function visibleRank(fade: SymbolFade | null): number {
  return fade !== null && fade.opacity > 0 ? 1 : 0
}
