// Precomputation sequence after Eric Bruneton's "Precomputed Atmospheric Scattering: a New Implementation"
// (2017), atmosphere/model.cc (Model::Precompute), BSD 3-Clause; the full notice is in AtmosphereModel.ts.
// Render-target handling (slice-by-slice 3D rendering) after takram three-geospatial (MIT, (c) 2024 Shota
// Matsuda), @takram/three-atmosphere src/webgpu/AtmosphereLUTTexturesWebGL.ts.

import {
  AddEquation,
  CustomBlending,
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
import { float, Fn, int, ivec2, screenCoordinate, texture3D, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { NodeMaterial, QuadMesh, type Node, type Renderer } from 'three/webgpu'

import type { AtmosphereModel, AtmosphereTextureSet } from './AtmosphereModel.js'
import {
  computeDirectIrradianceTexel,
  computeIndirectIrradiance,
  computeMultipleScattering,
  computeScatteringDensity,
  computeSingleScattering,
  computeTransmittanceTexel,
  type PreviousOrderTextures,
} from './precompute.js'

/** 3D textures are rendered this many slices per frame, so generation never stalls a frame for long. */
const SLICES_PER_STEP = 8

/**
 * Transmittance and irradiance: always 32-bit floats, read with texel loads (see
 * `AtmosphereModel.sampleBilinear`), never blended. Bruneton: 16-bit "gives artifacts" there.
 */
function createPreciseTarget(name: string, width: number, height: number): RenderTarget {
  const target = new RenderTarget(width, height, { depthBuffer: false, format: RGBAFormat, type: FloatType })
  configureTexture(target.texture, name, NearestFilter)
  return target
}

/** Scattering: filtered by the GPU, 32-bit or half floats (see `selectScatteringType`). */
function createScatteringTarget(name: string, width: number, height: number, depth: number): RenderTarget3D {
  const target = new RenderTarget3D(width, height, depth, { depthBuffer: false, format: RGBAFormat, type: HalfFloatType })
  configureTexture(target.texture, name, LinearFilter)
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

type MaterialFactory = (fragment: Node, additive?: boolean) => NodeMaterial
type Step = (renderer: Renderer) => void

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

  /** Wall time of the last generation, from the first pass to the GPU finishing, in milliseconds. */
  generationTimeMilliseconds: number | null = null

  protected readonly quad = new QuadMesh(new NodeMaterial())
  protected readonly slice = uniform(0)

  constructor(model: AtmosphereModel) {
    this.model = model
    const sizes = model.parameters.textureSizesTexels
    const scatteringSize = model.parameters.getScatteringTextureSizeTexels()
    this.transmittanceTarget = createPreciseTarget('atmosphereTransmittance', sizes.transmittance.x, sizes.transmittance.y)
    this.scatteringTarget = createScatteringTarget('atmosphereScattering', scatteringSize.x, scatteringSize.y, scatteringSize.z)
    this.irradianceTarget = createPreciseTarget('atmosphereIrradiance', sizes.irradiance.x, sizes.irradiance.y)
    this.quad.name = 'AtmosphereTextures'
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
   * Renders every lookup texture, a few passes per animation frame so the app keeps drawing. The renderer
   * must be initialised. Resolves once the GPU has finished, with the time taken in milliseconds, or with
   * null if `signal` aborted first (nothing is rendered after that). Temporary resources are released in
   * every case.
   */
  async generate(renderer: Renderer, signal?: AbortSignal): Promise<number | null> {
    const start = performance.now()
    this.scatteringTarget.texture.type = this.selectScatteringType(renderer)
    const transient = new TransientTargets(this.model, this.scatteringTarget.texture.type)
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
    const throwIfAborted = (): void => {
      if (signal?.aborted === true) throw new GenerationAborted()
    }
    try {
      for (const step of this.createSteps(transient, createMaterial)) {
        await nextFrame()
        throwIfAborted()
        this.runStep(renderer, step)
      }
      // Reading one texel back waits for every pass to finish on the GPU.
      await renderer.readRenderTargetPixelsAsync(this.irradianceTarget, 0, 0, 1, 1)
      throwIfAborted()
    } catch (error) {
      if (error instanceof GenerationAborted) return null
      throw error
    } finally {
      for (const material of materials) material.dispose()
      transient.dispose()
    }
    this.generationTimeMilliseconds = performance.now() - start
    return this.generationTimeMilliseconds
  }

  /** Runs one step without disturbing the app's renderer state. */
  protected runStep(renderer: Renderer, step: Step): void {
    const previousTarget = renderer.getRenderTarget()
    const previousCubeFace = renderer.getActiveCubeFace()
    const previousMipmapLevel = renderer.getActiveMipmapLevel()
    // Accumulating passes blend onto what the target holds: the renderer must not clear it first.
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    try {
      step(renderer)
    } finally {
      renderer.autoClear = previousAutoClear
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel)
    }
  }

  /** The pass sequence of Bruneton's Model::Precompute, one output per pass, cut into frame-sized steps. */
  protected createSteps(transient: TransientTargets, createMaterial: MaterialFactory): Step[] {
    const model = this.model
    const transmittance = this.transmittance
    const steps: Step[] = []
    const fragment2D = screenCoordinate
    const texel2D = ivec2(int(screenCoordinate.x), int(screenCoordinate.y))
    const fragment3D = vec3(screenCoordinate, this.slice.add(0.5))
    const scatteringCoordinates = () => model.coordinatesFromScatteringFragmentCoordinate(fragment3D)
    const pass = (target: RenderTarget, material: NodeMaterial): void => {
      steps.push(...this.passSteps(target, material))
    }

    pass(this.transmittanceTarget, createMaterial(Fn(() => vec4(computeTransmittanceTexel(model, fragment2D), 1))()))
    pass(transient.deltaIrradiance, createMaterial(Fn(() => vec4(computeDirectIrradianceTexel(model, transmittance, fragment2D), 1))()))
    // Ground irradiance only holds indirect light: the sun's direct light is computed at runtime.
    pass(this.irradianceTarget, createMaterial(vec4(0)))

    const single = () => computeSingleScattering(model, transmittance, scatteringCoordinates())
    pass(transient.deltaRayleigh, createMaterial(Fn(() => vec4(single().rayleigh, 1))()))
    pass(transient.deltaMie, createMaterial(Fn(() => vec4(single().mie, 1))()))
    const combinedSingle = Fn(() => {
      const { rayleigh, mie } = single()
      return vec4(rayleigh, mie.r)
    })()
    pass(this.scatteringTarget, createMaterial(combinedSingle))

    // deltaRayleigh is reused for the multiple scattering of the previous order once single Rayleigh
    // scattering is no longer needed (after the order 2 density and order 1 irradiance passes).
    const previous: PreviousOrderTextures = {
      singleRayleigh: transient.deltaRayleigh.texture,
      singleMie: transient.deltaMie.texture,
      multiple: transient.deltaRayleigh.texture,
    }
    const irradianceSize = model.parameters.textureSizesTexels.irradiance
    const scatteringSize = model.parameters.getScatteringTextureSizeTexels()
    // 32-bit irradiance is accumulated by ping-pong (sum into a scratch target, copy back), not blending,
    // which many GPUs cannot do on 32-bit floats.
    const sumIrradiance = createMaterial(textureLoad(this.irradiance, texel2D, 0).add(textureLoad(transient.deltaIrradiance.texture, texel2D, 0)))
    const copyIrradiance = createMaterial(textureLoad(transient.irradianceSum.texture, texel2D, 0))
    const accumulateScattering = createMaterial(
      Fn(() => {
        const uvw = fragment3D.div(vec3(scatteringSize.x, scatteringSize.y, scatteringSize.z))
        const multiple = texture3D(transient.deltaRayleigh.texture, uvw).level(float(0)).rgb
        // Stored divided by the Rayleigh phase function, which runtime lookups multiply back.
        return vec4(multiple.div(model.rayleighPhaseFunction(scatteringCoordinates().viewSunCosine)), 0)
      })(),
      true,
    )
    const multipleScattering = createMaterial(
      Fn(() => vec4(computeMultipleScattering(model, transmittance, transient.deltaScatteringDensity.texture, scatteringCoordinates()), 1))(),
    )

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

    for (let order = 2; order <= model.parameters.scatteringOrders; order++) {
      pass(transient.deltaScatteringDensity, densityMaterial(order))
      pass(transient.deltaIrradiance, indirectIrradianceMaterial(order - 1))
      pass(transient.irradianceSum, sumIrradiance)
      pass(this.irradianceTarget, copyIrradiance)
      pass(transient.deltaRayleigh, multipleScattering)
      pass(this.scatteringTarget, accumulateScattering)
    }
    return steps
  }

  /** Steps drawing a full-screen pass into a 2D target, or into the slices of a 3D one, a few per step. */
  protected passSteps(target: RenderTarget, material: NodeMaterial): Step[] {
    const depth = target instanceof RenderTarget3D ? target.depth : 1
    const steps: Step[] = []
    for (let first = 0; first < depth; first += SLICES_PER_STEP) {
      steps.push(renderer => {
        this.quad.material = material
        for (let slice = first; slice < Math.min(first + SLICES_PER_STEP, depth); slice++) {
          this.slice.value = slice
          renderer.setRenderTarget(target, slice)
          this.quad.render(renderer)
        }
      })
    }
    return steps
  }

  dispose(): void {
    this.transmittanceTarget.dispose()
    this.scatteringTarget.dispose()
    this.irradianceTarget.dispose()
    this.quad.geometry.dispose()
    ;(this.quad.material as NodeMaterial).dispose()
  }
}

/** Intermediate textures, released once the lookup textures are generated. */
class TransientTargets {
  readonly deltaIrradiance: RenderTarget
  readonly irradianceSum: RenderTarget
  readonly deltaRayleigh: RenderTarget3D
  readonly deltaMie: RenderTarget3D
  readonly deltaScatteringDensity: RenderTarget3D

  constructor(model: AtmosphereModel, scatteringType: TextureDataType) {
    const irradianceSize = model.parameters.textureSizesTexels.irradiance
    const { x, y, z } = model.parameters.getScatteringTextureSizeTexels()
    this.deltaIrradiance = createPreciseTarget('atmosphereDeltaIrradiance', irradianceSize.x, irradianceSize.y)
    this.irradianceSum = createPreciseTarget('atmosphereIrradianceSum', irradianceSize.x, irradianceSize.y)
    this.deltaRayleigh = createScatteringTarget('atmosphereDeltaRayleigh', x, y, z)
    this.deltaMie = createScatteringTarget('atmosphereDeltaMie', x, y, z)
    this.deltaScatteringDensity = createScatteringTarget('atmosphereDeltaScatteringDensity', x, y, z)
    for (const target of [this.deltaRayleigh, this.deltaMie, this.deltaScatteringDensity]) target.texture.type = scatteringType
  }

  dispose(): void {
    for (const target of [this.deltaIrradiance, this.irradianceSum, this.deltaRayleigh, this.deltaMie, this.deltaScatteringDensity]) target.dispose()
  }
}
