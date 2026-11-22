import { RenderTarget, Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { QuantizedMeshSource } from '../src/core/sources.js'
import { Terrain } from '../src/core/Terrain.js'
import { ImageOverlayPlugin } from '../src/tiles/ImageOverlayPlugin.js'
import {
  composeRegionsOnGpu,
  getCompositeDraws,
  type NormalizedRange,
  type TiledImageSourceLike,
  type TiledRegionImageSourceLike,
  type TilingSchemeLike,
} from '../src/tiles/imagery/composeRegionsOnGpu.js'
import { ImageryCompositor } from '../src/tiles/imagery/ImageryCompositor.js'
import { ImageryStatistics } from '../src/tiles/imagery/ImageryStatistics.js'
import { XYZImageryOverlay } from '../src/tiles/imagery/XYZImageryOverlay.js'

/** A tiling of 2^level × 2^level square tiles over the unit square, y up. */
const quadTiling: TilingSchemeLike = {
  minLevel: 0,
  maxLevel: 10,
  getTilesInRange(minX, minY, maxX, maxY, level) {
    const count = 2 ** level
    return [Math.floor(minX * count), Math.floor(minY * count), Math.floor(maxX * count), Math.floor(maxY * count)]
  },
  getTileBounds(x, y, level) {
    const size = 1 / 2 ** level
    return [x * size, y * size, (x + 1) * size, (y + 1) * size]
  },
}

function tileSource(tiling = quadTiling): TiledImageSourceLike & { textures: Map<string, Texture> } {
  const textures = new Map<string, Texture>()
  return {
    tiling,
    textures,
    get(x, y, level) {
      const key = `${x}_${y}_${level}`
      if (!textures.has(key)) textures.set(key, new Texture())
      return textures.get(key)!
    },
  }
}

/** Just enough of `WebGPURenderer` for the compositor. */
function fakeRenderer(renderMilliseconds = 0) {
  let target: RenderTarget | null = null
  const rendered: Array<RenderTarget | null> = []
  const renderer = {
    autoClear: false,
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => void (target = next),
    getClearAlpha: () => 1,
    getClearColor: <T>(color: T) => color,
    setClearColor: vi.fn(),
    render: () => {
      rendered.push(target)
      const end = performance.now() + renderMilliseconds
      while (performance.now() < end);
    },
  }
  return { renderer: renderer as unknown as WebGPURenderer, rendered, fake: renderer }
}

describe('getCompositeDraws', () => {
  it('places each covering tile in the range’s own 0 to 1 space', () => {
    // A range straddling four level-2 tiles, centred on (0.5, 0.5)
    const range: NormalizedRange = [0.375, 0.375, 0.625, 0.625]
    const draws = getCompositeDraws(range, 2, tileSource())
    expect(draws).toHaveLength(4)
    expect(draws.map(({ minimumX, minimumY, maximumX, maximumY }) => [minimumX, minimumY, maximumX, maximumY])).toEqual([
      [-0.5, -0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5, 1.5],
      [0.5, -0.5, 1.5, 0.5],
      [0.5, 0.5, 1.5, 1.5],
    ])
  })

  it('stays exact for deep levels, where 32-bit floats would be off by pixels', () => {
    const level = 20
    const size = 1 / 2 ** level
    const x = 0.9
    const range: NormalizedRange = [x, x, x + size, x + size]
    const draws = getCompositeDraws(range, level, tileSource({ ...quadTiling, maxLevel: 24 }))
    for (const draw of draws) {
      expect(draw.maximumX - draw.minimumX).toBeCloseTo(1, 9)
      expect(draw.maximumY - draw.minimumY).toBeCloseTo(1, 9)
    }
  })

  it('covers a terrain-tile range with Web Mercator tiles from 3DTilesRenderer’s own tiling', async () => {
    const overlay = new XYZImageryOverlay({ url: 'https://example.com/{z}/{x}/{y}.png', levels: 18 })
    const imageSource = (overlay as unknown as { imageSource: { init(): Promise<void>; tiling: TilingSchemeLike & { projection: { fromCartographicToNormalizedRange(range: number[]): NormalizedRange } } } }).imageSource
    await imageSource.init()
    // A geographic terrain tile around Fuji, as 3DTilesRenderer turns it into a normalised Mercator range
    const degrees = Math.PI / 180
    const range = imageSource.tiling.projection.fromCartographicToNormalizedRange([138.5 * degrees, 35.2 * degrees, 138.9 * degrees, 35.5 * degrees])
    const draws = getCompositeDraws(range, 9, { tiling: imageSource.tiling, get: () => new Texture() })
    expect(draws.length).toBeGreaterThan(0)
    // The tiles' union covers the whole range
    expect(Math.min(...draws.map(draw => draw.minimumX))).toBeLessThanOrEqual(0)
    expect(Math.min(...draws.map(draw => draw.minimumY))).toBeLessThanOrEqual(0)
    expect(Math.max(...draws.map(draw => draw.maximumX))).toBeGreaterThanOrEqual(1)
    expect(Math.max(...draws.map(draw => draw.maximumY))).toBeGreaterThanOrEqual(1)
  })
})

describe('ImageryCompositor', () => {
  it('draws queued compositions into their targets and restores the renderer', async () => {
    const compositor = new ImageryCompositor()
    const { renderer, rendered, fake } = fakeRenderer()
    const target = compositor.createTarget(256)
    const result = compositor.enqueue(target, [{ texture: new Texture(), minimumX: 0, minimumY: 0, maximumX: 1, maximumY: 1 }])
    expect(compositor.pendingCount).toBe(1)

    expect(compositor.render(renderer)).toBe(1)
    await expect(result).resolves.toBe(target.texture)
    expect(rendered).toEqual([target])
    expect(fake.getRenderTarget()).toBeNull()
    expect(fake.autoClear).toBe(false)
    expect(compositor.pendingCount).toBe(0)
  })

  it('spreads a burst over frames by time budget, drawing at least one per frame', async () => {
    const compositor = new ImageryCompositor({ budgetMilliseconds: 0 })
    const { renderer } = fakeRenderer(1)
    for (let index = 0; index < 3; index++) void compositor.enqueue(compositor.createTarget(4), [])
    expect(compositor.render(renderer)).toBe(1)
    expect(compositor.pendingCount).toBe(2)
  })

  it('drops a composition whose tile was released before it ran', async () => {
    const compositor = new ImageryCompositor()
    const controller = new AbortController()
    const result = compositor.enqueue(compositor.createTarget(4), [], controller.signal)
    controller.abort(new DOMException('released', 'AbortError'))
    await expect(result).rejects.toThrow('released')
    expect(compositor.pendingCount).toBe(0)
  })
})

describe('composeRegionsOnGpu', () => {
  function regionSource(source = tileSource()) {
    const upstreamDispose = vi.fn()
    const region: TiledRegionImageSourceLike = {
      tiledImageSource: source,
      resolution: 256,
      fetchItem: vi.fn(async () => null),
      disposeItem: upstreamDispose,
      _markImages: () => null,
    }
    return { region, upstreamDispose, source }
  }

  it('composes a range covered by several tiles on the GPU and frees the target on dispose', async () => {
    const compositor = new ImageryCompositor()
    const { region, upstreamDispose } = regionSource()
    composeRegionsOnGpu(region, () => compositor)
    const createTarget = vi.spyOn(compositor, 'createTarget')

    const tokens = [0.375, 0.375, 0.625, 0.625, 2]
    const pending = region.fetchItem(tokens)
    await Promise.resolve()
    await Promise.resolve()
    expect(compositor.pendingCount).toBe(1)
    const { renderer } = fakeRenderer()
    compositor.render(renderer)
    const texture = (await pending)!
    expect(texture.isRenderTargetTexture).toBe(true)

    const disposed = vi.fn()
    ;(createTarget.mock.results[0]?.value as RenderTarget).addEventListener('dispose', disposed)
    region.disposeItem(texture, tokens)
    expect(disposed).toHaveBeenCalled()
    // Upstream still unlocks the source tiles, without disposing anything itself
    expect(upstreamDispose).toHaveBeenCalledWith(null, tokens)
  })

  it('frees the target when the tile is released while its composition is queued', async () => {
    const compositor = new ImageryCompositor()
    const { region } = regionSource()
    composeRegionsOnGpu(region, () => compositor)
    const createTarget = vi.spyOn(compositor, 'createTarget')
    const controller = new AbortController()
    const pending = region.fetchItem([0.375, 0.375, 0.625, 0.625, 2], controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    const target = createTarget.mock.results[0]?.value as RenderTarget
    const disposed = vi.fn()
    target.addEventListener('dispose', disposed)

    controller.abort(new DOMException('released', 'AbortError'))
    await expect(pending).rejects.toThrow('released')
    expect(compositor.pendingCount).toBe(0)
    expect(disposed).toHaveBeenCalled()
  })

  it('reuses the source tile when it covers the range exactly', async () => {
    const compositor = new ImageryCompositor()
    const { region, source } = regionSource()
    composeRegionsOnGpu(region, () => compositor)
    const texture = await region.fetchItem([0.25, 0.5, 0.5, 0.75, 2])
    expect(compositor.pendingCount).toBe(0)
    expect(texture?.source).toBe(source.textures.get('1_2_2')?.source)
  })

  it('falls back to the upstream canvas composition without a compositor', async () => {
    const { region } = regionSource()
    const upstreamFetch = region.fetchItem
    composeRegionsOnGpu(region, () => null)
    await region.fetchItem([0, 0, 1, 1, 0])
    expect(upstreamFetch).toHaveBeenCalled()
  })
})

describe('ImageryStatistics', () => {
  it('reports the last complete frame and keeps totals', () => {
    const statistics = new ImageryStatistics()
    statistics.addTime('compositionMilliseconds', 1.5)
    statistics.addTime('layerSetupMilliseconds', 0.5)
    statistics.addTilesComposited(2)
    expect(statistics.lastFrame.mainThreadMilliseconds).toBe(0)

    statistics.endFrame()
    expect(statistics.lastFrame).toEqual({
      tilesComposited: 2,
      compositionMilliseconds: 1.5,
      layerSetupMilliseconds: 0.5,
      tileSplittingMilliseconds: 0,
      mainThreadMilliseconds: 2,
    })

    statistics.addTilesComposited(1)
    statistics.endFrame()
    expect(statistics.lastFrame.tilesComposited).toBe(1)
    expect(statistics.total.tilesComposited).toBe(3)
    expect(statistics.total.mainThreadMilliseconds).toBe(2)
  })
})

describe('ImageOverlayPlugin', () => {
  it('hands its compositor to GPU-composed overlays, including the initial ones', () => {
    const initial = new XYZImageryOverlay({ url: 'https://example.com/{z}/{x}/{y}.png' })
    const plugin = new ImageOverlayPlugin({ overlays: [initial] })
    const added = new XYZImageryOverlay({ url: 'https://example.com/{z}/{x}/{y}.png' })
    plugin.addOverlay(added as never)
    expect(initial.compositor).toBe(plugin.compositor)
    expect(added.compositor).toBe(plugin.compositor)
  })

  it('counts compositions per frame', async () => {
    const plugin = new ImageOverlayPlugin()
    const { renderer } = fakeRenderer()
    void plugin.compositor.enqueue(plugin.compositor.createTarget(4), [])
    plugin.composeImagery(renderer)
    expect(plugin.statistics.lastFrame.tilesComposited).toBe(0) // counted in the frame it ran in
    plugin.composeImagery(renderer)
    expect(plugin.statistics.lastFrame.tilesComposited).toBe(1)
    expect(plugin.statistics.total.tilesComposited).toBe(1)
  })
})

describe('Earth.inspect imagery counters', () => {
  it('reports zero imagery work before the first frame', () => {
    const earth = new Earth()
    earth.setTerrain(new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://example.com/terrain' })] }))
    expect(earth.inspect().terrain).toMatchObject({
      imageryTilesComposited: 0,
      imageryMainThreadMilliseconds: 0,
      imageryCompositionsPending: 0,
      imageryTilesCompositedTotal: 0,
      imageryMainThreadMillisecondsTotal: 0,
    })
  })
})
