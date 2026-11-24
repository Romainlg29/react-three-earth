import { Mesh, PerspectiveCamera, Scene } from 'three'
import { float, vec4 } from 'three/tsl'
import type { Node, PassNode, RenderPipeline } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Atmosphere } from '../src/core/Atmosphere.js'
import { Earth } from '../src/core/Earth.js'
import { EarthRenderPipeline } from '../src/core/EarthRenderPipeline.js'
import { PLUGIN_API_VERSION } from '../src/plugins/plugin.js'
import { RenderPassRegistry, type RenderPassDefinition } from '../src/plugins/renderPasses.js'
import { TRANSLUCENT_LAYER, TRANSLUCENT_RENDER_PASS_NAME, TranslucentCompositeNode, TranslucentPassNode } from '../src/core/TranslucentPass.js'

afterEach(() => vi.restoreAllMocks())

const camera = new PerspectiveCamera()

/** A pass that records its input and returns a fresh node, so the chain can be read back. */
function recordingPass(name: string, stage: RenderPassDefinition['stage'], log: Array<{ name: string; input: Node }>, order?: number): RenderPassDefinition & { output: Node } {
  const output = vec4(0, 0, 0, 1) as unknown as Node
  return {
    name,
    stage,
    order,
    output,
    build: ({ color }) => {
      log.push({ name, input: color })
      return output
    },
  }
}

function fakeRenderPipeline() {
  return { outputNode: null as Node | null, outputColorTransform: true, needsUpdate: false } as unknown as RenderPipeline & { outputNode: Node }
}

function fakeScenePass(color: Node, depth: Node): PassNode {
  return { getTextureNode: (name: string) => (name === 'output' ? color : depth) } as unknown as PassNode
}

function fakeAtmosphere() {
  const output = vec4(1, 1, 1, 1) as unknown as Node
  const createAerialPerspective = vi.fn(() => output)
  return { atmosphere: { createAerialPerspective } as unknown as Atmosphere, createAerialPerspective, output }
}

describe('RenderPassRegistry', () => {
  it('rejects invalid definitions and taken names, stating the fix', () => {
    const registry = new RenderPassRegistry()
    expect(() => registry.register({ name: '', stage: 'scene', build: () => float(0) as never })).toThrow(/non-empty `name`/)
    expect(() => registry.register({ name: 'x', stage: 'tone' as never, build: () => float(0) as never })).toThrow(/'scene', 'radiance' or 'display'/)
    expect(() => registry.register({ name: 'x', stage: 'scene' } as never)).toThrow(/`build` must be a function/)
    expect(() => registry.register({ name: 'x', stage: 'scene', order: Infinity, build: ({ color }) => color })).toThrow(/`order` must be a finite number/)
    expect(() => registry.register({ name: 'x', stage: 'scene', order: '2' as never, build: ({ color }) => color })).toThrow(/`order` must be a finite number/)
    registry.register({ name: 'bloom', stage: 'radiance', build: ({ color }) => color })
    expect(() => registry.register({ name: 'bloom', stage: 'display', build: ({ color }) => color })).toThrow(/already registered/)
  })

  it('notifies on changes and removes once', () => {
    const registry = new RenderPassRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const remove = registry.register({ name: 'a', stage: 'scene', build: ({ color }) => color })
    expect(registry.has('a')).toBe(true)
    remove()
    remove()
    expect(registry.size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reports registered passes no pipeline built as inactive', () => {
    const earth = new Earth()
    earth.renderPasses.register({ name: 'grade', stage: 'display', order: 2, build: ({ color }) => color })
    expect(earth.inspect().renderPasses).toEqual([{ name: 'grade', stage: 'display', order: 2, active: false, timing: 'fused' }])
  })
})

describe('translucent pass', () => {
  it('stays registered while anyone holds it, first in radiance', () => {
    const registry = new RenderPassRegistry()
    const releaseFirst = registry.retainTranslucentPass()
    const releaseSecond = registry.retainTranslucentPass()
    expect(registry.get(TRANSLUCENT_RENDER_PASS_NAME)?.stage).toBe('radiance')
    releaseFirst()
    releaseFirst()
    expect(registry.has(TRANSLUCENT_RENDER_PASS_NAME)).toBe(true)
    releaseSecond()
    expect(registry.has(TRANSLUCENT_RENDER_PASS_NAME)).toBe(false)
  })

  it('draws the scene pass\'s scene again on its own layer, and is skipped without a scene', () => {
    const earth = new Earth()
    earth.renderPasses.retainTranslucentPass()
    const color = vec4(0, 0, 0, 1) as unknown as Node
    const depth = float(1) as unknown as Node
    const scene = new Scene()
    const pipeline = new EarthRenderPipeline(earth)
    const scenePass = { ...fakeScenePass(color, depth), scene } as unknown as PassNode
    const renderPipeline = fakeRenderPipeline()
    pipeline.attach(renderPipeline, scenePass, camera)
    const output = renderPipeline.outputNode as unknown as TranslucentCompositeNode
    expect(output).toBeInstanceOf(TranslucentCompositeNode)
    expect(output.colorNode).toBe(color)
    expect(pipeline.inspect()).toEqual([expect.objectContaining({ name: TRANSLUCENT_RENDER_PASS_NAME, active: true })])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { outputNode } = pipeline.buildOutput({ color, depth, camera })
    expect(outputNode).toBe(color)
    expect(pipeline.inspect()[0]).toMatchObject({ active: false, error: expect.stringContaining('attach(renderPipeline, scenePass, camera)') })
    pipeline.dispose()
  })

  it('renders only the translucent layer', () => {
    const pass = new TranslucentPassNode(new Scene(), camera)
    expect(pass.getLayers()?.mask).toBe(1 << TRANSLUCENT_LAYER)
    const mesh = new Mesh()
    mesh.layers.set(TRANSLUCENT_LAYER)
    expect(mesh.layers.test(camera.layers)).toBe(false)
    pass.dispose()
  })
})

describe('EarthRenderPipeline', () => {
  it('outputs the scene colour as it is with no passes and no atmosphere', () => {
    const earth = new Earth()
    const color = vec4(0.5) as unknown as Node
    const { outputNode, outputColorTransform } = new EarthRenderPipeline(earth).buildOutput({ color, depth: float(0) as never, camera })
    expect(outputNode).toBe(color)
    expect(outputColorTransform).toBe(true)
  })

  it('runs the stages in order: scene, the atmosphere, radiance, then display after the output transform', () => {
    const earth = new Earth()
    const log: Array<{ name: string; input: Node }> = []
    const display = recordingPass('vignette', 'display', log)
    const radianceLate = recordingPass('radiance-late', 'radiance', log, 5)
    const radianceEarly = recordingPass('radiance-early', 'radiance', log, -1)
    const scene = recordingPass('outline', 'scene', log)
    for (const pass of [display, radianceLate, radianceEarly, scene]) earth.renderPasses.register(pass)
    const { atmosphere, createAerialPerspective, output: hazed } = fakeAtmosphere()
    const color = vec4(0.5) as unknown as Node
    const depth = float(0) as unknown as Node
    const pipeline = new EarthRenderPipeline(earth, { atmosphere, antialiasing: 'none' })
    const result = pipeline.buildOutput({ color, depth, camera })

    expect(log.map(entry => entry.name)).toEqual(['outline', 'radiance-early', 'radiance-late', 'vignette'])
    expect(log[0]!.input).toBe(color)
    expect(createAerialPerspective).toHaveBeenCalledWith(scene.output, depth, camera)
    expect(log[1]!.input).toBe(hazed)
    expect(log[2]!.input).toBe(radianceEarly.output)
    expect(log[3]!.input).not.toBe(radianceLate.output) // wrapped in the output transform
    expect(result.outputNode).toBe(display.output)
    expect(result.outputColorTransform).toBe(false)
    expect(pipeline.inspect().map(entry => `${entry.stage}:${entry.name}`)).toEqual(['scene:outline', 'radiance:radiance-early', 'radiance:radiance-late', 'display:vignette'])
  })

  it('runs the built-in FXAA last in display, only while an atmosphere is composited', () => {
    const earth = new Earth()
    earth.renderPasses.register({ name: 'grade', stage: 'display', order: Number.MAX_SAFE_INTEGER, build: ({ color }) => color })
    const withoutAtmosphere = new EarthRenderPipeline(earth)
    withoutAtmosphere.buildOutput({ color: vec4(0.5) as never, depth: float(0) as never, camera })
    expect(withoutAtmosphere.inspect().map(entry => entry.name)).toEqual(['grade'])

    const pipeline = new EarthRenderPipeline(earth, { atmosphere: fakeAtmosphere().atmosphere })
    pipeline.buildOutput({ color: vec4(0.5) as never, depth: float(0) as never, camera })
    expect(pipeline.inspect().map(entry => [entry.name, entry.timing])).toEqual([
      ['grade', 'fused'],
      ['fxaa', 'unavailable'], // it owns an 8-bit target
    ])
    expect(earth.inspect().renderPasses.map(entry => [entry.name, entry.active])).toEqual([
      ['grade', true],
      ['fxaa', true],
    ])
  })

  it('skips a pass whose build throws, reporting it with the fix', () => {
    const earth = new Earth()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    earth.renderPasses.register({ name: 'broken', stage: 'scene', build: () => { throw new Error('no texture') } })
    earth.renderPasses.register({ name: 'empty', stage: 'scene', build: () => undefined as never })
    const color = vec4(0.5) as unknown as Node
    const pipeline = new EarthRenderPipeline(earth)
    expect(pipeline.buildOutput({ color, depth: float(0) as never, camera }).outputNode).toBe(color)
    expect(pipeline.inspect()).toEqual([
      { name: 'broken', stage: 'scene', order: 0, active: false, timing: 'fused', error: 'no texture' },
      { name: 'empty', stage: 'scene', order: 0, active: false, timing: 'fused', error: "build must return a node (the stage's new colour)" },
    ])
    expect(error.mock.calls[0]![0]).toMatch(/Render pass "broken" failed to build and is skipped: no texture\. Fix its build function\./)
  })

  it('frees what a build created on the next build, and reports such passes as unavailable', () => {
    const earth = new Earth()
    const resources: Array<{ dispose: () => void }> = []
    earth.renderPasses.register({
      name: 'bloom',
      stage: 'radiance',
      build: ({ color, disposeOnRebuild }) => {
        const resource = { dispose: vi.fn() }
        resources.push(resource)
        disposeOnRebuild(resource)
        return color
      },
    })
    const pipeline = new EarthRenderPipeline(earth)
    const inputs = { color: vec4(0.5) as never, depth: float(0) as never, camera }
    pipeline.buildOutput(inputs)
    expect(pipeline.inspect()[0]!.timing).toBe('unavailable')
    expect(resources[0]!.dispose).not.toHaveBeenCalled()
    pipeline.buildOutput(inputs)
    expect(resources[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(resources[1]!.dispose).not.toHaveBeenCalled()
    pipeline.dispose()
    expect(resources[1]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps a resource a pass hands back again on the next build', () => {
    const earth = new Earth()
    const kept = { dispose: vi.fn() }
    earth.renderPasses.register({
      name: 'cached',
      stage: 'radiance',
      build: ({ color, disposeOnRebuild }) => {
        disposeOnRebuild(kept)
        return color
      },
    })
    const pipeline = new EarthRenderPipeline(earth)
    const inputs = { color: vec4(0.5) as never, depth: float(0) as never, camera }
    pipeline.buildOutput(inputs)
    pipeline.buildOutput(inputs)
    expect(kept.dispose).not.toHaveBeenCalled()
    pipeline.dispose()
    expect(kept.dispose).toHaveBeenCalledTimes(1)
  })

  it('rebuilds an attached pipeline once when passes change, never per frame, and stops when detached', async () => {
    const earth = new Earth()
    const frameRequests = vi.fn()
    earth.addEventListener('framerequest', frameRequests)
    const renderPipeline = fakeRenderPipeline()
    const color = vec4(0.5) as unknown as Node
    const pipeline = new EarthRenderPipeline(earth)
    pipeline.attach(renderPipeline, fakeScenePass(color, float(0) as never), camera)
    expect(renderPipeline.outputNode).toBe(color)
    expect(renderPipeline.needsUpdate).toBe(true)
    renderPipeline.needsUpdate = false

    const builds = vi.fn(({ color }: { color: Node }) => color)
    const first = earth.renderPasses.register({ name: 'a', stage: 'scene', build: builds })
    earth.renderPasses.register({ name: 'b', stage: 'display', build: builds })
    expect(builds).not.toHaveBeenCalled() // coalesced to the end of the task
    await Promise.resolve()
    expect(builds).toHaveBeenCalledTimes(2) // one rebuild, both passes
    expect(renderPipeline.needsUpdate).toBe(true)
    expect(renderPipeline.outputColorTransform).toBe(false)
    expect(frameRequests).toHaveBeenCalled()

    pipeline.atmosphere = fakeAtmosphere().atmosphere
    pipeline.antialiasing = 'none'
    await Promise.resolve()
    expect(builds).toHaveBeenCalledTimes(4)

    // A direct rebuild while one is queued builds once.
    pipeline.antialiasing = 'fxaa'
    pipeline.rebuild()
    await Promise.resolve()
    expect(builds).toHaveBeenCalledTimes(6)
    pipeline.antialiasing = 'none'
    await Promise.resolve()
    expect(builds).toHaveBeenCalledTimes(8)

    pipeline.detach()
    first()
    await Promise.resolve()
    expect(builds).toHaveBeenCalledTimes(8)
    expect(earth.inspect().renderPasses.every(entry => !entry.active)).toBe(true)
  })

  it('takes plugin passes, removed with the plugin', async () => {
    const earth = new Earth()
    const renderPipeline = fakeRenderPipeline()
    const color = vec4(0.5) as unknown as Node
    const graded = vec4(0.25) as unknown as Node
    new EarthRenderPipeline(earth).attach(renderPipeline, fakeScenePass(color, float(0) as never), camera)
    const plugin = {
      name: 'grading',
      apiVersion: PLUGIN_API_VERSION,
      install: (context: import('../src/plugins/plugin.js').PluginContext) => void context.registerRenderPass({ name: 'grade', stage: 'radiance', build: () => graded }),
    }
    earth.addPlugin(plugin)
    await Promise.resolve()
    expect(renderPipeline.outputNode).toBe(graded)
    earth.removePlugin(plugin)
    await Promise.resolve()
    expect(renderPipeline.outputNode).toBe(color)
    expect(earth.renderPasses.size).toBe(0)
  })
})
