import { Vector2, Vector3 } from 'three'
import { Fn, instancedArray, instanceIndex, vec4 } from 'three/tsl'
import type { ComputeNode, Node, StorageBufferNode, WebGPURenderer } from 'three/webgpu'

import type { WaveMesh } from './WaveMesh.js'
import { earthCenteredFromGeographic, eastNorthAt, type WaveSurface } from './WaveSurface.js'

/** Probes a `WaveProbe` holds unless told otherwise. */
export const WAVE_PROBE_CAPACITY = 16
/**
 * Rounds of the fixed point that finds which point of the plane the choppy waves moved over the probe: each divides the
 * error by about the waves' steepness, so three leave well under a millimetre on any sea that does not fold over.
 */
export const WAVE_PROBE_ITERATIONS = 3

/** A point on the sea to sample: WGS84 degrees. */
export interface WaveProbePoint {
  longitudeDegrees: number
  latitudeDegrees: number
}

/** The sea's surface over a probe's point, as the wave mesh draws it. */
export interface WaveProbeSample {
  /** The surface's height above the WGS84 ellipsoid, metres: sea level plus the wave. */
  heightMeters: number
  /** The wave's height above sea level, metres. */
  waveHeightMeters: number
  /** The surface's normal in the point's own east-north-up frame (x east, y north, z up), as a `GeographicAnchor`'s. */
  normal: Vector3
  /** Whether the sample comes from the waves: false until the first reading after `setPoints` lands. */
  ready: boolean
}

export interface WaveProbeOptions {
  /** How many points it can sample at once. Default: `WAVE_PROBE_CAPACITY`. */
  capacity?: number
}

/**
 * Samples the sea's surface at a few points, to float a boat on the waves: a compute pass reads the GPU's wave textures
 * exactly as the wave mesh does (the same ring, spacing and fades), so what it returns is what is drawn. The choppy waves
 * move the surface sideways too, so it first finds, by a fixed point, which point of the plane the waves moved over the
 * probe, then reads the height and slopes there.
 *
 * The readings come back asynchronously, one or two frames late (at most one is in flight); read `samples` each frame.
 * Without the GPU path (WebGL2) or while the mesh is hidden, the sea is drawn flat and the samples say so (sea level,
 * normal straight up) without a dispatch.
 *
 * Create it with `water.createProbe()`, which updates it every frame; `dispose` stops it.
 */
export class WaveProbe {
  readonly capacity: number
  /** One per point given to `setPoints`, in its order. */
  readonly samples: WaveProbeSample[] = []
  protected readonly surface: WaveSurface
  protected readonly mesh: WaveMesh
  protected readonly points: WaveProbePoint[] = []
  /** Per point, its east, north and up in ECEF. */
  protected readonly frames: Array<{ east: Vector3; north: Vector3; up: Vector3 }> = []
  protected readonly earthCentered: Vector3[] = []
  /** Per probe: its point on the wave plane, metres east and north of the anchor. */
  protected readonly targets: StorageBufferNode<'vec2'>
  /** Per probe: wave height, slope east, slope north, then 1 once written. */
  protected readonly readings: StorageBufferNode<'vec4'>
  protected readonly kernel: ComputeNode
  protected pending = false
  /** Bumped by `setPoints` and `dispose`: a reading started before is dropped. */
  protected pointsVersion = 0
  protected disposed = false
  protected readonly onDispose: (probe: WaveProbe) => void

  constructor(surface: WaveSurface, mesh: WaveMesh, { capacity = WAVE_PROBE_CAPACITY }: WaveProbeOptions = {}, onDispose: (probe: WaveProbe) => void = () => {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error(`WaveProbe: capacity must be a whole number from 1 to 4096, got ${capacity}.`)
    this.surface = surface
    this.mesh = mesh
    this.capacity = capacity
    this.onDispose = onDispose
    this.targets = instancedArray(capacity, 'vec2')
    this.readings = instancedArray(capacity, 'vec4')
    this.kernel = Fn(() => {
      const target = this.targets.element(instanceIndex).toVar() as unknown as Node<'vec2'>
      // x0 + D(x0) = target: the plane's point the waves moved over the probe.
      let origin: Node<'vec2'> = target
      for (let round = 0; round < WAVE_PROBE_ITERATIONS; round++) {
        origin = target.sub(mesh.sampleSurface(origin).displacement.xy).toVar() as unknown as Node<'vec2'>
      }
      const { displacement, slope } = mesh.sampleSurface(origin)
      this.readings.element(instanceIndex).assign(vec4(displacement.z, slope.x, slope.y, 1))
    })().compute(capacity)
  }

  /** The points to sample, at most `capacity`. Their samples start flat (`ready` false) until the next reading lands. */
  setPoints(points: ReadonlyArray<WaveProbePoint>): void {
    if (this.disposed) throw new Error('WaveProbe: it was disposed; create another with `water.createProbe()`.')
    if (points.length > this.capacity) throw new Error(`WaveProbe: ${points.length} points given, but it holds ${this.capacity}; create it with a larger \`capacity\`.`)
    this.points.length = 0
    this.samples.length = 0
    this.frames.length = 0
    this.earthCentered.length = 0
    for (const { longitudeDegrees, latitudeDegrees } of points) {
      if (!Number.isFinite(longitudeDegrees) || !Number.isFinite(latitudeDegrees)) throw new Error(`WaveProbe: points need finite longitudeDegrees and latitudeDegrees, got ${longitudeDegrees}, ${latitudeDegrees}.`)
      this.points.push({ longitudeDegrees, latitudeDegrees })
      const position = earthCenteredFromGeographic(longitudeDegrees, latitudeDegrees, 0, new Vector3())
      this.earthCentered.push(position)
      this.frames.push(eastNorthAt(position))
      this.samples.push({ heightMeters: this.surface.seaLevelMeters, waveHeightMeters: 0, normal: new Vector3(0, 0, 1), ready: false })
    }
    this.pointsVersion++
  }

  /** Dispatches a reading and starts reading it back, unless one is still in flight. `Water` calls it every frame. */
  update(renderer: WebGPURenderer | undefined): void {
    if (this.disposed || this.points.length === 0) return
    const plane = scratchPlane
    if (renderer === undefined || this.surface.compute === null || this.mesh.active.value === 0 || this.surface.planePosition(this.earthCentered[0]!, plane) === null) {
      // Nothing displaces the sea: it is drawn flat.
      for (const sample of this.samples) setFlat(sample, this.surface.seaLevelMeters)
      return
    }
    if (this.pending) return
    const targets = this.targets.value.array as Float32Array
    this.earthCentered.forEach((position, index) => {
      this.surface.planePosition(position, plane)
      targets[index * 2] = plane.x
      targets[index * 2 + 1] = plane.y
    })
    this.targets.value.needsUpdate = true
    void renderer.compute(this.kernel)
    this.pending = true
    const version = this.pointsVersion
    renderer
      .getArrayBufferAsync(this.readings.value)
      .then(buffer => {
        if (version === this.pointsVersion) this.read(new Float32Array(buffer))
      })
      .catch(() => {
        // A lost device or a disposed buffer: the next frame tries again.
      })
      .finally(() => {
        this.pending = false
      })
  }

  /** Turns the GPU's readings (wave height and slopes in the plane's frame) into samples at each point. */
  protected read(readings: Float32Array): void {
    const seaLevel = this.surface.seaLevelMeters
    this.samples.forEach((sample, index) => {
      if (readings[index * 4 + 3] !== 1) return
      const height = readings[index * 4]!
      const normal = scratchNormal.set(-readings[index * 4 + 1]!, -readings[index * 4 + 2]!, 1).normalize()
      // From the plane's frame (at the anchor) to the point's own: a turn of at most a few tenths of a degree.
      this.surface.planeDirectionToEarth(normal)
      const { east, north, up } = this.frames[index]!
      sample.normal.set(normal.dot(east), normal.dot(north), normal.dot(up)).normalize()
      sample.waveHeightMeters = height
      sample.heightMeters = seaLevel + height
      sample.ready = true
    })
  }

  /** Stops sampling and frees the GPU buffers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pointsVersion++
    this.kernel.dispose()
    this.targets.value.dispose()
    this.readings.value.dispose()
    this.onDispose(this)
  }
}

function setFlat(sample: WaveProbeSample, seaLevelMeters: number): void {
  sample.heightMeters = seaLevelMeters
  sample.waveHeightMeters = 0
  sample.normal.set(0, 0, 1)
  sample.ready = true
}

const scratchPlane = new Vector2()
const scratchNormal = new Vector3()
