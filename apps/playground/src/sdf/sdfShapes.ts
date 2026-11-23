// An example react-three-earth plugin: raymarched signed-distance shapes on the globe.
//
// Each shape is a box mesh (its bounds) whose fragment shader sphere-traces a distance function and writes
// the hit's true depth, so terrain hides it, it hides terrain and the atmosphere hazes it. It is lit by the
// scene's lights (the atmosphere's sun and sky), emits its colour on the flat map, and sits in a geographic
// anchor that follows the globe-to-map morph. See docs/design or the write-a-plugin skill.
import { createFlatMapEmissionNode, createLocalCameraPositionNode, depthFromViewZ, PLUGIN_API_VERSION, type EarthPlugin, type GeographicAnchor, type GeographicPosition, type PluginContext } from 'react-three-earth'
import { BackSide, BoxGeometry, Color, MathUtils, Mesh, Vector2, Vector3, type PerspectiveCamera } from 'three'
import { Break, Discard, float, Fn, If, Loop, max, min, modelViewMatrix, normalize, positionLocal, positionView, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'

import type { DistanceFunction } from './distance'

export interface SdfShapeOptions {
  position: GeographicPosition & { heightMeters: number }
  /** Turns the shape clockwise from north. Default: 0. */
  headingDegrees?: number
  /** Half extents of the box the shape is traced in, in metres. Keep it tight: cost grows with its pixels. */
  halfSizeMeters: readonly [number, number, number]
  distanceFunction: DistanceFunction
  /** Default: '#ffffff'. */
  color?: string
  /** Most sphere-tracing steps per pixel. Default: 64, at most 128. */
  maximumMarchSteps?: number
}

const STEP_LIMIT = 128
const drawingBufferSize = new Vector2()

/** A shape traced in its box. Add it with `plugin.add(shape)` (or `<SdfShape>`), which gives it its material. */
export class SdfShape extends Mesh<BoxGeometry, MeshStandardNodeMaterial> {
  readonly options: SdfShapeOptions
  readonly halfSize: Vector3
  readonly baseColor: Color
  maximumMarchSteps: number

  constructor(options: SdfShapeOptions) {
    super(new BoxGeometry(2, 2, 2))
    this.options = options
    this.name = 'SdfShape'
    this.halfSize = new Vector3(...options.halfSizeMeters)
    // The unit box becomes the shape's box; the shader works in metres from this.
    this.scale.copy(this.halfSize)
    this.baseColor = new Color(options.color ?? '#ffffff')
    this.maximumMarchSteps = Math.min(options.maximumMarchSteps ?? 64, STEP_LIMIT)
    this.frustumCulled = true
    this.visible = false // until the plugin gives it a material
  }
}

/**
 * Builds the material for one distance function. Size, colour and step count are per-object uniforms, so
 * every shape using the same function shares one pipeline.
 */
export function createSdfMaterial(distanceFunction: DistanceFunction, { view }: { view: Parameters<typeof createFlatMapEmissionNode>[1] }): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ side: BackSide, roughness: 0.6, metalness: 0 })
  const halfSize = uniform(new Vector3()).onObjectUpdate(({ object }) => (object as SdfShape).halfSize)
  const maximumSteps = uniform(64).onObjectUpdate(({ object }) => (object as SdfShape).maximumMarchSteps)
  // The angle one pixel covers: the hit tolerance grows with range, so far shapes converge in a few steps.
  const pixelAngleRadians = uniform(0).onRenderUpdate(({ renderer, camera }) => {
    const fov = (camera as PerspectiveCamera | undefined)?.fov ?? 60
    const height = renderer === null || renderer === undefined ? 1 : renderer.getDrawingBufferSize(drawingBufferSize).y
    return MathUtils.degToRad(fov) / Math.max(height, 1)
  })
  // The camera in the unit box's frame, computed in 64-bit on the CPU; in metres below.
  const cameraPosition = createLocalCameraPositionNode().mul(halfSize)
  // Back faces: positionLocal is where the view ray leaves the box. Everything here stays small.
  const exitPoint = positionLocal.mul(halfSize)
  const towardsExit = exitPoint.sub(cameraPosition)
  const cameraToExitMeters = towardsExit.length()
  const direction = towardsExit.div(cameraToExitMeters)

  const surface = Fn(() => {
    // Slab method, backwards from the exit point: how far back along the ray the box begins.
    const backwards = direction.negate()
    const safeBackwards = vec3(
      backwards.x.abs().max(1e-6).mul(backwards.x.sign().add(0.5).sign()),
      backwards.y.abs().max(1e-6).mul(backwards.y.sign().add(0.5).sign()),
      backwards.z.abs().max(1e-6).mul(backwards.z.sign().add(0.5).sign()),
    )
    const first = halfSize.negate().sub(exitPoint).div(safeBackwards)
    const second = halfSize.sub(exitPoint).div(safeBackwards)
    const far = max(first, second)
    // The camera may be inside the box: then the march starts at the camera.
    const entryDistance = min(min(far.x, min(far.y, far.z)), cameraToExitMeters).max(0).toVar()
    const travelled = float(0).toVar()
    const hit = float(0).toVar()
    const range = cameraToExitMeters.sub(entryDistance).toVar() // camera to the march start
    Loop(STEP_LIMIT, ({ i }: { i: Node<'int'> }) => {
      If(float(i).greaterThanEqual(maximumSteps), () => Break())
      const point = exitPoint.sub(direction.mul(entryDistance.sub(travelled)))
      const step = distanceFunction(point)
      If(step.lessThan(pixelAngleRadians.mul(range.add(travelled)).max(1e-3)), () => {
        hit.assign(1)
        Break()
      })
      travelled.addAssign(step)
      If(travelled.greaterThan(entryDistance), () => Break())
    })
    // The camera inside the solid: nothing sensible to draw.
    If(hit.equal(1).and(travelled.lessThanEqual(0)).and(entryDistance.greaterThanEqual(cameraToExitMeters)), () => Discard())
    If(hit.equal(0), () => Discard())
    return exitPoint.sub(direction.mul(entryDistance.sub(travelled)))
  })().toVar()

  // View-space hit from small numbers only: the box fragment plus the local offset, through the model-view rotation.
  const viewHit = positionView.add(modelViewMatrix.mul(vec4(surface.sub(exitPoint).div(halfSize), 0)).xyz)
  material.depthNode = depthFromViewZ(viewHit.z)
  // Tetrahedron gradient, in metres; into the unit box's frame (times the half size), then view space.
  const epsilon = float(0.01).max(pixelAngleRadians.mul(viewHit.z.negate()))
  const a = vec3(1, -1, -1)
  const b = vec3(-1, -1, 1)
  const c = vec3(-1, 1, -1)
  const d = vec3(1, 1, 1)
  const gradient = a
    .mul(distanceFunction(surface.add(a.mul(epsilon))))
    .add(b.mul(distanceFunction(surface.add(b.mul(epsilon)))))
    .add(c.mul(distanceFunction(surface.add(c.mul(epsilon)))))
    .add(d.mul(distanceFunction(surface.add(d.mul(epsilon)))))
  material.normalNode = normalize(transformNormalToView(normalize(gradient.mul(halfSize))))
  const color = uniform(new Color()).onObjectUpdate(({ object }) => (object as SdfShape).baseColor)
  material.colorNode = color
  // On the flat map the sun fades out: emit the colour there, as flat terrain does.
  material.emissiveNode = createFlatMapEmissionNode(color, view)
  return material
}

export interface SdfShapesPlugin extends EarthPlugin {
  /** Shows a shape. Shapes added before the plugin is installed wait for it. */
  add(shape: SdfShape): void
  /** Hides a shape and releases its share of the material. */
  remove(shape: SdfShape): void
}

/** The `sdf-shapes` plugin. One instance per earth. */
export function sdfShapes(): SdfShapesPlugin {
  let context: PluginContext | null = null
  const shapes = new Map<SdfShape, { anchor: GeographicAnchor; removeObject: () => void } | null>()
  const materials = new Map<DistanceFunction, { material: MeshStandardNodeMaterial; users: number }>()

  const acquireMaterial = (shape: SdfShape, active: PluginContext) => {
    const key = shape.options.distanceFunction
    let entry = materials.get(key)
    if (entry === undefined) {
      entry = { material: createSdfMaterial(key, { view: active.earth.view }), users: 0 }
      materials.set(key, entry)
    }
    entry.users++
    return entry.material
  }
  const releaseMaterial = (shape: SdfShape) => {
    const key = shape.options.distanceFunction
    const entry = materials.get(key)
    if (entry === undefined) return
    if (--entry.users === 0) {
      entry.material.dispose()
      materials.delete(key)
    }
  }
  const attach = (shape: SdfShape, active: PluginContext) => {
    const { position, headingDegrees } = shape.options
    const anchor = active.earth.createGeographicAnchor(position, { headingDegrees })
    anchor.add(shape)
    shape.material = acquireMaterial(shape, active)
    shape.visible = true
    shapes.set(shape, { anchor, removeObject: active.addObject(anchor) })
  }
  const detach = (shape: SdfShape) => {
    const entry = shapes.get(shape)
    if (entry === null || entry === undefined) return
    entry.removeObject()
    entry.anchor.dispose()
    entry.anchor.remove(shape)
    shape.visible = false
    releaseMaterial(shape)
    shapes.set(shape, null)
  }

  return {
    name: 'sdf-shapes',
    apiVersion: PLUGIN_API_VERSION,
    install(installed) {
      context = installed
      for (const shape of shapes.keys()) attach(shape, installed)
      installed.earth.requestFrame()
    },
    uninstall() {
      for (const shape of shapes.keys()) detach(shape)
      context = null
    },
    add(shape) {
      if (shapes.has(shape)) return
      shapes.set(shape, null)
      if (context !== null) {
        attach(shape, context)
        context.earth.requestFrame()
      }
    },
    remove(shape) {
      detach(shape)
      shapes.delete(shape)
      shape.geometry.dispose()
      context?.earth.requestFrame()
    },
    inspect: () => ({ shapes: shapes.size, shown: [...shapes.values()].filter(entry => entry !== null).length, pipelines: materials.size }),
  }
}
