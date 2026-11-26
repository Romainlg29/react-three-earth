import { terrainElevationMeters, terrainWaterLevelMeters, terrainWaterMask, type Terrain } from '@earthkit/globe'
import { Color, FloatType, HalfFloatType, LinearFilter, Matrix4, OrthographicCamera, RenderTarget, RGBAFormat, Vector2, type Object3D } from 'three'
import { abs, clamp, float, Fn, If, instancedArray, instanceIndex, int, ivec2, max, min, select, smoothstep, storageTexture, texture, uint, uniform, vec2, vec4 } from 'three/tsl'
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
  /**
   * The water's level over the wave plane, metres: sea level (`seaLevelOverPlaneMeters`) raised by the water's own level
   * where the terrain draws it elsewhere (a lake, a sea on the geoid).
   */
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
 * The level is the water's own surface as the terrain gives it (`terrainWaterLevelMeters`): sea level for water from
 * elevation (a raster DEM, its seafloor drawn or flattened), the drawn height under a quantized mesh's mask, so a lake
 * below sea level (the Dead Sea) or a sea on the geoid comes out right. Only flat water counts: a coarse tile's coastal
 * triangles climb into the land under the mask, so the water near a coast takes the level of the nearest flat water
 * instead, and the land near the water takes it too, so the mesh does not climb the beach.
 *
 * It covers the mesh's outer ring and is drawn again only when that ring moves (the camera crosses two of its cells),
 * the cells change size, the plane is laid again, or tiles change (at most every `WAVE_DEPTH_CACHE_REFRESH_SECONDS`):
 * one small draw of the tiles with a trivial shader and twenty-two compute dispatches, now and then. Half floats, filtered:
 * two samples a vertex (the ground and the shore). It also keeps the distance and way to the nearest shore, for the surf.
 */
export class WaveDepthCache {
  /** The tiles as drawn from above: water mask, the water's level and the elevation over sea level, 1 where drawn. */
  readonly target: RenderTarget
  /** What the mesh samples: water, the water's level over sea level (times `known`), `known` (1 where it is), depth. */
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
  protected readonly surface: WaveSurface
  protected readonly camera = new OrthographicCamera()
  protected readonly material = new MeshBasicNodeMaterial()
  protected readonly seaLevel = uniform(0)
  protected readonly sampler
  protected readonly shoreSampler
  protected readonly seeds: StorageBufferNode<'uint'>[]
  /** The shore before and between the passes of its blur. */
  protected readonly shoreBuffers: StorageBufferNode<'vec4'>[]
  /** The level of the nearest flat water (`WATER_LEVEL_STEPS` reach it), before and between its passes. */
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
    this.material.outputNode = vec4(terrainWaterMask, terrainWaterLevelMeters.sub(this.seaLevel), terrainElevationMeters.sub(this.seaLevel), 1)
    this.sampler = texture(this.ground)
    this.shoreSampler = texture(this.shore)
    this.seeds = [instancedArray(size * size, 'uint'), instancedArray(size * size, 'uint')]
    this.shoreBuffers = [instancedArray(size * size, 'vec4'), instancedArray(size * size, 'vec4')]
    this.shoreLevels = [instancedArray(size * size, 'float'), instancedArray(size * size, 'float')]
    this.kernels = this.createKernels(size)
  }

  /**
   * The shore pass: the water's level spread from its flat parts, seeds where water meets land, a jump flood carrying each
   * texel its nearest seed, then the ground texture and the way to the shore.
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

    const metresPerTexel = this.halfSizeMeters.mul(2 / size)
    const planeOf = (x: Node<'float'>, y: Node<'float'>) => vec2(x.add(0.5), y.add(0.5)).mul(metresPerTexel).sub(this.halfSizeMeters).add(this.centre)
    // The water's level, from its flat parts only. A quantized mesh's coastal triangles climb into the land under its
    // water mask, the more the coarser the tile, so the last water texels can stand metres above the sea; skirts in the
    // cracks between tiles hold their top's level. Flat water (each neighbour water within a few centimetres) is the
    // water's surface: a raster DEM's sea (all at sea level, its seafloor drawn or flattened), a quantized mesh's sea on
    // the geoid, a lake.
    const levelsFirst = this.shoreLevels[0]!
    const flatMeters = max(metresPerTexel.mul(FLAT_WATER_SLOPE), FLAT_WATER_METERS)
    const levelInit = Fn(() => {
      const here = read(column, row)
      const level = here.y
      const flatTo = (texel: Node<'vec4'>) => isWater(texel).and(abs(texel.y.sub(level)).lessThanEqual(flatMeters))
      const flat = isWater(here)
        .and(flatTo(read(column.add(1), row)))
        .and(flatTo(read(column.sub(1), row)))
        .and(flatTo(read(column, row.add(1))))
        .and(flatTo(read(column, row.sub(1))))
      levelsFirst.element(index).assign(select(flat, level, float(NO_LEVEL)))
    })().compute(count)
    // Spread to every texel without one (water near the coasts, and the land beside them) in passes of doubling steps:
    // each takes the lowest level found at the step, so the nearest flat water wins, out to 63 texels.
    const levelSteps: ComputeNode[] = []
    let levelSource = 0
    for (const step of WATER_LEVEL_STEPS) {
      const from = this.shoreLevels[levelSource]!
      const to = this.shoreLevels[1 - levelSource]!
      levelSteps.push(
        Fn(() => {
          const level = from.element(index).toVar()
          If(level.greaterThan(NO_LEVEL / 2), () => {
            for (const ox of [-step, 0, step]) {
              for (const oy of [-step, 0, step]) {
                if (ox === 0 && oy === 0) continue
                const x = clamp(column.add(ox) as never, 0, size - 1) as unknown as Node<'int'>
                const y = clamp(row.add(oy) as never, 0, size - 1) as unknown as Node<'int'>
                level.assign(min(level, from.element(y.mul(size).add(x))))
              }
            }
          })
          to.element(index).assign(level)
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
      const towards = vec2(0).toVar()
      const distance = float(0).toVar()
      If(found, () => {
        const shoreColumn = int(shoreSeed.mod(65536))
        const shoreRow = int(shoreSeed.div(65536))
        const shorePlane = planeOf(float(shoreColumn), float(shoreRow))
        const herePlane = planeOf(float(column), float(row))
        // The shore lies half a texel past its seed, the last water texel. On land the seed is the nearest water: the
        // offset turns round, so it points inland on both sides and the distance changes sign.
        const offset = shorePlane.sub(herePlane)
        const water = isWater(here)
        const reach = offset.length().add(metresPerTexel.mul(0.5))
        towards.assign(select(water, offset, offset.negate()))
        distance.assign(select(water, reach, reach.negate()))
      })
      const shoreWeight = select(found, float(1), float(0))
      // The nearest flat water's level; water with none in reach keeps its own, land with none lies at sea level.
      const spread = levels.element(index)
      const levelKnown = spread.lessThan(NO_LEVEL / 2)
      const level = select(levelKnown, spread, here.y)
      const levelWeight = select(drawn.and(levelKnown.or(isWater(here))), float(1), float(0))
      const value = vec4(
        // Where no tile was drawn the cache knows nothing: not water to the masks, so the terrain draws its own sea there.
        select(drawn, here.x, float(0)),
        // Over sea level, not over the plane: near 0 for a sea, so the half floats keep their millimetres.
        level.mul(levelWeight),
        levelWeight,
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

  /**
   * The ground at a point of the plane, in any shader stage. `seaLevelOverPlaneMeters` is where sea level lies over the
   * plane there (it curves away from it with the Earth): the water's level is that, raised by the cache's.
   */
  sample(plane: Node<'vec2'>, seaLevelOverPlaneMeters: Node<'float'>): WaveGround {
    const uv = plane.sub(this.centre).div(this.halfSizeMeters.mul(2)).add(0.5)
    const texel = this.sampler.sample(vec2(uv)).level(float(0))
    const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1))
    const trusted = this.valid.mul(select(inside, float(1), float(0)))
    // Levels come weighted by whether they are known, so filtering blends towards sea level where they are not.
    return {
      water: float(1).add(texel.x.sub(1).mul(trusted)) as unknown as Node<'float'>,
      surfaceMeters: seaLevelOverPlaneMeters.add(texel.y.mul(trusted)) as unknown as Node<'float'>,
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
/** The steps, in texels, of the passes spreading the flat water's level: nearest first, out to 63 texels. */
const WATER_LEVEL_STEPS = [1, 2, 4, 8, 16, 32]
/** No flat water in reach. */
const NO_LEVEL = 1e9
/** Water is flat where its neighbours' levels differ by at most this many metres, or this slope of a texel if more. */
const FLAT_WATER_METERS = 0.05
const FLAT_WATER_SLOPE = 2e-3
/** The shore's blur, each way: offsets in texels and binomial weights (1 6 15 20 15 6 1, over 64). */
const SHORE_BLUR: ReadonlyArray<readonly [number, number]> = [-3, -2, -1, 0, 1, 2, 3].map((offset, index) => [offset, [1, 6, 15, 20, 15, 6, 1][index]! / 64] as const)
const scratchMatrix = new Matrix4()
