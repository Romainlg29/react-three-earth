// Precomputation sequence after Eric Bruneton's "Precomputed Atmospheric Scattering: a New Implementation"
// (2017), atmosphere/model.cc (Model::Precompute), BSD 3-Clause; the full notice is in AtmosphereModel.ts.
// Render-target handling (slice-by-slice 3D rendering) after takram three-geospatial (MIT, (c) 2024 Shota
// Matsuda), @takram/three-atmosphere src/webgpu/AtmosphereLUTTexturesWebGL.ts.

import {
  AddEquation,
  CustomBlending,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  OneFactor,
  RenderTarget,
  RenderTarget3D,
  RGBAFormat,
  type Texture,
  type TextureDataType,
} from 'three'
import { float, Fn, int, ivec2, ivec3, mrt, screenCoordinate, struct, texture3D, texture3DLoad, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { NodeMaterial, QuadMesh, type Node, type Renderer } from 'three/webgpu'

import { AtmosphereModel, type AtmosphereTextureSet } from './AtmosphereModel.js'
import * as precompute from './precompute.js'
import { createAtmosphereCacheKey, hashString, type AtmosphereTextureCache, type AtmosphereTextureData } from './AtmosphereTextureCache.js'
import { GenerationPacer } from './GenerationPacer.js'
import { createGpuIdleWaiter, nextTask, type GpuIdleWaiter } from './GpuIdleWaiter.js'
import {
  computeDirectIrradianceTexel,
  computeIndirectIrradiance,
  computeMultipleScattering,
  computeScatteringDensity,
  computeSingleScattering,
  computeTransmittanceTexel,
  type PreviousOrderTextures,
} from './precompute.js'

/**
 * Transmittance and irradiance: always 32-bit floats (Bruneton: 16-bit "gives artifacts" there), never
 * blended, filtered by the GPU where it can filter 32-bit floats and by hand otherwise (see
 * `AtmosphereModel.sampleBilinear`).
 */
function createPreciseTarget(name: string, width: number, height: number, hardwareFiltering: boolean): RenderTarget {
  const target = new RenderTarget(width, height, { depthBuffer: false, format: RGBAFormat, type: FloatType })
  configureTexture(target.texture, name, hardwareFiltering ? LinearFilter : NearestFilter)
  return target
}

/**
 * Scattering: filtered by the GPU, 32-bit or half floats (see `selectScatteringType`). With several
 * names, one target with a texture per name, written together by a multiple-render-target pass whose
 * outputs carry those names.
 */
function createScatteringTarget(names: string[], width: number, height: number, depth: number, type: TextureDataType = HalfFloatType): RenderTarget3D {
  const target = new RenderTarget3D(width, height, depth, { depthBuffer: false, format: RGBAFormat, type, count: names.length })
  target.textures.forEach((texture, index) => configureTexture(texture, names[index]!, LinearFilter))
  return target
}

function configureTexture(result: Texture, name: string, filter: typeof LinearFilter | typeof NearestFilter): void {
  result.name = name
  result.minFilter = filter
  result.magFilter = filter
  result.colorSpace = NoColorSpace
  result.generateMipmaps = false
}

/** Adds the pass output to what the target holds, for accumulating scattering orders. */
function makeAdditive(material: NodeMaterial): NodeMaterial {
  material.transparent = true
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = OneFactor
  material.blendDstAlpha = OneFactor
  return material
}

/** Resolves on the next animation frame (or macrotask outside a browser), so the app keeps rendering. */
function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

/** Thrown inside `generate` when its signal aborts; `generate` turns it into a `null` result. */
class GenerationAborted extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new GenerationAborted()
}

/** Single Rayleigh and Mie scattering of one texel, as the single-scattering pass computes them. */
const SingleScatteringStruct = struct({ rayleigh: 'vec3', mie: 'vec3' }, 'AtmosphereSingleScattering')

type MaterialFactory = (fragment: Node, additive?: boolean) => NodeMaterial

/** Full-screen draws run together: a 2D pass, or slices of a 3D pass. */
interface WorkUnit {
  target: RenderTarget
  material: NodeMaterial
  /** The slices to draw (3D targets), or [0]; a number n stands for slices 0 to n - 1. */
  slices: number[] | number
  /** Relative GPU cost: estimated texture fetches (or equivalent work) per texel, times texels. */
  weight: number
}

/**
 * Rough texture fetches per texel of each pass, for `GenerationPacer`. Only their ratios matter: the pacer
 * measures milliseconds per unit of weight. Loops count their samples times the lookups in each.
 */
const PASS_COST = {
  /** 500 transmittance integration steps, arithmetic only. */
  transmittance: 125,
  copy: 1,
  /** 51 samples, two transmittance lookups each. */
  singleScattering: 102,
  /** 2 × 8 × 16 directions, a scattering lookup (two fetches) each, plus ground terms. */
  scatteringDensity: 600,
  /** 16 × 64 directions, one or two scattering lookups each. */
  indirectIrradiance: 2048,
  /** 51 samples, a scattering lookup (two fetches) and a transmittance lookup each. */
  multipleScattering: 153,
} as const

let implementationFingerprint: string | null = null

/**
 * A hash of the code that decides what the lookup textures contain (the model, the pass bodies and the
 * pass sequence), so that cached textures from another version of it are never used.
 */
function getImplementationFingerprint(): string {
  implementationFingerprint ??= hashString(
    [
      String(AtmosphereModel),
      ...Object.values(precompute).map(String),
      String((AtmosphereTextures.prototype as unknown as { createUnits: unknown }).createUnits),
    ].join('\n'),
  )
  return implementationFingerprint
}

export interface AtmosphereTexturesGenerateOptions {
  /** Loads the textures from this cache when it holds them, and stores them in it otherwise. */
  cache?: AtmosphereTextureCache | null
}

/**
 * The precomputed lookup textures of the Bruneton model: transmittance, scattering (4D packed into 3D) and
 * ground irradiance. `generate` fills them once, on the GPU, with fragment passes only (3D textures are
 * rendered slice by slice), so the WebGL 2 backend works too.
 */
export class AtmosphereTextures implements AtmosphereTextureSet {
  readonly model: AtmosphereModel

  protected readonly transmittanceTarget: RenderTarget
  protected readonly scatteringTarget: RenderTarget3D
  protected readonly irradianceTarget: RenderTarget

  /**
   * GPU time spent on generation per animation frame, in milliseconds. Each frame's batch of passes (or
   * slices of 3D passes) is sized from the measured cost of the previous ones, so that on any device
   * generation adds about this much to a frame: the app keeps its frame rate while the textures fill. A
   * single slice is never split, so one batch can exceed a very small budget. Raise it for a faster
   * startup when the app has headroom, lower it if frames still drop. Infinity generates everything in
   * one frame, for a loading screen (a long frame, the shortest total time).
   */
  budgetMillisecondsPerFrame = 4

  /**
   * Units (passes, or slices of 3D passes) per frame where the GPU's work cannot be timed (neither
   * WebGPU nor WebGL 2 backend). Unused otherwise.
   */
  untimedUnitsPerFrame = 8

  /** Longest wait for the GPU to report a batch done before carrying on regardless, in milliseconds. */
  maximumGpuWaitMilliseconds = 1000

  /** Wall time of the last generation (or cache load), from the first pass to the GPU finishing, in milliseconds. */
  generationTimeMilliseconds: number | null = null

  /** Animation frames the last generation (or cache load) took. */
  generationFrames: number | null = null

  /** Whether the current textures were loaded from the cache rather than generated. */
  loadedFromCache = false

  protected readonly quad = new QuadMesh(new NodeMaterial())
  protected readonly slice = uniform(0)

  constructor(model: AtmosphereModel) {
    this.model = model
    const sizes = model.parameters.textureSizesTexels
    const scatteringSize = model.parameters.getScatteringTextureSizeTexels()
    this.transmittanceTarget = createPreciseTarget('atmosphereTransmittance', sizes.transmittance.x, sizes.transmittance.y, false)
    this.scatteringTarget = createScatteringTarget(['atmosphereScattering'], scatteringSize.x, scatteringSize.y, scatteringSize.z)
    this.irradianceTarget = createPreciseTarget('atmosphereIrradiance', sizes.irradiance.x, sizes.irradiance.y, false)
    this.quad.name = 'AtmosphereTextures'
  }

  /** Matches the 32-bit textures' filters to how the model reads them. Call before their first use. */
  setHardwareFiltering(enabled: boolean): void {
    const filter = enabled ? LinearFilter : NearestFilter
    for (const target of [this.transmittanceTarget, this.irradianceTarget]) {
      target.texture.minFilter = filter
      target.texture.magFilter = filter
    }
  }

  get transmittance(): Texture {
    return this.transmittanceTarget.texture
  }

  get scattering(): Texture {
    return this.scatteringTarget.texture
  }

  get irradiance(): Texture {
    return this.irradianceTarget.texture
  }

  /**
   * The scattering texture is filtered in hardware and accumulates orders by additive blending: 32-bit
   * floats where the GPU can filter and blend them, half floats otherwise (enough for radiance).
   */
  protected selectScatteringType(renderer: Renderer): TextureDataType {
    return renderer.hasFeature('float32-filterable') && renderer.hasFeature('float32-blendable') ? FloatType : HalfFloatType
  }

  /**
   * Fills every lookup texture, a batch of passes per animation frame within `budgetMillisecondsPerFrame`
   * so the app keeps drawing, or loads them from `options.cache` when it holds them for these parameters
   * (and stores them there after generating). The renderer must be initialised. Resolves once the GPU has
   * finished, with the time taken in milliseconds, or with null if `signal` aborted first (nothing is
   * rendered after that). Temporary resources are released in every case; storing in the cache continues
   * in the background.
   */
  async generate(renderer: Renderer, signal?: AbortSignal, options: AtmosphereTexturesGenerateOptions = {}): Promise<number | null> {
    const start = performance.now()
    const scatteringType = this.selectScatteringType(renderer)
    this.scatteringTarget.texture.type = scatteringType
    const cache = options.cache ?? null
    const cacheKey = cache === null ? null : createAtmosphereCacheKey(this.model.parameters, scatteringType === HalfFloatType, getImplementationFingerprint())
    const materials: NodeMaterial[] = []
    const createMaterial: MaterialFactory = (fragment, additive = false) => {
      const material = new NodeMaterial()
      material.name = 'AtmosphereTexturesPass'
      material.fragmentNode = fragment
      material.depthTest = false
      material.depthWrite = false
      materials.push(material)
      return additive ? makeAdditive(material) : material
    }
    const disposables: { dispose(): void }[] = []
    let loadedFromCache = false
    try {
      const cached = cache === null || cacheKey === null ? null : await cache.read(cacheKey)
      throwIfAborted(signal)
      let units: WorkUnit[] | null = null
      if (cached !== null) {
        units = this.createUploadUnits(cached, scatteringType, createMaterial, disposables)
        loadedFromCache = units !== null
      }
      if (units === null) {
        const transient = new TransientTargets(this.model, scatteringType, this.model.hardwareFiltering)
        disposables.push(transient)
        units = this.createUnits(transient, createMaterial)
      }
      this.generationFrames = await this.runPaced(renderer, units, signal)
      // Reading one texel back waits for every pass to finish on the GPU.
      await renderer.readRenderTargetPixelsAsync(this.irradianceTarget, 0, 0, 1, 1)
      throwIfAborted(signal)
    } catch (error) {
      // A readback interrupted by disposal is a cancellation too, not a failure.
      if (error instanceof GenerationAborted || signal?.aborted === true) return null
      throw error
    } finally {
      for (const material of materials) material.dispose()
      for (const disposable of disposables) disposable.dispose()
    }
    this.loadedFromCache = loadedFromCache
    this.generationTimeMilliseconds = performance.now() - start
    if (cache !== null && cacheKey !== null && !loadedFromCache) void this.store(renderer, cache, cacheKey, signal)
    return this.generationTimeMilliseconds
  }

  /**
   * Runs the units in order, one batch per animation frame. Each batch starts once the GPU has caught up
   * with the app's frame and is timed until the GPU finishes it, which is what sizes the next one.
   * Returns the number of frames used.
   */
  protected async runPaced(renderer: Renderer, units: WorkUnit[], signal?: AbortSignal): Promise<number> {
    const waiter = createGpuIdleWaiter(renderer)
    const pacer = new GenerationPacer(this.budgetMillisecondsPerFrame)
    const weights = units.map(unit => unit.weight)
    // The waiter's own latency (a promise or a poll) is not GPU work: the fastest of a few waits with
    // nothing of ours queued (the app may slip a frame into one of them).
    let latencyMilliseconds = 0
    if (waiter !== null && this.budgetMillisecondsPerFrame !== Infinity) {
      await this.waitForGpu(waiter, signal)
      latencyMilliseconds = Infinity
      for (let sample = 0; sample < 3; sample++) {
        const before = performance.now()
        await this.waitForGpu(waiter, signal)
        latencyMilliseconds = Math.min(latencyMilliseconds, performance.now() - before)
      }
    }
    // A material's first draw compiles its shader, which says nothing about the GPU cost of later draws.
    const compiled = new Set<NodeMaterial>()
    let frames = 0
    let next = 0
    while (next < units.length) {
      await nextFrame()
      throwIfAborted(signal)
      frames++
      if (waiter === null || this.budgetMillisecondsPerFrame === Infinity) {
        const perFrame = this.budgetMillisecondsPerFrame === Infinity ? Infinity : Math.max(1, Math.floor(this.untimedUnitsPerFrame))
        const count = Math.min(units.length - next, perFrame)
        this.runUnits(renderer, units.slice(next, next + count))
        next += count
        continue
      }
      // Let the app's own animation-frame callbacks submit this frame first, then wait for the GPU to
      // finish it: otherwise the app's frame would queue ahead of the batch and be timed as part of it.
      await nextTask()
      await this.waitForGpu(waiter, signal)
      const count = pacer.plan(weights, next)
      const batch = units.slice(next, next + count)
      const compiling = batch.some(unit => !compiled.has(unit.material))
      for (const unit of batch) compiled.add(unit.material)
      const before = performance.now()
      this.runUnits(renderer, batch)
      await this.waitForGpu(waiter, signal)
      if (!compiling) {
        pacer.observe(
          batch.reduce((sum, unit) => sum + unit.weight, 0),
          performance.now() - before - latencyMilliseconds,
        )
      }
      next += count
    }
    return frames
  }

  /**
   * Waits for the GPU, giving up when `signal` aborts (a lost device may never answer) or after
   * `maximumGpuWaitMilliseconds` (then carries on as if it had answered).
   */
  protected async waitForGpu(waiter: GpuIdleWaiter, signal?: AbortSignal): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        waiter.wait(),
        new Promise<void>(resolve => (timeout = setTimeout(resolve, this.maximumGpuWaitMilliseconds))),
        new Promise<void>(resolve => {
          onAbort = resolve
          signal?.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timeout)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
    throwIfAborted(signal)
  }

  /** Draws the units without disturbing the app's renderer state. */
  protected runUnits(renderer: Renderer, units: WorkUnit[]): void {
    const previousTarget = renderer.getRenderTarget()
    const previousCubeFace = renderer.getActiveCubeFace()
    const previousMipmapLevel = renderer.getActiveMipmapLevel()
    // Accumulating passes blend onto what the target holds: the renderer must not clear it first.
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    try {
      for (const unit of units) {
        this.quad.material = unit.material
        const slices = typeof unit.slices === 'number' ? Array.from({ length: unit.slices }, (_, slice) => slice) : unit.slices
        for (const slice of slices) {
          this.slice.value = slice
          renderer.setRenderTarget(unit.target, slice)
          this.quad.render(renderer)
        }
      }
    } finally {
      renderer.autoClear = previousAutoClear
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel)
    }
  }

  /** The pass sequence of Bruneton's Model::Precompute, as frame-sized units. */
  protected createUnits(transient: TransientTargets, createMaterial: MaterialFactory): WorkUnit[] {
    const model = this.model
    const transmittance = this.transmittance
    const units: WorkUnit[] = []
    const fragment2D = screenCoordinate
    const texel2D = ivec2(int(screenCoordinate.x), int(screenCoordinate.y))
    const fragment3D = vec3(screenCoordinate, this.slice.add(0.5))
    const texel3D = ivec3(int(screenCoordinate.x), int(screenCoordinate.y), int(this.slice))
    const scatteringCoordinates = () => model.coordinatesFromScatteringFragmentCoordinate(fragment3D)
    const pass = (target: RenderTarget, material: NodeMaterial, costPerTexel: number): void => {
      units.push(...this.passUnits(target, material, costPerTexel))
    }
    const singleTarget = transient.singleScattering
    const [singleRayleigh, singleMie] = singleTarget.textures as [Texture, Texture]

    pass(this.transmittanceTarget, createMaterial(Fn(() => vec4(computeTransmittanceTexel(model, fragment2D), 1))()), PASS_COST.transmittance)
    pass(
      transient.deltaIrradiance,
      createMaterial(Fn(() => vec4(computeDirectIrradianceTexel(model, transmittance, fragment2D), 1))()),
      PASS_COST.copy,
    )
    // Ground irradiance only holds indirect light: the sun's direct light is computed at runtime.
    pass(this.irradianceTarget, createMaterial(vec4(0)), PASS_COST.copy)

    // Single Rayleigh and Mie scattering, integrated once and written to both textures of one target.
    // A multiple-render-target output must be the material's fragment node itself (anything else is
    // converted to one vec4), so the integration returns a struct, held in a variable, read twice.
    const singleCall = Fn(() => {
      const { rayleigh, mie } = computeSingleScattering(model, transmittance, scatteringCoordinates())
      return SingleScatteringStruct(rayleigh, mie)
    })() as unknown as { toVar(name: string): { get(member: 'rayleigh' | 'mie'): Node<'vec3'> } }
    const single = singleCall.toVar('singleScattering')
    const singleScattering = mrt({ [singleRayleigh.name]: vec4(single.get('rayleigh'), 1), [singleMie.name]: vec4(single.get('mie'), 1) })
    pass(singleTarget, createMaterial(singleScattering), PASS_COST.singleScattering)
    // The scattering texture packs them as (Rayleigh, Mie red): copied exactly, texel for texel.
    const combineSingle = Fn(() => vec4(texture3DLoad(singleRayleigh, texel3D, int(0)).rgb, texture3DLoad(singleMie, texel3D, int(0)).r))()
    pass(this.scatteringTarget, createMaterial(combineSingle), PASS_COST.copy)

    // The single-scattering target is reused for the multiple scattering of the previous order once single
    // scattering is no longer needed (after the order 2 density and order 1 irradiance passes): Rayleigh's
    // texture takes it, Mie's is cleared.
    const previous: PreviousOrderTextures = { singleRayleigh, singleMie, multiple: singleRayleigh }
    const irradianceSize = model.parameters.textureSizesTexels.irradiance
    const scatteringSize = model.parameters.getScatteringTextureSizeTexels()
    // 32-bit irradiance is accumulated by ping-pong (sum into a scratch target, copy back), not blending,
    // which many GPUs cannot do on 32-bit floats.
    const sumIrradiance = createMaterial(textureLoad(this.irradiance, texel2D, 0).add(textureLoad(transient.deltaIrradiance.texture, texel2D, 0)))
    const copyIrradiance = createMaterial(textureLoad(transient.irradianceSum.texture, texel2D, 0))
    const accumulateScattering = createMaterial(
      Fn(() => {
        const uvw = fragment3D.div(vec3(scatteringSize.x, scatteringSize.y, scatteringSize.z))
        const multiple = texture3D(singleRayleigh, uvw).level(float(0)).rgb
        // Stored divided by the Rayleigh phase function, which runtime lookups multiply back.
        return vec4(multiple.div(model.rayleighPhaseFunction(scatteringCoordinates().viewSunCosine)), 0)
      })(),
      true,
    )
    const multiple = Fn(() => vec4(computeMultipleScattering(model, transmittance, transient.deltaScatteringDensity.texture, scatteringCoordinates()), 1))()
    const multipleScattering = createMaterial(mrt({ [singleRayleigh.name]: multiple, [singleMie.name]: vec4(0) }))

    // Order 2 reads single scattering; later orders all read the previous multiple scattering, so their
    // shaders are identical and compile once.
    const densityMaterials = new Map<number, NodeMaterial>()
    const indirectIrradianceMaterials = new Map<number, NodeMaterial>()
    const densityMaterial = (order: number): NodeMaterial => {
      const key = Math.min(order, 3)
      let material = densityMaterials.get(key)
      if (material === undefined) {
        const density = Fn(() => {
          const coordinates = scatteringCoordinates()
          const groundIrradiance = transient.deltaIrradiance.texture
          const samples = model.parameters.scatteringDensityAngularSamples
          return vec4(computeScatteringDensity(model, transmittance, previous, groundIrradiance, coordinates, key, samples), 1)
        })()
        material = createMaterial(density)
        densityMaterials.set(key, material)
      }
      return material
    }
    const indirectIrradianceMaterial = (order: number): NodeMaterial => {
      const key = Math.min(order, 2)
      let material = indirectIrradianceMaterials.get(key)
      if (material === undefined) {
        const irradiance = Fn(() => {
          const { radius, sunZenithCosine } = model.radiusAndSunCosineFromIrradianceTextureUv(fragment2D.div(vec2(irradianceSize.x, irradianceSize.y)))
          return vec4(computeIndirectIrradiance(model, previous, radius, sunZenithCosine, key), 1)
        })()
        material = createMaterial(irradiance)
        indirectIrradianceMaterials.set(key, material)
      }
      return material
    }

    const densityCost = PASS_COST.scatteringDensity * (model.parameters.scatteringDensityAngularSamples / 8) ** 2
    for (let order = 2; order <= model.parameters.scatteringOrders; order++) {
      pass(transient.deltaScatteringDensity, densityMaterial(order), densityCost)
      pass(transient.deltaIrradiance, indirectIrradianceMaterial(order - 1), PASS_COST.indirectIrradiance)
      pass(transient.irradianceSum, sumIrradiance, PASS_COST.copy)
      pass(this.irradianceTarget, copyIrradiance, PASS_COST.copy)
      pass(singleTarget, multipleScattering, PASS_COST.multipleScattering)
      pass(this.scatteringTarget, accumulateScattering, PASS_COST.copy)
    }
    return units
  }

  /**
   * Units drawing a full-screen pass into a 2D target, or into the slices of a 3D one: one unit per slice
   * for costly passes, one for all slices of a cheap one (a copy), so that cheap passes never cost a frame
   * per slice.
   */
  protected passUnits(target: RenderTarget, material: NodeMaterial, costPerTexel: number): WorkUnit[] {
    const depth = target instanceof RenderTarget3D ? target.depth : 1
    const weight = costPerTexel * target.width * target.height
    if (costPerTexel <= PASS_COST.copy) return [{ target, material, slices: depth, weight: weight * depth }]
    return Array.from({ length: depth }, (_, slice) => ({ target, material, slices: [slice], weight }))
  }

  /**
   * Units copying cached texture data into the lookup textures, or null if the data does not match their
   * sizes or storage type. The data textures are added to `disposables`.
   */
  protected createUploadUnits(
    data: AtmosphereTextureData,
    scatteringType: TextureDataType,
    createMaterial: MaterialFactory,
    disposables: { dispose(): void }[],
  ): WorkUnit[] | null {
    const transmittanceTarget = this.transmittanceTarget
    const irradianceTarget = this.irradianceTarget
    const scatteringTarget = this.scatteringTarget
    const texels = (target: RenderTarget, depth = 1) => target.width * target.height * depth * 4
    const halfFloat = scatteringType === HalfFloatType
    const valid =
      data.scatteringHalfFloat === halfFloat &&
      data.scattering instanceof (halfFloat ? Uint16Array : Float32Array) &&
      data.transmittance instanceof Float32Array &&
      data.irradiance instanceof Float32Array &&
      data.transmittance.length === texels(transmittanceTarget) &&
      data.irradiance.length === texels(irradianceTarget) &&
      data.scattering.length === texels(scatteringTarget, scatteringTarget.depth)
    if (!valid) return null

    const source2D = (array: Float32Array, target: RenderTarget): DataTexture => {
      const result = new DataTexture(array, target.width, target.height, RGBAFormat, FloatType)
      configureTexture(result, 'atmosphereCachedTexture', NearestFilter)
      result.needsUpdate = true
      disposables.push(result)
      return result
    }
    const scatteringSource = new Data3DTexture(data.scattering, scatteringTarget.width, scatteringTarget.height, scatteringTarget.depth)
    scatteringSource.format = RGBAFormat
    scatteringSource.type = scatteringType
    configureTexture(scatteringSource, 'atmosphereCachedScattering', NearestFilter)
    scatteringSource.needsUpdate = true
    disposables.push(scatteringSource)

    const texel2D = ivec2(int(screenCoordinate.x), int(screenCoordinate.y))
    const texel3D = ivec3(int(screenCoordinate.x), int(screenCoordinate.y), int(this.slice))
    const copy2D = (source: DataTexture) => createMaterial(textureLoad(source, texel2D, 0))
    return [
      ...this.passUnits(transmittanceTarget, copy2D(source2D(data.transmittance, transmittanceTarget)), PASS_COST.copy),
      ...this.passUnits(irradianceTarget, copy2D(source2D(data.irradiance, irradianceTarget)), PASS_COST.copy),
      ...this.passUnits(scatteringTarget, createMaterial(texture3DLoad(scatteringSource, texel3D, int(0))), PASS_COST.copy),
    ]
  }

  /** Reads the lookup textures back from the GPU. They must be generated. */
  async readBack(renderer: Renderer): Promise<AtmosphereTextureData> {
    const read = async (target: RenderTarget, slice = 0) =>
      (await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, 0, slice)) as Float32Array | Uint16Array
    const transmittance = await read(this.transmittanceTarget)
    const irradiance = await read(this.irradianceTarget)
    const target = this.scatteringTarget
    const sliceLength = target.width * target.height * 4
    const halfFloat = target.texture.type === HalfFloatType
    const scattering = halfFloat ? new Uint16Array(sliceLength * target.depth) : new Float32Array(sliceLength * target.depth)
    for (let slice = 0; slice < target.depth; slice++) {
      const data = await read(target, slice)
      if (data.length !== sliceLength) throw new Error(`Atmosphere: read ${data.length} values from a scattering slice, expected ${sliceLength}.`)
      scattering.set(data, slice * sliceLength)
    }
    if (!(transmittance instanceof Float32Array) || !(irradiance instanceof Float32Array) || !(scattering instanceof (halfFloat ? Uint16Array : Float32Array))) {
      throw new Error('Atmosphere: lookup textures read back with unexpected types.')
    }
    return { transmittance, irradiance, scattering, scatteringHalfFloat: halfFloat }
  }

  /**
   * Reads the generated textures back and stores them, unless `signal` aborts. Failures (a backend that
   * cannot read half floats back, a full quota) only skip caching, and so does data that cannot be right
   * (see `isPlausible`): a bad readback must never be served on every later visit.
   */
  protected async store(renderer: Renderer, cache: AtmosphereTextureCache, key: string, signal?: AbortSignal): Promise<void> {
    try {
      const data = await this.readBack(renderer)
      if (signal?.aborted === true) return
      if (!isPlausible(data)) {
        console.warn('Atmosphere: the lookup textures read back wrong; not caching them.')
        return
      }
      await cache.write(key, data)
    } catch (error) {
      if (signal?.aborted !== true) console.warn('Atmosphere: could not cache the lookup textures.', error)
    }
  }

  dispose(): void {
    this.transmittanceTarget.dispose()
    this.scatteringTarget.dispose()
    this.irradianceTarget.dispose()
    this.quad.geometry.dispose()
    ;(this.quad.material as NodeMaterial).dispose()
  }
}

/**
 * Whether read-back textures can be right: every value finite, transmittance within [0, 1] and reaching
 * 1 somewhere (rays that leave the atmosphere at once), irradiance and scattering not negative, and
 * scattering not all zero.
 */
export function isPlausible(data: AtmosphereTextureData): boolean {
  let transmittanceMaximum = 0
  for (const value of data.transmittance) {
    if (!(value >= 0 && value <= 1.001)) return false
    if (value > transmittanceMaximum) transmittanceMaximum = value
  }
  if (transmittanceMaximum < 0.999) return false
  for (const value of data.irradiance) if (!(value >= 0) || !Number.isFinite(value)) return false
  // A failed readback (WebGL 2 does not guarantee half-float reads) leaves zeros: a sky must have light.
  let scatteringNonZero = false
  if (data.scatteringHalfFloat) {
    // Half floats: exponent bits all set is infinity or NaN; the sign bit is negative (or -0).
    for (const word of data.scattering) {
      if ((word & 0x7c00) === 0x7c00 || (word & 0x8000) !== 0) return false
      if (word !== 0) scatteringNonZero = true
    }
  } else {
    for (const value of data.scattering) {
      if (!(value >= 0) || !Number.isFinite(value)) return false
      if (value > 0) scatteringNonZero = true
    }
  }
  return scatteringNonZero
}

/** Intermediate textures, released once the lookup textures are generated. */
class TransientTargets {
  readonly deltaIrradiance: RenderTarget
  readonly irradianceSum: RenderTarget
  /** Single Rayleigh and Mie scattering; later, multiple scattering of the previous order (Rayleigh's texture). */
  readonly singleScattering: RenderTarget3D
  readonly deltaScatteringDensity: RenderTarget3D

  constructor(model: AtmosphereModel, scatteringType: TextureDataType, hardwareFiltering: boolean) {
    const irradianceSize = model.parameters.textureSizesTexels.irradiance
    const { x, y, z } = model.parameters.getScatteringTextureSizeTexels()
    this.deltaIrradiance = createPreciseTarget('atmosphereDeltaIrradiance', irradianceSize.x, irradianceSize.y, hardwareFiltering)
    this.irradianceSum = createPreciseTarget('atmosphereIrradianceSum', irradianceSize.x, irradianceSize.y, hardwareFiltering)
    this.singleScattering = createScatteringTarget(['atmosphereDeltaRayleigh', 'atmosphereDeltaMie'], x, y, z, scatteringType)
    this.deltaScatteringDensity = createScatteringTarget(['atmosphereDeltaScatteringDensity'], x, y, z, scatteringType)
  }

  dispose(): void {
    for (const target of [this.deltaIrradiance, this.irradianceSum, this.singleScattering, this.deltaScatteringDensity]) target.dispose()
  }
}
