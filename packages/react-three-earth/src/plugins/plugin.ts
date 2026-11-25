import type { Camera, Object3D } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import type { Earth } from '../core/Earth.js'
import type { EarthEventMap, EarthEventType } from '../core/events.js'
import type { PointerInteraction } from '../core/PointerInteractions.js'
import type { DrapedLayerDefinition, DrapedLayerHandle } from './drapedLayers.js'
import type { RenderPassDefinition } from './renderPasses.js'
import type { StyleLayerTypeDefinition } from './styleLayerTypes.js'
import type { SymbolEffectDefinition } from './symbolEffects.js'
import type { TerrainShadingDefinition } from './terrainShadings.js'

/**
 * The version of the plugin API this @earthkit/globe implements. Additive changes keep it; a change that
 * breaks plugins raises it. A plugin states the version it was built against in `apiVersion`.
 */
export const PLUGIN_API_VERSION = 1

/**
 * A package that extends @earthkit/globe: install it with `earth.addPlugin(plugin)` or
 * `<Earth plugins={[plugin]}>`. Everything it registers through its `PluginContext` is undone when it is
 * removed, so `earth.removePlugin(plugin)` leaves the earth as it was.
 *
 * @example
 * const spinner: EarthPlugin = {
 *   name: 'spinner',
 *   apiVersion: PLUGIN_API_VERSION,
 *   install(context) {
 *     const box = new Mesh(new BoxGeometry(1000, 1000, 1000))
 *     context.addObject(box)
 *     context.onUpdate(({ deltaSeconds }) => void (box.rotation.z += deltaSeconds))
 *   },
 * }
 */
export interface EarthPlugin {
  /** Unique on an earth, npm-style: `'@acme/sdf-shapes'`. */
  readonly name: string
  /** The `PLUGIN_API_VERSION` the plugin was built against. */
  readonly apiVersion: number
  /**
   * Registers everything the plugin adds, through `context`. May return a promise for asynchronous setup
   * (a texture, a WebAssembly module): the earth counts as loading, and `idle` waits, until it settles. A
   * rejection removes the plugin and fires the earth's `pluginerror` event.
   */
  install(context: PluginContext): void | Promise<void>
  /** Clean-up beyond what the context undoes on its own, for resources the plugin created itself. */
  uninstall?(): void
  /** A JSON-serialisable snapshot for `earth.inspect().plugins[name]`, for agents and devtools. */
  inspect?(): unknown
}

/** What `PluginContext.onUpdate` callbacks receive, once per `earth.update`. */
export interface PluginFrame {
  readonly earth: Earth
  readonly camera: Camera
  /** Time since the last frame. */
  readonly deltaSeconds: number
  /** 0 on the globe, 1 on the flat map (`earth.view.morph`). */
  readonly morph: number
  /** The renderer drawing this frame: for GPU work of the plugin's own (compute passes). */
  readonly renderer: WebGPURenderer
}

/**
 * What a plugin registers through. Every call is recorded and undone, in reverse order, when the plugin
 * is removed.
 */
export interface PluginContext {
  /** The earth the plugin is installed on: camera, view, terrain, atmosphere, events. */
  readonly earth: Earth
  /** The `PLUGIN_API_VERSION` of this @earthkit/globe. */
  readonly apiVersion: number
  /**
   * Runs `callback` at the end of every `earth.update`, after the camera, the morph, the tiles and the sun.
   * Return true to ask for another frame (hosts that render on demand). Timed per plugin in
   * `earth.inspect().plugins`.
   */
  onUpdate(callback: (frame: PluginFrame) => boolean | void): void
  /**
   * Adds an object under the earth, in ECEF metres (place it with `earth.createGeographicAnchor`). Returns
   * a function that removes it; whatever is left is removed when the plugin is.
   */
  addObject(object: Object3D): () => void
  /** Counts as loading until the promise settles, so `load` and `idle` wait for it. */
  trackLoading(promise: Promise<unknown>): void
  /** Listens to an earth event; the listener is removed with the plugin. */
  addEventListener<T extends EarthEventType>(type: T, listener: (event: EarthEventMap[T] & { type: T; target: Earth }) => void): void
  /** Runs `callback` when the plugin is removed, after the context's own clean-up steps registered later. */
  onDispose(callback: () => void): void
  /**
   * Adds a custom style layer type: style layers with `"type": definition.type` are drawn by it in every map
   * style source of this earth, at their place in the style. Registered later than the style loaded, those
   * layers appear without refetching tiles. Returns a function that removes it early.
   */
  registerStyleLayerType(definition: StyleLayerTypeDefinition): () => void
  /**
   * Adds a symbol effect: the text and SDF icons of `symbol` layers whose metadata names it
   * (`"react-three-earth:symbol-effect": definition.name`) are shaded by it, in every map style source of this
   * earth. Labels already drawn switch at once, without processing tiles again. Returns a function that removes it early.
   */
  registerSymbolEffect(definition: SymbolEffectDefinition): () => void
  /**
   * Adds a terrain shading: every terrain tile's material runs it over its own colour and the imagery, to change the
   * colour, roughness, metalness, normal or emission (a sea's gloss, snow). It composes with `createMaterial` and
   * terrain styles. Tiles already loaded rebuild their shaders, without reloading. Returns a function that removes it early.
   */
  registerTerrainShading(definition: TerrainShadingDefinition): () => void
  /**
   * Adds a screen effect to the earth's render pipeline (`EarthRenderPipeline`), in a stage: `scene` (before
   * the atmosphere), `radiance` (after it, linear HDR) or `display` (tone-mapped). The pipeline's output is
   * rebuilt once, not per frame. Returns a function that removes it early.
   */
  registerRenderPass(definition: RenderPassDefinition): () => void
  /**
   * Drapes a layer drawn by the plugin above every imagery layer, through the imagery compositor's queue and
   * budget. It is static: it redraws only when `handle.invalidate(bounds)` is called. `handle.remove()`
   * removes it early.
   */
  registerDrapedLayer(definition: DrapedLayerDefinition): DrapedLayerHandle
  /**
   * Lets the plugin take presses on the map from the camera controls (`earth.interactions`): a press its
   * `pointerDown` returns true for, and that press's moves and release, never pan the map. For dragging
   * vertices and handles. Returns a function that removes it early.
   */
  addPointerInteraction(interaction: PointerInteraction): () => void
}
