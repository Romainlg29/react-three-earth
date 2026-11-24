// Main-thread side of raster, hillshade and colour relief layers: draws them into a region of a map style, at
// their place among the vector layers. Each layer type is a handler (`RasterLayerTypeRenderer`) keyed by type.
import {
  DataTexture,
  DoubleSide,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RenderTarget,
  RGBAFormat,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  type Object3D,
} from 'three'
import {
  abs,
  acos,
  atan,
  clamp,
  cos,
  cosh,
  dot,
  float,
  floor,
  Fn,
  If,
  int,
  ivec2,
  length,
  Loop,
  max,
  min,
  mix,
  mod,
  pow,
  select,
  sin,
  sqrt,
  sRGBTransferEOTF,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu'

import type { RasterLayerSummary, RasterLayerType, RasterTileData, TileRequest } from '../worker/types.js'
import { HILLSHADE_METHODS, MAXIMUM_COLOR_RELIEF_STOPS, MAXIMUM_HILLSHADE_LIGHTS, type ColorReliefPaint, type HillshadePaint, type RasterPaint } from './rasterLayers.js'

/** Earth's equatorial circumference in meters (WGS84), for Web Mercator distances. */
const EQUATORIAL_CIRCUMFERENCE_METERS = 2 * Math.PI * 6378137

/** Written where an elevation sample has no tile; anything below `NO_DATA_THRESHOLD` counts as missing. */
const NO_DATA_ELEVATION = -1e9
const NO_DATA_THRESHOLD = -1e8

/** A raster tile of a region, as `MapStyleOverlay` lists them, with its decoded content. */
export interface RasterRegionTile {
  request: TileRequest
  /** Unwrapped column (may lie outside 0 to 2^z − 1 next to the antimeridian). */
  column: number
  /** Ring tiles around the region: elevation sources read them for the slopes at the region's edge. */
  textOnly: boolean
  /** Index in the region's tile list: the draw order within a layer group. */
  order: number
  raster: RasterTileData
}

/** A mesh to draw in the region pass at `renderOrder` (`group × 10 000 + tile`), like the vector layers'. */
export interface PlacedRasterMesh {
  mesh: Mesh
  renderOrder: number
}

/** What one region draw needs. */
export interface RasterRegion {
  /** The region in normalised Web Mercator (y up): minimum x, minimum y, maximum x, maximum y. */
  range: readonly number[]
  /** The zoom the region is drawn at. */
  level: number
  /** The region texture's size in pixels. */
  resolution: number
  layers: readonly RasterLayerSummary[]
  tiles: readonly RasterRegionTile[]
}

/**
 * The elevation of a region and its slopes, for the hillshade and colour relief layers of one `raster-dem`
 * source: a texture on the source's own pixel grid, so neighbouring regions sample the same values at their shared
 * edge (no seams), with the mapping from region coordinates to it.
 */
interface ElevationField {
  texture: Texture
  /** Texture coordinates from region coordinates: `u = x × a + b`, `v` (from the top) `= y × c + d`. */
  mapping: Vector4
  /** Texels per side of the texture. */
  size: number
}

/** Per-mesh values the shared materials read (`onObjectUpdate`). */
interface RasterMeshValues {
  texture?: Texture
  textureSize?: Vector2
  paint?: object
  elevation?: ElevationField
  ramp?: { texture: DataTexture; count: number }
}

/** How the main thread draws one raster layer type: its material, and the meshes of one layer in one region. */
export interface RasterLayerTypeRenderer {
  readonly material: MeshBasicNodeMaterial
  dispose(): void
}

function valuesOf(object: Object3D | null | undefined): RasterMeshValues {
  return (object?.userData.raster as RasterMeshValues | undefined) ?? {}
}

const emptyTexture = new Texture()

/** A colour in premultiplied sRGB (MapLibre's shader space) to the region pass's linear, straight alpha. */
function toLinearStraight(premultipliedColor: Node<'vec4'>, alpha: Node<'float'>): Node<'vec4'> {
  const straight = premultipliedColor.rgb.div(max(premultipliedColor.a, float(1e-6)))
  return vec4(sRGBTransferEOTF(clamp(straight, 0, 1) as unknown as Node<'vec3'>) as unknown as Node<'vec3'>, premultipliedColor.a.mul(alpha)) as unknown as Node<'vec4'>
}

/** Texture coordinates of the nearest texel's centre, for `*-resampling: nearest`. */
function snapToTexel(coordinate: Node<'vec2'>, size: Node<'vec2'>): Node<'vec2'> {
  return floor(coordinate.mul(size)).add(0.5).div(size) as unknown as Node<'vec2'>
}

function createLayerMaterial(): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false, side: DoubleSide })
}

/**
 * `raster` layers: MapLibre's raster program (hue rotation, saturation, contrast, brightness), in sRGB space as
 * MapLibre computes it, then converted to linear for the region pass.
 */
function createRasterMaterial(): MeshBasicNodeMaterial {
  const paint = (object: Object3D | null | undefined) => valuesOf(object).paint as RasterPaint | undefined
  const image = texture(emptyTexture).onObjectUpdate(({ object }, self) => {
    self.value = valuesOf(object).texture ?? emptyTexture
  })
  const size = uniform(new Vector2(1, 1)).onObjectUpdate(({ object }, self) => self.value.copy(valuesOf(object).textureSize ?? self.value.set(1, 1)))
  const opacity = uniform(1).onObjectUpdate(({ object }) => paint(object)?.opacity ?? 0)
  const spin = uniform(new Vector3(1, 0, 0)).onObjectUpdate(({ object }, self) => self.value.fromArray(paint(object)?.spinWeights ?? [1, 0, 0]))
  const brightnessMinimum = uniform(0).onObjectUpdate(({ object }) => paint(object)?.brightnessMinimum ?? 0)
  const brightnessMaximum = uniform(1).onObjectUpdate(({ object }) => paint(object)?.brightnessMaximum ?? 1)
  const saturation = uniform(0).onObjectUpdate(({ object }) => paint(object)?.saturationFactor ?? 0)
  const contrast = uniform(1).onObjectUpdate(({ object }) => paint(object)?.contrastFactor ?? 1)
  const nearest = uniform(0).onObjectUpdate(({ object }) => (paint(object)?.nearest === true ? 1 : 0))
  const material = createLayerMaterial()
  material.colorNode = Fn(() => {
    // Quad uv has v = 1 at the north edge; decoded tiles have v = 0 at the image top (the imagery compositor's convention).
    const coordinate = uv().flipY() as unknown as Node<'vec2'>
    const color = image.sample(mix(coordinate, snapToTexel(coordinate, size as unknown as Node<'vec2'>), nearest)) as unknown as Node<'vec4'>
    const rgb = color.rgb
    const spun = vec3(dot(rgb, spin.xyz), dot(rgb, spin.zxy), dot(rgb, spin.yzx))
    // MapLibre averages the colour before the rotation.
    const average = color.r.add(color.g).add(color.b).div(3)
    const saturated = spun.add(average.sub(spun).mul(saturation))
    const contrasted = saturated.sub(0.5).mul(contrast).add(0.5)
    const bright = mix(vec3(brightnessMinimum), vec3(brightnessMaximum), contrasted)
    return vec4(sRGBTransferEOTF(clamp(bright, 0, 1) as unknown as Node<'vec3'>) as unknown as Node<'vec3'>, color.a.mul(opacity))
  })()
  return material
}

/** Samples the region's elevation field: slopes east and south (m/m) in xy, elevation in z, coverage in w. */
function sampleElevationField(object: (object: Object3D | null | undefined) => RasterMeshValues, nearest: Node<'float'>): Node<'vec4'> {
  const field = texture(emptyTexture).onObjectUpdate(({ object: mesh }, self) => {
    self.value = object(mesh).elevation?.texture ?? emptyTexture
  })
  // Not mergeable: `color-relief` samples it beside its ramp, and both start on the same placeholder texture, which
  // three would merge into one when it builds the shader (see `wrapOverlaysNodeMaterial`).
  field.mergeable = false
  const mapping = uniform(new Vector4()).onObjectUpdate(({ object: mesh }, self) => self.value.copy(object(mesh).elevation?.mapping ?? self.value.set(0, 0, 0, 0)))
  const size = uniform(1).onObjectUpdate(({ object: mesh }) => object(mesh).elevation?.size ?? 1)
  // The region quad's uv is the region coordinate (y up, north).
  const region = uv()
  const coordinate = vec2(region.x.mul(mapping.x).add(mapping.y), region.y.mul(mapping.z).add(mapping.w)) as unknown as Node<'vec2'>
  const texelSize = vec2(size, size) as unknown as Node<'vec2'>
  return field.sample(mix(coordinate, snapToTexel(coordinate, texelSize), nearest)) as unknown as Node<'vec4'>
}

/** `x mod y`, always positive (as GLSL's `mod`, and TSL's on both backends). */
function positiveModulo(x: Node<'float'>, y: number): Node<'float'> {
  return mod(x, float(y)) as unknown as Node<'float'>
}

/**
 * `hillshade` layers: MapLibre 5's hillshade program, every `hillshade-method` (standard, basic, combined, igor,
 * multidirectional), on slopes computed from the region's elevation field.
 */
function createHillshadeMaterial(): MeshBasicNodeMaterial {
  const paint = (object: Object3D | null | undefined) => valuesOf(object).paint as HillshadePaint | undefined
  const method = uniform(0).onObjectUpdate(({ object }) => paint(object)?.method ?? 0)
  const exaggeration = uniform(0.5).onObjectUpdate(({ object }) => paint(object)?.exaggeration ?? 0.5)
  const slopeScale = uniform(1).onObjectUpdate(({ object }) => paint(object)?.slopeScale ?? 1)
  const nearest = uniform(0).onObjectUpdate(({ object }) => (paint(object)?.nearest === true ? 1 : 0))
  const accent = uniform(new Vector4()).onObjectUpdate(({ object }, self) => self.value.fromArray(paint(object)?.accentColor ?? [0, 0, 0, 0]))
  const lightCount = uniform(1).onObjectUpdate(({ object }) => paint(object)?.directionsRadians.length ?? 1)
  const lights = Array.from({ length: MAXIMUM_HILLSHADE_LIGHTS }, (_, index) => ({
    direction: uniform(0).onObjectUpdate(({ object }) => paint(object)?.directionsRadians[index] ?? 0),
    altitude: uniform(0).onObjectUpdate(({ object }) => paint(object)?.altitudesRadians[index] ?? 0),
    shadow: uniform(new Vector4()).onObjectUpdate(({ object }, self) => self.value.fromArray(paint(object)?.shadowColors[index] ?? [0, 0, 0, 0])),
    highlight: uniform(new Vector4()).onObjectUpdate(({ object }, self) => self.value.fromArray(paint(object)?.highlightColors[index] ?? [0, 0, 0, 0])),
  }))
  const material = createLayerMaterial()
  material.colorNode = Fn(() => {
    const field = sampleElevationField(valuesOf, nearest as unknown as Node<'float'>)
    const deriv = field.xy.mul(slopeScale)
    const PI = Math.PI
    const [first] = lights as [(typeof lights)[number]]
    const aspectOf = (d: Node<'vec2'>) => select(d.x.notEqual(0), atan(d.y, d.x.negate()), float(PI / 2).mul(select(d.y.greaterThan(0), float(1), float(-1))))

    // standard: MapLibre's original algorithm
    const standard = (() => {
      const azimuth = first.direction.add(PI)
      const base = float(1.875).sub(exaggeration.mul(1.75))
      const maximum = 0.5 * PI
      const slope = atan(length(deriv).mul(1.25))
      const scaledSlope = select(exaggeration.notEqual(0.5), pow(base, slope).sub(1).div(pow(base, float(maximum)).sub(1)).mul(maximum), slope)
      const intensity = clamp(exaggeration.mul(2), 0, 1)
      const accentColor = float(1).sub(cos(scaledSlope)).mul(accent).mul(intensity)
      const shade = abs(positiveModulo(aspectOf(deriv as unknown as Node<'vec2'>).add(azimuth).div(PI).add(0.5), 2).sub(1))
      const shadeColor = mix(first.shadow, first.highlight, shade).mul(sin(scaledSlope)).mul(intensity)
      return accentColor.mul(float(1).sub(shadeColor.a)).add(shadeColor)
    })()

    // GDAL's algorithms work on slopes scaled by the exaggeration.
    const scaled = deriv.mul(exaggeration).mul(2)
    const normalLength = sqrt(float(1).add(dot(scaled, scaled)))
    const incidence = (cosineAzimuth: Node<'float'>, sineAzimuth: Node<'float'>, altitude: Node<'float'>) =>
      sin(altitude).sub(scaled.y.mul(cosineAzimuth).mul(cos(altitude)).sub(scaled.x.mul(sineAzimuth).mul(cos(altitude)))).div(normalLength)
    const basicLight = (light: (typeof lights)[number], cosineAzimuth: Node<'float'>, sineAzimuth: Node<'float'>) => {
      const shade = clamp(incidence(cosineAzimuth, sineAzimuth, light.altitude as unknown as Node<'float'>), 0, 1)
      return select(shade.greaterThan(0.5), light.highlight.mul(shade.mul(2).sub(1)), light.shadow.mul(float(1).sub(shade.mul(2))))
    }
    const firstAzimuth = first.direction.add(PI)
    const basic = basicLight(first, cos(firstAzimuth) as unknown as Node<'float'>, sin(firstAzimuth) as unknown as Node<'float'>)

    let multidirectional: Node<'vec4'> = vec4(0) as unknown as Node<'vec4'>
    lights.forEach((light, index) => {
      const contribution = basicLight(light, cos(light.direction).negate() as unknown as Node<'float'>, sin(light.direction).negate() as unknown as Node<'float'>)
      multidirectional = multidirectional.add(select(lightCount.greaterThan(index), contribution.div(lightCount), vec4(0))) as unknown as Node<'vec4'>
    })

    const combined = (() => {
      const angle = clamp(acos(clamp(incidence(cos(firstAzimuth) as unknown as Node<'float'>, sin(firstAzimuth) as unknown as Node<'float'>, first.altitude as unknown as Node<'float'>), -1, 1)), 0, PI / 2)
      const steepness = atan(length(scaled)).mul(4 / PI / PI)
      return first.shadow.mul(angle.mul(steepness)).add(first.highlight.mul(float(PI / 2).sub(angle).mul(steepness)))
    })()

    const igor = (() => {
      const slopeStrength = atan(length(scaled)).mul(2 / PI)
      const aspectStrength = float(1).sub(abs(positiveModulo(aspectOf(scaled as unknown as Node<'vec2'>).add(firstAzimuth).div(PI).add(0.5), 2).sub(1)))
      return first.shadow.mul(slopeStrength.mul(aspectStrength)).add(first.highlight.mul(slopeStrength.mul(float(1).sub(aspectStrength))))
    })()

    const index = (name: (typeof HILLSHADE_METHODS)[number]) => HILLSHADE_METHODS.indexOf(name)
    const color = select(
      method.equal(index('basic')),
      basic,
      select(method.equal(index('combined')), combined, select(method.equal(index('igor')), igor, select(method.equal(index('multidirectional')), multidirectional, standard))),
    ) as unknown as Node<'vec4'>
    return toLinearStraight(color, field.w as unknown as Node<'float'>)
  })()
  return material
}

/** `color-relief` layers: the colour ramp at the region's elevation, searched as MapLibre does (binary search, then linear). */
function createColorReliefMaterial(): MeshBasicNodeMaterial {
  const paint = (object: Object3D | null | undefined) => valuesOf(object).paint as ColorReliefPaint | undefined
  const opacity = uniform(1).onObjectUpdate(({ object }) => paint(object)?.opacity ?? 0)
  const nearest = uniform(0).onObjectUpdate(({ object }) => (paint(object)?.nearest === true ? 1 : 0))
  const ramp = texture(emptyTexture).onObjectUpdate(({ object }, self) => {
    self.value = valuesOf(object).ramp?.texture ?? emptyTexture
  })
  ramp.mergeable = false
  const count = uniform(1, 'int').onObjectUpdate(({ object }) => valuesOf(object).ramp?.count ?? 1)
  const material = createLayerMaterial()
  material.colorNode = Fn(() => {
    const field = sampleElevationField(valuesOf, nearest as unknown as Node<'float'>)
    const elevation = field.z
    const stopElevation = (stop: Node<'int'>) => ramp.load(ivec2(stop, int(0))).x
    const low = int(0).toVar()
    const high = count.sub(1).toVar()
    // 2^8 = MAXIMUM_COLOR_RELIEF_STOPS: eight halvings find any stop.
    Loop(Math.ceil(Math.log2(MAXIMUM_COLOR_RELIEF_STOPS)), () => {
      If(high.sub(low).greaterThan(1), () => {
        const middle = low.add(high).div(2)
        If(elevation.lessThan(stopElevation(middle as unknown as Node<'int'>)), () => {
          high.assign(middle)
        }).Else(() => {
          low.assign(middle)
        })
      })
    })
    const lowElevation = stopElevation(low as unknown as Node<'int'>)
    const highElevation = stopElevation(high as unknown as Node<'int'>)
    const blend = clamp(elevation.sub(lowElevation).div(max(highElevation.sub(lowElevation), float(1e-6))), 0, 1)
    const color = mix(ramp.load(ivec2(low, int(1))), ramp.load(ivec2(high, int(1))), blend) as unknown as Node<'vec4'>
    return toLinearStraight(color, opacity.mul(field.w) as unknown as Node<'float'>)
  })()
  return material
}

/** Copies a DEM tile's elevations into the region's elevation grid, at the source's own pixels (nearest). */
function createElevationCopyMaterial(): MeshBasicNodeMaterial {
  const elevations = texture(emptyTexture).onObjectUpdate(({ object }, self) => {
    self.value = valuesOf(object).texture ?? emptyTexture
  })
  const size = uniform(new Vector2(1, 1)).onObjectUpdate(({ object }, self) => self.value.copy(valuesOf(object).textureSize ?? self.value.set(1, 1)))
  const material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, side: DoubleSide })
  material.fragmentNode = Fn(() => {
    // Rows from the north: v from the top of the tile.
    const coordinate = uv().flipY()
    const texel = clamp(floor(coordinate.mul(size)), vec2(0), size.sub(1))
    return vec4(elevations.load(ivec2(texel)).x, 0, 0, 1)
  })()
  return material
}

/**
 * Slopes from the elevation grid (MapLibre's `hillshade_prepare`: a Sobel kernel over the 8 neighbours, divided by the
 * ground distance between texels at the texel's latitude), with the elevation and coverage. A missing neighbour takes
 * the centre's elevation, so the edge of the data stays flat instead of a cliff.
 */
function createSlopeMaterial() {
  const elevationGrid = texture(emptyTexture)
  /** Texels per side; normalised Web Mercator t (from the north) of the first row and between rows; meters between rows at the equator. */
  const size = uniform(1)
  const top = uniform(0)
  const step = uniform(0)
  const meters = uniform(1)
  const material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, side: DoubleSide })
  material.fragmentNode = Fn(() => {
    // The texel's centre, counted from the left and from the top; the elevation grid has a one-texel border.
    const texel = vec2(uv().x.mul(size), float(1).sub(uv().y).mul(size))
    const at = (dx: number, dy: number) => elevationGrid.sample(texel.add(vec2(1 + dx, 1 + dy)).div(size)).x
    const center = at(0, 0)
    const sample = (dx: number, dy: number) => {
      const value = at(dx, dy)
      return select(value.lessThan(NO_DATA_THRESHOLD), center, value)
    }
    const [a, b, c, d, f, g, h, i] = [sample(-1, -1), sample(0, -1), sample(1, -1), sample(-1, 0), sample(1, 0), sample(-1, 1), sample(0, 1), sample(1, 1)]
    // Normalised Web Mercator y from the top of the texel's row: cos(latitude) = 1 / cosh(π (1 − 2 t)).
    const row = texel.y.sub(0.5)
    const fromTop = top.add(row.mul(step))
    const groundStep = meters.div(cosh(float(Math.PI).mul(float(1).sub(fromTop.mul(2)))))
    const east = c.add(f.mul(2)).add(i).sub(a.add(d.mul(2)).add(g)).div(groundStep.mul(8))
    const south = g.add(h.mul(2)).add(i).sub(a.add(b.mul(2)).add(c)).div(groundStep.mul(8))
    const covered = select(center.lessThan(NO_DATA_THRESHOLD), float(0), float(1))
    return vec4(east.mul(covered), south.mul(covered), center.mul(covered), covered)
  })()
  return { material, elevationGrid, size, top, step, meters }
}

/** Fills the elevation grid with "no data" before the tiles are drawn over it. */
function createNoDataMaterial(): MeshBasicNodeMaterial {
  // Data passes write `fragmentNode`: the colour path (lighting, opacity) would clamp negative values.
  const material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, side: DoubleSide })
  material.fragmentNode = vec4(NO_DATA_ELEVATION, 0, 0, 1)
  return material
}

/** A quad spanning [0, 1] × [−1, 0]: a tile placed by its north-west corner. */
function createTileGeometry(): PlaneGeometry {
  const geometry = new PlaneGeometry(1, 1)
  geometry.translate(0.5, -0.5, 0)
  return geometry
}

/**
 * Draws a map style's raster layers (`raster`, `hillshade`, `color-relief`) into a region, at their place in the
 * style. Raster tiles are drawn as one quad per tile. Elevation layers read a field built once per region and
 * source: the DEM tiles (with a ring of neighbours) are copied onto the source's own pixel grid with a one-texel
 * border, slopes are computed there, and the layers sample it bilinearly, so slopes match across tile and region
 * edges.
 */
export class RasterLayerRenderer {
  /** Renderers by layer type: a new raster layer type is a new entry, not a branch. */
  protected readonly renderers = new Map<RasterLayerType, { material: MeshBasicNodeMaterial }>()
  protected readonly textures = new Map<RasterTileData, Texture>()
  protected readonly ramps = new Map<string, { key: string; texture: DataTexture; count: number }>()
  protected readonly tileGeometry = createTileGeometry()
  protected readonly regionGeometry = new PlaneGeometry(1, 1).translate(0.5, 0.5, 0)
  protected readonly meshPool: Mesh[] = []
  protected meshesUsed = 0
  protected readonly elevationCopyMaterial = createElevationCopyMaterial()
  protected readonly noDataMaterial = createNoDataMaterial()
  protected readonly slopes = createSlopeMaterial()
  protected readonly elevationScene = new Scene()
  protected readonly elevationCamera = new OrthographicCamera(0, 1, 1, 0, -1, 1)
  protected readonly slopeScene = new Scene()
  protected readonly slopeCamera = new OrthographicCamera(0, 1, 1, 0, -1, 1)
  protected readonly slopeQuad: Mesh
  protected elevationTarget: RenderTarget | null = null
  protected readonly fieldTargets: RenderTarget[] = []

  constructor() {
    this.renderers.set('raster', { material: createRasterMaterial() })
    this.renderers.set('hillshade', { material: createHillshadeMaterial() })
    this.renderers.set('color-relief', { material: createColorReliefMaterial() })
    this.elevationScene.matrixWorldAutoUpdate = true
    this.slopeScene.matrixWorldAutoUpdate = true
    this.slopeQuad = new Mesh(this.regionGeometry, this.slopes.material)
    this.slopeQuad.frustumCulled = false
  }

  /**
   * Builds the region's raster meshes. Elevation fields are drawn now (their own targets), so call before the region
   * pass sets its render target. The meshes are valid until the next call.
   */
  prepareRegion(renderer: WebGPURenderer, region: RasterRegion): PlacedRasterMesh[] {
    this.meshesUsed = 0
    const placed: PlacedRasterMesh[] = []
    const zoom = Math.min(Math.max(region.level, 0), 24)
    const fields = new Map<string, ElevationField | null>()
    for (const layer of region.layers) {
      const paint = layer.paintByZoom[zoom]
      if (paint == null) continue
      const material = this.renderers.get(layer.type)?.material
      if (material === undefined) continue
      const tiles = region.tiles.filter(tile => tile.request.sourceId === layer.source)
      if (layer.type === 'raster') {
        for (const tile of tiles) {
          if (tile.textOnly || tile.raster.kind !== 'image') continue
          const mesh = this.placeTile(this.nextMesh(material), tile, region.range)
          mesh.userData.raster = { texture: this.textureFor(tile.raster), textureSize: new Vector2(tile.raster.width, tile.raster.height), paint } satisfies RasterMeshValues
          placed.push({ mesh, renderOrder: layer.group * 10_000 + tile.order })
        }
        continue
      }
      let field = fields.get(layer.source)
      if (field === undefined) {
        field = this.drawElevationField(renderer, region, tiles, fields.size)
        fields.set(layer.source, field)
      }
      if (field === null) continue
      const mesh = this.nextMesh(material)
      mesh.geometry = this.regionGeometry
      mesh.position.set(0, 0, 0)
      mesh.scale.set(1, 1, 1)
      const values: RasterMeshValues = { paint, elevation: field }
      if (layer.type === 'color-relief') values.ramp = this.rampFor(layer.id, paint as unknown as ColorReliefPaint)
      mesh.userData.raster = values
      placed.push({ mesh, renderOrder: layer.group * 10_000 })
    }
    return placed
  }

  /** Frees a raster tile's GPU copy and its decoded image, when its bucket leaves the cache. */
  releaseTile(raster: RasterTileData | null | undefined): void {
    if (raster == null) return
    this.textures.get(raster)?.dispose()
    this.textures.delete(raster)
    if (raster.kind === 'image') raster.image.close?.()
  }

  /** Frees colour ramps of layers that are gone. */
  pruneLayers(layerIds: ReadonlySet<string>): void {
    for (const [id, ramp] of this.ramps) {
      if (layerIds.has(id)) continue
      ramp.texture.dispose()
      this.ramps.delete(id)
    }
  }

  dispose(): void {
    for (const texture of this.textures.values()) texture.dispose()
    this.textures.clear()
    for (const ramp of this.ramps.values()) ramp.texture.dispose()
    this.ramps.clear()
    for (const { material } of this.renderers.values()) material.dispose()
    this.elevationCopyMaterial.dispose()
    this.noDataMaterial.dispose()
    this.slopes.material.dispose()
    this.tileGeometry.dispose()
    this.regionGeometry.dispose()
    this.elevationTarget?.dispose()
    for (const target of this.fieldTargets) target.dispose()
  }

  protected nextMesh(material: MeshBasicNodeMaterial): Mesh {
    let mesh = this.meshPool[this.meshesUsed]
    if (mesh === undefined) {
      mesh = new Mesh(this.tileGeometry, material)
      mesh.frustumCulled = false
      this.meshPool.push(mesh)
    }
    this.meshesUsed++
    mesh.material = material
    mesh.geometry = this.tileGeometry
    return mesh
  }

  /** Places a tile quad in region coordinates (0 to 1, y up), computed in 64-bit here. */
  protected placeTile(mesh: Mesh, tile: RasterRegionTile, range: readonly number[]): Mesh {
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
    const width = maximumX - minimumX
    const height = maximumY - minimumY
    const tileSize = 1 / 2 ** tile.request.z
    mesh.position.set((tile.column * tileSize - minimumX) / width, (1 - tile.request.y * tileSize - minimumY) / height, 0)
    mesh.scale.set(tileSize / width, tileSize / height, 1)
    return mesh
  }

  protected textureFor(raster: RasterTileData): Texture {
    let texture = this.textures.get(raster)
    if (texture !== undefined) return texture
    if (raster.kind === 'image') {
      texture = new Texture(raster.image as unknown as HTMLImageElement)
      texture.colorSpace = NoColorSpace // MapLibre's raster maths run on the sRGB values
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
    } else {
      texture = new DataTexture(raster.elevations, raster.width, raster.height, RedFormat, FloatType)
      texture.minFilter = NearestFilter
      texture.magFilter = NearestFilter
    }
    texture.generateMipmaps = false
    texture.needsUpdate = true
    this.textures.set(raster, texture)
    return texture
  }

  /** The layer's colour ramp as a texture: elevations in row 0, premultiplied sRGB colours in row 1. */
  protected rampFor(layerId: string, paint: ColorReliefPaint): { texture: DataTexture; count: number } {
    const key = JSON.stringify([paint.elevations, paint.colors])
    const existing = this.ramps.get(layerId)
    if (existing?.key === key) return existing
    existing?.texture.dispose()
    const count = paint.elevations.length
    const data = new Float32Array(count * 2 * 4)
    paint.elevations.forEach((elevation, index) => {
      data[index * 4] = elevation
      data.set(paint.colors.slice(index * 4, index * 4 + 4), (count + index) * 4)
    })
    const texture = new DataTexture(data, count, 2, RGBAFormat, FloatType)
    texture.minFilter = NearestFilter
    texture.magFilter = NearestFilter
    texture.needsUpdate = true
    const ramp = { key, texture, count }
    this.ramps.set(layerId, ramp)
    return ramp
  }

  /**
   * Draws a region's elevation field for one source: null when the source has no tile there. The grid is the source's
   * pixel grid (every `stride`-th pixel when the region spans more pixels than its own texture), so its values do not
   * depend on the region, and two regions sharing an edge sample the same slopes along it.
   */
  protected drawElevationField(renderer: WebGPURenderer, region: RasterRegion, tiles: readonly RasterRegionTile[], index: number): ElevationField | null {
    const elevationTiles = tiles.filter(tile => tile.raster.kind === 'dem')
    const first = elevationTiles[0]
    if (first === undefined) return null
    const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = region.range
    const width = maximumX - minimumX
    const height = maximumY - minimumY
    const size = region.resolution + 4
    const { step, offset, firstColumn, lastColumn, firstRow, lastRow } = elevationFieldGrid(region.range, region.resolution, first.request.z, first.raster.width)
    if (lastColumn - firstColumn + 3 > size || lastRow - firstRow + 3 > size) return null

    // 1. Elevations on the grid, with a one-texel border, from the DEM tiles (ring included).
    const elevationTarget = this.getElevationTarget(size)
    const left = ((firstColumn - 1) * step + offset - minimumX) / width - step / width / 2
    const top = (1 - ((firstRow - 1) * step + offset) - minimumY) / height + step / height / 2
    const camera = this.elevationCamera
    camera.left = left
    camera.right = left + (size * step) / width
    camera.top = top
    camera.bottom = top - (size * step) / height
    camera.updateProjectionMatrix()
    const noData = this.nextMesh(this.noDataMaterial)
    noData.geometry = this.regionGeometry
    noData.position.set(camera.left, camera.bottom, 0)
    noData.scale.set(camera.right - camera.left, camera.top - camera.bottom, 1)
    noData.renderOrder = -1
    this.elevationScene.add(noData)
    for (const tile of elevationTiles) {
      if (tile.raster.kind !== 'dem') continue
      const mesh = this.placeTile(this.nextMesh(this.elevationCopyMaterial), tile, region.range)
      mesh.userData.raster = { texture: this.textureFor(tile.raster), textureSize: new Vector2(tile.raster.width, tile.raster.height) } satisfies RasterMeshValues
      mesh.renderOrder = 0
      this.elevationScene.add(mesh)
    }
    try {
      renderer.setRenderTarget(elevationTarget)
      renderer.render(this.elevationScene, camera)
    } finally {
      this.elevationScene.clear()
    }

    // 2. Slopes, elevation and coverage at each grid point of the field.
    const field = this.getFieldTarget(index, size)
    this.slopes.elevationGrid.value = elevationTarget.texture
    this.slopes.size.value = size
    this.slopes.top.value = firstRow * step + offset
    this.slopes.step.value = step
    this.slopes.meters.value = step * EQUATORIAL_CIRCUMFERENCE_METERS
    this.slopeScene.add(this.slopeQuad)
    try {
      renderer.setRenderTarget(field)
      renderer.render(this.slopeScene, this.slopeCamera)
    } finally {
      this.slopeScene.clear()
    }

    // Region coordinates to field texture coordinates (v from the top), in 64-bit here.
    const mapping = new Vector4(
      width / (step * size),
      ((minimumX - offset) / step - firstColumn + 0.5) / size,
      -height / (step * size),
      ((1 - minimumY - offset) / step - firstRow + 0.5) / size,
    )
    return { texture: field.texture, mapping, size }
  }

  /** The elevation grid: 32-bit float (slopes need centimetres at any height), sampled at texel centres only. */
  protected getElevationTarget(size: number): RenderTarget {
    if (this.elevationTarget !== null && this.elevationTarget.width === size) return this.elevationTarget
    this.elevationTarget?.dispose()
    this.elevationTarget = new RenderTarget(size, size, { type: FloatType, format: RedFormat, colorSpace: LinearSRGBColorSpace, depthBuffer: false, generateMipmaps: false, minFilter: NearestFilter, magFilter: NearestFilter })
    this.elevationTarget.texture.name = 'MapStyleElevationGrid'
    return this.elevationTarget
  }

  /** A field target per elevation source of the region (usually one): half float, filtered (slopes and elevation). */
  protected getFieldTarget(index: number, size: number): RenderTarget {
    const existing = this.fieldTargets[index]
    if (existing !== undefined && existing.width === size) return existing
    existing?.dispose()
    const target = new RenderTarget(size, size, { type: HalfFloatType, colorSpace: LinearSRGBColorSpace, depthBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter })
    target.texture.name = 'MapStyleElevationField'
    this.fieldTargets[index] = target
    return target
  }
}

/**
 * The grid of a region's elevation field: the source's pixel centres (every `stride`-th, a power of two, so the region
 * fits its texture), as indices in x from the west and in t = 1 − y from the north. Bilinear samples inside the
 * region need the grid points around it, so the range is rounded outwards.
 */
export function elevationFieldGrid(range: readonly number[], resolution: number, tileZoom: number, tilePixels: number) {
  const [minimumX = 0, minimumY = 0, maximumX = 0, maximumY = 0] = range
  const pixel = 1 / (2 ** tileZoom * tilePixels)
  const pixelsAcross = Math.max(maximumX - minimumX, maximumY - minimumY) / pixel
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(pixelsAcross / resolution) - 1e-9))
  const step = stride * pixel
  const offset = pixel / 2
  return {
    stride,
    step,
    offset,
    firstColumn: Math.floor((minimumX - offset) / step),
    lastColumn: Math.ceil((maximumX - offset) / step),
    firstRow: Math.floor((1 - maximumY - offset) / step),
    lastRow: Math.ceil((1 - minimumY - offset) / step),
  }
}
