import { Texture, type RenderTarget } from 'three'

/** Image size of a region texture. */
const widthOf = (texture: Texture) => (texture.image as { width: number }).width
import type { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { PLUGIN_API_VERSION, type PluginContext } from '../src/plugins/plugin.js'
import { DrapedLayerRegistry, type DrapedLayerDefinition, type DrapedLayerDrawInputs } from '../src/plugins/drapedLayers.js'
import { DrapedLayerOverlay } from '../src/tiles/imagery/DrapedLayerOverlay.js'
import { ImageryCompositor, type CompositionPriority, type CompositionRenderer } from '../src/tiles/imagery/ImageryCompositor.js'
import { ImageOverlayPlugin } from '../src/tiles/ImageOverlayPlugin.js'

afterEach(() => vi.restoreAllMocks())

/** A compositor that records queued renders and runs them on demand, with a fake renderer. */
function recordingCompositor() {
  const compositor = new ImageryCompositor()
  const jobs: Array<{ target: RenderTarget; render: CompositionRenderer; priority: CompositionPriority; resolve: () => void; reject: (reason: unknown) => void }> = []
  const tasks: Array<() => void> = []
  vi.spyOn(compositor, 'enqueueRender').mockImplementation((target, render, signal, priority = 'preload') => new Promise((resolve, reject) => {
    const job = { target, render, priority, resolve: () => resolve(target.texture), reject }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    jobs.push(job)
  }))
  vi.spyOn(compositor, 'runBeforeNextRender').mockImplementation(task => void tasks.push(task))
  vi.spyOn(compositor, 'prioritize')
  const renderer = { setRenderTarget: vi.fn(), clear: vi.fn() } as unknown as WebGPURenderer
  /** Draws every queued job (as the compositor would within its budget). */
  const drawAll = async () => {
    for (const job of jobs.splice(0)) {
      try {
        job.render(renderer, job.target)
        job.resolve()
      } catch (error) {
        job.reject(error)
      }
    }
    await new Promise(resolve => setTimeout(resolve))
  }
  const runFrameTasks = () => {
    for (const task of tasks.splice(0)) task()
  }
  return { compositor, jobs, drawAll, runFrameTasks, renderer }
}

const WEST_HALF = [0, 0, 0.5, 1]
const EAST_QUARTER = [0.75, 0.25, 1, 0.5]

async function overlayFor(definition: Omit<DrapedLayerDefinition, 'draw'> & { draw?: DrapedLayerDefinition['draw'] }) {
  const registry = new DrapedLayerRegistry()
  const draws: DrapedLayerDrawInputs[] = []
  const handle = registry.register({ draw: inputs => void draws.push(inputs), ...definition })
  const layer = registry.get(definition.id)!
  const overlay = new DrapedLayerOverlay(layer)
  const recording = recordingCompositor()
  overlay.compositor = recording.compositor
  await (overlay as unknown as { init(): Promise<void> }).init()
  return { overlay, handle, draws, ...recording }
}

describe('DrapedLayerRegistry', () => {
  it('rejects invalid definitions and taken ids, stating the fix', () => {
    const registry = new DrapedLayerRegistry()
    expect(() => registry.register({ id: '', draw: () => {} })).toThrow(/non-empty `id`/)
    expect(() => registry.register({ id: 'glow' } as never)).toThrow(/`draw` must be a function/)
    expect(() => registry.register({ id: 'glow', bounds: 'everywhere' as never, draw: () => {} })).toThrow(/`bounds` must be/)
    registry.register({ id: 'glow', draw: () => {} })
    expect(() => registry.register({ id: 'glow', draw: () => {} })).toThrow(/already registered/)
  })

  it('stacks layers in registration order and removes them through their handle', () => {
    const registry = new DrapedLayerRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const first = registry.register({ id: 'a', draw: () => {} })
    registry.register({ id: 'b', draw: () => {} })
    expect([...registry.values()].map(layer => [layer.id, layer.sequence])).toEqual([['a', 1], ['b', 2]])
    first.remove()
    first.remove()
    expect([...registry.values()].map(layer => layer.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('reads bounds: everywhere by default, a function each time, nowhere when it throws', () => {
    const registry = new DrapedLayerRegistry()
    registry.register({ id: 'everywhere', draw: () => {} })
    expect(registry.get('everywhere')!.readBounds()).toEqual({ westDegrees: -180, southDegrees: -90, eastDegrees: 180, northDegrees: 90 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.register({ id: 'broken', bounds: () => { throw new Error('no selection') }, draw: () => {} })
    expect(registry.get('broken')!.readBounds()).toBeNull()
    expect(error.mock.calls[0]![0]).toMatch(/Draped layer "broken": its bounds function threw.*Fix the function/)
  })

  it('is registered through the plugin context and removed with the plugin', () => {
    const earth = new Earth()
    let handleId = ''
    const plugin = { name: 'glow', apiVersion: PLUGIN_API_VERSION, install: (context: PluginContext) => void (handleId = context.registerDrapedLayer({ id: 'selection', draw: () => {} }).id) }
    earth.addPlugin(plugin)
    expect(handleId).toBe('selection')
    expect(earth.inspect().drapedLayers).toEqual([{ id: 'selection', regions: 0, regionsDrawn: 0 }])
    earth.removePlugin(plugin)
    expect(earth.drapedLayers.size).toBe(0)
  })
})

describe('DrapedLayerOverlay', () => {
  it('draws regions inside its bounds through the compositor, and gives the others a 1 × 1 target with no draw', async () => {
    const { overlay, jobs, drawAll, draws } = await overlayFor({ id: 'glow', bounds: { westDegrees: -170, southDegrees: 10, eastDegrees: -160, northDegrees: 20 } })
    const inside = overlay.lockTexture(WEST_HALF)
    const outside = overlay.lockTexture(EAST_QUARTER)
    expect(jobs.map(job => job.priority)).toEqual(['preload'])
    expect(jobs[0]!.target.width).toBe(256)
    expect(widthOf(await outside)).toBe(1)
    await drawAll()
    expect(await inside).toBeInstanceOf(Texture)
    expect(draws).toHaveLength(1)
    expect(overlay.regionCount).toBe(2)
    expect(overlay.drawnRegionCount).toBe(1)
  })

  it('hands draw the region: its range, bounds, zoom and a 64-bit projection into its own 0 to 1 space', async () => {
    const { overlay, drawAll, draws } = await overlayFor({ id: 'glow' })
    void overlay.lockTexture(WEST_HALF)
    await drawAll()
    const { region } = draws[0]!
    expect(region.mercatorRange).toEqual(WEST_HALF)
    expect(region.bounds.westDegrees).toBe(-180)
    expect(region.bounds.eastDegrees).toBe(0)
    expect(region.bounds.northDegrees).toBeCloseTo(85.0511, 3)
    expect(region.resolutionPixels).toBe(256)
    expect(region.zoom).toBe(0) // 256 pixels across half of a world 512 pixels wide at zoom 0
    expect(region.project({ longitudeDegrees: -180, latitudeDegrees: 0 })).toEqual({ x: 0, y: 0.5 })
    expect(region.project({ longitudeDegrees: -90, latitudeDegrees: 0 }).x).toBeCloseTo(0.5, 12)
    // The copy of the longitude closest to the region: 179° E sits just west of it.
    expect(region.project({ longitudeDegrees: 179, latitudeDegrees: 0 }).x).toBeCloseTo(-1 / 180, 12)
  })

  it('prioritises a region being waited for', async () => {
    const { overlay, compositor } = await overlayFor({ id: 'glow' })
    void overlay.lockTexture(WEST_HALF)
    void overlay.getTexture(WEST_HALF)
    expect(compositor.prioritize).toHaveBeenCalledTimes(1)
  })

  it('redraws only regions within the invalidated bounds, in place, resizing those that enter or leave its bounds', async () => {
    let bounds = { westDegrees: -170, southDegrees: 10, eastDegrees: -160, northDegrees: 20 }
    const { overlay, handle, jobs, drawAll, runFrameTasks } = await overlayFor({ id: 'glow', bounds: () => bounds })
    const west = await Promise.all([overlay.lockTexture(WEST_HALF), drawAll()]).then(([texture]) => texture)
    const east = await overlay.lockTexture(EAST_QUARTER)
    expect(widthOf(east)).toBe(1)

    // Move the content east: the old place and the new one are invalidated.
    bounds = { westDegrees: 100, southDegrees: -60, eastDegrees: 110, northDegrees: -10 }
    handle.invalidate({ westDegrees: 100, southDegrees: -60, eastDegrees: 110, northDegrees: -10 })
    expect(overlay.recompositionsPending).toBe(1)
    runFrameTasks()
    expect(jobs.map(job => job.priority)).toEqual(['recomposition'])
    expect(widthOf(east)).toBe(256) // the same texture, resized: the terrain keeps its binding
    handle.invalidate({ westDegrees: -170, southDegrees: 10, eastDegrees: -160, northDegrees: 20 })
    runFrameTasks()
    expect(widthOf(west)).toBe(1)
    await drawAll()
    expect(overlay.recompositionsPending).toBe(0)
    expect(overlay.drawnRegionCount).toBe(1)
  })

  it('reports a throwing draw once, with the fix, and keeps the region transparent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { overlay, drawAll } = await overlayFor({ id: 'glow', draw: () => { throw new Error('no scene') } })
    const texture = overlay.lockTexture(WEST_HALF)
    void overlay.lockTexture(EAST_QUARTER)
    await drawAll()
    await texture
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]![0]).toMatch(/Draped layer "glow": draw threw.*Fix the layer's draw function/)
  })

  it('frees a region when its last terrain tile releases it', async () => {
    const { overlay } = await overlayFor({ id: 'glow', bounds: null })
    const texture = await overlay.lockTexture(EAST_QUARTER)
    await overlay.lockTexture(EAST_QUARTER)
    const dispose = vi.fn()
    ;(texture as Texture & { renderTarget?: RenderTarget }).renderTarget?.addEventListener('dispose', dispose)
    overlay.releaseTexture(EAST_QUARTER)
    expect(overlay.regionCount).toBe(1)
    overlay.releaseTexture(EAST_QUARTER)
    expect(overlay.regionCount).toBe(0)
    expect(dispose).toHaveBeenCalled()
  })
})

describe('ImageOverlayPlugin with draped layers', () => {
  it('stacks draped layers above every imagery overlay, even imagery added later', () => {
    const plugin = new ImageOverlayPlugin()
    const registry = new DrapedLayerRegistry()
    const imagery = { opacity: 1 }
    plugin.addOverlay(imagery as never)
    plugin.setDrapedLayers(registry)
    registry.register({ id: 'first', draw: () => {} })
    const second = registry.register({ id: 'second', draw: () => {} })
    const laterImagery = { opacity: 1 }
    plugin.addOverlay(laterImagery as never)
    const order = (overlay: object) => plugin.overlayInfo.get(overlay)!.order
    const [first, secondOverlay] = plugin.drapedOverlays
    expect(order(imagery)).toBe(0)
    expect(order(laterImagery)).toBe(1)
    expect(order(first!)).toBeLessThan(order(secondOverlay!))
    expect(order(first!)).toBeGreaterThan(order(laterImagery))
    second.remove()
    expect(plugin.drapedOverlays).toEqual([first])
    expect(plugin.overlays).not.toContain(secondOverlay)
    plugin.setDrapedLayers(null)
    expect(plugin.drapedOverlays).toEqual([])
  })
})

describe('terrain materials wrapped for overlays and fades', () => {
  it('keep both wrappers working whichever wraps first, so a layer added later reaches the shader', async () => {
    const { MeshStandardNodeMaterial } = await import('three/webgpu')
    const { wrapOverlaysNodeMaterial } = await import('../src/tiles/wrapOverlaysNodeMaterial.js')
    const { wrapFadeNodeMaterial } = await import('../src/tiles/wrapFadeNodeMaterial.js')
    const material = new MeshStandardNodeMaterial()
    wrapOverlaysNodeMaterial(material)
    wrapFadeNodeMaterial(material)
    const defines = material.defines as Record<string, number>
    defines.LAYER_COUNT = 1
    const oneLayer = material.colorNode
    const oneLayerKey = material.customProgramCacheKey()
    defines.LAYER_COUNT = 2
    expect(material.colorNode).not.toBe(oneLayer)
    // The colour nodes are parameterless functions: the count must reach the program key, or three keeps the old shader.
    expect(material.customProgramCacheKey()).not.toBe(oneLayerKey)
    defines.FEATURE_FADE = 1
    expect(material.outputNode).not.toBeNull()
  })
})
