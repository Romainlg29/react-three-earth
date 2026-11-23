import type { Tile } from '3d-tiles-renderer'
import { BufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, Vector2, type BufferGeometry, type Material, type Object3D } from 'three'
import { attribute, diffuseColor, float, instanceIndex, mat3, mix, normalGeometry, positionGeometry, smoothstep, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'

import type { ViewMorph } from '../view/ViewMorph.js'
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
const crestLift = vec3(0, 0, unrollCrest.mul(unrollCrest).mul(distanceFromAnchorMeters).mul(0.08))
const morphedPosition = mix(globeToFlatUniform.mul(vec4(positionGeometry, 1)).xyz, flatPosition.add(worldCopyOffset), localMorph).add(crestLift)

/**
 * The normal, turned with the geometry into the flat frame, so shading stays continuous when the morph
 * starts (the mesh is then drawn with the flat frame's matrix). On the map itself sunlight is faded out.
 */
const morphedNormal = transformNormalToView(mat3(globeToFlatUniform).mul(normalGeometry).normalize())

/** On the flat map the imagery is shown unlit, as a map: its colour is emitted, fading in with the morph. */
/** A thin glow rides the crest of the front. */
const UNROLL_GLOW_COLOR = vec3(0.55, 0.8, 1)
const unrollGlow = UNROLL_GLOW_COLOR.mul(unrollCrest.pow(24).mul(smoothstep(0.05, 0.3, distanceFromAnchor)).mul(1.2))
// The sunlight fades as 1 - morph (see `Earth.update`): unrolled ground makes up the rest, so its brightness
// holds steady through the transition.
const flatEmission = diffuseColor.rgb.mul(localMorph.mul(morphUniform)).add(unrollGlow).mul(flatMapLuminanceUniform)

const WRAPPED = Symbol('FLAT_MAP_WRAPPED')
const combinedEmissions = new WeakSet<Node>()

type WrappableMaterial = NodeMaterial & { [WRAPPED]?: true; emissiveNode?: Node | null }

const geodetic: GeodeticRadians = { longitude: 0, latitude: 0, heightMeters: 0 }
const meshToTileScene = new Matrix4()
const globeMatrix = new Matrix4()
const flatMatrix = new Matrix4()
const centerOffset = new Matrix4()

/**
 * Lays terrain tiles on the flat map and morphs them between globe and map, for `ViewMorph`.
 *
 * - On load, each mesh gets a `positionFlat` attribute: every vertex converted to Web Mercator on the CPU
 *   in double precision, relative to the mesh's own flat centre (so float32 keeps centimetres).
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

  /** Puts a mesh in its globe or flat frame for this draw. */
  protected applyMorph(mesh: FlatMesh): void {
    const state = mesh[FLAT_STATE]
    const view = this.view
    if (state === undefined) return
    const morph = view?.morph ?? 0
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
  if ('emissiveNode' in nodeMaterial) {
    const existing = nodeMaterial.emissiveNode ?? null
    if (existing === null) {
      nodeMaterial.emissiveNode = flatEmission
    } else if (existing !== flatEmission && !combinedEmissions.has(existing)) {
      const combined = (existing as Node<'vec3'>).add(flatEmission) as unknown as Node
      combinedEmissions.add(combined)
      nodeMaterial.emissiveNode = combined
    }
  }
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
 * relative to the centre of the mesh's flat bounding box. Returns that centre.
 */
export function computeFlatPositions(geometry: BufferGeometry, meshToEarth: Matrix4, referenceLongitude: number | null): [number, number, number] {
  const position = geometry.getAttribute('position')
  const count = position.count
  const flat = new Float64Array(count * 3)
  const e = meshToEarth.elements
  let reference = referenceLongitude
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
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
  return center
}
