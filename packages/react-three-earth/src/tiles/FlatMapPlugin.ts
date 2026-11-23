import type { Tile } from '3d-tiles-renderer'
import { BufferAttribute, BufferGeometry, InstancedBufferGeometry, Matrix3, Matrix4, Mesh, Vector2, type Intersection, type Material, type Object3D, type Raycaster } from 'three'
import { attribute, diffuseColor, output, float, instanceIndex, mat3, mix, normalGeometry, positionGeometry, smoothstep, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'

import type { ViewMorph } from '../view/ViewMorph.js'
import { setBaseOutputNode } from './wrapFadeNodeMaterial.js'
import {
  ecefToGeodetic,
  latitudeToMercatorY,
  longitudeToMercatorX,
  mercatorScaleFactor,
  unwrapLongitude,
  wrapMercatorXNear,
  WEB_MERCATOR_HALF_EXTENT_METERS,
  type GeodeticRadians,
} from '../view/webMercator.js'

/** Name of the vertex attribute holding each vertex's flat-map position, relative to the mesh's flat centre. */
export const FLAT_POSITION_ATTRIBUTE = 'positionFlat'
/**
 * Name of the vertex attribute holding each vertex's height as a vector in the mesh's frame: from the ellipsoid
 * straight up to the vertex (the ellipsoid normal times the height). Exaggeration adds it again, scaled.
 */
export const HEIGHT_OFFSET_ATTRIBUTE = 'heightOffset'

const FLAT_STATE = Symbol('FLAT_STATE')

/** Per-mesh morph state, read by the shared shader uniforms when the mesh is drawn. */
interface FlatMeshState {
  /** The mesh's centre in flat coordinates (Web Mercator metres): `positionFlat` is relative to it. */
  readonly centerXMeters: number
  readonly centerYMeters: number
  readonly centerZMeters: number
  /** Takes the mesh's own (globe) vertex positions into its flat frame. Identity on the globe. */
  readonly globeToFlat: Matrix4
  morph: number
  flatMapLuminance: number
  /** World copies drawn as instances: instance 0 is this many world widths from the mesh's own frame. */
  firstWorldCopyOffset: number
  /** The mesh's flat centre minus the anchor's, in Web Mercator metres: where the unroll front reaches it. */
  centerFromAnchorXMeters: number
  centerFromAnchorYMeters: number
  /** Whether `matrixWorld` holds the flat frame: only between `onBeforeRender` and `onAfterRender`. */
  flattened: boolean
  /** The terrain's exaggeration, for this draw. */
  exaggeration: number
}

type FlatMesh = Mesh & { [FLAT_STATE]?: FlatMeshState }

function getState(object: Object3D): FlatMeshState | undefined {
  return (object as FlatMesh)[FLAT_STATE]
}

const identityMatrix = new Matrix4()
const globeToFlatUniform = uniform(new Matrix4()).onObjectUpdate(({ object }, self) => {
  const state = object === null ? undefined : getState(object)
  self.value = state?.globeToFlat ?? identityMatrix
})
const morphUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getState(object)?.morph ?? 0)))
const firstWorldCopyOffsetUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getState(object)?.firstWorldCopyOffset ?? 0)))
const centerFromAnchorUniform = uniform(new Vector2()).onObjectUpdate(({ object }, self) => {
  const state = object === null ? undefined : getState(object)
  self.value.set(state?.centerFromAnchorXMeters ?? 0, state?.centerFromAnchorYMeters ?? 0)
})
const flatMapLuminanceUniform = uniform(1).onObjectUpdate(({ object }) => (object === null ? 1 : (getState(object)?.flatMapLuminance ?? 1)))
/** Exaggeration minus one: 0 leaves every position exactly as loaded. */
const exaggerationLiftUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getState(object)?.exaggeration ?? 1) - 1))
const flatCenterHeightUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getState(object)?.centerZMeters ?? 0)))

/**
 * The vertex position, morphed. On the globe the mesh is drawn with its own matrix and `morph` is 0, so the
 * result is the geometry's position exactly (mix with weight 0). Otherwise the mesh is drawn with its flat
 * frame's matrix and the globe position is brought into that frame first.
 */
const worldCopyOffset = vec3(float(instanceIndex).add(firstWorldCopyOffsetUniform).mul(2 * WEB_MERCATOR_HALF_EXTENT_METERS), 0, 0)
const flatPosition = attribute(FLAT_POSITION_ATTRIBUTE, 'vec3')

/**
 * The unroll: the map opens from the anchor outwards, like a sheet peeling off the globe, and rolls back up
 * from its edges. Each vertex morphs once the front (at `morph` times the reach) passes its distance from
 * the anchor.
 */
const UNROLL_FRONT_WIDTH = 0.35
const UNROLL_REACH_METERS = 1.5 * WEB_MERCATOR_HALF_EXTENT_METERS
const distanceFromAnchorMeters = flatPosition.xy.add(centerFromAnchorUniform).length()
const distanceFromAnchor = distanceFromAnchorMeters.div(UNROLL_REACH_METERS).min(1)
const localMorph = smoothstep(0, 1, morphUniform.mul(1 + UNROLL_FRONT_WIDTH).sub(distanceFromAnchor).div(UNROLL_FRONT_WIDTH))
/** 1 on the crest of the front, 0 away from it. */
const unrollCrest = localMorph.mul(float(1).sub(localMorph)).mul(4)
/** The crest lifts off the map, more the farther it has travelled. */
const crestLift = vec3(0, 0, unrollCrest.mul(unrollCrest).mul(distanceFromAnchorMeters).mul(0.03))
/**
 * Exaggeration: on the globe, the height vector added again, scaled (0 times it at 1: the position bit for bit); on the
 * map, the flat height (already scaled by Mercator's factor) likewise.
 */
const exaggeratedGlobePosition = positionGeometry.add(attribute(HEIGHT_OFFSET_ATTRIBUTE, 'vec3').mul(exaggerationLiftUniform))
const exaggeratedFlatPosition = flatPosition.add(vec3(0, 0, flatPosition.z.add(flatCenterHeightUniform).mul(exaggerationLiftUniform)))
const morphedPosition = mix(globeToFlatUniform.mul(vec4(exaggeratedGlobePosition, 1)).xyz, exaggeratedFlatPosition.add(worldCopyOffset), localMorph).add(crestLift)

/**
 * The normal, turned with the geometry into the flat frame, so shading stays continuous when the morph
 * starts (the mesh is then drawn with the flat frame's matrix). On the map itself sunlight is faded out.
 */
// Unrolled ground faces straight up the map (flat +z), so it is not lit as if still curved round the globe.
const morphedNormal = transformNormalToView(mix(mat3(globeToFlatUniform).mul(normalGeometry).normalize(), vec3(0, 0, 1), localMorph).normalize())

/** A thin glow rides the crest of the front. */
const UNROLL_GLOW_COLOR = vec3(0.55, 0.8, 1)
const unrollGlow = UNROLL_GLOW_COLOR.mul(
  unrollCrest
    .pow(32)
    .mul(smoothstep(0.05, 0.3, distanceFromAnchor))
    .mul(morphUniform.mul(float(1).sub(morphUniform)).mul(4))
    .mul(0.35),
)
/**
 * On the flat map the imagery is shown unlit, as a map. Each vertex passes from the lit globe to the unlit
 * map as the unroll front reaches it, so the ground still on the globe keeps its shading and the unrolled
 * ground already looks like the map, with no blend of both.
 */
const flatColor = diffuseColor.rgb.add(unrollGlow).mul(flatMapLuminanceUniform)
const unrollOutput = vec4(mix(output.rgb, flatColor, localMorph), output.a)

const WRAPPED = Symbol('FLAT_MAP_WRAPPED')

type WrappableMaterial = NodeMaterial & { [WRAPPED]?: true }

const geodetic: GeodeticRadians = { longitude: 0, latitude: 0, heightMeters: 0 }
const meshToTileScene = new Matrix4()
const globeMatrix = new Matrix4()
const flatMatrix = new Matrix4()
const centerOffset = new Matrix4()

/**
 * Lays terrain tiles on the flat map and morphs them between globe and map, for `ViewMorph`.
 *
 * - On load, each mesh gets a `positionFlat` attribute: every vertex converted to Web Mercator on the CPU
 *   in double precision, relative to the mesh's own flat centre (so float32 keeps centimetres), and a
 *   `heightOffset` attribute (its height along the ellipsoid normal), which `exaggeration` scales in the shader.
 * - Each tile material's `positionNode` mixes the globe and flat positions; the shader is shared by all
 *   tiles, and on the globe it returns the original position bit for bit.
 * - When a mesh is drawn while the morph is under way or done, its `matrixWorld` is swapped for its flat
 *   frame (the map plane placed by `ViewMorph`, offset to the mesh's flat centre), so `highPrecision`
 *   rendering stays exact on the map too. It is restored as soon as the globe is back.
 * - Standard materials emit their imagery colour on the map (see `ViewMorph.flatMapLuminance`).
 *
 * Runs after the material replacement and imagery overlay plugins (priority 0), and again on the meshes
 * that imagery tile splitting creates (their attribute is interpolated by the splitter, then recomputed).
 */
export class FlatMapPlugin {
  readonly name = 'FLAT_MAP_PLUGIN'
  readonly priority = 0
  /** The morph to follow. Null keeps tiles on the globe. */
  view: ViewMorph | null = null
  /** How much terrain heights are scaled when drawn (see `Terrain.exaggeration`). */
  exaggeration = 1
  protected tiles: { group: Object3D; forEachLoadedModel(callback: (scene: Object3D, tile: Tile) => void): void } | null = null

  init(tiles: NonNullable<FlatMapPlugin['tiles']>): void {
    this.tiles = tiles
    tiles.forEachLoadedModel((scene, tile) => this.processTileModel(scene, tile))
  }

  processTileModel(scene: Object3D, tile: Tile): void {
    const region = (tile.boundingVolume as { region?: number[] } | undefined)?.region
    const referenceLongitude = region === undefined ? null : (region[0]! + region[2]!) / 2
    scene.updateMatrix()
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      const mesh = object as FlatMesh
      this.prepareMesh(mesh, scene, referenceLongitude)
    })
  }

  protected prepareMesh(mesh: FlatMesh, scene: Object3D, referenceLongitude: number | null): void {
    // The mesh's transform up to the tile scene, whose matrix places it in the tile set's frame (ECEF).
    meshToTileScene.identity()
    for (let node: Object3D | null = mesh; node !== null; node = node.parent) {
      node.updateMatrix()
      meshToTileScene.premultiply(node.matrix)
      if (node === scene) break
    }
    const center = computeFlatPositions(mesh.geometry, meshToTileScene, referenceLongitude)
    mesh.geometry = toInstancedGeometry(mesh.geometry)
    mesh[FLAT_STATE] = {
      centerXMeters: center[0],
      centerYMeters: center[1],
      centerZMeters: center[2],
      globeToFlat: new Matrix4(),
      morph: 0,
      flatMapLuminance: 1,
      firstWorldCopyOffset: 0,
      centerFromAnchorXMeters: 0,
      centerFromAnchorYMeters: 0,
      flattened: false,
      exaggeration: 1,
    }
    wrapMaterial(mesh.material as Material, mesh.geometry.hasAttribute('normal'))

    // The flat matrix only lives for the draw: raycasts, pointer events and everything else between frames
    // see the globe matrix.
    const previousBeforeRender = mesh.onBeforeRender
    mesh.onBeforeRender = (...args) => {
      this.applyMorph(mesh)
      previousBeforeRender.apply(mesh, args)
    }
    const previousAfterRender = mesh.onAfterRender
    mesh.onAfterRender = (...args) => {
      previousAfterRender.apply(mesh, args)
      restoreGlobeMatrix(mesh)
    }
  }

  /**
   * Raycasts a tile against its ground as drawn when it is exaggerated (3DTilesRenderer's `raycastTile` hook): each mesh
   * through a copy of its geometry with the heights scaled, made once per exaggeration. Returns false at 1 (the stock
   * raycast is exact then).
   */
  raycastTile(_tile: Tile, scene: Object3D, raycaster: Raycaster, intersects: Intersection[]): boolean {
    const exaggeration = this.exaggeration
    if (exaggeration === 1) return false
    const hits: Intersection[] = []
    scene.traverse(object => {
      if (!object.layers.test(raycaster.layers)) return
      if (!(object instanceof Mesh)) {
        raycaster.intersectObject(object, false, intersects)
        return
      }
      const geometry = exaggeratedGeometry(object.geometry, exaggeration)
      if (geometry === null) {
        raycaster.intersectObject(object, false, intersects)
        return
      }
      raycastProxy.geometry = geometry
      raycastProxy.material = object.material
      raycastProxy.matrixWorld.copy(object.matrixWorld)
      hits.length = 0
      raycastProxy.raycast(raycaster, hits)
      for (const hit of hits) {
        hit.object = object
        intersects.push(hit)
      }
    })
    return true
  }

  /** Puts a mesh in its globe or flat frame for this draw. */
  protected applyMorph(mesh: FlatMesh): void {
    const state = mesh[FLAT_STATE]
    const view = this.view
    if (state === undefined) return
    const morph = view?.morph ?? 0
    state.exaggeration = this.exaggeration
    if (morph === 0 || view === null || this.tiles === null || mesh.parent === null) {
      restoreGlobeMatrix(mesh)
      state.morph = 0
      state.globeToFlat.identity()
      return
    }
    globeMatrix.multiplyMatrices(mesh.parent.matrixWorld, mesh.matrix)
    // The map is one world wide: place each mesh within half a world of the camera (of the anchor during
    // the morph), so the map has no seam near the camera and everything near it is in the mesh matrix, at
    // full precision. The other copies are instances of the same draw, offset in the shader: they are at
    // least a quarter of a world away, so only seen zoomed out, where float32 metres don't show.
    const centerXMeters = wrapMercatorXNear(state.centerXMeters, view.worldCopyReferenceXMeters)
    state.firstWorldCopyOffset = view.firstWorldCopy
    state.centerFromAnchorXMeters = centerXMeters - view.anchorMercatorXMeters
    state.centerFromAnchorYMeters = state.centerYMeters - latitudeToMercatorY(view.anchorLatitudeRadians)
    ;(mesh.geometry as InstancedBufferGeometry).instanceCount = view.worldCopyCount
    flatMatrix
      .multiplyMatrices(this.tiles.group.matrixWorld, view.flatToEarth)
      .multiply(centerOffset.makeTranslation(centerXMeters, state.centerYMeters, state.centerZMeters))
    state.globeToFlat.copy(flatMatrix).invert().multiply(globeMatrix)
    mesh.matrixWorld.copy(flatMatrix)
    state.flattened = true
    state.morph = morph
    state.flatMapLuminance = view.flatMapLuminance
  }
}

const raycastProxy = new Mesh()
const exaggeratedGeometries = new WeakMap<BufferGeometry, { exaggeration: number; geometry: BufferGeometry }>()

/** The geometry with every position moved along its height offset, scaled: the ground as drawn. Null without offsets. */
function exaggeratedGeometry(source: BufferGeometry, exaggeration: number): BufferGeometry | null {
  const cached = exaggeratedGeometries.get(source)
  if (cached !== undefined && cached.exaggeration === exaggeration) return cached.geometry
  const offsets = source.getAttribute(HEIGHT_OFFSET_ATTRIBUTE)
  const positions = source.getAttribute('position')
  if (offsets === undefined || positions === undefined) return null
  cached?.geometry.dispose()
  const lift = exaggeration - 1
  const moved = new Float32Array(positions.count * 3)
  for (let index = 0; index < positions.count; index++) {
    moved[index * 3] = positions.getX(index) + offsets.getX(index) * lift
    moved[index * 3 + 1] = positions.getY(index) + offsets.getY(index) * lift
    moved[index * 3 + 2] = positions.getZ(index) + offsets.getZ(index) * lift
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(moved, 3))
  geometry.setIndex(source.index)
  geometry.computeBoundingSphere()
  exaggeratedGeometries.set(source, { exaggeration, geometry })
  return geometry
}

function restoreGlobeMatrix(mesh: FlatMesh): void {
  const state = mesh[FLAT_STATE]
  if (state === undefined || !state.flattened) return
  ;(mesh.geometry as InstancedBufferGeometry).instanceCount = 1
  if (mesh.parent === null) mesh.matrixWorld.copy(mesh.matrix)
  else mesh.matrixWorld.multiplyMatrices(mesh.parent.matrixWorld, mesh.matrix)
  state.flattened = false
}

function wrapMaterial(material: Material, hasNormals: boolean): void {
  const nodeMaterial = material as WrappableMaterial
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial !== true || nodeMaterial[WRAPPED] === true) return
  nodeMaterial[WRAPPED] = true
  nodeMaterial.positionNode = morphedPosition
  if (hasNormals && nodeMaterial.normalNode == null) nodeMaterial.normalNode = morphedNormal
  setBaseOutputNode(nodeMaterial, unrollOutput as unknown as Node)
  nodeMaterial.needsUpdate = true
}

/**
 * The same geometry (shared attributes, index and groups) as an `InstancedBufferGeometry`, so world copies
 * are drawn by its `instanceCount`. Instancing through `mesh.count` instead would give every tile mesh its
 * own render cache key in three r187, and so its own node build: a hitch per tile loaded on the map.
 */
export function toInstancedGeometry(geometry: BufferGeometry): InstancedBufferGeometry {
  if ((geometry as InstancedBufferGeometry).isInstancedBufferGeometry === true) return geometry as InstancedBufferGeometry
  const instanced = new InstancedBufferGeometry()
  instanced.name = geometry.name
  instanced.index = geometry.index
  // Shared, not copied: attributes plugins add later (imagery UVs) reach both.
  instanced.attributes = geometry.attributes
  instanced.morphAttributes = geometry.morphAttributes
  instanced.morphTargetsRelative = geometry.morphTargetsRelative
  instanced.groups = geometry.groups
  instanced.drawRange = geometry.drawRange
  instanced.boundingBox = geometry.boundingBox
  instanced.boundingSphere = geometry.boundingSphere
  instanced.userData = geometry.userData
  instanced.instanceCount = 1
  return instanced
}

/**
 * Writes `positionFlat`: each vertex in Web Mercator metres (height scaled by the local scale factor),
 * relative to the centre of the mesh's flat bounding box, and `heightOffset`: each vertex's height along the
 * ellipsoid normal, in the mesh's frame. Returns the flat centre.
 */
export function computeFlatPositions(geometry: BufferGeometry, meshToEarth: Matrix4, referenceLongitude: number | null): [number, number, number] {
  const position = geometry.getAttribute('position')
  const count = position.count
  const flat = new Float64Array(count * 3)
  const e = meshToEarth.elements
  let reference = referenceLongitude
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const heightOffsets = new Float32Array(count * 3)
  // Directions from the tile set's frame back into the mesh's (the inverse of its linear part).
  const earthToMesh = new Matrix3().setFromMatrix4(meshToEarth).invert().elements
  for (let index = 0; index < count; index++) {
    const x = position.getX(index)
    const y = position.getY(index)
    const z = position.getZ(index)
    ecefToGeodetic(
      e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
      e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
      e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
      geodetic,
    )
    const cosLatitude = Math.cos(geodetic.latitude)
    const upX = cosLatitude * Math.cos(geodetic.longitude) * geodetic.heightMeters
    const upY = cosLatitude * Math.sin(geodetic.longitude) * geodetic.heightMeters
    const upZ = Math.sin(geodetic.latitude) * geodetic.heightMeters
    heightOffsets[index * 3] = earthToMesh[0]! * upX + earthToMesh[3]! * upY + earthToMesh[6]! * upZ
    heightOffsets[index * 3 + 1] = earthToMesh[1]! * upX + earthToMesh[4]! * upY + earthToMesh[7]! * upZ
    heightOffsets[index * 3 + 2] = earthToMesh[2]! * upX + earthToMesh[5]! * upY + earthToMesh[8]! * upZ
    reference ??= geodetic.longitude
    const longitude = unwrapLongitude(geodetic.longitude, reference)
    const values = [longitudeToMercatorX(longitude), latitudeToMercatorY(geodetic.latitude), geodetic.heightMeters * mercatorScaleFactor(geodetic.latitude)]
    for (let axis = 0; axis < 3; axis++) {
      const value = values[axis]!
      flat[index * 3 + axis] = value
      if (value < min[axis]!) min[axis] = value
      if (value > max[axis]!) max[axis] = value
    }
  }
  const center: [number, number, number] = count === 0 ? [0, 0, 0] : [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2]
  const relative = new Float32Array(count * 3)
  for (let index = 0; index < count * 3; index++) relative[index] = flat[index]! - center[index % 3]!
  geometry.setAttribute(FLAT_POSITION_ATTRIBUTE, new BufferAttribute(relative, 3))
  geometry.setAttribute(HEIGHT_OFFSET_ATTRIBUTE, new BufferAttribute(heightOffsets, 3))
  return center
}
