/** Main-thread imagery work over one frame interval. */
export interface ImageryFrameStatistics {
  /** Terrain-tile overlay textures composed on the GPU. */
  tilesComposited: number
  /** `renderer.render` calls into composite targets, including the source tiles' texture uploads they trigger. */
  compositionMilliseconds: number
  /** Per-vertex layer UV generation and layer (uniform, attribute) updates on terrain tiles. */
  layerSetupMilliseconds: number
  /** Splitting terrain tiles along imagery tile boundaries (geometry clipping on the CPU). */
  tileSplittingMilliseconds: number
  /** The sum of the three timings above. */
  mainThreadMilliseconds: number
}

function emptyFrame(): ImageryFrameStatistics {
  return { tilesComposited: 0, compositionMilliseconds: 0, layerSetupMilliseconds: 0, tileSplittingMilliseconds: 0, mainThreadMilliseconds: 0 }
}

export type ImageryTiming = 'compositionMilliseconds' | 'layerSetupMilliseconds' | 'tileSplittingMilliseconds'

/**
 * Counters for the imagery work done on the main thread, for on-device profiling.
 *
 * Timings come from `performance.now()` around the synchronous code paths, so they are cheap (a few calls per
 * tile) and include nothing that runs off the main thread: image fetch and decode, and GPU execution, are not
 * counted. Work done between two frames counts towards the frame interval it falls in.
 */
export class ImageryStatistics {
  /** The last complete frame interval: from one `endFrame` to the next. */
  lastFrame: ImageryFrameStatistics = emptyFrame()
  /** Since the plugin was created. */
  readonly total: ImageryFrameStatistics = emptyFrame()
  protected current: ImageryFrameStatistics = emptyFrame()

  /** Adds main-thread time to a category. */
  addTime(timing: ImageryTiming, milliseconds: number): void {
    this.current[timing] += milliseconds
    this.current.mainThreadMilliseconds += milliseconds
    this.total[timing] += milliseconds
    this.total.mainThreadMilliseconds += milliseconds
  }

  /** Counts composed terrain-tile textures. */
  addTilesComposited(count: number): void {
    this.current.tilesComposited += count
    this.total.tilesComposited += count
  }

  /** Runs a synchronous function and adds its duration to a category. */
  measure<Result>(timing: ImageryTiming, run: () => Result): Result {
    const startMilliseconds = performance.now()
    try {
      return run()
    } finally {
      this.addTime(timing, performance.now() - startMilliseconds)
    }
  }

  /** Closes the current frame interval: it becomes `lastFrame`. */
  endFrame(): void {
    this.lastFrame = this.current
    this.current = emptyFrame()
  }
}
