import { UnsignedByteType, type Camera } from 'three'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { renderOutput, rtt } from 'three/tsl'
import type { Node, PassNode, RenderPipeline } from 'three/webgpu'

import {
  sortRenderPasses,
  type RegisteredRenderPass,
  type RenderPassDefinition,
  type RenderPassInspection,
  type RenderPassResource,
  type RenderPassStage,
} from '../plugins/renderPasses.js'
import type { Atmosphere } from './Atmosphere.js'
import type { Earth } from './Earth.js'

/** Edge antialiasing in the `display` stage. */
export type EarthRenderPipelineAntialiasing = 'fxaa' | 'none'

export interface EarthRenderPipelineOptions {
  /**
   * The atmosphere composited in the `radiance` stage (aerial perspective and the sky). Null leaves the
   * scene colour as it is. Default: null.
   */
  atmosphere?: Atmosphere | null
  /**
   * Antialiasing after the atmosphere. The atmosphere decides sky or ground per pixel from one depth sample,
   * which undoes the canvas's multisampling along silhouettes such as the planet's limb; `'fxaa'` is a single
   * cheap pass that smooths them again (it also softens fine text in imagery slightly). Runs last in the
   * `display` stage, only while an atmosphere is composited. Default: `'fxaa'`.
   */
  antialiasing?: EarthRenderPipelineAntialiasing
}

/** What the pipeline builds from: the scene pass's colour and depth, and its camera. */
export interface EarthRenderPipelineInputs {
  color: Node
  depth: Node
  camera: Camera
}

/** The output `buildOutput` returns: set both on a three `RenderPipeline`. */
export interface EarthRenderPipelineOutput {
  outputNode: Node
  /** False once a `display` pass ran: the colour is already tone-mapped and in the output colour space. */
  outputColorTransform: boolean
}

/** The built-in antialiasing, registered in the `display` stage after every other pass. */
const FXAA_RENDER_PASS: RenderPassDefinition = {
  name: 'fxaa',
  stage: 'display',
  order: Number.MAX_SAFE_INTEGER,
  build: ({ color, disposeOnRebuild }) => {
    // FXAA samples neighbours, so it needs a texture. 8 bits are enough for display-referred colour: a quarter
    // of the default half-float target's memory.
    const input = (color as Node & { isTextureNode?: boolean }).isTextureNode === true ? color : rtt(color, null, null, { type: UnsignedByteType })
    if (input !== color) disposeOnRebuild(input as unknown as RenderPassResource)
    return fxaa(input as never) as unknown as Node
  },
}
const FXAA_ENTRY: RegisteredRenderPass = { definition: FXAA_RENDER_PASS, order: Number.MAX_SAFE_INTEGER, sequence: 0 }

/**
 * Builds a three `RenderPipeline`'s output from the scene pass, in three stages:
 *
 * `scene` (the scene's colour) → `radiance` (after aerial perspective and the sky, linear HDR; the scene
 * colour without an atmosphere) → `display` (after tone mapping; FXAA runs last here).
 *
 * Passes come from `earth.renderPasses` (plugins register them with `context.registerRenderPass`). The output
 * node is rebuilt once when passes, the atmosphere or the antialiasing change, never per frame. `<Atmosphere>`
 * (or `<Earth>`, when passes are registered without an atmosphere) runs one in React; vanilla apps attach
 * one to their own pipeline.
 *
 * @example
 * const renderPipeline = new RenderPipeline(renderer)
 * const earthPipeline = new EarthRenderPipeline(earth, { atmosphere })
 * earthPipeline.attach(renderPipeline, pass(scene, camera), camera)
 * renderer.setAnimationLoop(() => {
 *   earth.update(camera, renderer)
 *   renderPipeline.render()
 * })
 */
export class EarthRenderPipeline {
  readonly earth: Earth
  protected _atmosphere: Atmosphere | null
  protected _antialiasing: EarthRenderPipelineAntialiasing
  protected renderPipeline: RenderPipeline | null = null
  protected inputs: EarthRenderPipelineInputs | null = null
  /** What the last build created that owns GPU memory: freed by the next build. */
  protected resources: RenderPassResource[] = []
  protected report: RenderPassInspection[] = []
  protected rebuildScheduled = false
  protected unsubscribe: (() => void) | null = null

  constructor(earth: Earth, { atmosphere = null, antialiasing = 'fxaa' }: EarthRenderPipelineOptions = {}) {
    this.earth = earth
    this._atmosphere = atmosphere
    this._antialiasing = antialiasing
  }

  /** True between `attach` and `detach` (or `dispose`). */
  get isAttached(): boolean {
    return this.renderPipeline !== null
  }

  get atmosphere(): Atmosphere | null {
    return this._atmosphere
  }

  /** Rebuilds the output (once, at the end of the current task). */
  set atmosphere(value: Atmosphere | null) {
    if (this._atmosphere === value) return
    this._atmosphere = value
    this.invalidate()
  }

  get antialiasing(): EarthRenderPipelineAntialiasing {
    return this._antialiasing
  }

  /** Rebuilds the output (once, at the end of the current task). */
  set antialiasing(value: EarthRenderPipelineAntialiasing) {
    if (this._antialiasing === value) return
    this._antialiasing = value
    this.invalidate()
  }

  /**
   * Builds `renderPipeline`'s output from `scenePass` now, and again whenever the passes change. Call it
   * again when the scene pass or the camera is replaced.
   */
  attach(renderPipeline: RenderPipeline, scenePass: PassNode, camera: Camera): void {
    this.attachInputs(renderPipeline, { color: scenePass.getTextureNode('output'), depth: scenePass.getTextureNode('depth'), camera })
  }

  /** Like `attach`, from colour and depth nodes of your own (a pass that is not three's `pass`). */
  attachInputs(renderPipeline: RenderPipeline, inputs: EarthRenderPipelineInputs): void {
    this.unsubscribe ??= this.earth.renderPasses.subscribe(() => this.invalidate())
    this.renderPipeline = renderPipeline
    this.inputs = inputs
    this.rebuild()
  }

  /** Stops building into the pipeline it was attached to and following the passes. Its output stays as last built. */
  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.renderPipeline = null
    this.inputs = null
    this.setReport([])
  }

  /** Schedules a rebuild at the end of the current task, so several changes in a row rebuild once. */
  invalidate(): void {
    if (this.rebuildScheduled || this.renderPipeline === null) return
    this.rebuildScheduled = true
    queueMicrotask(() => {
      // A direct `rebuild` (or `attach`) since then already built the latest state.
      if (this.rebuildScheduled) this.rebuild()
    })
  }

  /** Rebuilds the attached pipeline's output now. */
  rebuild(): void {
    this.rebuildScheduled = false
    const renderPipeline = this.renderPipeline
    const inputs = this.inputs
    if (renderPipeline === null || inputs === null) return
    const { outputNode, outputColorTransform } = this.buildOutput(inputs)
    renderPipeline.outputNode = outputNode as never
    renderPipeline.outputColorTransform = outputColorTransform
    renderPipeline.needsUpdate = true
    this.earth.requestFrame()
  }

  /**
   * Builds the output node from colour and depth, running every stage, without touching a pipeline. For apps
   * that compose the result further. What owns GPU memory is freed by the next build or `dispose`.
   */
  buildOutput({ color, depth, camera }: EarthRenderPipelineInputs): EarthRenderPipelineOutput {
    const atmosphere = this._atmosphere
    const passes = this.collectPasses()
    const report: RenderPassInspection[] = []
    const resources: RenderPassResource[] = []
    const runStage = (stage: RenderPassStage, input: Node): Node => {
      let current = input
      for (const { definition, order } of passes) {
        if (definition.stage !== stage) continue
        const owned: RenderPassResource[] = []
        const entry: RenderPassInspection = { name: definition.name, stage, order, active: true, timing: 'fused' }
        try {
          const output = definition.build({
            color: current as Node<'vec4'>,
            depth: depth as Node<'float'>,
            camera,
            atmosphere,
            disposeOnRebuild: resource => void owned.push(resource),
          })
          if ((output as { isNode?: boolean } | null | undefined)?.isNode !== true) throw new Error('build must return a node (the stage\'s new colour)')
          current = output
          resources.push(...owned)
          if (owned.length > 0) entry.timing = 'unavailable'
        } catch (error) {
          disposeAll(owned)
          entry.active = false
          entry.error = (error as Error)?.message ?? String(error)
          console.error(`Render pass "${definition.name}" failed to build and is skipped: ${entry.error}. Fix its build function.`, error)
        }
        report.push(entry)
      }
      return current
    }

    let current = runStage('scene', color)
    if (atmosphere !== null) current = atmosphere.createAerialPerspective(current, depth, camera)
    current = runStage('radiance', current)
    const hasDisplayPasses = passes.some(({ definition }) => definition.stage === 'display')
    let outputColorTransform = true
    if (hasDisplayPasses) {
      // Display passes work on tone-mapped colour in the output colour space, so that transform runs first, here.
      current = runStage('display', renderOutput(current as never) as unknown as Node)
      outputColorTransform = false
    }
    // A pass may hand back a resource it kept from the previous build: free only what this build dropped.
    const kept = new Set(resources)
    const dropped = this.resources.filter(resource => !kept.has(resource))
    this.resources = resources
    disposeAll(dropped)
    this.setReport(report)
    return { outputNode: current, outputColorTransform }
  }

  /** The passes of the last build, in the order they ran. */
  inspect(): RenderPassInspection[] {
    return this.report.map(entry => ({ ...entry }))
  }

  /**
   * Detaches and frees what the last build created (render targets of passes such as FXAA). The pipeline it
   * built into must not render that output any more; `attach` again to build a new one.
   */
  dispose(): void {
    this.detach()
    disposeAll(this.resources)
    this.resources = []
  }

  /** Registered passes plus the built-in ones, in the order they run within each stage. FXAA always runs last. */
  protected collectPasses(): RegisteredRenderPass[] {
    const passes = sortRenderPasses(this.earth.renderPasses.entries())
    if (this._antialiasing === 'fxaa' && this._atmosphere !== null) passes.push(FXAA_ENTRY)
    return passes
  }

  protected setReport(report: RenderPassInspection[]): void {
    this.report = report
    this.earth.renderPasses.setBuildReport(this, report.length === 0 ? null : report)
  }
}

function disposeAll(resources: readonly RenderPassResource[]): void {
  for (const resource of resources) {
    try {
      resource.dispose()
    } catch (error) {
      console.error('EarthRenderPipeline: a render pass resource threw on dispose.', error)
    }
  }
}
