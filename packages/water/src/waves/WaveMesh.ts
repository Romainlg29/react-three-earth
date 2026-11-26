import type { Terrain } from '@earthkit/globe'
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, Vector2, Vector3, type Object3D } from 'three'
import { abs, ceil, clamp, cos, exp, exp2, float, floor, fract, frontFacing, log2, max, min, mix, positionGeometry, select, sin, smoothstep, transformNormalToView, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { MeshPhysicalNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu'

import { WaveDepthCache, type WaveGround, type WaveShore } from './WaveDepthCache.js'
import { deepWavenumber, SURF_BEACH_SLOPE, shallowWavenumberNode, shoalingCoefficientNode, surfPhaseNode } from './surf.js'
import type { WaveSurface, WaveSurfaceNodes } from './WaveSurface.js'

/** Cells from the centre to the edge of each ring of the mesh (a ring is twice this across). */
export const WAVE_MESH_RESOLUTION = 48
/** Rings of the mesh, each twice the cell size of the one inside it. */
export const WAVE_MESH_LEVELS = 10
/** The finest cell the mesh lays, metres: right at the water, the short chop becomes geometry. */
export const WAVE_MESH_MINIMUM_CELL_METERS = 2 ** -6
/**
 * How far ahead of the camera the rings centre, as a share of where the view's centre meets the sea: the fine rings
 * then lie in view rather than under and behind the camera.
 */
export const WAVE_MESH_LOOK_AHEAD_SHARE = 0.5
/** The farthest the rings centre ahead of the camera, in camera heights: the sea at the bottom of the view stays fine. */
export const WAVE_MESH_LOOK_AHEAD_HEIGHTS = 4
/**
 * Above this height over the sea the mesh is not drawn, metres: its displacement no longer shows, and the terrain's
 * waves (normals only) are enough.
 */
export const WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS = 1500

/** What the sea looks like on the mesh, from the waves at the fragment: the plugin's own shading. */
export interface WaveMeshShading {
  color: Node<'vec3'>
  roughness: Node<'float'>
  /** Light the water sends out of itself (the sun's light scattered through the crests), radiance. */
  emissive?: Node<'vec3'>
  /**
   * The surface seen from below, radiance: when a crest rises over the camera, it sees the waves' underside. Without it,
   * the underside is dark.
   */
  underside?: Node<'vec3'>
}

/** The geometry at a fragment of the mesh, in the wave plane's frame (x east, y north, z up), for its shading. */
export interface WaveMeshView {
  /** The surface's normal, unit. */
  normal: Node<'vec3'>
  /** Towards the camera, unit. */
  toCamera: Node<'vec3'>
  /** How high the waves lift the surface here over the water's level, metres (negative in a trough). */
  waveHeightMeters: Node<'float'>
  /** The sea state's significant wave height, metres: what a crest's height compares with. */
  significantWaveHeightMeters: Node<'float'>
}

/** The ground under a fragment of the mesh, for its shading. */
export interface WaveMeshGround {
  /** How far the seafloor lies below sea level, metres (0 where unknown). */
  depthMeters: Node<'float'>
  /** 1 in the surf zone, where the surf breaks (0 elsewhere): the water there is churned and clouded with sand. */
  surfZone: Node<'float'>
}

/** What the mesh needs of the earth to read the ground under it: without it, it lies at sea level over everything. */
export interface WaveMeshGroundSource {
  renderer: WebGPURenderer | undefined
  terrain: Terrain | null
  /** The object whose frame is ECEF. */
  earth: Object3D
}

/** Seawater's index of refraction for visible light. */
export const WATER_INDEX_OF_REFRACTION = 1.34

/** Waves break where they stand taller than this share of the water's depth (McCowan): the mesh calms them there. */
export const WAVE_BREAKING_DEPTH_RATIO = 0.78

/**
 * The surf at a point of the plane, from the vertex to its fragments: the way to the shore, the phase from it (without
 * time), its height, wavenumber, lean and how much it breaks.
 */
interface WaveSurf {
  displacement: Node<'vec3'>
  towardsShore: Node<'vec2'>
  phase: Node<'float'>
  amplitudeMeters: Node<'float'>
  wavenumber: Node<'float'>
  /** Gerstner's `Q A k`: how far the crests lean and sharpen, 0 to below 1. */
  lean: Node<'float'>
  breaking: Node<'float'>
  /** 1 where the vertices resolve the waves, 0 where they lie too far apart and only the surf zone's mean shows. */
  resolved: Node<'float'>
}

/** How far a surf crest leans (Gerstner's `Q A k`) before it breaks, and once broken. */
const SURF_LEAN = 0.45
const SURF_BREAKING_LEAN = 0.85
/** The whitewater a breaking crest leaves behind: its density just behind the crest, and how fast it thins over a wave. */
const SURF_WHITEWATER_DENSITY = 0.75
const SURF_WHITEWATER_DECAY = 3
/** The foam lasting all over the surf zone, between the crests' whitewater. */
const SURF_ZONE_FOAM_DENSITY = 0.12
/** The surf zone's foam density averaged over a wave, where its waves are too fine to draw. */
const SURF_FOAM_MEAN_DENSITY = 0.4

export interface WaveMeshOptions {
  /** Cells from the centre to the edge of each ring. Default: `WAVE_MESH_RESOLUTION`. */
  resolution?: number
  /** Rings. Default: `WAVE_MESH_LEVELS`. */
  levels?: number
}

/**
 * The sea's surface near the camera as geometry, moved by the waves: rings of cells around a point ahead of the camera
 * along its view (`lookAhead`, so the detail lies where it looks rather than under and behind it), each twice the
 * size of the one inside it (geometry clipmaps, Losasso & Hoppe 2004, as ocean renderers such as Crest lay them), so the
 * detail per pixel is about even from the camera's feet to the mesh's edge. Each ring snaps to its own cells as the
 * camera moves, so its vertices sample the waves at fixed places and never swim; the outer part of each ring morphs its
 * odd vertices onto the next ring's grid, so rings meet without cracks or pops. The innermost cell scales with the
 * camera's height (about a 96th of it, a power of two, from `WAVE_MESH_MINIMUM_CELL_METERS`, 1.6 cm, so right at the
 * water the short chop becomes geometry). Vertices move by the GPU's displacement (height and the choppy waves'
 * pull towards the crests); the fragments shade from the slopes, sampled per pixel. The outer ring flattens to the plane,
 * where the terrain's sea takes over (`coverage`), with the Earth's curvature applied, so the two meet seamlessly.
 *
 * Needs the GPU path (`WaveSurface.compute`): without it, nothing displaces and the mesh is hidden.
 */
export class WaveMesh {
  readonly mesh: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  readonly resolution: number
  readonly levels: number
  /** The innermost ring's cell size, metres. */
  protected readonly cellSize = uniform(1)
  /**
   * Where the rings centre on the wave plane, metres east and north of its anchor: ahead of the camera along its view
   * (`WAVE_MESH_LOOK_AHEAD_SHARE`), so the detail lies where it looks. Each ring still snaps to its own cells.
   */
  readonly centre = uniform(new Vector2())
  /** 1 while drawn: the terrain's sea under it gives way (`coverage`). */
  readonly active = uniform(0)
  protected readonly curvature = uniform(0)
  /** 1 when the terrain's elevation holds the seafloor's depth (`Water.depthFromElevation`): the shallows calm the waves. */
  readonly depthWeight = uniform(0)
  /** The sea state's significant wave height, metres: the shallows calm the waves below `WAVE_BREAKING_DEPTH_RATIO` of it. */
  readonly significantWaveHeightMeters = uniform(1)
  /**
   * The surf's height in open water off the coast, metres (0: no surf). Near the shore a train of it runs straight at the
   * land, shortens and steepens over the shallows and breaks at `WAVE_BREAKING_DEPTH_RATIO` of the depth.
   */
  readonly surfHeightMeters = uniform(0)
  /** The surf's deep-water wavenumber, rad/m: from its period (`setSurf`). */
  protected readonly surfDeepWavenumber = uniform(deepWavenumber(8))
  /** The surf's phase in time, `ω t` modulo a turn: its crests run towards the shore. */
  protected readonly surfTimePhase = uniform(0)
  protected surfAngularFrequency = (2 * Math.PI) / 8
  /** The ground under the mesh, drawn from above: where the water is, its level and depth. */
  readonly ground: WaveDepthCache
  protected readonly surface: WaveSurface
  protected laidAnchorVersion = -1

  constructor(surface: WaveSurface, shade: (waves: WaveSurfaceNodes, ground: WaveMeshGround, view: WaveMeshView) => WaveMeshShading, { resolution = WAVE_MESH_RESOLUTION, levels = WAVE_MESH_LEVELS }: WaveMeshOptions = {}) {
    if (!Number.isInteger(resolution) || resolution < 24 || resolution % 4 !== 0) {
      throw new Error(`WaveMesh: resolution must be a multiple of 4 of at least 24 (cells from the centre to a ring's edge), got ${resolution}.`)
    }
    if (!Number.isInteger(levels) || levels < 1 || levels > 16) throw new Error(`WaveMesh: levels must be a whole number from 1 to 16, got ${levels}.`)
    this.surface = surface
    this.resolution = resolution
    this.levels = levels
    // The outer ring: `2 resolution` of its cells across.
    this.ground = new WaveDepthCache(surface, 2 * resolution)
    // Water's index of refraction: 2 % reflected head-on (Fresnel), all of it at grazing angles.
    const material = new MeshPhysicalNodeMaterial({ metalness: 0, ior: WATER_INDEX_OF_REFRACTION })
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
   * `WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS` over the water (or the ground) under the camera, and when `visible` (waves
   * on, the globe rather than the flat map). With `source`, it draws the ground under it again when it moved.
   */
  update(visible: boolean, source?: WaveMeshGroundSource): void {
    const { surface } = this
    const height = this.cameraHeightAboveSurface(source?.terrain ?? null)
    const shown = visible && surface.compute !== null && height < WAVE_MESH_MAXIMUM_CAMERA_HEIGHT_METERS
    this.mesh.visible = shown
    this.active.value = shown ? 1 : 0
    if (!shown) return
    this.surfTimePhase.value = (this.surfAngularFrequency * surface.timeSeconds) % (2 * Math.PI)
    // Finer near the sea (the innermost ring reaches about half the height), a power of two so the rings keep their places.
    this.cellSize.value = 2 ** Math.min(0, Math.max(Math.log2(WAVE_MESH_MINIMUM_CELL_METERS), Math.floor(Math.log2(height / (2 * this.resolution)))))
    lookAhead(surface.cameraPlane.value, surface.cameraForward, height, this.centre.value)
    if (source !== undefined) {
      // Over the outer ring, which snaps to twice its cells.
      const outer = this.cellSize.value * 2 ** (this.levels - 1)
      const centre = this.centre.value
      scratchCentre.set(Math.floor(centre.x / (2 * outer)) * 2 * outer, Math.floor(centre.y / (2 * outer)) * 2 * outer)
      this.ground.update(source.renderer, source.terrain, source.earth, scratchCentre, this.resolution * outer)
    }
    if (this.laidAnchorVersion !== surface.anchorVersion) {
      this.mesh.matrix.copy(surface.planeFrame)
      this.mesh.matrixWorldNeedsUpdate = true
      this.curvature.value = 1 / (2 * surface.curvatureRadiusMeters)
      this.laidAnchorVersion = surface.anchorVersion
    }
  }

  /** The surf near the shore: its height in open water (0: none), metres, and its period, seconds. */
  setSurf(heightMeters: number, periodSeconds: number): void {
    if (!(heightMeters >= 0) || !Number.isFinite(heightMeters)) throw new Error(`WaveMesh: the surf's height must be a finite number of metres of at least 0, got ${heightMeters}.`)
    if (!(periodSeconds > 0) || !Number.isFinite(periodSeconds)) throw new Error(`WaveMesh: the surf's period must be a positive number of seconds, got ${periodSeconds}.`)
    this.surfHeightMeters.value = heightMeters
    this.surfDeepWavenumber.value = deepWavenumber(periodSeconds)
    this.surfAngularFrequency = (2 * Math.PI) / periodSeconds
  }

  /**
   * The camera's height over what it looks down on: sea level, or the terrain as drawn under it where a tile covers it
   * and it lies higher (a sea on the geoid above the ellipsoid). Below sea level the camera is over a depression (the
   * Dead Sea): the drawn ground then, as a seafloor the terrain draws under its water can only lie below a camera above
   * sea level.
   */
  protected cameraHeightAboveSurface(terrain: Terrain | null): number {
    const { surface } = this
    const ground = terrain?.sampleElevation(surface.cameraLongitudeRadians, surface.cameraLatitudeRadians) ?? null
    if (ground === null) return surface.cameraHeightAboveSeaMeters
    const seaLevel = surface.cameraHeightMeters - surface.cameraHeightAboveSeaMeters
    return surface.cameraHeightMeters - (surface.cameraHeightAboveSeaMeters < 0 ? ground : Math.max(ground, seaLevel))
  }

  /**
   * 1 where the mesh draws the sea, at a point of the wave plane: inside the outer ring, `insetCells` of its cells short
   * of its edge. The mesh discards its fragments beyond 3; the terrain's sea gives way within 4, so the two overlap by a
   * cell (where the outer ring lies flat) and no gap opens between them.
   */
  coverage(plane: Node<'vec2'>, insetCells = 3): Node<'float'> {
    const reach = this.cellSize.mul(2 ** (this.levels - 1) * (this.resolution - insetCells))
    const offset = abs(plane.sub(this.centre))
    return float(1).sub(smoothstep(reach, reach.add(1e-3), max(offset.x, offset.y))).mul(this.active) as unknown as Node<'float'>
  }

  /**
   * The surface as the mesh draws it at a point of the plane (before the waves move it), outside the mesh's own shaders:
   * the ring that draws there, its vertices' spacing and fades, so what a probe reads is what is on screen. Zero while
   * the mesh is hidden (the terrain's sea is flat). `displacement` is east, north and up, metres; `slope` east and north;
   * `heightAboveSeaMeters` the surface's height over sea level at the point (a lake's level included); `water` 1 over water.
   */
  sampleSurface(plane: Node<'vec2'>): { displacement: Node<'vec3'>; slope: Node<'vec2'>; heightAboveSeaMeters: Node<'float'>; water: Node<'float'> } {
    const { resolution, levels } = this
    const offset = abs(plane.sub(this.centre))
    const distance = max(offset.x, offset.y)
    // The innermost ring that reaches the point draws it (each ring is `resolution` of its cells from centre to edge).
    const level = clamp(ceil(log2(distance.div(this.cellSize.mul(resolution)).max(1e-6))), 0, levels - 1)
    const cell = this.cellSize.mul(exp2(level))
    const cells = distance.div(cell)
    const morph = morphAt(cells, resolution)
    const ground = this.groundAt(plane)
    const amplitude = select(level.greaterThan(levels - 1.5), float(1).sub(smoothstep(resolution * 0.5, resolution * 0.85, cells)), float(1))
      .mul(this.active)
      .mul(ground.calm)
    const spacing = cell.mul(morph.add(1)) as unknown as Node<'float'>
    const fade = select(level.greaterThan(levels - 1.5), float(1).sub(smoothstep(resolution * 0.5, resolution * 0.85, cells)), float(1)).mul(this.active)
    const surf = this.surfAt(plane, ground, spacing, fade as unknown as Node<'float'>)
    const displacement = this.surface.sampleDisplacement(plane, spacing).mul(amplitude).add(surf.displacement)
    const displacementHeight = displacement.z
    return {
      displacement: displacement as unknown as Node<'vec3'>,
      slope: this.surface.sampleSlope(plane, spacing).mul(amplitude).add(this.surfSlope(surf.towardsShore, surf.phase, surf.amplitudeMeters, surf.wavenumber, surf.lean)) as unknown as Node<'vec2'>,
      // The water's level over the plane, put back over the ellipsoid's curve: over sea level at the point.
      heightAboveSeaMeters: ground.surfaceMeters.add(plane.dot(plane).mul(this.curvature)).mul(this.active).add(displacementHeight) as unknown as Node<'float'>,
      water: ground.water,
    }
  }

  /**
   * The ground at a point of the plane: the water's level over the plane (sea level, the Earth's curvature applied, where
   * the cache knows nothing), whether it is water, its depth, and how much the waves keep there: calmed where they would
   * break in the shallows (when the depth is known) and flat over the last metres of the shore.
   */
  protected groundAt(plane: Node<'vec2'>): WaveGround & { calm: Node<'float'>; shore: WaveShore; shallowMeters: Node<'float'> } {
    const bend = plane.dot(plane).mul(this.curvature).negate() as unknown as Node<'float'>
    const ground = this.ground.sample(plane, bend)
    const shore = this.ground.sampleShore(plane)
    // Elevation models fill the sea with sea level where they hold no depth (as for the seafloor's colour): no depth there,
    // and none for water above sea level (a lake), whose depth the elevation does not give. There, a beach's slope from
    // the nearest shore stands for it (very deep where no shore is in reach).
    const depthKnown = smoothstep(0.05, 0.5, ground.depthMeters).mul(this.depthWeight).mul(ground.known)
    const sloping = float(UNKNOWN_SHALLOW_METERS).add(max(shore.distanceMeters, 0).mul(SURF_BEACH_SLOPE).sub(UNKNOWN_SHALLOW_METERS).mul(shore.known))
    const shallowMeters = sloping.add(ground.depthMeters.sub(sloping).mul(depthKnown)) as unknown as Node<'float'>
    // The wind's waves break where they stand taller than `WAVE_BREAKING_DEPTH_RATIO` of the depth: calmed there.
    const shallows = shallowMeters.mul(WAVE_BREAKING_DEPTH_RATIO).div(max(this.significantWaveHeightMeters, 0.05)).clamp(0, 1)
    const atShore = smoothstep(0.5, 1, ground.water)
    return { ...ground, shore, shallowMeters, calm: shallows.mul(atShore) as unknown as Node<'float'> }
  }

  /**
   * The surf at a point of the plane: a train of waves running straight at the nearest shore (refracted until their
   * crests lie along it), shortening and steepening over the shallows (Eckart's dispersion and the shoaling of their
   * energy flux), leaning forward, then breaking where they would stand taller than `WAVE_BREAKING_DEPTH_RATIO` of the
   * depth, beyond which they shrink with it. It fades in where the water is shallower than half its wavelength (where
   * waves start to feel the bottom), and out where the vertices lie too far apart to draw it (`spacingMeters`). Its
   * phase follows a beach's slope from the shore (`surfPhase`) so its crests keep their spacing; its height and breaking
   * follow the depth itself.
   */
  protected surfAt(plane: Node<'vec2'>, ground: { water: Node<'float'>; shore: WaveShore; shallowMeters: Node<'float'> }, spacingMeters: Node<'float'>, fade: Node<'float'>): WaveSurf {
    const { shore, shallowMeters } = ground
    const deep = this.surfDeepWavenumber as unknown as Node<'float'>
    const deepLength = float(2 * Math.PI).div(deep)
    const depth = max(shallowMeters, 0.2) as unknown as Node<'float'>
    const wavenumber = shallowWavenumberNode(deep, depth)
    const height = this.surfHeightMeters.mul(shoalingCoefficientNode(wavenumber.mul(depth) as unknown as Node<'float'>))
    const limit = depth.mul(WAVE_BREAKING_DEPTH_RATIO)
    const breaking = smoothstep(0.8, 1, height.div(limit))
    // Sets of bigger waves, and crests that rise and fall along the shore, so the lines are never ruled.
    const phase = surfPhaseNode(deep, max(shore.distanceMeters, 0) as unknown as Node<'float'>)
    const sets = cos(phase.add(this.surfTimePhase).mul(1 / 7)).mul(0.2).add(0.8)
    const along = sin(plane.dot(vec2(0.0071, 0.0053)).add(1.3)).mul(sin(plane.dot(vec2(-0.0043, 0.0089)))).mul(0.25).add(0.75)
    const wavelength = float(2 * Math.PI).div(wavenumber)
    const present = shore.known
      .mul(float(1).sub(smoothstep(deepLength.mul(0.25), deepLength.mul(0.5), depth)))
      .mul(smoothstep(0.5, 1, ground.water))
      .mul(fade)
    // The waves themselves only where the vertices lie close enough to draw them; the surf zone's foam everywhere.
    const resolved = float(1).sub(smoothstep(wavelength.mul(1 / 4), wavelength.mul(1 / 2), spacingMeters))
    const amplitude = min(height, limit).mul(0.5).mul(sets).mul(along).mul(present).mul(resolved) as unknown as Node<'float'>
    // Gerstner: the water turns in orbits, gathering under the crests; `Q A k` grows to `SURF_BREAKING_LEAN` as they break.
    const lean = min(amplitude.mul(wavenumber), breaking.mul(SURF_BREAKING_LEAN - SURF_LEAN).add(SURF_LEAN)) as unknown as Node<'float'>
    const now = phase.add(this.surfTimePhase)
    const towards = shore.towardsShore
    const horizontal = towards.mul(sin(now).mul(lean).div(wavenumber))
    return {
      displacement: vec3(horizontal, cos(now).mul(amplitude)) as unknown as Node<'vec3'>,
      towardsShore: towards,
      phase,
      amplitudeMeters: amplitude,
      wavenumber,
      lean,
      breaking: breaking.mul(present) as unknown as Node<'float'>,
      resolved: resolved as unknown as Node<'float'>,
    }
  }

  /**
   * The surf's slope where its phase from the shore is `phase`: `A k sin φ` towards the shore, over how much the crests
   * gather (`1 − Q A k cos φ`), so the crests are sharp and the troughs broad.
   */
  protected surfSlope(towards: Node<'vec2'>, phase: Node<'float'>, amplitude: Node<'float'>, wavenumber: Node<'float'>, lean: Node<'float'>): Node<'vec2'> {
    const now = phase.add(this.surfTimePhase)
    const gathered = max(float(1).sub(lean.mul(cos(now))), 0.15)
    return towards.mul(amplitude.mul(wavenumber).mul(sin(now)).div(gathered)) as unknown as Node<'vec2'>
  }

  /**
   * The surf zone's foam density, 0 to 1: thick on the breaking crests' front (the shoreward side), left behind them as
   * they run on and thinning until the next crest (the bore's whitewater), over a lasting sheen of foam where the surf
   * breaks. Broken into patches by the caller.
   */
  protected surfFoam(phase: Node<'float'>, breaking: Node<'float'>, resolved: Node<'float'>): Node<'float'> {
    const now = phase.add(this.surfTimePhase)
    const crest = smoothstep(0.3, 1, cos(now.add(0.5)))
    // How far behind the last crest, a turn being one wave: the crest leaves the water seaward of it, at larger phases.
    const behind = fract(now.div(2 * Math.PI))
    const wake = exp(behind.mul(-SURF_WHITEWATER_DECAY)).mul(SURF_WHITEWATER_DENSITY)
    // Where the waves are not resolved, their crests would alias: the foam's mean over a wave instead.
    const foam = mix(float(SURF_FOAM_MEAN_DENSITY), max(crest, wake.add(SURF_ZONE_FOAM_DENSITY)), resolved)
    return breaking.mul(foam).clamp(0, 1) as unknown as Node<'float'>
  }

  protected buildNodes(material: MeshPhysicalNodeMaterial, shade: (waves: WaveSurfaceNodes, ground: WaveMeshGround, view: WaveMeshView) => WaveMeshShading): void {
    const { surface, resolution } = this
    const camera = this.centre
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
    const ground = this.groundAt(plane as unknown as Node<'vec2'>)
    const spacing = cell.mul(morph.add(1)) as unknown as Node<'float'>
    const surf = this.surfAt(plane as unknown as Node<'vec2'>, ground, spacing, amplitude as unknown as Node<'float'>)
    const displacement = surface.sampleDisplacement(plane as unknown as Node<'vec2'>, spacing).mul(amplitude.mul(ground.calm)).add(surf.displacement)
    // On the water's own level: sea level with the Earth's curvature, or what the terrain draws (a lake, a geoid).
    const moved = plane.add(displacement.xy)
    material.positionNode = vec3(moved, displacement.z.add(ground.surfaceMeters))

    // Fragments: the waves sampled per pixel where this point of the plane lay before it moved.
    const fragmentPlane = varying(plane, 'wavePlane') as unknown as Node<'vec2'>
    const drawnPlane = varying(moved, 'waveDrawnPlane') as unknown as Node<'vec2'>
    const depthMeters = varying(ground.depthMeters, 'waveDepth') as unknown as Node<'float'>
    const waveHeightMeters = varying(displacement.z, 'waveHeight') as unknown as Node<'float'>
    const waterLevel = varying(ground.surfaceMeters, 'waveLevel') as unknown as Node<'float'>
    // The surf, per pixel from its phase at the vertices: one varying pair rather than another lookup of the shore.
    const surfOrbit = varying(vec4(surf.towardsShore, surf.phase, surf.amplitudeMeters), 'waveSurfOrbit') as unknown as Node<'vec4'>
    const surfShape = varying(vec4(surf.wavenumber, surf.lean, surf.breaking, surf.resolved), 'waveSurfShape') as unknown as Node<'vec4'>
    const surfTowards = surfOrbit.xy.div(max(surfOrbit.xy.length(), 1e-6)) as unknown as Node<'vec2'>
    const sea = surface.sampleWaves(fragmentPlane)
    const waves: WaveSurfaceNodes = {
      ...sea,
      slope: sea.slope.add(this.surfSlope(surfTowards, surfOrbit.z as unknown as Node<'float'>, surfOrbit.w as unknown as Node<'float'>, max(surfShape.x, 1e-4) as unknown as Node<'float'>, surfShape.y as unknown as Node<'float'>)) as unknown as Node<'vec2'>,
      foam: max(sea.foam, surface.patternFoam(fragmentPlane, this.surfFoam(surfOrbit.z as unknown as Node<'float'>, surfShape.z as unknown as Node<'float'>, surfShape.w as unknown as Node<'float'>))) as unknown as Node<'float'>,
    }
    // The slopes tilt the plane's up (the mesh's z), in its own frame: east is x, north y.
    const normal = vec3(waves.slope.x.negate(), waves.slope.y.negate(), 1).normalize() as unknown as Node<'vec3'>
    const toCamera = vec3(surface.cameraPlane.sub(drawnPlane), surface.cameraPlaneHeight.sub(waterLevel.add(waveHeightMeters))).normalize() as unknown as Node<'vec3'>
    const { color, roughness, emissive, underside } = shade(waves, { depthMeters, surfZone: surfShape.z as unknown as Node<'float'> }, { normal, toCamera, waveHeightMeters, significantWaveHeightMeters: this.significantWaveHeightMeters as unknown as Node<'float'> })
    // Both sides: a crest higher than the camera shows its underside, which would otherwise leave a hole to the sky's black.
    material.side = DoubleSide
    material.colorNode = select(frontFacing, color, vec3(0)) as unknown as Node<'vec3'>
    material.roughnessNode = select(frontFacing, roughness, float(1)) as unknown as Node<'float'>
    material.emissiveNode = select(frontFacing, emissive ?? vec3(0), underside ?? vec3(0)) as unknown as Node<'vec3'>
    // Seen from below, the surface faces down.
    material.normalNode = transformNormalToView(select(frontFacing, normal, normal.negate()) as unknown as Node<'vec3'>)
    // Only over water, where it lies after the waves moved it (the terrain's sea gives way by the same map); beyond the
    // terrain's edge of the mesh (`coverage`), the terrain draws the sea.
    material.maskNode = this.coverage(drawnPlane).greaterThan(0.5).and(this.coversWater(drawnPlane))
  }

  /** Whether the terrain draws water at a point of the plane, by the ground map: the mesh draws there, the terrain gives way. */
  coversWater(plane: Node<'vec2'>): Node<'bool'> {
    return this.ground.sample(plane, float(0) as unknown as Node<'float'>).water.greaterThanEqual(0.5) as unknown as Node<'bool'>
  }

  dispose(): void {
    this.ground.dispose()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

/**
 * Where the rings centre, into `target`: ahead of the camera on the plane along its view, by `WAVE_MESH_LOOK_AHEAD_SHARE`
 * of the distance to where the view's centre meets the sea, at most `WAVE_MESH_LOOK_AHEAD_HEIGHTS` camera heights. Under
 * the camera when it looks straight down (or up). `forward` is the view's direction in the plane's frame (x east, y
 * north, z up).
 */
export function lookAhead(camera: Vector2, forward: Vector3, heightMeters: number, target: Vector2): Vector2 {
  target.copy(camera)
  const along = Math.hypot(forward.x, forward.y)
  if (along < 1e-6 || !(heightMeters > 0)) return target
  // Where the view's centre meets the sea; the horizon when it looks level or up.
  const meetsSea = forward.z < 0 ? (heightMeters * along) / -forward.z : Infinity
  const ahead = Math.min(meetsSea * WAVE_MESH_LOOK_AHEAD_SHARE, heightMeters * WAVE_MESH_LOOK_AHEAD_HEIGHTS)
  return target.set(camera.x + (forward.x / along) * ahead, camera.y + (forward.y / along) * ahead)
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

const scratchCentre = new Vector2()
/** The depth taken where neither the terrain nor a shore gives one, metres: deep enough that no wave feels the bottom. */
const UNKNOWN_SHALLOW_METERS = 10_000
