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
  NoColorSpace,
  OneFactor,
  RenderTarget,
  RenderTarget3D,
  RGBAFormat,
  type Texture,
  type TextureDataType,
} from 'three'
import { float, Fn, screenCoordinate, texture, texture3D, uniform, vec2, vec3, vec4 } from 'three/tsl'
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

/** Zenith directions sampled when integrating the scattering density (twice as many azimuths). */
const SCATTERING_DENSITY_ANGULAR_SAMPLES = 8

function configureTexture(target: RenderTarget, name: string): void {
  const result = target.texture
  result.name = name
  result.minFilter = LinearFilter
  result.magFilter = LinearFilter
  result.colorSpace = NoColorSpace
  result.generateMipmaps = false
}

function createRenderTarget(name: string, width: number, height: number): RenderTarget {
  const target = new RenderTarget(width, height, { depthBuffer: false, format: RGBAFormat })
  configureTexture(target, name)
  return target
}

function createRenderTarget3D(name: string, width: number, height: number, depth: number): RenderTarget3D {
  const target = new RenderTarget3D(width, height, depth, { depthBuffer: false, format: RGBAFormat })
  configureTexture(target, name)
  return target
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
    const sizes = model.parameters.textureSizes
    const scatteringSize = model.parameters.scatteringTextureSize
    this.transmittanceTarget = createRenderTarget('atmosphereTransmittance', sizes.transmittance.x, sizes.transmittance.y)
    this.scatteringTarget = createRenderTarget3D('atmosphereScattering', scatteringSize.x, scatteringSize.y, scatteringSize.z)
    this.irradianceTarget = createRenderTarget('atmosphereIrradiance', sizes.irradiance.x, sizes.irradiance.y)
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
   * 32-bit floats where the GPU can both filter and blend them (orders accumulate by additive blending),
   * half floats otherwise, which are enough for display.
   */
  protected selectTextureType(renderer: Renderer): TextureDataType {
    return renderer.hasFeature('float32-filterable') && renderer.hasFeature('float32-blendable') ? FloatType : HalfFloatType
  }

  /**
   * Renders every lookup texture. The renderer must be initialised. Resolves once the GPU has finished,
   * with the time taken in milliseconds.
   */
  async generate(renderer: Renderer): Promise<number> {
    const start = performance.now()
    const type = this.selectTextureType(renderer)
    const transient = new TransientTargets(this.model, type)
    for (const target of [this.transmittanceTarget, this.scatteringTarget, this.irradianceTarget]) target.texture.type = type

    const previousTarget = renderer.getRenderTarget()
    const previousCubeFace = renderer.getActiveCubeFace()
    const previousMipmapLevel = renderer.getActiveMipmapLevel()
    const materials: NodeMaterial[] = []
    const createMaterial = (fragment: Node, additive = false): NodeMaterial => {
      const material = new NodeMaterial()
      material.name = 'AtmosphereTexturesPass'
      material.fragmentNode = fragment
      material.depthTest = false
      material.depthWrite = false
      materials.push(material)
      return additive ? makeAdditive(material) : material
    }
    // Accumulating passes blend onto what the target holds: the renderer must not clear it first.
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    try {
      this.renderPasses(renderer, transient, createMaterial)
    } finally {
      renderer.autoClear = previousAutoClear
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel)
    }
    // Reading one texel back waits for every pass to finish on the GPU.
    await renderer.readRenderTargetPixelsAsync(this.irradianceTarget, 0, 0, 1, 1)
    for (const material of materials) material.dispose()
    transient.dispose()
    this.generationTimeMilliseconds = performance.now() - start
    return this.generationTimeMilliseconds
  }

  /** The pass sequence of Bruneton's Model::Precompute, with one output per pass. */
  protected renderPasses(renderer: Renderer, transient: TransientTargets, createMaterial: (fragment: Node, additive?: boolean) => NodeMaterial): void {
    const model = this.model
    const transmittance = this.transmittance
    const fragment2D = screenCoordinate
    const fragment3D = vec3(screenCoordinate, this.slice.add(0.5))
    const scatteringCoordinates = () => model.coordinatesFromScatteringFragmentCoordinate(fragment3D)

    this.render(renderer, this.transmittanceTarget, createMaterial(Fn(() => vec4(computeTransmittanceTexel(model, fragment2D), 1))()))
    this.render(renderer, transient.deltaIrradiance, createMaterial(Fn(() => vec4(computeDirectIrradianceTexel(model, transmittance, fragment2D), 1))()))
    // Ground irradiance only holds indirect light: the sun's direct light is computed at runtime.
    this.render(renderer, this.irradianceTarget, createMaterial(vec4(0)))

    const single = () => computeSingleScattering(model, transmittance, scatteringCoordinates())
    this.render(renderer, transient.deltaRayleigh, createMaterial(Fn(() => vec4(single().rayleigh, 1))()))
    this.render(renderer, transient.deltaMie, createMaterial(Fn(() => vec4(single().mie, 1))()))
    this.render(
      renderer,
      this.scatteringTarget,
      createMaterial(
        Fn(() => {
          const { rayleigh, mie } = single()
          return vec4(rayleigh, mie.r)
        })(),
      ),
    )

    // deltaRayleigh is reused for the multiple scattering of the previous order once single Rayleigh
    // scattering is no longer needed (after the order 2 density and order 1 irradiance passes).
    const previous: PreviousOrderTextures = {
      singleRayleigh: transient.deltaRayleigh.texture,
      singleMie: transient.deltaMie.texture,
      multiple: transient.deltaRayleigh.texture,
    }
    const irradianceSize = model.parameters.textureSizes.irradiance
    const scatteringSize = model.parameters.scatteringTextureSize
    const accumulateIrradiance = createMaterial(texture(transient.deltaIrradiance.texture, fragment2D.div(vec2(irradianceSize.x, irradianceSize.y))), true)
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
          return vec4(computeScatteringDensity(model, transmittance, previous, groundIrradiance, coordinates, key, SCATTERING_DENSITY_ANGULAR_SAMPLES), 1)
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
      this.render(renderer, transient.deltaScatteringDensity, densityMaterial(order))
      this.render(renderer, transient.deltaIrradiance, indirectIrradianceMaterial(order - 1))
      this.render(renderer, this.irradianceTarget, accumulateIrradiance)

      this.render(renderer, transient.deltaRayleigh, multipleScattering)
      this.render(renderer, this.scatteringTarget, accumulateScattering)
    }
  }

  /** Draws a full-screen pass into a 2D target, or into each slice of a 3D one. */
  protected render(renderer: Renderer, target: RenderTarget, material: NodeMaterial): void {
    this.quad.material = material
    const depth = target instanceof RenderTarget3D ? target.depth : 1
    for (let slice = 0; slice < depth; slice++) {
      this.slice.value = slice
      renderer.setRenderTarget(target, slice)
      this.quad.render(renderer)
    }
  }

  dispose(): void {
    this.transmittanceTarget.dispose()
    this.scatteringTarget.dispose()
    this.irradianceTarget.dispose()
    this.quad.geometry.dispose()
  }
}

/** Intermediate textures, released once the lookup textures are generated. */
class TransientTargets {
  readonly deltaIrradiance: RenderTarget
  readonly deltaRayleigh: RenderTarget3D
  readonly deltaMie: RenderTarget3D
  readonly deltaScatteringDensity: RenderTarget3D

  constructor(model: AtmosphereModel, type: TextureDataType) {
    const irradianceSize = model.parameters.textureSizes.irradiance
    const { x, y, z } = model.parameters.scatteringTextureSize
    this.deltaIrradiance = createRenderTarget('atmosphereDeltaIrradiance', irradianceSize.x, irradianceSize.y)
    this.deltaRayleigh = createRenderTarget3D('atmosphereDeltaRayleigh', x, y, z)
    this.deltaMie = createRenderTarget3D('atmosphereDeltaMie', x, y, z)
    this.deltaScatteringDensity = createRenderTarget3D('atmosphereDeltaScatteringDensity', x, y, z)
    for (const target of this.all) target.texture.type = type
  }

  protected get all(): RenderTarget[] {
    return [this.deltaIrradiance, this.deltaRayleigh, this.deltaMie, this.deltaScatteringDensity]
  }

  dispose(): void {
    for (const target of this.all) target.dispose()
  }
}
