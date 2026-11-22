import { RenderTarget } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import type { GeographicBounds } from '../src/core/camera.js'
import { MapStyleSource } from '../src/core/sources.js'
import { ImageryCompositor } from '../src/tiles/imagery/ImageryCompositor.js'
import type { MapStyleBackend } from '../src/vector/MapStyleBackend.js'
import { bucketKey, MapStyleOverlay } from '../src/vector/MapStyleOverlay.js'
import { RefCountedCache } from '../src/vector/RefCountedCache.js'
import { MapStyleProcessor } from '../src/vector/worker/MapStyleProcessor.js'
import { boundsToMercatorRectangles, tileOverlaps } from '../src/vector/worker/rectangles.js'
import type { ImageChange, TileBucket, TileRequest } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

/** Just enough of `WebGPURenderer` for the compositor. */
function fakeRenderer(): WebGPURenderer {
  let target: RenderTarget | null = null
  let mrt: object | null = null
  return {
    autoClear: false,
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => void (target = next),
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getMRT: () => mrt,
    setMRT: (next: object | null) => void (mrt = next),
    getClearAlpha: () => 1,
    getClearColor: <T>(color: T) => color,
    setClearColor: () => {},
    render: () => {},
  } as unknown as WebGPURenderer
}

/** Normalised Web Mercator x, y (y up) to degrees. */
function toDegrees(x: number, y: number): { longitudeDegrees: number; latitudeDegrees: number } {
  return { longitudeDegrees: x * 360 - 180, latitudeDegrees: (Math.atan(Math.sinh(Math.PI * (2 * y - 1))) * 180) / Math.PI }
}

function boundsAround(minimumX: number, minimumY: number, maximumX: number, maximumY: number): GeographicBounds {
  const southWest = toDegrees(minimumX, minimumY)
  const northEast = toDegrees(maximumX, maximumY)
  return { westDegrees: southWest.longitudeDegrees, southDegrees: southWest.latitudeDegrees, eastDegrees: northEast.longitudeDegrees, northDegrees: northEast.latitudeDegrees }
}

interface Draw {
  region: string
  output: RenderTarget
  /** Data version of each tile drawn, by tile key. */
  versions: Map<string, number>
}

/**
 * A `MapStyleOverlay` on a fake backend whose tiles carry a data version (in `byteLength`), drawn through a
 * real `ImageryCompositor` with a fake renderer. `drawRegion` records what each region drew.
 */
class TestOverlay extends MapStyleOverlay {
  readonly draws: Draw[] = []
  /** Data version per tile key; bump it to change a tile "on the server". */
  readonly serverVersions = new Map<string, number>()
  readonly processed: string[] = []
  readonly invalidations: unknown[] = []
  /** Image ids each tile's patterns use, by tile key. */
  readonly tileImages = new Map<string, string[]>()
  /** What the fake worker answers to the next image change. */
  nextImageChange: ImageChange = { rebuild: true, backgroundPatternByZoom: [], missingBackgroundImages: [] }
  /** When set, tile loads wait for `releaseHeldTiles`. */
  holdTiles = false
  protected heldTiles: Array<() => void> = []
  readonly renderer = fakeRenderer()

  constructor() {
    super({ style: { version: 8, sources: {}, layers: [] }, baseUrl: 'https://maps.test/', createWorker: null })
    this.summary = { sources: [{ id: 'base', minimumZoom: 0, maximumZoom: 14 }], backgroundByZoom: [], skippedLayers: [], attributions: [], backgroundPatternByZoom: [], missingBackgroundImages: [], spriteImageIds: [] }
    this.compositor = new ImageryCompositor({ budgetMilliseconds: Infinity })
    const backend: MapStyleBackend = {
      init: async () => this.summary!,
      processTile: async (request: TileRequest) => {
        const key = bucketKey(request)
        this.processed.push(key)
        const version = this.serverVersions.get(key) ?? 1 // read when the request is made, as a fetch would
        if (this.holdTiles) await new Promise<void>(resolve => this.heldTiles.push(resolve))
        return { shapes: null, text: null, atlas: null, images: this.tileImages.get(key) ?? [], missingImages: [], byteLength: version } satisfies TileBucket
      },
      invalidate: rectangles => void this.invalidations.push(rectangles),
      setImage: async () => this.nextImageChange,
      dispose: () => {},
    }
    this.backend = backend
    this.imagesSent = true
    this.resolveBackendReady()
  }

  releaseHeldTiles(): void {
    for (const resolve of this.heldTiles.splice(0)) resolve()
  }

  /** Lets promises settle, then draws one compositor frame; repeated until nothing is left to do. */
  async settle(): Promise<void> {
    for (let frame = 0; frame < 20; frame++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      this.compositor!.render(this.renderer)
    }
  }

  drawsOf(range: number[]): Draw[] {
    const region = range.join('_')
    return this.draws.filter(draw => draw.region.startsWith(`${region}_`))
  }

  protected override drawRegion(
    _renderer: WebGPURenderer,
    _compositor: ImageryCompositor,
    output: RenderTarget,
    range: readonly number[],
    level: number,
    tiles: ReadonlyArray<{ key: string }>,
    buckets: ReadonlyArray<{ bucket: TileBucket }>,
  ): void {
    const versions = new Map(tiles.map((tile, index) => [tile.key, buckets[index]!.bucket.byteLength]))
    this.draws.push({ region: `${range.join('_')}_${level}`, output, versions })
  }
}

// Regions of 1/8 × 1/8 are textured at zoom 2 (tiles of 1/4); labels reach half a tile into neighbours.
const A = [0.5, 0.5, 0.625, 0.625] // tile (2, 1)
const B = [0.625, 0.5, 0.75, 0.625] // tile (2, 1), next to tile (3, 1)
const D = [0.25, 0.5, 0.375, 0.625] // tile (1, 1): tile (3, 1) is out of label reach
const C = [0, 0, 0.125, 0.125] // tile (0, 3), far away
const tile31 = bucketKey({ sourceId: 'base', x: 3, y: 1, z: 2, zoom: 2 })
const tile21 = bucketKey({ sourceId: 'base', x: 2, y: 1, z: 2, zoom: 2 })

describe('boundsToMercatorRectangles', () => {
  it('splits bounds crossing the antimeridian and spans every longitude past 360°', () => {
    const [east, west] = boundsToMercatorRectangles({ westDegrees: 170, southDegrees: -10, eastDegrees: -170, northDegrees: 10 })
    expect(east!.minimumX).toBeCloseTo(350 / 360)
    expect(east!.maximumX).toBe(1)
    expect(west!.minimumX).toBe(0)
    expect(west!.maximumX).toBeCloseTo(10 / 360)
    expect(east!.minimumY).toBeCloseTo(west!.minimumY)
    expect(boundsToMercatorRectangles({ westDegrees: 190, southDegrees: 0, eastDegrees: 200, northDegrees: 1 })[0]!.minimumX).toBeCloseTo(10 / 360) // 190° E is 170° W
    const whole = boundsToMercatorRectangles({ westDegrees: -180, southDegrees: -90, eastDegrees: 180, northDegrees: 90 })
    expect(whole).toHaveLength(1)
    expect(whole[0]!.minimumX).toBe(0)
    expect(whole[0]!.maximumX).toBe(1)
    expect(whole[0]!.minimumY).toBeLessThanOrEqual(0)
    expect(whole[0]!.maximumY).toBeGreaterThanOrEqual(1)
  })

  it('keeps a point on the tiles it lies on, and leaves out tiles that only share an edge with the bounds', () => {
    const point = boundsToMercatorRectangles({ westDegrees: 0, southDegrees: 0, eastDegrees: 0, northDegrees: 0 })
    // The point (0, 0) is the corner of the four zoom 1 tiles.
    expect([tileOverlaps(0, 0, 1, point), tileOverlaps(1, 0, 1, point), tileOverlaps(0, 1, 1, point), tileOverlaps(1, 1, 1, point)]).toEqual([true, true, true, true])
    const eastHalf = boundsToMercatorRectangles({ westDegrees: 0, southDegrees: -80, eastDegrees: 180, northDegrees: 80 })
    expect(tileOverlaps(0, 0, 1, eastHalf)).toBe(false)
    expect(tileOverlaps(1, 0, 1, eastHalf)).toBe(true)
  })

  it('states the fix for bad bounds', () => {
    expect(() => boundsToMercatorRectangles({ westDegrees: 0, southDegrees: 10, eastDegrees: 1, northDegrees: 0 })).toThrow(/swap them/)
    expect(() => boundsToMercatorRectangles({ westDegrees: Number.NaN, southDegrees: 0, eastDegrees: 1, northDegrees: 1 })).toThrow(/finite degrees/)
  })
})

describe('RefCountedCache.discard', () => {
  it('frees an unused value now, and a leased one when its lease ends, while the key loads again', async () => {
    let version = 0
    const dispose = vi.fn()
    const cache = new RefCountedCache({ load: async () => ({ version: ++version }), dispose, getByteLength: () => 1, retainedBytes: 100 })
    const old = cache.acquire('a')
    expect(await old.promise).toEqual({ version: 1 })
    cache.discard('a')
    const fresh = cache.acquire('a')
    expect(await fresh.promise).toEqual({ version: 2 })
    expect(dispose).not.toHaveBeenCalled()
    old.release()
    old.release() // a second release does nothing
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledWith({ version: 1 }, 'a')
    fresh.release()
    expect(dispose).toHaveBeenCalledTimes(1) // kept for reuse
    cache.discard('a')
    expect(dispose).toHaveBeenCalledWith({ version: 2 }, 'a')
    expect(cache.size).toBe(0)
  })
})

describe('RefCountedCache.dispose', () => {
  it('ignores leases released after it, so a disposed cache keeps nothing', async () => {
    const dispose = vi.fn()
    const cache = new RefCountedCache({ load: async () => ({}), dispose, getByteLength: () => 1, retainedBytes: 100 })
    const lease = cache.acquire('a')
    await lease.promise
    cache.dispose()
    lease.release()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })
})

describe('ImageryCompositor queues', () => {
  it('draws first textures of visible tiles, then recompositions, then preloads, and runs frame tasks once first', async () => {
    const compositor = new ImageryCompositor({ budgetMilliseconds: Infinity })
    const order: string[] = []
    const queue = (name: string, priority: 'waited' | 'recomposition' | 'preload') =>
      compositor.enqueueRender(new RenderTarget(1, 1), () => void order.push(name), undefined, priority)
    const done = Promise.all([queue('preload', 'preload'), queue('recomposition', 'recomposition'), queue('waited', 'waited')])
    const task = vi.fn(() => void order.push('task'))
    compositor.runBeforeNextRender(task)
    compositor.runBeforeNextRender(task)
    expect(compositor.pendingCount).toBe(3)
    compositor.render(fakeRenderer())
    await done
    expect(order).toEqual(['task', 'waited', 'recomposition', 'preload'])
    expect(task).toHaveBeenCalledTimes(1)
  })
})

describe('MapStyleOverlay.invalidate', () => {
  it('redraws in place only the regions whose tiles (labels of neighbours included) overlap the bounds', async () => {
    const overlay = new TestOverlay()
    const textures = await Promise.all([A, B, C, D].map(range => {
      const locked = overlay.lockTexture(range)
      return overlay.settle().then(() => locked)
    }))
    expect(overlay.draws).toHaveLength(4)
    overlay.draws.length = 0
    overlay.processed.length = 0

    overlay.serverVersions.set(tile31, 2)
    const bounds = boundsAround(0.8, 0.55, 0.85, 0.6) // inside tile (3, 1)
    overlay.invalidate(bounds)
    overlay.invalidate(bounds) // coalesced with the first
    expect(overlay.recompositionsPending).toBe(2)
    await overlay.settle()

    expect(overlay.drawsOf(A)).toHaveLength(1)
    expect(overlay.drawsOf(B)).toHaveLength(1)
    expect(overlay.drawsOf(C)).toHaveLength(0)
    expect(overlay.drawsOf(D)).toHaveLength(0)
    expect(overlay.drawsOf(A)[0]!.versions.get(tile31)).toBe(2)
    // Into the same texture the terrain already samples.
    expect(overlay.drawsOf(A)[0]!.output.texture).toBe(textures[0])
    // Only the changed tile was processed again; its unchanged neighbours came from the cache.
    expect(overlay.processed).toEqual([tile31])
    expect(overlay.invalidations).toHaveLength(2)
    expect(overlay.recompositionsPending).toBe(0)
  })

  it('handles bounds crossing the antimeridian', async () => {
    const overlay = new TestOverlay()
    // Zoom 5 regions (tiles of 1/32): on either side of the antimeridian, and one at the prime meridian.
    const size = 1 / 64
    const west = [0, 0.5, size, 0.5 + size]
    const east = [1 - size, 0.5, 1, 0.5 + size]
    const middle = [0.5, 0.5, 0.5 + size, 0.5 + size]
    for (const range of [west, east, middle]) {
      overlay.lockTexture(range)
      await overlay.settle()
    }
    overlay.draws.length = 0
    overlay.invalidate({ westDegrees: 175, southDegrees: 1, eastDegrees: -175, northDegrees: 2 })
    await overlay.settle()
    expect(overlay.drawsOf(west)).toHaveLength(1)
    expect(overlay.drawsOf(east)).toHaveLength(1)
    expect(overlay.drawsOf(middle)).toHaveLength(0)
  })

  it('ends with fresh content when invalidated while a region is still loading', async () => {
    const overlay = new TestOverlay()
    overlay.holdTiles = true
    const texture = overlay.lockTexture(A)
    await overlay.settle()
    expect(overlay.draws).toHaveLength(0)
    // The tiles were requested at version 1; the data changes, then they arrive (stale).
    overlay.serverVersions.set(tile21, 2)
    overlay.invalidate()
    expect(overlay.recompositionsPending).toBe(1)
    overlay.holdTiles = false
    overlay.releaseHeldTiles()
    await overlay.settle()
    await texture
    const draws = overlay.drawsOf(A)
    expect(draws.map(draw => draw.versions.get(tile21))).toEqual([1, 2]) // shown at once, then redrawn
    expect(draws[1]!.output).toBe(draws[0]!.output)
    expect(overlay.recompositionsPending).toBe(0)
  })

  it('redraws once more when invalidated during a redraw, and stops redrawing a released region', async () => {
    const overlay = new TestOverlay()
    overlay.lockTexture(A)
    await overlay.settle()
    overlay.holdTiles = true
    overlay.serverVersions.set(tile21, 2)
    overlay.invalidate()
    await overlay.settle() // the redraw waits for its tiles
    overlay.serverVersions.set(tile21, 3)
    overlay.invalidate()
    overlay.holdTiles = false
    overlay.releaseHeldTiles()
    await overlay.settle()
    expect(overlay.drawsOf(A).map(draw => draw.versions.get(tile21))).toEqual([1, 2, 3])

    overlay.holdTiles = true
    overlay.invalidate()
    await overlay.settle()
    overlay.releaseTexture(A)
    overlay.releaseHeldTiles()
    await overlay.settle()
    expect(overlay.drawsOf(A)).toHaveLength(3)
    expect(overlay.recompositionsPending).toBe(0)
  })
})

describe('MapStyleSource.invalidate', () => {
  it('reaches every live overlay of the source', () => {
    const source = new MapStyleSource({ url: 'https://maps.test/style.json' })
    const first = source.createOverlay({ opacity: 1 })
    const second = source.createOverlay({ opacity: 1 })
    const firstInvalidate = vi.spyOn(first, 'invalidate')
    const secondInvalidate = vi.spyOn(second, 'invalidate')
    second.dispose()
    source.invalidate({ westDegrees: 0, southDegrees: 0, eastDegrees: 1, northDegrees: 1 })
    expect(firstInvalidate).toHaveBeenCalledTimes(1)
    expect(secondInvalidate).not.toHaveBeenCalled()
    first.dispose()
  })
})

describe('MapStyleProcessor.invalidate', () => {
  it('fetches tiles in the bounds again and keeps the others', async () => {
    const tile = encodeVectorTile([{ name: 'water', features: [{ type: 'Polygon', geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 0]]], properties: {} }] }])
    const { fetch } = createFakeFetch({ 'https://maps.test/0/0/0.pbf': tile, 'https://maps.test/1/1/0.pbf': tile, 'https://maps.test/1/0/0.pbf': tile })
    const fetchSpy = vi.fn(fetch)
    const processor = await MapStyleProcessor.create(
      {
        style: { version: 8, sources: { base: { type: 'vector', tiles: ['https://maps.test/{z}/{x}/{y}.pbf'] } }, layers: [{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water' }] },
        baseUrl: 'https://maps.test/',
        requestHeaders: {},
        localFontFamily: 'sans-serif',
      },
      { fetch: fetchSpy as typeof globalThis.fetch },
    )
    const process = (x: number, z: number) => processor.processTile({ sourceId: 'base', x, y: 0, z, zoom: z })
    await Promise.all([process(0, 1), process(1, 1)])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    processor.invalidate(boundsToMercatorRectangles({ westDegrees: 10, southDegrees: 10, eastDegrees: 20, northDegrees: 20 }))
    await Promise.all([process(0, 1), process(1, 1)])
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://maps.test/1/0/0.pbf', 'https://maps.test/1/1/0.pbf', 'https://maps.test/1/1/0.pbf'])
    // Refetched tiles skip the browser cache's freshness, so a cached copy from before the change is not reused.
    expect(fetchSpy.mock.calls.map(([, init]) => (init as RequestInit).cache)).toEqual([undefined, undefined, 'no-cache'])
    processor.invalidate(null)
    await process(0, 1)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect((fetchSpy.mock.calls[3]![1] as RequestInit).cache).toBe('no-cache')
    // Once: a later refetch of the same tile (after the raw cache forgets it) uses the HTTP cache again.
    processor.invalidate(boundsToMercatorRectangles({ westDegrees: 170, southDegrees: -80, eastDegrees: 179, northDegrees: -70 }))
    ;(processor as unknown as { rawTiles: Map<string, unknown> }).rawTiles.clear()
    await process(0, 1)
    expect((fetchSpy.mock.calls[4]![1] as RequestInit).cache).toBeUndefined()
  })
})

describe('MapStyleOverlay.setImage', () => {
  async function loadedOverlay() {
    const overlay = new TestOverlay()
    overlay.tileImages.set(tile21, ['stripes'])
    for (const range of [A, B, C, D]) {
      overlay.lockTexture(range)
      await overlay.settle()
    }
    overlay.draws.length = 0
    overlay.processed.length = 0
    return overlay
  }

  it('rebuilds the tiles that use an image which appeared or changed size, and redraws only their regions', async () => {
    const overlay = await loadedOverlay()
    await overlay.setImage('stripes', { width: 2, height: 2, data: new Uint8Array(16), pixelRatio: 1, sdf: false })
    await overlay.settle()
    // A and B draw tile (2, 1)'s shapes. D draws it only for labels, which patterns do not change; C not at all.
    expect(overlay.drawsOf(A)).toHaveLength(1)
    expect(overlay.drawsOf(B)).toHaveLength(1)
    expect(overlay.drawsOf(C)).toHaveLength(0)
    expect(overlay.drawsOf(D)).toHaveLength(0)
    expect(overlay.processed).toEqual([tile21])
  })

  it('only redraws, without rebuilding, when the image was rewritten in place', async () => {
    const overlay = await loadedOverlay()
    overlay.nextImageChange = { rebuild: false, backgroundPatternByZoom: [], missingBackgroundImages: [] }
    await overlay.setImage('stripes', { width: 2, height: 2, data: new Uint8Array(16), pixelRatio: 1, sdf: false })
    await overlay.settle()
    expect(overlay.drawsOf(A)).toHaveLength(1)
    expect(overlay.drawsOf(B)).toHaveLength(1)
    expect(overlay.draws).toHaveLength(2)
    expect(overlay.processed).toEqual([])
    // An image no tile uses redraws nothing.
    overlay.draws.length = 0
    await overlay.setImage('unused', null)
    await overlay.settle()
    expect(overlay.draws).toHaveLength(0)
  })

  it('still finds regions whose buckets left the cache', async () => {
    const overlay = await loadedOverlay()
    const buckets = (overlay as unknown as { buckets: RefCountedCache<unknown> }).buckets
    for (const key of [...buckets.keys()]) buckets.discard(key) // evicted: unlocked, so freed now
    expect(buckets.size).toBe(0)
    await overlay.setImage('stripes', { width: 2, height: 2, data: new Uint8Array(16), pixelRatio: 1, sdf: false })
    await overlay.settle()
    expect(overlay.drawsOf(A)).toHaveLength(1)
    expect(overlay.drawsOf(B)).toHaveLength(1)
    expect(overlay.drawsOf(D)).toHaveLength(0)
  })

  it('keeps the record of a cached bucket whose regions were released, for when a region takes it back', async () => {
    const overlay = new TestOverlay()
    overlay.tileImages.set(tile21, ['stripes'])
    overlay.lockTexture(A)
    await overlay.settle()
    overlay.releaseTexture(A) // the bucket stays in the reuse cache
    await overlay.setImage('unrelated', null) // prunes the record
    overlay.lockTexture(A) // from the cached bucket: no new load
    await overlay.settle()
    overlay.draws.length = 0
    await overlay.setImage('stripes', { width: 2, height: 2, data: new Uint8Array(16), pixelRatio: 1, sdf: false })
    await overlay.settle()
    expect(overlay.drawsOf(A)).toHaveLength(1)
  })

  it('redraws every region when the background pattern uses the image', async () => {
    const overlay = await loadedOverlay()
    const rectangle = { x: 1, y: 1, width: 2, height: 2, pixelRatio: 1 }
    overlay.nextImageChange = { rebuild: false, backgroundPatternByZoom: [{ imageId: 'paper', rectangle, opacity: 1 }], missingBackgroundImages: [] }
    await overlay.setImage('paper', { width: 2, height: 2, data: new Uint8Array(16), pixelRatio: 1, sdf: false })
    await overlay.settle()
    expect(overlay.draws).toHaveLength(4)
    expect(overlay.processed).toEqual([])
    expect(overlay.summary!.backgroundPatternByZoom[0]!.imageId).toBe('paper')
  })

  it('reports each missing image once until it is added', async () => {
    const missing: string[] = []
    const overlay = new MapStyleOverlay({ style: { version: 8, sources: {}, layers: [] }, baseUrl: 'https://maps.test/', createWorker: null, onStyleImageMissing: id => missing.push(id) })
    const report = (ids: string[]) => (overlay as unknown as { reportMissingImages(ids: string[]): void }).reportMissingImages(ids)
    report(['a', 'b'])
    report(['a'])
    expect(missing).toEqual(['a', 'b'])
    await overlay.setImage('a', { width: 1, height: 1, data: new Uint8Array(4), pixelRatio: 1, sdf: false })
    await overlay.setImage('a', null)
    report(['a'])
    expect(missing).toEqual(['a', 'b', 'a'])
  })
})

describe('MapStyleSource images', () => {
  it('hands images to overlays created later, and states the fix for duplicate or unknown ids', () => {
    const source = new MapStyleSource({ style: { version: 8, sources: {}, layers: [] }, baseUrl: 'https://maps.test/', createWorker: null })
    source.addImage('dot', { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }, { pixelRatio: 2 })
    expect(source.hasImage('dot')).toBe(true)
    expect(() => source.addImage('dot', { width: 1, height: 1, data: new Uint8Array(4) })).toThrow(/updateImage\("dot"/)
    expect(() => source.updateImage('nothing', { width: 1, height: 1, data: new Uint8Array(4) })).toThrow(/addImage\("nothing"/)
    expect(() => source.addImage('bad', { width: 2, height: 2, data: new Uint8Array(4) })).toThrow(/width × height × 4 = 16/)
    source.updateImage('dot', { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) })
    const overlay = source.createOverlay({ opacity: 1 }) as unknown as { images: Map<string, { pixelRatio: number; data: Uint8Array }> }
    expect(overlay.images.get('dot')!.pixelRatio).toBe(2) // options kept by updateImage
    expect([...overlay.images.get('dot')!.data]).toEqual([0, 255, 0, 255])
    source.removeImage('dot')
    expect(source.hasImage('dot')).toBe(false)
    expect(overlay.images.has('dot')).toBe(false)
  })
})
