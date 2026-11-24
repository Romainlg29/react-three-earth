import { Color, Layers, Matrix4, type Camera, type Light, type Object3D, type PerspectiveCamera, type Scene } from 'three'
import {
  float,
  Fn,
  getViewPosition,
  If,
  isBackgroundDepth,
  logarithmicDepthToViewZ,
  mix,
  perspectiveDepthToViewZ,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { Node, PassNode, type NodeBuilder, type NodeFrame } from 'three/webgpu'

import type { RenderPassDefinition } from '../plugins/renderPasses.js'
import type { Atmosphere } from './Atmosphere.js'

/**
 * The layer of see-through geometry that the atmosphere hazes at its own distance (`object.layers.set(TRANSLUCENT_LAYER)`).
 *
 * The opaque scene pass cannot: transparent faces write no depth, so the haze there goes by whatever stands behind
 * them (the ground's distance below the horizon, none against the sky), and a face crossing the horizon changes
 * colour along it. Objects on this layer are left out of the scene pass (cameras see layer 0) and drawn in a pass of
 * their own after the atmosphere, hazed at the distance of their nearest face and hidden behind nearer opaque geometry.
 *
 * Give their materials `depthWrite: true` (the pass's depth buffer is their own) and `transparent: true`. The pass
 * runs while `earth.renderPasses.retainTranslucentPass()` is held, inside an `EarthRenderPipeline` attached with the
 * scene pass; every light that lights the scene lights them too.
 */
export const TRANSLUCENT_LAYER = 30

/** The name the translucent pass is registered under in `earth.renderPasses`. */
export const TRANSLUCENT_RENDER_PASS_NAME = 'translucent'

const translucentLayers = new Layers()
translucentLayers.set(TRANSLUCENT_LAYER)

const savedClearColor = new Color()

/**
 * Draws the objects on `TRANSLUCENT_LAYER` (and nothing else) into a colour and depth target of their own, over a
 * transparent black clear: premultiplied colour with coverage in alpha. Lights the scene camera sees light them.
 * Skips the drawing while no visible object is on the layer, once its target is clear.
 */
export class TranslucentPassNode extends PassNode {
  static get type(): string {
    return 'TranslucentPassNode'
  }

  /** Whether the target holds nothing: drawn at least once, with no object on the layer that time. */
  protected targetClear = false
  /** Lights given the layer for one render, to take it off again after. */
  protected readonly lightsGivenLayer: Light[] = []

  constructor(scene: Object3D, camera: Camera) {
    super(PassNode.COLOR, scene, camera)
    this.setLayers(translucentLayers)
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    const { scene, camera } = this
    const lights = this.lightsGivenLayer
    lights.length = 0
    let hasObjects = false
    // The scene pass draws with the camera's layers: the lights it uses light the translucent objects too.
    scene.traverseVisible(object => {
      if ((object as Light).isLight === true) {
        if (object.layers.test(camera.layers) && !object.layers.isEnabled(TRANSLUCENT_LAYER)) lights.push(object as Light)
      } else if (!hasObjects && object.layers.isEnabled(TRANSLUCENT_LAYER)) {
        hasObjects = true
      }
    })
    if (!hasObjects && this.targetClear) return undefined
    this.targetClear = !hasObjects

    const renderer = frame.renderer!
    const sceneWithBackground = scene as Partial<Scene> & { backgroundNode?: unknown }
    const background = sceneWithBackground.background ?? null
    const backgroundNode = sceneWithBackground.backgroundNode ?? null
    renderer.getClearColor(savedClearColor)
    const clearAlpha = renderer.getClearAlpha()
    for (const light of lights) light.layers.enable(TRANSLUCENT_LAYER)
    // Cleared to nothing, so the composite sees coverage 0 where no translucent object stands.
    if (background !== null) sceneWithBackground.background = null
    if (backgroundNode !== null) sceneWithBackground.backgroundNode = null
    renderer.setClearColor(0x000000, 0)
    try {
      return super.updateBefore(frame) as boolean | undefined
    } finally {
      renderer.setClearColor(savedClearColor, clearAlpha)
      if (background !== null) sceneWithBackground.background = background
      if (backgroundNode !== null) sceneWithBackground.backgroundNode = backgroundNode
      for (const light of lights) light.layers.disable(TRANSLUCENT_LAYER)
      lights.length = 0
    }
  }
}

/**
 * Composites the translucent pass over the stage's colour: each pixel's translucent colour is hazed at the distance
 * of its nearest translucent face (`Atmosphere.createAerialPerspectiveAlongRay`) and goes over the colour, unless
 * opaque geometry stands nearer. Without an atmosphere it goes over unhazed.
 */
export class TranslucentCompositeNode extends Node {
  static get type(): string {
    return 'TranslucentCompositeNode'
  }

  constructor(
    readonly colorNode: Node<'vec4'>,
    readonly depthNode: Node<'float'>,
    readonly translucentColorNode: Node<'vec4'>,
    readonly translucentDepthNode: Node<'float'>,
    readonly camera: Camera,
    readonly atmosphere: Atmosphere | null,
  ) {
    super('vec4')
  }

  override setup(builder: NodeBuilder): Node<'vec4'> {
    const camera = this.camera as PerspectiveCamera
    const renderer = builder.renderer
    const logarithmicDepth = renderer.logarithmicDepthBuffer && !renderer.reversedDepthBuffer
    const projectionMatrixInverse = uniform(new Matrix4()).onRenderUpdate((_, self) => void self.value.copy(camera.projectionMatrixInverse))
    const near = uniform(1).onRenderUpdate(() => camera.near)
    const far = uniform(1).onRenderUpdate(() => camera.far)
    const toViewZ = (depth: Node<'float'>) => (logarithmicDepth ? logarithmicDepthToViewZ(depth, near, far) : perspectiveDepthToViewZ(depth, near, far))
    const atmosphere = this.atmosphere
    const alongRay = atmosphere?.createAerialPerspectiveAlongRay(camera) ?? null
    const { colorNode, depthNode, translucentColorNode, translucentDepthNode } = this

    return Fn(() => {
      const behind = vec4(colorNode).toVar()
      const front = vec4(translucentColorNode).toConst()
      If(front.a.greaterThan(0), () => {
        const frontDepth = vec4(translucentDepthNode).x.toConst()
        const sceneDepth = vec4(depthNode).x.toConst()
        const frontHasDepth = isBackgroundDepth(frontDepth).not().toConst()
        const frontViewZ = toViewZ(frontDepth).toConst()
        // View z is negative ahead of the camera: the larger, the nearer.
        const hidden = frontHasDepth.and(isBackgroundDepth(sceneDepth).not()).and(toViewZ(sceneDepth).greaterThan(frontViewZ))
        If(hidden.not(), () => {
          const light = front.rgb.toVar()
          if (alongRay !== null && atmosphere !== null) {
            If(frontHasDepth.and(atmosphere.context.opacity.greaterThan(0)), () => {
              const viewDirection = getViewPosition(uv(), float(0.5), projectionMatrixInverse).normalize()
              const air = alongRay(frontViewZ.div(viewDirection.z))
              light.assign(mix(front.rgb, front.rgb.mul(air.transmittance).add(air.radiance.mul(front.a)), atmosphere.context.opacity))
            })
          }
          const uncovered = float(1).sub(front.a)
          behind.assign(vec4(light.add(behind.rgb.mul(uncovered)), front.a.add(behind.a.mul(uncovered))))
        })
      })
      return behind
    })()
  }
}

/**
 * The built-in pass that draws `TRANSLUCENT_LAYER` after the atmosphere, first in the `radiance` stage (so bloom and
 * the like see it). Registered by `earth.renderPasses.retainTranslucentPass()`.
 */
export const TRANSLUCENT_RENDER_PASS: RenderPassDefinition = {
  name: TRANSLUCENT_RENDER_PASS_NAME,
  stage: 'radiance',
  order: -Number.MAX_SAFE_INTEGER,
  build: ({ color, depth, camera, atmosphere, scene, disposeOnRebuild }) => {
    if (scene === null) {
      throw new Error('the translucent pass draws the scene again: attach the pipeline with attach(renderPipeline, scenePass, camera), or give attachInputs a scene')
    }
    const pass = new TranslucentPassNode(scene, camera)
    disposeOnRebuild(pass)
    return new TranslucentCompositeNode(color, depth, pass.getTextureNode('output') as unknown as Node<'vec4'>, pass.getTextureNode('depth') as unknown as Node<'float'>, camera, atmosphere)
  },
}
