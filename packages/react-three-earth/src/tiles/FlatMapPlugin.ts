import type { Tile } from '3d-tiles-renderer'
import { BufferAttribute, Matrix4, Mesh, type BufferGeometry, type Material, type Object3D } from 'three'
import { attribute, diffuseColor, mix, positionGeometry, uniform, vec4 } from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'

import type { ViewMorph } from '../view/ViewMorph.js'
import { ecefToGeodetic, latitudeToMercatorY, longitudeToMercatorX, mercatorScaleFactor, unwrapLongitude, type GeodeticRadians } from '../view/webMercator.js'

/** Name of the vertex attribute holding each vertex's flat-map position, relative to the mesh's flat centre. */
export const FLAT_POSITION_ATTRIBUTE = 'positionFlat'

const FLAT_STATE = Symbol('FLAT_STATE')

/** Per-mesh morph state, read by the shared shader uniforms when the mesh is drawn. */
interface FlatMeshState {
  /** The mesh's centre in flat coordinates (Web Mercator metres): `positionFlat` is relative to it. */
  readonly centerX: number
  readonly centerY: number
  readonly centerZ: number
  /** Takes the mesh's own (globe) vertex positions into its flat frame. Identity on the globe. */
  readonly globeToFlat: Matrix4
  morph: number
  flatMapLuminance: number
  /** Whether `matrixWorld` currently holds the flat frame. */
  flattened: boolean
}

type FlatMesh = Mesh & { [FLAT_STATE]?: FlatMeshState }

function getState(object: Object3D): FlatMeshState | undefined {
  return (object as FlatMesh)[FLAT_STATE]
}

const globeToFlatUniform = uniform(new Matrix4()).onObjectUpdate(({ object }, self) => {
  const state = object === null ? undefined : getState(object)
  if (state !== undefined) self.value = state.globeToFlat
})
const morphUniform = uniform(0).onObjectUpdate(({ object }) => (object === null ? 0 : (getState(object)?.morph ?? 0)))
const flatMapLuminanceUniform = uniform(1).onObjectUpdate(({ object }) => (object === null ? 1 : (getState(object)?.flatMapLuminance ?? 1)))

/**
 * The vertex position, morphed. On the globe the mesh is drawn with its own matrix and `morph` is 0, so the
 * result is the geometry's position exactly (mix with weight 0). Otherwise the mesh is drawn with its flat
 * frame's matrix and the globe position is brought into that frame first.
 */
const morphedPosition = mix(globeToFlatUniform.mul(vec4(positionGeometry, 1)).xyz, attribute(FLAT_POSITION_ATTRIBUTE, 'vec3'), morphUniform)

/** On the flat map the imagery is shown unlit, as a map: its colour is emitted, fading in with the morph. */
const flatEmission = diffuseColor.rgb.mul(morphUniform).mul(flatMapLuminanceUniform)

const WRAPPED = Symbol('FLAT_MAP_WRAPPED')
const combinedEmissions = new WeakSet<Node>()

type WrappableMaterial = NodeMaterial & { [WRAPPED]?: true; emissiveNode?: Node | null }

const geodetic: GeodeticRadians = { longitude: 0, latitude: 0, height: 0 }
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
    mesh[FLAT_STATE] = {
      centerX: center[0],
      centerY: center[1],
      centerZ: center[2],
      globeToFlat: new Matrix4(),
      morph: 0,
      flatMapLuminance: 1,
      flattened: false,
    }
    wrapMaterial(mesh.material as Material)

    const previous = mesh.onBeforeRender
    mesh.onBeforeRender = (...args) => {
      this.applyMorph(mesh)
      previous.apply(mesh, args)
    }
  }

  /** Puts a mesh in its globe or flat frame for this draw. */
  protected applyMorph(mesh: FlatMesh): void {
    const state = mesh[FLAT_STATE]
    const view = this.view
    if (state === undefined) return
    const morph = view?.morph ?? 0
    if (morph === 0 || view === null || this.tiles === null || mesh.parent === null) {
      if (state.flattened) {
        mesh.matrixWorld.multiplyMatrices(mesh.parent?.matrixWorld ?? globeMatrix.identity(), mesh.matrix)
        state.flattened = false
      }
      state.morph = 0
      state.globeToFlat.identity()
      return
    }
    globeMatrix.multiplyMatrices(mesh.parent.matrixWorld, mesh.matrix)
    flatMatrix
      .multiplyMatrices(this.tiles.group.matrixWorld, view.flatToEarth)
      .multiply(centerOffset.makeTranslation(state.centerX, state.centerY, state.centerZ))
    state.globeToFlat.copy(flatMatrix).invert().multiply(globeMatrix)
    mesh.matrixWorld.copy(flatMatrix)
    state.flattened = true
    state.morph = morph
    state.flatMapLuminance = view.flatMapLuminance
  }
}

function wrapMaterial(material: Material): void {
  const nodeMaterial = material as WrappableMaterial
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial !== true || nodeMaterial[WRAPPED] === true) return
  nodeMaterial[WRAPPED] = true
  nodeMaterial.positionNode = morphedPosition
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
    const values = [longitudeToMercatorX(longitude), latitudeToMercatorY(geodetic.latitude), geodetic.height * mercatorScaleFactor(geodetic.latitude)]
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
