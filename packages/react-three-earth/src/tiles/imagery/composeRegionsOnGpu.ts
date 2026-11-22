// Adapted from 3DTilesRendererJS (Apache-2.0, (c) NASA-AMMOS and contributors), v0.5.4:
// src/three/plugins/images/sources/RegionImageSource.js and overlays/utils.js (forEachTileInBounds).
// https://github.com/NASA-AMMOS/3DTilesRendererJS, https://www.apache.org/licenses/LICENSE-2.0
// Changed: tiles are composed on the GPU by an `ImageryCompositor` instead of a main-thread 2D canvas.

import type { RenderTarget, Texture } from 'three'

import type { CompositeDraw, ImageryCompositor } from './ImageryCompositor.js'

/** Range in the overlay's normalised projected space: [minimum x, minimum y, maximum x, maximum y]. */
export type NormalizedRange = [number, number, number, number]

/** The parts of 3DTilesRenderer's `TilingScheme` used here. */
export interface TilingSchemeLike {
  minLevel: number
  maxLevel: number
  getTilesInRange(minX: number, minY: number, maxX: number, maxY: number, level: number, normalized: boolean): NormalizedRange
  getTileBounds(x: number, y: number, level: number, normalized: boolean, clamp: boolean): NormalizedRange
}

/** The parts of 3DTilesRenderer's `TiledImageSource` (a ref-counted tile cache) used here. */
export interface TiledImageSourceLike {
  tiling: TilingSchemeLike
  get(x: number, y: number, level: number): Texture | null
}

/**
 * The parts of 3DTilesRenderer's private `TiledRegionImageSource` used here. It is a ref-counted cache
 * (`DataCache`) of one texture per terrain-tile range, built by `fetchItem` and freed by `disposeItem`.
 */
export interface TiledRegionImageSourceLike {
  tiledImageSource: TiledImageSourceLike
  resolution: number
  fetchItem(tokens: number[], signal?: AbortSignal): Promise<Texture | null> | Texture | null
  disposeItem(item: Texture | null, tokens: number[]): void
  _markImages(range: NormalizedRange, level: number, release: boolean): Promise<unknown> | null
}

// Normalised bounds closer than this are the same tile (upstream's BOUNDS_EPSILON).
const BOUNDS_EPSILON = 1e-10

/** Calls back with every source tile covering the range at the level (clamped to the tiling's levels). */
export function forEachTileInBounds(
  range: NormalizedRange,
  level: number,
  tiling: TilingSchemeLike,
  callback: (x: number, y: number, level: number) => void,
): void {
  // Pull the bounds in a little so a range that matches a tile exactly does not touch its neighbours.
  const [minimumX, minimumY, maximumX, maximumY] = range
  const epsilonX = (maximumX - minimumX) * 1e-4
  const epsilonY = (maximumY - minimumY) * 1e-4
  const clampedLevel = Math.max(Math.min(level, tiling.maxLevel), tiling.minLevel)
  const [fromX, fromY, toX, toY] = tiling.getTilesInRange(
    minimumX + epsilonX,
    minimumY + epsilonY,
    maximumX - epsilonX,
    maximumY - epsilonY,
    clampedLevel,
    true,
  )
  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) callback(x, y, clampedLevel)
  }
}

/** Maps each covering tile's bounds into the range's own 0 to 1 space, in 64-bit on the CPU. */
export function getCompositeDraws(range: NormalizedRange, level: number, source: TiledImageSourceLike): CompositeDraw[] {
  const [minimumX, minimumY, maximumX, maximumY] = range
  const width = maximumX - minimumX
  const height = maximumY - minimumY
  const draws: CompositeDraw[] = []
  forEachTileInBounds(range, level, source.tiling, (x, y, tileLevel) => {
    const texture = source.get(x, y, tileLevel)
    if (texture === null) return
    const bounds = source.tiling.getTileBounds(x, y, tileLevel, true, false)
    draws.push({
      texture,
      minimumX: (bounds[0] - minimumX) / width,
      minimumY: (bounds[1] - minimumY) / height,
      maximumX: (bounds[2] - minimumX) / width,
      maximumY: (bounds[3] - minimumY) / height,
    })
  })
  return draws
}

/** The single tile whose bounds are exactly the range, if there is one. */
function findExactTile(range: NormalizedRange, level: number, tiling: TilingSchemeLike): [number, number, number] | null {
  let exact: [number, number, number] | null = null
  forEachTileInBounds(range, level, tiling, (x, y, tileLevel) => {
    const bounds = tiling.getTileBounds(x, y, tileLevel, true, false)
    if (bounds.every((value, index) => Math.abs(value - range[index]!) <= BOUNDS_EPSILON)) exact = [x, y, tileLevel]
  })
  return exact
}

/**
 * Makes a `TiledRegionImageSource` compose on the GPU.
 *
 * Replaces its `fetchItem` and `disposeItem` on the instance: the class is private to 3DTilesRenderer, so it
 * cannot be subclassed. Everything else (ref counting, source-tile locking, `hasContent`) stays upstream.
 * When `getCompositor` returns null (the overlay is used by a plugin without one) it falls back to the
 * upstream canvas composition.
 */
export function composeRegionsOnGpu(regionSource: TiledRegionImageSourceLike, getCompositor: () => ImageryCompositor | null): void {
  const upstreamFetchItem = regionSource.fetchItem.bind(regionSource)
  const upstreamDisposeItem = regionSource.disposeItem.bind(regionSource)
  const targets = new Map<Texture, RenderTarget>()

  const releaseTarget = (target: RenderTarget): void => {
    targets.delete(target.texture)
    target.dispose() // safe to call twice
  }

  regionSource.fetchItem = async (tokens, signal) => {
    const compositor = getCompositor()
    if (compositor === null) return upstreamFetchItem(tokens, signal)

    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0, level = 0] = tokens
    const range: NormalizedRange = [minimumX, minimumY, maximumX, maximumY]
    const { tiledImageSource } = regionSource

    await regionSource._markImages(range, level, false)
    signal?.throwIfAborted()

    // Fast path: one tile covers the range exactly, so use it as is. Cloning shares its GPU source while
    // giving the cache entry its own object to dispose.
    const exact = findExactTile(range, level, tiledImageSource.tiling)
    if (exact !== null) return tiledImageSource.get(...exact)?.clone() ?? null

    const target = compositor.createTarget(regionSource.resolution)
    targets.set(target.texture, target)
    // The cache aborts an entry only when disposing it, so an abort at any point (queued, or between
    // resolving and the cache storing the result) means the target is no longer wanted.
    signal?.addEventListener('abort', () => releaseTarget(target), { once: true })
    try {
      return await compositor.enqueue(target, getCompositeDraws(range, level, tiledImageSource), signal)
    } catch (error) {
      releaseTarget(target) // the cache gets no item to dispose
      throw error
    }
  }

  regionSource.disposeItem = (item, tokens) => {
    const target = item === null ? undefined : targets.get(item)
    if (target !== undefined) releaseTarget(target)
    // Upstream unlocks the source tiles. Given null, it skips disposing the item.
    upstreamDisposeItem(target !== undefined ? null : item, tokens)
  }
}
