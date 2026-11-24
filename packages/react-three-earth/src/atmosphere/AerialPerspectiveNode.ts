import { Matrix4, type Camera, type PerspectiveCamera } from 'three'
import {
  float,
  Fn,
  fwidth,
  getViewPosition,
  If,
  isBackgroundDepth,
  logarithmicDepthToViewZ,
  mix,
  min,
  perspectiveDepthToViewZ,
  int,
  vec2,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { Node, type NodeBuilder, type TextureNode } from 'three/webgpu'

import type { AtmosphereContext } from './AtmosphereContext.js'
import { LENGTH_UNIT_METERS } from './AtmosphereModel.js'

/** What `nearestNeighbourKilometers` returns when no pixel beside has geometry. */
const NO_NEIGHBOUR_KILOMETERS = 1e9

/**
 * Post-processing node that puts the scene inside the atmosphere: geometry is dimmed by the transmittance
 * between it and the camera and hazed by the light scattered in between; background pixels get the sky
 * and the sun disk. The output is opaque.
 *
 * It reads the scene camera given to it, never the renderer's: inside a post-processing pass the renderer
 * draws a full-screen quad with its own camera. Perspective cameras only. Works with standard, reversed
 * and logarithmic depth buffers; use a reversed one, since a standard float depth buffer with a far plane
 * at 1e8 m resolves distances from orbit only in steps of hundreds of kilometres, and the haze bands.
 * Until the lookup textures are generated it passes the scene colour through.
 */
export class AerialPerspectiveNode extends Node {
  static get type(): string {
    return 'AerialPerspectiveNode'
  }

  readonly context: AtmosphereContext
  readonly colorNode: Node<'vec4'>
  readonly depthNode: Node<'vec4'>
  /** The scene camera. Fixed: the shader is built for it. */
  readonly camera: Camera
  /** Whether the sky shows the sun disk. Fixed: the shader is built with or without it. */
  readonly showSun: boolean

  constructor(
    context: AtmosphereContext,
    colorNode: Node<'vec4'>,
    depthNode: Node<'vec4'>,
    camera: Camera,
    { showSun = true }: { showSun?: boolean } = {},
  ) {
    super('vec4')
    this.context = context
    this.colorNode = colorNode
    this.depthNode = depthNode
    this.camera = camera
    this.showSun = showSun
  }

  override setup(builder: NodeBuilder): Node<'vec4'> {
    const camera = this.camera as PerspectiveCamera
    if (camera.isPerspectiveCamera !== true) throw new Error('AerialPerspectiveNode: only perspective cameras are supported.')
    const renderer = builder.renderer
    const logarithmicDepth = renderer.logarithmicDepthBuffer && !renderer.reversedDepthBuffer

    const { model, textures, sunDirection, texturesReady, opacity } = this.context
    const projectionMatrixInverse = uniform(new Matrix4()).onRenderUpdate((_, self) => void self.value.copy(camera.projectionMatrixInverse))
    const cameraWorldMatrix = uniform(new Matrix4()).onRenderUpdate((_, self) => void self.value.copy(camera.matrixWorld))
    const near = uniform(1).onRenderUpdate(() => camera.near)
    const far = uniform(1).onRenderUpdate(() => camera.far)
    this.context.prepare(renderer)
    const cameraNodes = this.context.createCameraNodes(camera)
    const skyLuminanceFactor = this.context.skyLuminanceFactor
    const { colorNode, depthNode } = this

    return Fn(() => {
      const depth = depthNode.x.toConst()
      // Any point along the pixel's ray gives its direction; mid-range depth is defined for all depth modes.
      const viewDirection = getViewPosition(uv(), float(0.5), projectionMatrixInverse).normalize().toConst()
      const worldDirection = cameraWorldMatrix.mul(vec4(viewDirection, 0)).xyz.normalize().toConst()
      const sunDisk = this.showSun ? this.sunDiskMask(worldDirection) : float(0)

      // The model's frame tilts the vertical by up to 0.19° (see correctPositionForEllipsoid): directions are
      // rotated to match at the camera, so the sky's horizon meets the terrain's and the sun sets on time.
      const { atmospherePosition: cameraPosition, directionRotation } = cameraNodes
      const viewDirectionModel = directionRotation.mul(worldDirection).toConst()
      const sunDirectionModel = directionRotation.mul(sunDirection).toConst()
      const luminance = vec3(0).toVar()
      // Until the lookup textures are generated, and on the flat map, show the scene as it is (no sky).
      If(texturesReady.lessThan(0.5).or(opacity.lessThanEqual(0)), () => {
        luminance.assign(colorNode.rgb)
      }).ElseIf(isBackgroundDepth(depth), () => {
        const sky = model.getSkyRadiance(textures, cameraPosition, viewDirectionModel, sunDirectionModel)
        const sun = sky.transmittance.mul(model.solarRadiance).mul(this.context.sunLuminanceFactor).mul(sunDisk)
        const behind = sky.radiance.mul(skyLuminanceFactor).add(sun)
        // Geometry that writes no depth (transparent faces, screen labels) leaves premultiplied colour over the
        // cleared background (alpha 0), with its coverage in alpha: it goes over the sky, not under it. So do the
        // multisampled edges of opaque geometry, such as the planet's limb: hazed as far away as the nearest
        // neighbouring geometry, they blend into the haze beside them. A scene background colour (alpha 1) covers
        // the sky.
        const coverage = colorNode.a.toConst()
        const front = colorNode.rgb.toVar()
        const neighbourKilometers = this.nearestNeighbourKilometers(viewDirection, near, far, logarithmicDepth)
        If(coverage.greaterThan(0).and(neighbourKilometers.lessThan(NO_NEIGHBOUR_KILOMETERS)), () => {
          const between = this.context.getAerialPerspective(cameraNodes, worldDirection, neighbourKilometers)
          front.assign(colorNode.rgb.mul(between.transmittance).add(between.radiance.mul(coverage)))
        })
        luminance.assign(front.add(behind.mul(float(1).sub(coverage))))
      }).Else(() => {
        const viewZ = logarithmicDepth ? logarithmicDepthToViewZ(depth, near, far) : perspectiveDepthToViewZ(depth, near, far)
        const distanceKilometers = viewZ.div(viewDirection.z).div(LENGTH_UNIT_METERS)
        const between = this.context.getAerialPerspective(cameraNodes, worldDirection, distanceKilometers)
        luminance.assign(colorNode.rgb.mul(between.transmittance).add(between.radiance))
      })
      // The sky covers every pixel the scene left empty, so the result is opaque. Keeping the scene's cleared
      // alpha (0) would show the page behind the canvas where the sky should be.
      return vec4(mix(colorNode.rgb, luminance, opacity), 1)
    })()
  }

  /**
   * Distance in kilometres to the nearest geometry among the four pixels beside this one, or
   * `NO_NEIGHBOUR_KILOMETERS` when they are all background (or the depth is not a texture to sample around).
   */
  protected nearestNeighbourKilometers(viewDirection: Node<'vec3'>, near: Node<'float'>, far: Node<'float'>, logarithmicDepth: boolean): Node<'float'> {
    const depthTexture = this.depthNode as unknown as TextureNode
    if (depthTexture.isTextureNode !== true) return float(NO_NEIGHBOUR_KILOMETERS)
    const texel = vec2(1).div(vec2(depthTexture.size(int(0)) as Node<'ivec2'>)).toConst()
    const nearest = float(NO_NEIGHBOUR_KILOMETERS).toVar()
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const depth = depthTexture.sample(uv().add(texel.mul(vec2(x, y)))).x.toConst()
      If(isBackgroundDepth(depth).not(), () => {
        const viewZ = logarithmicDepth ? logarithmicDepthToViewZ(depth, near, far) : perspectiveDepthToViewZ(depth, near, far)
        nearest.assign(min(nearest, viewZ.div(viewDirection.z).div(LENGTH_UNIT_METERS)))
      })
    }
    return nearest
  }

  /** 1 inside the sun disk, 0 outside, with a one-pixel soft edge. Uses derivatives: call in uniform control flow. */
  protected sunDiskMask(worldDirection: Node<'vec3'>): Node<'float'> {
    const angularRadius = this.context.parameters.sunAngularRadiusRadians
    const threshold = 1 - Math.cos(angularRadius)
    const distanceFromCenter = float(1).sub(worldDirection.dot(this.context.sunDirection)).toConst()
    const edgeWidth = fwidth(distanceFromCenter)
    return float(1).sub(smoothstep(float(threshold).sub(edgeWidth), edgeWidth.add(threshold), distanceFromCenter))
  }
}
