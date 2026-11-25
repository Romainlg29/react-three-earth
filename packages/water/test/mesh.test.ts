import { Group, PerspectiveCamera, Vector2, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { Water } from '../src/Water.js'
import type { SeaStateOptions } from '../src/waves/spectrum.js'
import { WaveField } from '../src/waves/WaveField.js'
import { createRings, WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS, WaveMesh } from '../src/waves/WaveMesh.js'
import { WaveProbe } from '../src/waves/WaveProbe.js'
import { earthCenteredFromGeographic, geodeticLatitudeAndHeight, WaveSurface } from '../src/waves/WaveSurface.js'

const openOcean: SeaStateOptions = { windSpeedMetersPerSecond: 10, windDirectionDegrees: 270, fetchKilometers: 300, temperatureCelsius: 15, salinityPartsPerThousand: 35 }
const webgpu = (extra: object = {}) => ({ backend: { isWebGPUBackend: true }, compute: vi.fn(), ...extra }) as unknown as WebGPURenderer

/** A surface laid under a camera `heightMeters` over the sea at longitude 0, latitude 0, on the GPU path. */
function laidSurface(heightMeters: number, renderer: WebGPURenderer = webgpu()): WaveSurface {
  const surface = new WaveSurface()
  surface.setSeaState(openOcean)
  const earth = new Group()
  earth.updateMatrixWorld()
  const camera = new PerspectiveCamera()
  camera.position.set(6378137 + heightMeters, 0, 0)
  camera.updateMatrixWorld()
  surface.update(0.016, camera, earth, renderer)
  return surface
}

const shade = () => ({ color: undefined as never, roughness: undefined as never })

describe('createRings', () => {
  it('lays a full grid inside and rings with a hole around it, overlapping by one cell', () => {
    const resolution = 8
    const levels = 3
    const geometry = createRings(resolution, levels)
    const side = 2 * resolution + 1
    expect(geometry.getAttribute('position').count).toBe(levels * side * side)
    const fullCells = (2 * resolution) ** 2
    const hole = resolution / 2 - 1
    const ringCells = fullCells - (2 * hole) ** 2
    expect(geometry.getIndex()!.count).toBe(6 * (fullCells + (levels - 1) * ringCells))
    // Ring 1's hole edge (in its cells, twice ring 0's) lies one of its cells inside ring 0's edge.
    expect(2 * hole).toBe(resolution - 2)
  })

  it('switches to 32-bit indices past 65535 vertices', () => {
    expect(createRings(48, 8).getIndex()!.array).toBeInstanceOf(Uint32Array)
    expect(createRings(16, 2).getIndex()!.array).toBeInstanceOf(Uint16Array)
  })
})

describe('WaveMesh', () => {
  it('refuses a resolution or level count it cannot lay', () => {
    const surface = new WaveSurface()
    expect(() => new WaveMesh(surface, shade, { resolution: 10 })).toThrow(/multiple of 4/)
    expect(() => new WaveMesh(surface, shade, { resolution: 16 })).toThrow(/at least 24/)
    expect(() => new WaveMesh(surface, shade, { levels: 0 })).toThrow(/levels/)
  })

  it('shows only on the GPU path, low over the sea, with finer cells nearer the water', () => {
    const surface = laidSurface(30)
    const mesh = new WaveMesh(surface, shade)
    mesh.update(true)
    expect(mesh.mesh.visible).toBe(true)
    expect(mesh.active.value).toBe(1)
    const cellSize = (mesh as unknown as { cellSize: { value: number } }).cellSize
    expect(cellSize.value).toBe(1)
    surface.cameraHeightAboveSeaMeters = 2
    mesh.update(true)
    expect(cellSize.value).toBe(1 / 16)
    // Laid on the plane's frame: sea level under the anchor.
    expect(mesh.mesh.matrix.elements[12]).toBeCloseTo(6378137, 3)
    mesh.update(false)
    expect(mesh.mesh.visible).toBe(false)
    expect(mesh.active.value).toBe(0)
    surface.cameraHeightAboveSeaMeters = WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS + 1
    mesh.update(true)
    expect(mesh.mesh.visible).toBe(false)
    const cpu = laidSurface(30, { backend: { isWebGLBackend: true } } as unknown as WebGPURenderer)
    const cpuMesh = new WaveMesh(cpu, shade)
    cpuMesh.update(true)
    expect(cpuMesh.mesh.visible).toBe(false)
  })
})

describe('wave seed and time', () => {
  it('draws another sea for another seed, and the same one back', () => {
    const field = new WaveField({ seed: 1 })
    field.setSeaState(openOcean)
    field.update(5)
    const first = Array.from(field.cascades[1]!.slopes)
    const version = field.seaStateVersion
    field.setSeed(2)
    expect(field.seed).toBe(2)
    expect(field.seaStateVersion).not.toBe(version)
    field.update(5)
    expect(Array.from(field.cascades[1]!.slopes)).not.toEqual(first)
    field.setSeed(1)
    field.update(5)
    expect(Array.from(field.cascades[1]!.slopes)).toEqual(first)
  })

  it('takes a seed and a clock from the water settings', () => {
    const water = new Water({ waveSeed: 42 })
    expect(water.waveSurface.seed).toBe(42)
    expect(water.state.waveSeed).toBe(42)
    expect(() => water.setSettings({ waveSeed: 1.5 })).toThrow(/integer/)
    water.waveSurface.timeSeconds = 120
    expect(water.waveSurface.timeSeconds).toBe(120)
    expect(() => (water.waveSurface.timeSeconds = Number.NaN)).toThrow(/finite/)
  })
})

describe('WaveProbe', () => {
  it('places geographic points on the plane under the camera', () => {
    const point = earthCenteredFromGeographic(0.001, 0.002, 12, new Vector3())
    const { latitude, height } = geodeticLatitudeAndHeight(point)
    expect((latitude * 180) / Math.PI).toBeCloseTo(0.002, 9)
    expect(height).toBeCloseTo(12, 6)
    const surface = laidSurface(30)
    const plane = surface.planePosition(point, new Vector2())!
    // At the equator and the prime meridian, east is +y and north +z.
    expect(plane.x).toBeCloseTo(111.32, 1)
    expect(plane.y).toBeCloseTo(221.15, 0)
    expect(new WaveSurface().planePosition(point, new Vector2())).toBeNull()
  })

  it('reads the GPU back into heights and normals at each point', async () => {
    const readings = new Float32Array(16)
    // Point 0: 1.5 m up, sloping up eastwards. Point 1: not written yet.
    readings.set([1.5, 0.2, 0, 1], 0)
    const renderer = webgpu({ getArrayBufferAsync: vi.fn(async () => readings.buffer) })
    const surface = laidSurface(30, renderer)
    surface.seaLevelMeters = 2
    const mesh = new WaveMesh(surface, shade)
    mesh.update(true)
    const probe = new WaveProbe(surface, mesh, { capacity: 4 })
    probe.setPoints([
      { longitudeDegrees: 0.001, latitudeDegrees: 0 },
      { longitudeDegrees: 0.002, latitudeDegrees: 0 },
    ])
    expect(probe.samples.map(sample => sample.ready)).toEqual([false, false])
    probe.update(renderer)
    // One reading in flight at a time.
    probe.update(renderer)
    expect(renderer.getArrayBufferAsync).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(probe.samples[0]!.ready).toBe(true))
    const [sample, unwritten] = probe.samples
    expect(sample!.waveHeightMeters).toBeCloseTo(1.5, 6)
    expect(sample!.heightMeters).toBeCloseTo(3.5, 6)
    expect(sample!.normal.x).toBeCloseTo(-0.2 / Math.hypot(0.2, 1), 4)
    expect(sample!.normal.z).toBeCloseTo(1 / Math.hypot(0.2, 1), 4)
    expect(unwritten!.ready).toBe(false)
    const targets = (probe as unknown as { targets: { value: { array: Float32Array } } }).targets.value.array
    expect(targets[0]).toBeCloseTo(111.32, 1)
    probe.dispose()
  })

  it('reports a flat sea without the GPU path, and refuses more points than it holds', () => {
    const surface = laidSurface(30, { backend: { isWebGLBackend: true } } as unknown as WebGPURenderer)
    surface.seaLevelMeters = -1
    const water = new Water()
    const probe = new WaveProbe(surface, new WaveMesh(surface, shade), { capacity: 1 })
    expect(() => probe.setPoints([{ longitudeDegrees: 0, latitudeDegrees: 0 }, { longitudeDegrees: 1, latitudeDegrees: 0 }])).toThrow(/capacity/)
    probe.setPoints([{ longitudeDegrees: 0, latitudeDegrees: 0 }])
    probe.update(undefined)
    expect(probe.samples[0]).toMatchObject({ heightMeters: -1, waveHeightMeters: 0, ready: true })
    expect(probe.samples[0]!.normal.toArray()).toEqual([0, 0, 1])
    probe.dispose()
    expect(() => probe.setPoints([])).toThrow(/disposed/)
    // The plugin's probes stop with it.
    const owned = water.createProbe()
    const dispose = vi.spyOn(owned, 'dispose')
    water.dispose()
    expect(dispose).toHaveBeenCalled()
  })
})
