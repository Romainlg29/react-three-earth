// Main-thread side of custom style layer types: their materials, meshes and offscreen composites.
import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  MaxEquation,
  NormalBlending,
  OneFactor,
  type Object3D,
} from 'three'
import { attribute, float, Fn, max, positionGeometry, screenUV, sRGBTransferEOTF, uniform, vec4, type texture } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node, type NodeMaterial } from 'three/webgpu'

import { paintAttributeName, type StyleLayerTypeDefinition } from '../plugins/styleLayerTypes.js'
import { discardOutsideTile } from './VectorTileMeshes.js'
import { TILE_EXTENT, TILE_SIZE_PIXELS } from './worker/types.js'

/** Per-draw values a custom layer mesh carries, read by its material's tile nodes. */
export interface CustomLayerDrawValues {
  pixelsPerTileUnit: number
  zoom: number
}

/** Sets the per-draw values of a placed custom layer mesh, for a tile at `z` drawn at `zoom`. */
export function setCustomLayerDrawValues(object: Object3D, z: number, zoom: number): void {
  const values: CustomLayerDrawValues = { pixelsPerTileUnit: (TILE_SIZE_PIXELS * 2 ** (zoom - z)) / TILE_EXTENT, zoom }
  object.userData.customLayer = values
}

function drawValues(object: Object3D | null | undefined): CustomLayerDrawValues {
  return (object?.userData.customLayer as CustomLayerDrawValues | undefined) ?? { pixelsPerTileUnit: 0, zoom: 0 }
}

/**
 * Builds a layer type's material: calls the plugin's `createMaterial` with its paint and tile nodes, then sets
 * what the region pass needs (no depth, both sides, blending), and clips it to its tile unless it has reach.
 */
export function createCustomLayerMaterial(definition: StyleLayerTypeDefinition): NodeMaterial {
  const paintProperties = definition.paint ?? {}
  const require = (name: string, types: readonly string[]) => {
    const property = paintProperties[name]
    if (property === undefined || !types.includes(property.type)) {
      throw new Error(`Layer type "${definition.type}": paint.${types[0] === 'color' ? 'color' : types[0] === 'number' ? 'number' : 'enumIndex'}("${name}") needs a declared ${types.join(' or ')} paint property of that name.`)
    }
    return paintAttributeName(definition, name)
  }
  const material = definition.createMaterial({
    paint: {
      color: name => {
        const value = attribute<'vec4'>(require(name, ['color']), 'vec4')
        return vec4(sRGBTransferEOTF(value.rgb) as unknown as Node<'vec3'>, value.a) as unknown as Node<'vec4'>
      },
      number: name => attribute<'float'>(require(name, ['number']), 'float'),
      enumIndex: name => attribute<'float'>(require(name, ['enum', 'boolean']), 'float'),
    },
    tile: {
      pixelsPerTileUnit: uniform(0).onObjectUpdate(({ object }) => drawValues(object).pixelsPerTileUnit) as unknown as Node<'float'>,
      zoom: uniform(0).onObjectUpdate(({ object }) => drawValues(object).zoom) as unknown as Node<'float'>,
      position: positionGeometry.xy as unknown as Node<'vec2'>,
    },
  })
  material.transparent = true
  material.depthTest = false
  material.depthWrite = false
  material.side = DoubleSide
  const offscreen = definition.offscreen
  if (offscreen === undefined) {
    material.blending = NormalBlending
  } else {
    // WebGPU allows min/max only with one/one factors.
    const equation = offscreen.blending === 'maximum' ? MaxEquation : AddEquation
    material.blending = CustomBlending
    material.blendEquation = equation
    material.blendEquationAlpha = equation
    material.blendSrc = OneFactor
    material.blendDst = OneFactor
    material.blendSrcAlpha = OneFactor
    material.blendDstAlpha = OneFactor
    // Straight alpha in, premultiplied into the layer target (after opacity), so max and add stay meaningful.
    // CustomBlending keeps the one/one factors regardless.
    material.premultipliedAlpha = true
  }
  const color = material.colorNode
  if (color === null) throw new Error(`Layer type "${definition.type}": createMaterial must set the material's colorNode.`)
  if ((definition.maximumReachPixels ?? 0) === 0) {
    material.colorNode = Fn(() => {
      discardOutsideTile()
      return color
    })()
  }
  return material
}

/** Draws an offscreen layer's target into the region, at the layer's place in the order. */
export function createCompositeMaterial(definition: StyleLayerTypeDefinition, layerTexture: ReturnType<typeof texture>): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false })
  // Same pixel as the layer target: the composite quad covers the region exactly as the layer drew into it.
  const layer = layerTexture.sample(screenUV) as unknown as Node<'vec4'>
  const composite = definition.offscreen?.composite ?? (({ layer }: { layer: Node<'vec4'> }) => vec4(layer.rgb.div(max(layer.a, float(1e-4))), layer.a) as unknown as Node<'vec4'>)
  material.colorNode = composite({ layer })
  return material
}
