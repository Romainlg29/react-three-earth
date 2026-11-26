import { terrainElevationMeters, terrainWaterMask, type Terrain } from '@earthkit/globe'
import { Color, FloatType, HalfFloatType, LinearFilter, Matrix4, OrthographicCamera, RenderTarget, RGBAFormat, Vector2, type Object3D } from 'three'
import { clamp, float, Fn, If, instancedArray, instanceIndex, int, ivec2, max, min, positionView, select, smoothstep, storageTexture, texture, uint, uniform, vec2, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, NoBlending, StorageTexture, type ComputeNode, type Node, type StorageBufferNode, type WebGPURenderer } from 'three/webgpu'

import type { WaveSurface } from './WaveSurface.js'

/** Texels of the cache across one cell of the mesh's outer ring. */
export const WAVE_DEPTH_CACHE_TEXELS_PER_CELL = 8
/**
 * The least time between two refreshes for tiles alone (a tile shown or hidden), seconds; a move of the mesh refreshes at
 * once. Tiles change nearly every frame while the camera moves, and a refresh draws every tile again (a few milliseconds
 * of the CPU's frame): once a second keeps that off most frames, and finer tiles change the coast little.
 */
export const WAVE_DEPTH_CACHE_REFRESH_SECONDS = 1
/** Height of the cache's camera over the wave plane, metres: above any coast. It sees down as far below. */
const CAMERA_HEIGHT_METERS = 10_000
/** The depth written where nothing is known, metres: deep enough that no wave is calmed. */
const UNKNOWN_DEPTH_METERS = 10_000
/** No shore found yet, in the jump flood's seeds. */
const NO_SEED = 0xffffffff

/** What the cache knows of the ground at a point of the wave plane. */
export interface WaveGround {
  /** 1 over water (as the terrain says), 0 over land and where no tile was drawn; 1 everywhere without a terrain. */
  water: Node<'float'>
  /** The water's level over the wave plane, metres: its nearest shore's; `fallback` where no shore is in reach. */
  surfaceMeters: Node<'float'>
  /** How far the seafloor lies below sea level, metres (0 on land; very deep where unknown); from the terrain's elevation. */
  depthMeters: Node<'float'>
  /** 1 where a tile was drawn into the cache, 0 where it knows nothing. */
  known: Node<'float'>
}

/** Where the shore lies from a point of the wave plane, for the surf. */
export interface WaveShore {
  /** How far the nearest shore lies, metres: positive over water, negative over land. */
  distanceMeters: Node<'float'>
  /** Towards the nearest shore on the plane (east, north), unit: the way the surf runs. */
  towardsShore: Node<'vec2'>
  /** 1 where a shore was found in the cache, 0 where none is in reach (and outside it). */
  known: Node<'float'>
}

/**
 * A map of the ground under the wave mesh, drawn from above (Crest's "sea floor depth cache"): per texel, whether the
 * terrain is water there, the water's level and the seafloor's depth. The mesh reads it to draw only over water, at the
 * water's own level, and to calm its waves in the shallows; the terrain's sea gives way under the mesh by the same map, so
 * the two never leave a gap.
 *
 * The level is the height of the nearest shore, found by a jump flood on the GPU: a lake below sea level (the Dead Sea),
 * a sea on the geoid and a sea over a seafloor the terrain draws (bathymetry under its water mask) all come out right,
 * as each body of water takes the level where it meets the land. Where no shore is in reach, it is sea level.
 *
 * It covers the mesh's outer ring and is drawn again only when that ring moves (the camera crosses two of its cells),
 * the cells change size, the plane is laid again, or tiles change (at most every `WAVE_DEPTH_CACHE_REFRESH_SECONDS`):
 * one small draw of the tiles with a trivial shader and twenty-two compute dispatches, now and then. Half floats, filtered:
 * two samples a vertex (the ground and the shore). It also keeps the distance and way to the nearest shore, for the surf.
 */
export class WaveDepthCache {
  /** The tiles as drawn from above: water mask, height over the plane, elevation over sea level, 1 where drawn. */
  readonly target: RenderTarget
  /** What the mesh samples: water, level over the plane (times `shore`), `shore` (1 where a shore was found), depth. */
  readonly ground: StorageTexture
  /**
   * The nearest shore per texel, weighted by whether one was found (`w`): the offset to it on the plane (x, y, metres,
   * pointing to the land), the signed distance to it (z, metres, negative on land).
   */
  readonly shore: StorageTexture
  readonly texels: number
  /** The cache's centre on the wave plane, metres east and north of the anchor. */
  readonly centre = uniform(new Vector2())
  /** Half its side, metres. */
  readonly halfSizeMeters = uniform(1)
  /** 1 once drawn for the current place; 0 when nothing could be drawn (no terrain): every point is then unknown. */
  readonly valid = uniform(0)
  /** The Earth's curvature on the plane, 1 / (2 R): heights over the plane fall by r² times it. */
  readonly curvature = uniform(0)
  protected readonly surface: WaveSurface
  protected readonly camera = new OrthographicCamera()
  protected readonly material = new MeshBasicNodeMaterial()
  protected readonly seaLevel = uniform(0)
  protected readonly sampler
  protected readonly shoreSampler
  protected readonly seeds: StorageBufferNode<'uint'>[]
  /** The shore before and between the passes of its blur. */
  protected readonly shoreBuffers: StorageBufferNode<'vec4'>[]
  /**
   * The lowest water level within `SHORE_LEVEL_STEPS` of each water texel, brought onto the Earth's curve (the level
   * over the plane plus r² times the curvature), before and between its passes.
   */
  protected readonly shoreLevels: StorageBufferNode<'float'>[]
  protected readonly kernels: ComputeNode[]
  protected laidKey = ''
  protected laidTilesVersion = -1
  protected laidTerrain: Terrain | null = null
  protected laidAtMilliseconds = -Infinity

  constructor(surface: WaveSurface, cellsAcross: number) {
    this.surface = surface
    const size = cellsAcross * WAVE_DEPTH_CACHE_TEXELS_PER_CELL
    this.texels = size
    // Full floats: the shores' heights keep their centimetres up a mountain lake (only loaded, never filtered).
    this.target = new RenderTarget(size, size, { type: FloatType, format: RGBAFormat, generateMipmaps: false, depthBuffer: true })
    this.target.texture.name = 'WaveDepthCacheTiles'
    this.ground = new StorageTexture(size, size)
    this.ground.type = HalfFloatType
    this.ground.minFilter = LinearFilter
    this.ground.magFilter = LinearFilter
    this.ground.generateMipmaps = false
    this.ground.name = 'WaveDepthCache'
    this.shore = new StorageTexture(size, size)
    this.shore.type = HalfFloatType
    this.shore.minFilter = LinearFilter
    this.shore.magFilter = LinearFilter
    this.shore.generateMipmaps = false
    this.shore.name = 'WaveDepthCacheShore'
    this.camera.matrixAutoUpdate = false
    this.camera.matrixWorldAutoUpdate = false
    this.material.name = 'WaveDepthCache'
    this.material.blending = NoBlending
    // The camera looks down the plane's up: its view z is the height below it.
    const height = float(CAMERA_HEIGHT_METERS).add(positionView.z)
    this.material.outputNode = vec4(terrainWaterMask, height, terrainElevationMeters.sub(this.seaLevel), 1)
    this.sampler = texture(this.ground)
    this.shoreSampler = texture(this.shore)
    this.seeds = [instancedArray(size * size, 'uint'), instancedArray(size * size, 'uint')]
    this.shoreBuffers = [instancedArray(size * size, 'vec4'), instancedArray(size * size, 'vec4')]
    this.shoreLevels = [instancedArray(size * size, 'float'), instancedArray(size * size, 'float')]
    this.kernels = this.createKernels(size)
  }

  /**
   * The shore pass: seeds where water meets land, a jump flood carrying each texel its nearest seed, then the ground
   * texture with each water texel at its shore's level (moved along the Earth's curve to where it is).
   */
  protected createKernels(size: number): ComputeNode[] {
    const count = size * size
    const tiles = texture(this.target.texture)
    const index = instanceIndex.toInt()
    const column = index.mod(size)
    const row = index.div(size)
    // Rows count from the south here, as the ground texture's (sampled with v northwards). The tiles' render target holds
    // the north edge in its first row (WebGPU rasterises the top of the view there): read it upside down.
    const load = (x: Node<'int'>, y: Node<'int'>) =>
      tiles.load(ivec2(clamp(x as never, 0, size - 1) as never, int(size - 1).sub(clamp(y as never, 0, size - 1) as never) as never)) as unknown as Node<'vec4'>
    // The tiles, with the cracks between them filled (`fill`). Lent by the blur, which only writes after the resolve.
    const filled = this.shoreBuffers[1]!
    const read = (x: Node<'int'>, y: Node<'int'>) =>
      filled.element(clamp(y as never, 0, size - 1).mul(size).add(clamp(x as never, 0, size - 1) as never)) as unknown as Node<'vec4'>
    const isWater = (texel: Node<'vec4'>) => texel.w.greaterThan(0.5).and(texel.x.greaterThanEqual(0.5))
    const isLand = (texel: Node<'vec4'>) => texel.w.greaterThan(0.5).and(texel.x.lessThan(0.5))
    const [first, second] = this.seeds as [StorageBufferNode<'uint'>, StorageBufferNode<'uint'>]

    // Neighbouring tiles of different detail leave cracks a texel wide that no tile draws, along two of their edges. Taken
    // as unknown, they would cut a line of open sea out of the water mask: each is filled from a drawn neighbour.
    const fill = Fn(() => {
      const here = load(column, row)
      const east = load(column.add(1), row)
      const west = load(column.sub(1), row)
      const north = load(column, row.add(1))
      const south = load(column, row.sub(1))
      const drawn = (texel: Node<'vec4'>) => texel.w.greaterThan(0.5)
      filled.element(index).assign(select(drawn(here), here, select(drawn(east), east, select(drawn(west), west, select(drawn(north), north, south)))))
    })().compute(count)

    const seed = Fn(() => {
      const here = read(column, row) as unknown as Node<'vec4'>
      const shore = isWater(here)
        .and(
          isLand(read(column.add(1), row) as unknown as Node<'vec4'>)
            .or(isLand(read(column.sub(1), row) as unknown as Node<'vec4'>))
            .or(isLand(read(column, row.add(1)) as unknown as Node<'vec4'>))
            .or(isLand(read(column, row.sub(1)) as unknown as Node<'vec4'>)),
        )
      first.element(index).assign(select(shore, uint(row).mul(65536).add(uint(column)), uint(NO_SEED)))
    })().compute(count)

    // Each shore's level: the lowest water drawn at or above sea level near it. Terrains rarely draw the water flat to
    // the coast: a quantized mesh's coastal triangles climb into the land under its water mask, the more the coarser the
    // tile, so the last water texel can stand metres above the sea and the water would float there in a plateau, with a
    // cliff where the next tile's shore is lower. The lowest level spreads over the water in passes of halving steps,
    // up to about a kilometre on the outer ring, so the shores of one sea share it.
    const metresPerTexel = this.halfSizeMeters.mul(2 / size)
    const planeOf = (x: Node<'float'>, y: Node<'float'>) => vec2(x.add(0.5), y.add(0.5)).mul(metresPerTexel).sub(this.halfSizeMeters).add(this.centre)
    // Levels over the plane fall by r² times the curvature away from its origin: added back, they compare along the Earth.
    const curved = (level: Node<'float'>, plane: Node<'vec2'>) => level.add(plane.dot(plane).mul(this.curvature))
    const [levelsFirst, levelsSecond] = this.shoreLevels as [StorageBufferNode<'float'>, StorageBufferNode<'float'>]
    const levelInit = Fn(() => {
      const here = read(column, row)
      // Only water drawn at or above sea level: below it the terrain may draw the seafloor (bathymetry under its water
      // mask), whose depths are not the water's level.
      const level = select(isWater(here).and(here.z.greaterThanEqual(0)), curved(here.y, planeOf(float(column), float(row))), float(NO_LEVEL))
      levelsFirst.element(index).assign(level)
    })().compute(count)
    const levelSteps: ComputeNode[] = []
    let levelSource = 0
    for (const step of SHORE_LEVEL_STEPS) {
      const from = this.shoreLevels[levelSource]!
      const to = this.shoreLevels[1 - levelSource]!
      levelSteps.push(
        Fn(() => {
          const lowest = from.element(index).toVar()
          If(isWater(read(column, row)), () => {
            for (const ox of [-step, 0, step]) {
              for (const oy of [-step, 0, step]) {
                if (ox === 0 && oy === 0) continue
                const x = clamp(column.add(ox) as never, 0, size - 1) as unknown as Node<'int'>
                const y = clamp(row.add(oy) as never, 0, size - 1) as unknown as Node<'int'>
                lowest.assign(min(lowest, from.element(y.mul(size).add(x))))
              }
            }
          })
          to.element(index).assign(lowest)
        })().compute(count),
      )
      levelSource = 1 - levelSource
    }
    const levels = this.shoreLevels[levelSource]!

    const steps: ComputeNode[] = []
    let source = 0
    for (let step = 2 ** Math.ceil(Math.log2(size)) / 2; step >= 1; step /= 2) {
      const from = this.seeds[source]!
      const to = this.seeds[1 - source]!
      steps.push(
        Fn(() => {
          const best = from.element(index).toVar()
          const bestDistance = float(1e12).toVar()
          If(best.notEqual(uint(NO_SEED)), () => {
            const dx = float(best.mod(65536)).sub(float(column))
            const dy = float(best.div(65536)).sub(float(row))
            bestDistance.assign(dx.mul(dx).add(dy.mul(dy)))
          })
          for (const ox of [-step, 0, step]) {
            for (const oy of [-step, 0, step]) {
              if (ox === 0 && oy === 0) continue
              const x = column.add(ox)
              const y = row.add(oy)
              If(x.greaterThanEqual(0).and(x.lessThan(size)).and(y.greaterThanEqual(0)).and(y.lessThan(size)), () => {
                const candidate = from.element(y.mul(size).add(x))
                If(candidate.notEqual(uint(NO_SEED)), () => {
                  const dx = float(candidate.mod(65536)).sub(float(column))
                  const dy = float(candidate.div(65536)).sub(float(row))
                  const distance = dx.mul(dx).add(dy.mul(dy))
                  If(distance.lessThan(bestDistance), () => {
                    bestDistance.assign(distance)
                    best.assign(candidate)
                  })
                })
              })
            }
          }
          to.element(index).assign(best)
        })().compute(count),
      )
      source = 1 - source
    }
    const nearest = this.seeds[source]!

    const shoreRaw = this.shoreBuffers[0]!
    const shoreBlurred = this.shoreBuffers[1]!
    const resolve = Fn(() => {
      const here = read(column, row) as unknown as Node<'vec4'>
      const drawn = here.w.greaterThan(0.5)
      const shoreSeed = nearest.element(index)
      const found = shoreSeed.notEqual(uint(NO_SEED)).and(drawn)
      const level = float(0).toVar()
      const towards = vec2(0).toVar()
      const distance = float(0).toVar()
      If(found, () => {
        const shoreColumn = int(shoreSeed.mod(65536))
        const shoreRow = int(shoreSeed.div(65536))
        const shorePlane = planeOf(float(shoreColumn), float(shoreRow))
        const herePlane = planeOf(float(column), float(row))
        // Where no water at or above sea level lies near the shore, its own level.
        const lowest = levels.element(shoreRow.mul(size).add(shoreColumn))
        const shoreLevel = select(lowest.lessThan(NO_LEVEL / 2), lowest, curved(read(shoreColumn, shoreRow).y, shorePlane))
        // Back under this texel's: the plane curves away from the ellipsoid.
        level.assign(shoreLevel.sub(herePlane.dot(herePlane).mul(this.curvature)))
        // The shore lies half a texel past its seed, the last water texel. On land the seed is the nearest water: the
        // offset turns round, so it points inland on both sides and the distance changes sign.
        const offset = shorePlane.sub(herePlane)
        const water = isWater(here)
        const reach = offset.length().add(metresPerTexel.mul(0.5))
        towards.assign(select(water, offset, offset.negate()))
        distance.assign(select(water, reach, reach.negate()))
      })
      const shoreWeight = select(found, float(1), float(0))
      const value = vec4(
        // Where no tile was drawn the cache knows nothing: not water to the masks, so the terrain draws its own sea there.
        select(drawn, here.x, float(0)),
        level.mul(shoreWeight),
        shoreWeight,
        select(drawn, max(here.z.negate(), 0), float(UNKNOWN_DEPTH_METERS)),
      )
      storageTexture(this.ground, ivec2(column, row), value).toStack()
      shoreRaw.element(index).assign(vec4(towards.mul(shoreWeight), distance.mul(shoreWeight), shoreWeight))
    })().compute(count)

    // The distance to the nearest seed rises in scallops along a coast the texels stair-step: smoothed over a few texels
    // (a separable binomial blur), the surf's crests lie along the coast instead.
    const blur = (from: StorageBufferNode<'vec4'>, along: [number, number], write: (value: Node<'vec4'>) => void) =>
      Fn(() => {
        const sum = vec4(0).toVar()
        for (const [offset, weight] of SHORE_BLUR) {
          const x = clamp(column.add(along[0] * offset) as never, 0, size - 1) as unknown as Node<'int'>
          const y = clamp(row.add(along[1] * offset) as never, 0, size - 1) as unknown as Node<'int'>
          sum.addAssign(from.element(y.mul(size).add(x)).mul(weight))
        }
        write(sum)
      })().compute(count)
    const across = blur(shoreRaw, [1, 0], value => shoreBlurred.element(index).assign(value))
    const down = blur(shoreBlurred, [0, 1], value => storageTexture(this.shore, ivec2(column, row), value).toStack())

    return [fill, seed, levelInit, ...levelSteps, ...steps, resolve, across, down]
  }

  /**
   * Draws the cache again if the mesh moved (`centre`, `halfSizeMeters`, given in plane metres) or the tiles changed.
   * `earth` is the object whose frame is ECEF.
   */
  update(renderer: WebGPURenderer | undefined, terrain: Terrain | null, earth: Object3D, centre: Vector2, halfSizeMeters: number): void {
    const { surface } = this
    const key = `${centre.x},${centre.y},${halfSizeMeters},${surface.anchorVersion},${surface.seaLevelMeters}`
    const now = performance.now()
    const moved = key !== this.laidKey || terrain !== this.laidTerrain
    const tilesChanged = terrain !== null && terrain.visibleTilesVersion !== this.laidTilesVersion && now - this.laidAtMilliseconds >= WAVE_DEPTH_CACHE_REFRESH_SECONDS * 1000
    if (!moved && !tilesChanged) return
    this.laidKey = key
    this.laidTerrain = terrain
    this.laidAtMilliseconds = now
    this.centre.value.copy(centre)
    this.halfSizeMeters.value = halfSizeMeters
    this.curvature.value = 1 / (2 * surface.curvatureRadiusMeters)
    if (renderer === undefined || terrain === null) {
      this.valid.value = 0
      return
    }
    this.laidTilesVersion = terrain.visibleTilesVersion
    this.seaLevel.value = surface.seaLevelMeters
    const { camera } = this
    camera.left = -halfSizeMeters
    camera.right = halfSizeMeters
    camera.top = halfSizeMeters
    camera.bottom = -halfSizeMeters
    camera.near = 1
    camera.far = 2 * CAMERA_HEIGHT_METERS
    camera.updateProjectionMatrix()
    // Over the centre, axes along the plane's (x east, y north, z up): it looks down.
    camera.matrixWorld.multiplyMatrices(earth.matrixWorld, surface.planeFrame).multiply(scratchMatrix.makeTranslation(centre.x, centre.y, CAMERA_HEIGHT_METERS))
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    // Cleared to nothing drawn (alpha 0).
    const drawn = terrain.renderTiles(renderer, camera, this.target, this.material, CLEAR_COLOR, 0)
    if (drawn) void renderer.compute(this.kernels)
    this.valid.value = drawn ? 1 : 0
  }

  /** The ground at a point of the plane, in any shader stage; `fallbackSurfaceMeters` where no shore is in reach. */
  sample(plane: Node<'vec2'>, fallbackSurfaceMeters: Node<'float'>): WaveGround {
    const uv = plane.sub(this.centre).div(this.halfSizeMeters.mul(2)).add(0.5)
    const texel = this.sampler.sample(vec2(uv)).level(float(0))
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1))
    const trusted = this.valid.mul(select(inside, float(1), float(0)))
    // Levels come weighted by whether a shore was found, so filtering blends towards the fallback where none was.
    const shore = texel.z.mul(trusted)
    const level = texel.y.div(max(texel.z, 1e-4))
    return {
      water: float(1).add(texel.x.sub(1).mul(trusted)) as unknown as Node<'float'>,
      surfaceMeters: fallbackSurfaceMeters.add(level.sub(fallbackSurfaceMeters).mul(shore)) as unknown as Node<'float'>,
      depthMeters: float(UNKNOWN_DEPTH_METERS).add(texel.w.sub(UNKNOWN_DEPTH_METERS).mul(trusted)) as unknown as Node<'float'>,
      known: trusted as unknown as Node<'float'>,
    }
  }

  /**
   * The nearest shore from a point of the plane, in any shader stage: filtered, so the distance and the way to the shore
   * turn smoothly round a headland or into a bay. Unknown (`known` 0) where no shore is in reach.
   */
  sampleShore(plane: Node<'vec2'>): WaveShore {
    const uv = plane.sub(this.centre).div(this.halfSizeMeters.mul(2)).add(0.5)
    const texel = this.shoreSampler.sample(vec2(uv)).level(float(0))
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1))
    const found = texel.w.mul(this.valid).mul(select(inside, float(1), float(0)))
    const towards = texel.xy
    return {
      distanceMeters: texel.z.div(max(texel.w, 1e-4)) as unknown as Node<'float'>,
      towardsShore: towards.div(max(towards.length(), 1e-6)) as unknown as Node<'vec2'>,
      known: smoothstep(0.5, 1, found) as unknown as Node<'float'>,
    }
  }

  dispose(): void {
    for (const kernel of this.kernels) kernel.dispose()
    for (const seeds of this.seeds) seeds.value.dispose()
    for (const buffer of this.shoreBuffers) buffer.value.dispose()
    for (const levels of this.shoreLevels) levels.value.dispose()
    this.target.dispose()
    this.ground.dispose()
    this.shore.dispose()
    this.material.dispose()
  }
}

const CLEAR_COLOR = new Color(1, 0, 0)
/** The steps, in texels, of the passes spreading the lowest water level: it reaches 63 texels (1 km on the outer ring). */
const SHORE_LEVEL_STEPS = [32, 16, 8, 4, 2, 1]
/** No water at or above sea level in reach. */
const NO_LEVEL = 1e9
/** The shore's blur, each way: offsets in texels and binomial weights (1 6 15 20 15 6 1, over 64). */
const SHORE_BLUR: ReadonlyArray<readonly [number, number]> = [-3, -2, -1, 0, 1, 2, 3].map((offset, index) => [offset, [1, 6, 15, 20, 15, 6, 1][index]! / 64] as const)
const scratchMatrix = new Matrix4()
