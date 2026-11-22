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

/** Lets the overlay mark a region as waited for, so its composition jumps ahead of preloads. */
export interface GpuRegionComposition {
  /** Call when 3DTilesRenderer starts waiting for the region (`getTexture`), with the cache tokens. */
  prioritize(tokens: readonly number[]): void
}

/**
 * Makes a `TiledRegionImageSource` compose on the GPU.
 *
 * Replaces its `fetchItem` and `disposeItem` on the instance: the class is private to 3DTilesRenderer, so it
 * cannot be subclassed. Everything else (ref counting, source-tile locking, `hasContent`) stays upstream.
 * When `getCompositor` returns null (the overlay is used by a plugin without one) it falls back to the
 * upstream canvas composition.
 *
 * Lifetime: the region cache (upstream `DataCache`) aborts an entry's signal whenever it drops the entry,
 * before calling `disposeItem`, whether the entry is queued, has just resolved, or is stored. So the abort
 * listener is the one place that frees what an entry holds. Removing it on success would leak the target
 * when the entry is dropped between our promise resolving and the cache storing the result (the cache then
 * calls `disposeItem(null)`). `disposeItem` only unlocks the source tiles.
 */
export function composeRegionsOnGpu(
  regionSource: TiledRegionImageSourceLike,
  getCompositor: () => ImageryCompositor | null,
): GpuRegionComposition {
  const upstreamFetchItem = regionSource.fetchItem.bind(regionSource)
  const upstreamDisposeItem = regionSource.disposeItem.bind(regionSource)
  // Items this patch produced: the cache must not dispose them (targets are freed on abort, source tiles
  // belong to the tiled image source).
  const ownItems = new WeakSet<Texture>()
  // By cache key: regions being fetched, those of them waited for, and their queued compositions' targets.
  // Counts, not a set: a dropped entry's fetch can still be settling when the key is fetched again.
  const fetchingKeys = new Map<string, number>()
  const waitedKeys = new Set<string>()
  const queuedTargets = new Map<string, RenderTarget>()

  const fetchItem = async (tokens: number[], signal?: AbortSignal): Promise<Texture | null> => {
    const compositor = getCompositor()
    if (compositor === null) return upstreamFetchItem(tokens, signal)
    const key = tokens.join('_')
    fetchingKeys.set(key, (fetchingKeys.get(key) ?? 0) + 1)
    try {
      return await composeRegion(compositor, key, tokens, signal)
    } finally {
      const count = (fetchingKeys.get(key) ?? 1) - 1
      if (count > 0) fetchingKeys.set(key, count)
      else {
        fetchingKeys.delete(key)
        waitedKeys.delete(key)
      }
    }
  }

  const composeRegion = async (compositor: ImageryCompositor, key: string, tokens: number[], signal?: AbortSignal): Promise<Texture | null> => {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0, level = 0] = tokens
    const range: NormalizedRange = [minimumX, minimumY, maximumX, maximumY]
    const { tiledImageSource } = regionSource

    await regionSource._markImages(range, level, false)
    signal?.throwIfAborted()

    // Fast path: one tile covers the range exactly, so the terrain shows the source tile itself. Not a clone:
    // on WebGPU three keys GPU textures by Texture object, so a clone would upload a second copy.
    const exact = findExactTile(range, level, tiledImageSource.tiling)
    if (exact !== null) {
      const texture = tiledImageSource.get(...exact)
      if (texture === null) return null
      compositor.configureSampling(texture)
      ownItems.add(texture)
      compositor.retainTexture(texture)
      signal?.addEventListener('abort', () => compositor.releaseTexture(texture), { once: true })
      return texture
    }

    const target = compositor.createTarget(regionSource.resolution)
    ownItems.add(target.texture)
    signal?.addEventListener('abort', () => target.dispose(), { once: true })
    queuedTargets.set(key, target)
    try {
      return await compositor.enqueue(target, getCompositeDraws(range, level, tiledImageSource), signal, waitedKeys.has(key))
    } catch (error) {
      target.dispose() // the cache gets no item; safe to call twice
      throw error
    } finally {
      if (queuedTargets.get(key) === target) queuedTargets.delete(key)
    }
  }

  regionSource.fetchItem = fetchItem
  regionSource.disposeItem = (item, tokens) => {
    upstreamDisposeItem(item !== null && ownItems.has(item) ? null : item, tokens)
  }

  return {
    prioritize(tokens) {
      const key = tokens.join('_')
      const target = queuedTargets.get(key)
      const compositor = getCompositor()
      if (target !== undefined && compositor !== null) compositor.prioritize(target)
      // Still downloading its source tiles: queue it as waited for when it gets there.
      else if (fetchingKeys.has(key)) waitedKeys.add(key)
    },
  }
}
