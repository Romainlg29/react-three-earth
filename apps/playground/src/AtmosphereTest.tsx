import { Atmosphere, AtmosphereParameters } from '@earthkit/globe'
import { useEffect } from 'react'
import { DataUtils, HalfFloatType, PerspectiveCamera, Scene, type Texture } from 'three'
import { WebGPURenderer, type RenderTarget } from 'three/webgpu'

/** Per-channel sums, non-finite count and a few texels of one lookup texture: compared across versions. */
interface TextureFingerprint {
  sums: number[]
  nonFinite: number
  samples: number[][]
}

export interface AtmosphereTestResult {
  backend: string
  /** Wall time of the generation (or cache load), as the library reports it. */
  generationTimeMilliseconds: number | null
  /** Whether the textures came from the persistent cache. */
  fromCache: boolean
  generationFrames: number | null
  /** Frame intervals during generation, in milliseconds. */
  frameIntervalsMilliseconds: number[]
  /** Frame intervals before generation started, for the baseline. */
  idleFrameIntervalsMilliseconds: number[]
  textures: Record<'transmittance' | 'irradiance' | 'scattering', TextureFingerprint>
}

declare global {
  interface Window {
    atmosphereTest?: AtmosphereTestResult | { error: string }
  }
}

function toFloats(data: ArrayBufferView, texture: Texture): Float32Array {
  if (texture.type !== HalfFloatType) return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
  const halves = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const floats = new Float32Array(halves.length)
  for (let index = 0; index < halves.length; index++) floats[index] = DataUtils.fromHalfFloat(halves[index]!)
  return floats
}

async function fingerprint(renderer: WebGPURenderer, texture: Texture): Promise<TextureFingerprint> {
  const target = (texture as Texture & { renderTarget: RenderTarget & { depth?: number } }).renderTarget
  const { width, height } = target
  const depth = target.depth ?? 1
  const sums = [0, 0, 0, 0]
  let nonFinite = 0
  const samples: number[][] = []
  for (let slice = 0; slice < depth; slice++) {
    const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, 0, slice)
    const floats = toFloats(data as ArrayBufferView, texture)
    for (let index = 0; index < width * height * 4; index++) {
      const value = floats[index]!
      if (!Number.isFinite(value)) nonFinite++
      else sums[index % 4]! += value
    }
    if (slice === 0 || slice === depth >> 1 || slice === depth - 1) {
      for (const [x, y] of [[0, 0], [width >> 1, height >> 1], [width - 1, height - 1], [width >> 2, (height * 3) >> 2]] as const) {
        const offset = (y * width + x) * 4
        samples.push([slice, x, y, ...Array.from(floats.subarray(offset, offset + 4))])
      }
    }
  }
  return { sums, nonFinite, samples }
}

async function run(): Promise<AtmosphereTestResult> {
  const params = new URLSearchParams(location.search)
  const renderer = new WebGPURenderer({ forceWebGL: params.has('webgl'), reversedDepthBuffer: true })
  await renderer.init()
  renderer.setSize(320, 240)
  document.body.appendChild(renderer.domElement)
  const scene = new Scene()
  const camera = new PerspectiveCamera()

  const intervals: number[] = []
  let last = performance.now()
  renderer.setAnimationLoop(time => {
    intervals.push(time - last)
    last = time
    renderer.render(scene, camera)
  })
  // Idle frames first, for the baseline frame interval.
  while (intervals.length < 30) await new Promise(resolve => requestAnimationFrame(resolve))
  const idle = intervals.splice(0)

  const atmosphere = new Atmosphere({ parameters: new AtmosphereParameters(), cache: params.has('cache') })
  atmosphere.install(renderer)
  const ready = await atmosphere.ready
  const during = intervals.splice(0)
  renderer.setAnimationLoop(null)
  if (ready !== true) throw new Error('generation failed')

  const textures = atmosphere.context.textures
  return {
    backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'webgpu' : 'webgl2',
    generationTimeMilliseconds: atmosphere.generationTimeMilliseconds,
    fromCache: atmosphere.loadedFromCache,
    generationFrames: atmosphere.generationFrames,
    frameIntervalsMilliseconds: during,
    idleFrameIntervalsMilliseconds: idle,
    textures: {
      transmittance: await fingerprint(renderer, textures.transmittance),
      irradiance: await fingerprint(renderer, textures.irradiance),
      scattering: await fingerprint(renderer, textures.scattering),
    },
  }
}

/** Generates the atmosphere's lookup textures alone and publishes their fingerprints on `window.atmosphereTest`. */
export function AtmosphereTest() {
  useEffect(() => {
    run().then(
      result => (window.atmosphereTest = result),
      error => (window.atmosphereTest = { error: String(error) }),
    )
  }, [])
  return null
}
