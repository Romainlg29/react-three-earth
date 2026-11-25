import { BufferAttribute, BufferGeometry, Mesh } from 'three'
import { abs, ceil, clamp, exp2, float, floor, fract, log2, max, positionGeometry, select, smoothstep, transformNormalToView, uniform, varying, vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'

import type { WaveSurface, WaveSurfaceNodes } from './WaveSurface.js'

/** Cells from the centre to the edge of each ring of the mesh (a ring is twice this across). */
export const WAVE_MESH_RESOLUTION = 48
/** Rings of the mesh, each twice the cell size of the one inside it. */
export const WAVE_MESH_LEVELS = 8
/**
 * Above this height over the sea the mesh is not drawn, metres: its displacement no longer shows, and the terrain's
 * waves (normals only) are enough.
 */
export const WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS = 1500

/** What the sea looks like on the mesh, from the waves at the fragment: the plugin's own shading. */
export interface WaveMeshShading {
  color: Node<'vec3'>
  roughness: Node<'float'>
}

export interface WaveMeshOptions {
  /** Cells from the centre to the edge of each ring. Default: `WAVE_MESH_RESOLUTION`. */
  resolution?: number
  /** Rings. Default: `WAVE_MESH_LEVELS`. */
  levels?: number
}

/**
 * The sea's surface near the camera as geometry, moved by the waves: rings of cells around the camera, each twice the
 * size of the one inside it (geometry clipmaps, Losasso & Hoppe 2004, as ocean renderers such as Crest lay them), so the
 * detail per pixel is about even from the camera's feet to the mesh's edge. Each ring snaps to its own cells as the
 * camera moves, so its vertices sample the waves at fixed places and never swim; the outer part of each ring morphs its
 * odd vertices onto the next ring's grid, so rings meet without cracks or pops. The innermost cell scales with the
 * camera's height (a power of two, from 6 cm). Vertices move by the GPU's displacement (height and the choppy waves'
 * pull towards the crests); the fragments shade from the slopes, sampled per pixel. The outer ring flattens to the plane,
 * where the terrain's sea takes over (`coverage`), with the Earth's curvature applied, so the two meet seamlessly.
 *
 * Needs the GPU path (`WaveSurface.compute`): without it, nothing displaces and the mesh is hidden.
 */
export class WaveMesh {
  readonly mesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  readonly resolution: number
  readonly levels: number
  /** The innermost ring's cell size, metres. */
  protected readonly cellSize = uniform(1)
  /** 1 while drawn: the terrain's sea under it gives way (`coverage`). */
  readonly active = uniform(0)
  protected readonly curvature = uniform(0)
  protected readonly surface: WaveSurface
  protected laidAnchorVersion = -1

  constructor(surface: WaveSurface, shade: (waves: WaveSurfaceNodes) => WaveMeshShading, { resolution = WAVE_MESH_RESOLUTION, levels = WAVE_MESH_LEVELS }: WaveMeshOptions = {}) {
    if (!Number.isInteger(resolution) || resolution < 24 || resolution % 4 !== 0) {
      throw new Error(`WaveMesh: resolution must be a multiple of 4 of at least 24 (cells from the centre to a ring's edge), got ${resolution}.`)
    }
    if (!Number.isInteger(levels) || levels < 1 || levels > 16) throw new Error(`WaveMesh: levels must be a whole number from 1 to 16, got ${levels}.`)
    this.surface = surface
    this.resolution = resolution
    this.levels = levels
    const material = new MeshStandardNodeMaterial({ metalness: 0 })
    material.name = 'WaveMesh'
    this.buildNodes(material, shade)
    this.mesh = new Mesh(createRings(resolution, levels), material)
    this.mesh.name = 'WaveMesh'
    // The vertices move on the GPU: the bounds on the CPU do not hold them.
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.visible = false
  }

  /**
   * Lays the mesh under the camera and shows it while it can: on the GPU path, below
   * `WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS`, and when `visible` (waves on, the globe rather than the flat map).
   */
  update(visible: boolean): void {
    const { surface } = this
    const height = surface.cameraHeightAboveSeaMeters
    const shown = visible && surface.compute !== null && height < WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS
    this.mesh.visible = shown
    this.active.value = shown ? 1 : 0
    if (!shown) return
    // Finer near the sea, a power of two so the rings keep their places between changes.
    this.cellSize.value = 2 ** Math.min(0, Math.max(-4, Math.floor(Math.log2(Math.max(height, 0.5) / 24))))
    if (this.laidAnchorVersion !== surface.anchorVersion) {
      this.mesh.matrix.copy(surface.planeFrame)
      this.mesh.matrixWorldNeedsUpdate = true
      this.curvature.value = 1 / (2 * surface.curvatureRadiusMeters)
      this.laidAnchorVersion = surface.anchorVersion
    }
  }

  /**
   * 1 where the mesh draws the sea, at a point of the wave plane: inside the outer ring, `insetCells` of its cells short
   * of its edge. The mesh discards its fragments beyond 3; the terrain's sea gives way within 4, so the two overlap by a
   * cell (where the outer ring lies flat) and no gap opens between them.
   */
  coverage(plane: Node<'vec2'>, insetCells = 3): Node<'float'> {
    const reach = this.cellSize.mul(2 ** (this.levels - 1) * (this.resolution - insetCells))
    const offset = abs(plane.sub(this.surface.cameraPlane))
    return float(1).sub(smoothstep(reach, reach.add(1e-3), max(offset.x, offset.y))).mul(this.active) as unknown as Node<'float'>
  }

  /**
   * The surface as the mesh draws it at a point of the plane (before the waves move it), outside the mesh's own shaders:
   * the ring that draws there, its vertices' spacing and fades, so what a probe reads is what is on screen. Zero while
   * the mesh is hidden (the terrain's sea is flat). `displacement` is east, north and up, metres; `slope` east and north.
   */
  sampleSurface(plane: Node<'vec2'>): { displacement: Node<'vec3'>; slope: Node<'vec2'> } {
    const { resolution, levels } = this
    const offset = abs(plane.sub(this.surface.cameraPlane))
    const distance = max(offset.x, offset.y)
    // The innermost ring that reaches the point draws it (each ring is `resolution` of its cells from centre to edge).
    const level = clamp(ceil(log2(distance.div(this.cellSize.mul(resolution)).max(1e-6))), 0, levels - 1)
    const cell = this.cellSize.mul(exp2(level))
    const cells = distance.div(cell)
    const morph = morphAt(cells, resolution)
    const amplitude = select(level.greaterThan(levels - 1.5), float(1).sub(smoothstep(resolution * 0.5, resolution * 0.85, cells)), float(1)).mul(this.active)
    const spacing = cell.mul(morph.add(1)) as unknown as Node<'float'>
    return {
      displacement: this.surface.sampleDisplacement(plane, spacing).mul(amplitude) as unknown as Node<'vec3'>,
      slope: this.surface.sampleSlope(plane, spacing).mul(amplitude) as unknown as Node<'vec2'>,
    }
  }

  protected buildNodes(material: MeshStandardNodeMaterial, shade: (waves: WaveSurfaceNodes) => WaveMeshShading): void {
    const { surface, resolution } = this
    const camera = surface.cameraPlane
    const local = positionGeometry.xy
    const level = positionGeometry.z
    const cell = this.cellSize.mul(exp2(level))
    // Each ring snaps to twice its cells: the next ring's grid, so the inner ring's even vertices sit on it.
    const centre = floor(camera.div(cell.mul(2))).mul(cell.mul(2))
    const unmorphed = centre.add(local.mul(cell))
    const distance = abs(unmorphed.sub(camera))
    const cells = max(distance.x, distance.y).div(cell)
    const morph = morphAt(cells, resolution)
    const morphed = local.sub(fract(local.mul(0.5)).mul(2).mul(morph))
    const plane = centre.add(morphed.mul(cell))
    // The outer ring flattens to the plane before its edge, where the terrain's sea takes over.
    const outer = level.greaterThan(this.levels - 1.5)
    const amplitude = select(outer, float(1).sub(smoothstep(resolution * 0.5, resolution * 0.85, cells)), float(1))
    const displacement = surface.sampleDisplacement(plane as unknown as Node<'vec2'>, cell.mul(morph.add(1)) as unknown as Node<'float'>).mul(amplitude)
    const bend = plane.dot(plane).mul(this.curvature)
    material.positionNode = vec3(plane.add(displacement.xy), displacement.z.sub(bend))

    // Fragments: the waves sampled per pixel where this point of the plane lay before it moved.
    const fragmentPlane = varying(plane, 'wavePlane') as unknown as Node<'vec2'>
    const waves = surface.sampleWaves(fragmentPlane)
    const { color, roughness } = shade(waves)
    material.colorNode = color
    material.roughnessNode = roughness
    // The slopes tilt the plane's up (the mesh's z), in its own frame: east is x, north y.
    const normal = vec3(waves.slope.x.negate(), waves.slope.y.negate(), 1).normalize()
    material.normalNode = transformNormalToView(normal)
    // Beyond the terrain's edge of the mesh (`coverage`), the terrain draws the sea.
    material.maskNode = this.coverage(fragmentPlane).greaterThan(0.5)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

/**
 * How far a ring's odd vertices have moved onto the next ring's grid, at `cells` of its cells from the camera: none
 * until past the next ring's hole (its edge lies up to `resolution / 2 + 1` of that ring's cells away, as the rings snap
 * apart), all of it before the next ring overlaps this one (up to 4 cells inside this ring's edge), so where both are
 * drawn they have the same shape.
 */
function morphAt(cells: Node<'float'>, resolution: number): Node<'float'> {
  return smoothstep(resolution * 0.55, resolution - 6, cells) as unknown as Node<'float'>
}

/**
 * The rings: the innermost a full grid of `2 resolution` cells a side, each other ring the same grid at twice the cell
 * size with its middle left out, overlapping the ring inside by one cell (the rings snap independently, up to one cell
 * apart). Positions hold the vertex's cell coordinates in its ring (x, y) and the ring (z).
 */
export function createRings(resolution: number, levels: number): BufferGeometry {
  const side = 2 * resolution + 1
  const hole = resolution / 2 - 1
  const positions: number[] = []
  const indices: number[] = []
  for (let level = 0; level < levels; level++) {
    const first = positions.length / 3
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) positions.push(column - resolution, row - resolution, level)
    }
    for (let row = 0; row < side - 1; row++) {
      for (let column = 0; column < side - 1; column++) {
        const x = column - resolution
        const y = row - resolution
        // Cells wholly inside the hole belong to the ring inside.
        if (level > 0 && x >= -hole && x + 1 <= hole && y >= -hole && y + 1 <= hole) continue
        const a = first + row * side + column
        const b = a + 1
        const c = a + side
        const d = c + 1
        // Every cell split along the same diagonal (lower left to upper right): a morphed block of four cells then takes
        // exactly the shape of the coarser ring's cell, so nothing pops when cells pass from one ring to the next.
        indices.push(a, b, d, a, d, c)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(new BufferAttribute(positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 1))
  return geometry
}
