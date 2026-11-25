import { BufferAttribute, BufferGeometry, LessEqualDepth, Mesh, Vector3, type Object3D } from 'three'
import { attribute, clamp, cosh, dot, float, max, mix, mat3, normalGeometry, output, positionGeometry, sRGBTransferEOTF, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu'

import { prepareScreenClipMask, screenClipFactor, screenClipPlane } from '../../core/screenClip.js'
import { flatMapLuminanceNode, flatMorphFactor, globeToFlatMatrix, morphPosition } from '../../tiles/FlatMapPlugin.js'
import { WEB_MERCATOR_RADIUS_METERS } from '../../view/webMercator.js'
import type { ExtrusionMesh } from '../worker/types.js'

/** What the shared materials read from each building mesh when it is drawn (`mesh.userData`). */
export interface ExtrusionMeshUserData {
  /** 0 to 1: how far the heights have moved from the tile's zoom towards the next (the camera's zoom between them). */
  extrusionZoomFactor: number
  /** The layer's opacity at the camera's zoom, times the imagery layer's. */
  extrusionOpacity: number
  /** Web Mercator y of the tile's centre, in metres: the flat map's scale factor follows it. */
  extrusionCenterMercatorYMeters: number
}

function userDataOf(object: Object3D | null): ExtrusionMeshUserData | null {
  return object === null ? null : (object.userData as ExtrusionMeshUserData)
}

const zoomFactor = uniform(0).onObjectUpdate(({ object }) => userDataOf(object)?.extrusionZoomFactor ?? 0)
const opacity = uniform(1).onObjectUpdate(({ object }) => userDataOf(object)?.extrusionOpacity ?? 1)
const centerMercatorY = uniform(0).onObjectUpdate(({ object }) => userDataOf(object)?.extrusionCenterMercatorYMeters ?? 0)

/** Mean Earth radius: the up direction at a vertex is taken on a sphere of it, close enough over one tile. */
const EARTH_RADIUS_METERS = 6_371_000

/**
 * Where a vertex stands: lifted from the ellipsoid by its building's terrain elevation (`elevation`, written on the CPU)
 * and by its height's change towards the next zoom. Positions are in the tile centre's east-north-up frame; the up
 * direction tilts with the Earth's curvature across the tile.
 */
const lift = attribute('elevation', 'float').add(attribute('heightDelta', 'float').mul(zoomFactor))
const globeUp = positionGeometry.add(vec3(0, 0, EARTH_RADIUS_METERS)).normalize()
const globePosition = positionGeometry.add(globeUp.mul(lift))
const flatPosition = attribute('positionFlat', 'vec3')
// Heights on the flat map grow by the Web Mercator scale factor at the vertex's latitude, as the terrain's.
const flatScale = cosh(flatPosition.y.add(centerMercatorY).div(WEB_MERCATOR_RADIUS_METERS))
const flatMapPosition = flatPosition.add(vec3(0, 0, lift.mul(flatScale)))
const extrusionPosition = morphPosition(globePosition as unknown as Node<'vec3'>, flatMapPosition as unknown as Node<'vec3'>)

/** Normals are in the tile's east-north-up frame, which is the flat map's frame too (Web Mercator is conformal). */
const extrusionNormal = transformNormalToView(mix(mat3(globeToFlatMatrix).mul(normalGeometry).normalize(), normalGeometry, flatMorphFactor).normalize())

/** `fill-extrusion-color` (sRGB bytes) as linear colour. */
const colorSrgb = attribute('extrusionColor', 'vec4')
const colorLinear = sRGBTransferEOTF(colorSrgb.rgb) as unknown as Node<'vec3'>

/**
 * On the flat map buildings are shaded as MapLibre shades them, by its default light (from the north-east, 30° from
 * the zenith, intensity 0.5), not by the sun: the map is unlit.
 */
const LIGHT_DIRECTION = vec3(0.2875, 0.498, 0.996)
const LIGHT_INTENSITY = 0.5
const directional = clamp(dot(normalGeometry, LIGHT_DIRECTION), 0, 1)
const colorValue = dot(colorSrgb.rgb, vec3(0.2126, 0.7152, 0.0722))
const shade = mix(float(1 - LIGHT_INTENSITY), max(float(1 + LIGHT_INTENSITY).sub(colorValue), 1), directional)
const flatColor = (sRGBTransferEOTF(clamp(colorSrgb.rgb.mul(shade), 0, 1)) as unknown as Node<'vec3'>).mul(flatMapLuminanceNode)

/** Materials shared by every building mesh of a map style source. */
export interface ExtrusionMaterials {
  /** Opaque layers: lit by the scene's lights (the atmosphere's sun) on the globe. */
  opaque: MeshStandardNodeMaterial
  /** Translucent layers: drawn over `depth`, so only the front-most surface of each pixel blends (MapLibre's approach). */
  translucent: MeshStandardNodeMaterial
  /** Writes depth only, before `translucent`. */
  depth: MeshBasicNodeMaterial
}

/** `clipPlane`: the part of the canvas the buildings keep (the imagery layer's `screenClip`, from `screenClipPlane`). */
export function createExtrusionMaterials(clipPlane: { readonly value: Vector3 } = { value: screenClipPlane(null) }): ExtrusionMaterials {
  // Discarded, not faded: a clipped building must not hide what is behind it in the depth buffer either.
  const kept = screenClipFactor(uniform(new Vector3()).onRenderUpdate((_, self) => void self.value.copy(clipPlane.value)) as unknown as Node<'vec3'>).greaterThan(0.5)
  const create = (transparent: boolean) => {
    const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0, transparent })
    material.name = transparent ? 'ExtrusionTranslucent' : 'ExtrusionOpaque'
    material.positionNode = extrusionPosition
    material.normalNode = extrusionNormal
    material.colorNode = colorLinear
    if (transparent) {
      material.opacityNode = opacity
      material.depthWrite = false
      material.depthFunc = LessEqualDepth
    }
    material.outputNode = vec4(mix(output.rgb, flatColor, flatMorphFactor), output.a)
    prepareScreenClipMask(material, kept)
    return material
  }
  const depth = new MeshBasicNodeMaterial({ colorWrite: false })
  depth.name = 'ExtrusionDepth'
  depth.positionNode = extrusionPosition
  prepareScreenClipMask(depth, kept)
  return { opaque: create(false), translucent: create(true), depth }
}

/** Vertex attributes of one tile's buildings, shared by its layers' geometries. */
export interface ExtrusionAttributes {
  attributes: Record<string, BufferAttribute>
  /** Per vertex: its building's terrain elevation, in metres; 0 until the terrain under it is read. */
  elevation: BufferAttribute
}

export function createExtrusionAttributes(extrusions: ExtrusionMesh): ExtrusionAttributes {
  const elevation = new BufferAttribute(new Float32Array(extrusions.positions.length / 3), 1)
  return {
    attributes: {
      position: new BufferAttribute(extrusions.positions, 3),
      positionFlat: new BufferAttribute(extrusions.flatPositions, 3),
      normal: new BufferAttribute(extrusions.normals, 3, true),
      extrusionColor: new BufferAttribute(extrusions.colors, 4, true),
      heightDelta: new BufferAttribute(extrusions.heightDeltas, 1),
      elevation,
    },
    elevation,
  }
}

/** The geometry of one layer's buildings in a tile: the tile's attributes, the layer's triangles. */
export function createExtrusionGeometry({ attributes }: ExtrusionAttributes, indices: Uint16Array | Uint32Array): BufferGeometry {
  const geometry = new BufferGeometry()
  for (const [name, value] of Object.entries(attributes)) geometry.setAttribute(name, value)
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}

/** A building mesh: drawn without frustum culling (the camera's tiles are already in view) and never hit by raycasts. */
export function createExtrusionMesh(geometry: BufferGeometry, material: MeshStandardNodeMaterial | MeshBasicNodeMaterial, name: string): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.name = name
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  // Terrain queries raycast the scene graph: buildings must not answer them.
  mesh.raycast = () => {}
  return mesh
}
