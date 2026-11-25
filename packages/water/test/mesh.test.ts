import { Group, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { vec3 } from 'three/tsl'
import type { MeshPhysicalNodeMaterial, WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { Water } from '../src/Water.js'
import type { SeaStateOptions } from '../src/waves/spectrum.js'
import { WaveField } from '../src/waves/WaveField.js'
import {
  createRings,
  lookAhead,
  WATER_INDEX_OF_REFRACTION,
  WAVE_MESH_LOOK_AHEAD_HEIGHTS,
  WAVE_MESH_LOOK_AHEAD_SHARE,
  WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS,
  WAVE_MESH_MINIMUM_CELL_METERS,
  WaveMesh,
} from '../src/waves/WaveMesh.js'
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
    // About a 96th of the height, a power of two.
    expect(cellSize.value).toBe(1 / 4)
    surface.cameraHeightAboveSeaMeters = 2
    mesh.update(true)
    expect(cellSize.value).toBe(WAVE_MESH_MINIMUM_CELL_METERS)
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

describe('lookAhead', () => {
  it('centres the rings ahead along the view, never past a few camera heights, and under a camera looking down', () => {
    const camera = new Vector2(100, -50)
    const target = new Vector2()
    // Looking east, 45° down from 10 m: the view meets the sea 10 m ahead.
    lookAhead(camera, new Vector3(1, 0, -1).normalize(), 10, target)
    expect(target.x).toBeCloseTo(100 + 10 * WAVE_MESH_LOOK_AHEAD_SHARE, 9)
    expect(target.y).toBeCloseTo(-50, 9)
    // Looking north at the horizon: as far as the bottom of the view allows.
    lookAhead(camera, new Vector3(0, 1, 0), 10, target)
    expect(target.y).toBeCloseTo(-50 + 10 * WAVE_MESH_LOOK_AHEAD_HEIGHTS, 9)
    lookAhead(camera, new Vector3(0, 0, -1), 10, target)
    expect(target.equals(camera)).toBe(true)
  })
})

describe('wave mesh material', () => {
  it('reflects as water does, and glows with the light its shading scatters', () => {
    const plain = new WaveMesh(laidSurface(30), shade)
    expect((plain.mesh.material as MeshPhysicalNodeMaterial).ior).toBe(WATER_INDEX_OF_REFRACTION)
    expect((plain.mesh.material as MeshPhysicalNodeMaterial).metalness).toBe(0)
    expect((plain.mesh.material as MeshPhysicalNodeMaterial).emissiveNode).toBeNull()
    const glow = vec3(0, 0.1, 0.2)
    let seen: Parameters<ConstructorParameters<typeof WaveMesh>[1]>[2] | undefined
    const glowing = new WaveMesh(laidSurface(30), (_waves, _ground, view) => {
      seen = view
      return { ...shade(), emissive: glow }
    })
    expect((glowing.mesh.material as MeshPhysicalNodeMaterial).emissiveNode).toBe(glow)
    expect(seen?.significantWaveHeightMeters).toBe(glowing.significantWaveHeightMeters)
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
    // Point 0: 1.5 m up, sloping up eastwards. Point 1: not written yet. Point 2: on land, 12 m up.
    readings.set([1.5, 0.2, 0, 1], 0)
    readings.set([12, 0, 0, 2], 8)
    const renderer = webgpu({ getArrayBufferAsync: vi.fn(async () => readings.buffer) })
    const surface = laidSurface(30, renderer)
    surface.seaLevelMeters = 2
    const mesh = new WaveMesh(surface, shade)
    mesh.update(true)
    const probe = new WaveProbe(surface, mesh, { capacity: 4 })
    probe.setPoints([
      { longitudeDegrees: 0.001, latitudeDegrees: 0 },
      { longitudeDegrees: 0.002, latitudeDegrees: 0 },
      { longitudeDegrees: 0.003, latitudeDegrees: 0 },
    ])
    expect(probe.samples.map(sample => sample.ready)).toEqual([false, false, false])
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
    expect(sample!.onWater).toBe(true)
    expect(unwritten!.ready).toBe(false)
    expect(probe.samples[2]).toMatchObject({ onWater: false, waveHeightMeters: 12, ready: true })
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

describe('WaveDepthCache', () => {
  /** A terrain stand-in that records its draws and says where its ground is. */
  function fakeTerrain(groundMeters: number | null = 0) {
    return {
      visibleTilesVersion: 0,
      renderTiles: vi.fn(() => true),
      sampleElevation: vi.fn(() => groundMeters),
    }
  }

  it('draws the ground again only when the mesh moves, or now and then when tiles change', () => {
    const renderer = webgpu()
    const surface = laidSurface(30, renderer)
    const mesh = new WaveMesh(surface, shade)
    const terrain = fakeTerrain()
    const earth = new Group()
    const source = { renderer, terrain: terrain as never, earth }
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    mesh.update(true, source)
    expect(terrain.renderTiles).toHaveBeenCalledTimes(1)
    expect(mesh.ground.valid.value).toBe(1)
    // The shore pass follows each draw, in one submit: seeds, the jump flood's ten steps (768 texels), the ground.
    expect((vi.mocked(renderer.compute).mock.lastCall![0] as unknown[]).length).toBe(12)
    // Covers the outer ring: 2 × 48 of its 128 m cells.
    expect(mesh.ground.halfSizeMeters.value).toBe(48 * 128)
    expect(mesh.ground.target.width).toBe(96 * 8)
    mesh.update(true, source)
    expect(terrain.renderTiles).toHaveBeenCalledTimes(1)
    // Tiles changed: not before the refresh interval.
    terrain.visibleTilesVersion++
    now.mockReturnValue(1100)
    mesh.update(true, source)
    expect(terrain.renderTiles).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1300)
    mesh.update(true, source)
    expect(terrain.renderTiles).toHaveBeenCalledTimes(2)
    // Lower: finer cells, a smaller square, drawn at once.
    surface.cameraHeightMeters = 3
    surface.cameraHeightAboveSeaMeters = 3
    mesh.update(true, source)
    expect(terrain.renderTiles).toHaveBeenCalledTimes(3)
    expect(mesh.ground.halfSizeMeters.value).toBe(48 * 128 / 8)
    // Without a terrain nothing is known: the mesh lies at sea level over everything.
    mesh.update(true, { renderer, terrain: null, earth })
    expect(mesh.ground.valid.value).toBe(0)
    now.mockRestore()
  })

  it('sizes the mesh by the camera height over the ground drawn under it, a lake below sea level included', () => {
    const surface = laidSurface(30)
    surface.cameraHeightMeters = -400
    surface.cameraHeightAboveSeaMeters = -400
    const mesh = new WaveMesh(surface, shade)
    const cellSize = (mesh as unknown as { cellSize: { value: number } }).cellSize
    // 30 m over the Dead Sea's surface at -430 m.
    mesh.update(true, { renderer: webgpu(), terrain: fakeTerrain(-430) as never, earth: new Group() })
    expect(mesh.mesh.visible).toBe(true)
    expect(cellSize.value).toBe(1 / 4)
    // 3 m over a sea whose seafloor the terrain draws 2 km down: by the sea's level.
    surface.cameraHeightMeters = 3
    surface.cameraHeightAboveSeaMeters = 3
    mesh.update(true, { renderer: webgpu(), terrain: fakeTerrain(-2000) as never, earth: new Group() })
    expect(mesh.mesh.visible).toBe(true)
    expect(cellSize.value).toBe(1 / 32)
  })
})
