import type { Camera } from 'three'
import type { Node } from 'three/webgpu'

import type { Atmosphere } from '../core/Atmosphere.js'

/**
 * Where a render pass runs in `EarthRenderPipeline`:
 *
 * - `scene`: on the scene's colour, before the atmosphere. What it adds is hazed and lit like the ground
 *   (screen-space outlines, effects that belong to the scene).
 * - `radiance`: on the colour after aerial perspective and the sky, linear HDR (bloom, volumes composited
 *   with `createAerialPerspectiveAlongRay`). Without an atmosphere it receives the scene colour.
 * - `display`: on the tone-mapped, display-referred colour (grading, vignette). The built-in FXAA runs last
 *   here.
 */
export type RenderPassStage = 'scene' | 'radiance' | 'display'

export const RENDER_PASS_STAGES: readonly RenderPassStage[] = ['scene', 'radiance', 'display']

/** Something a pass created for one build (a render target, a node that owns one), freed when the output is rebuilt. */
export interface RenderPassResource {
  dispose(): void
}

/** What a render pass's `build` receives. */
export interface RenderPassInputs {
  /** The stage's colour so far (the previous pass's output): linear HDR in `scene` and `radiance`, display-referred in `display`. */
  color: Node<'vec4'>
  /** The scene's depth (the scene pass's depth texture), as three's `depth` node reads it. */
  depth: Node<'float'>
  /** The camera the scene is rendered with. */
  camera: Camera
  /** The atmosphere composited in the `radiance` stage, or null when there is none. */
  atmosphere: Atmosphere | null
  /**
   * Frees `resource` when the output is rebuilt or the pipeline disposed. Pass what the build created that
   * owns GPU memory (a node with its own render target, such as three's `bloom`). Such passes are reported
   * with timing `'unavailable'`, the rest as `'fused'`.
   */
  disposeOnRebuild(resource: RenderPassResource): void
}

/**
 * A screen effect in `EarthRenderPipeline`, registered with `context.registerRenderPass` (or
 * `earth.renderPasses.register`). The pipeline calls `build` once each time its output is rebuilt (when a
 * pass is added or removed, the atmosphere or the camera changes), never per frame.
 *
 * @example
 * context.registerRenderPass({
 *   name: 'vignette',
 *   stage: 'display',
 *   build: ({ color }) => vec4(color.rgb.mul(screenUV.sub(0.5).length().oneMinus()), color.a),
 * })
 */
export interface RenderPassDefinition {
  /** Unique on an earth: `'bloom'`, `'@acme/grading'`. */
  name: string
  stage: RenderPassStage
  /**
   * A finite number: lower runs first within the stage; passes with the same order run in registration order.
   * The built-in FXAA always runs after every `display` pass, whatever its order. Default: 0.
   */
  order?: number
  /** Returns the stage's new colour node. Pure TSL nodes are fused by three into one fullscreen shader. */
  build(inputs: RenderPassInputs): Node
}

/** How a pass's GPU time is reported in v1. */
export type RenderPassTiming = 'fused' | 'unavailable'

/** One pass in `earth.inspect().renderPasses`. */
export interface RenderPassInspection {
  name: string
  stage: RenderPassStage
  order: number
  /** True when a mounted `EarthRenderPipeline` built it into its output. */
  active: boolean
  /**
   * `'fused'`: a pure node pass, compiled into the stage's fullscreen shader, with no time of its own.
   * `'unavailable'`: the pass renders its own targets, which v1 does not time separately.
   */
  timing: RenderPassTiming
  /** Set when the last `build` threw: the pass was skipped. */
  error?: string
}

/** Listener of a registry: called after a pass was registered or removed. */
export type RenderPassListener = () => void

/** A registered pass with its registration sequence, for stable ordering. */
export interface RegisteredRenderPass {
  readonly definition: RenderPassDefinition
  readonly order: number
  readonly sequence: number
}

/** Checks a definition, throwing an error that states the fix. */
export function validateRenderPass(definition: RenderPassDefinition): void {
  const name = definition?.name
  if (typeof name !== 'string' || name.length === 0) throw new Error('registerRenderPass: give the pass a non-empty `name`.')
  if (!RENDER_PASS_STAGES.includes(definition.stage)) {
    throw new Error(`registerRenderPass("${name}"): \`stage\` must be 'scene', 'radiance' or 'display', not ${JSON.stringify(definition.stage)}.`)
  }
  if (definition.order !== undefined && !Number.isFinite(definition.order)) {
    throw new Error(`registerRenderPass("${name}"): \`order\` must be a finite number, such as 10 or -1; leave it out for 0.`)
  }
  if (typeof definition.build !== 'function') throw new Error(`registerRenderPass("${name}"): \`build\` must be a function returning the stage's new colour node.`)
}

/** Sorts passes by `order`, then registration sequence (stages filter the result). */
export function sortRenderPasses<T extends RegisteredRenderPass>(passes: Iterable<T>): T[] {
  return [...passes].sort((a, b) => a.order - b.order || a.sequence - b.sequence)
}

/**
 * The render passes installed on one `Earth` (`earth.renderPasses`). Plugins register through
 * `context.registerRenderPass`; an `EarthRenderPipeline` builds them into its output, and rebuilds it once
 * when they change.
 */
export class RenderPassRegistry {
  protected readonly passes = new Map<string, RegisteredRenderPass>()
  protected readonly listeners = new Set<RenderPassListener>()
  /** What each mounted `EarthRenderPipeline` built last, by pipeline. */
  protected readonly buildReports = new Map<object, readonly RenderPassInspection[]>()
  protected sequence = 0

  /** Adds a pass. Returns a function that removes it. Throws when the name is taken, stating the fix. */
  register(definition: RenderPassDefinition): () => void {
    validateRenderPass(definition)
    if (this.passes.has(definition.name)) {
      throw new Error(`registerRenderPass: a render pass named "${definition.name}" is already registered; pick another name or remove the other pass first.`)
    }
    const entry: RegisteredRenderPass = { definition, order: definition.order ?? 0, sequence: ++this.sequence }
    this.passes.set(definition.name, entry)
    this.notify()
    return () => {
      if (this.passes.get(definition.name) !== entry) return
      this.passes.delete(definition.name)
      this.notify()
    }
  }

  get(name: string): RenderPassDefinition | undefined {
    return this.passes.get(name)?.definition
  }

  has(name: string): boolean {
    return this.passes.has(name)
  }

  get size(): number {
    return this.passes.size
  }

  /** The passes in registration order. */
  values(): IterableIterator<RenderPassDefinition> {
    return [...this.passes.values()].map(entry => entry.definition)[Symbol.iterator]()
  }

  /** The passes with their order and registration sequence, in registration order. */
  entries(): RegisteredRenderPass[] {
    return [...this.passes.values()]
  }

  /** Records what a pipeline built (null: it stopped building), for `inspect`. `EarthRenderPipeline` calls it. */
  setBuildReport(pipeline: object, report: readonly RenderPassInspection[] | null): void {
    if (report === null) this.buildReports.delete(pipeline)
    else this.buildReports.set(pipeline, report)
  }

  /**
   * The passes as built by the mounted pipelines (built-in ones such as `fxaa` included), then registered
   * passes no pipeline built, with `active: false`. `earth.inspect().renderPasses` reports it.
   */
  inspect(): RenderPassInspection[] {
    const result = new Map<string, RenderPassInspection>()
    for (const report of this.buildReports.values()) {
      for (const entry of report) {
        const seen = result.get(entry.name)
        if (seen === undefined || (!seen.active && entry.active)) result.set(entry.name, { ...entry })
      }
    }
    for (const { definition, order } of sortRenderPasses(this.passes.values())) {
      if (!result.has(definition.name)) result.set(definition.name, { name: definition.name, stage: definition.stage, order, active: false, timing: 'fused' })
    }
    return [...result.values()]
  }

  /** Calls `listener` after each change. Returns a function that removes it. */
  subscribe(listener: RenderPassListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('RenderPassRegistry: a listener threw.', error)
      }
    }
  }
}
