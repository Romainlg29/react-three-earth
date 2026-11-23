import type { Camera, Object3D } from 'three'

import { GeographicAnchor } from '../core/GeographicAnchor.js'
import type { Earth } from '../core/Earth.js'
import type { EarthEventMap, EarthEventType } from '../core/events.js'
import type { DrapedLayerDefinition, DrapedLayerHandle } from './drapedLayers.js'
import type { RenderPassDefinition } from './renderPasses.js'
import type { StyleLayerTypeDefinition } from './styleLayerTypes.js'
import { PLUGIN_API_VERSION, type EarthPlugin, type PluginContext, type PluginFrame } from './plugin.js'

/** Per-plugin statistics in `earth.inspect().plugins`. */
export interface PluginInspection {
  apiVersion: number
  /** False until an asynchronous `install` settles. */
  ready: boolean
  /** Main-thread time of the plugin's `onUpdate` callbacks over the last frame. */
  updateMilliseconds: number
  /** Whatever the plugin's own `inspect()` returns. */
  details?: unknown
}

/** Average `onUpdate` time over which a plugin gets one warning, in milliseconds. */
const SLOW_UPDATE_MILLISECONDS = 1
/** Frames averaged before warning about a slow plugin. */
const SLOW_UPDATE_FRAMES = 120

/** One installed plugin: its context, the steps that undo its registrations, and its timings. */
export class PluginInstallation implements PluginContext {
  readonly plugin: EarthPlugin
  readonly earth: Earth
  readonly apiVersion = PLUGIN_API_VERSION
  ready = true
  updateMilliseconds = 0
  protected readonly undoSteps: Array<() => void> = []
  protected readonly updateCallbacks: Array<(frame: PluginFrame) => boolean | void> = []
  protected readonly loading = new Set<Promise<unknown>>()
  protected slowFrames = 0
  protected slowMilliseconds = 0
  protected warnedSlow = false
  protected disposed = false

  constructor(plugin: EarthPlugin, earth: Earth) {
    this.plugin = plugin
    this.earth = earth
  }

  get isLoading(): boolean {
    return !this.ready || this.loading.size > 0
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  onUpdate(callback: (frame: PluginFrame) => boolean | void): void {
    this.requireActive('onUpdate')
    this.updateCallbacks.push(callback)
    this.undoSteps.push(() => this.updateCallbacks.splice(this.updateCallbacks.indexOf(callback), 1))
  }

  addObject(object: Object3D): () => void {
    this.requireActive('addObject')
    this.earth.add(object)
    let removed = false
    const remove = () => {
      if (removed) return
      removed = true
      // An anchor stops following the morph; anything else leaves the earth, unless something moved it meanwhile.
      if (object instanceof GeographicAnchor) object.dispose()
      else if (object.parent === this.earth) this.earth.remove(object)
    }
    this.undoSteps.push(remove)
    return remove
  }

  trackLoading(promise: Promise<unknown>): void {
    this.requireActive('trackLoading')
    this.loading.add(promise)
    const settle = () => {
      this.loading.delete(promise)
      this.earth.requestFrame()
    }
    promise.then(settle, settle)
  }

  addEventListener<T extends EarthEventType>(type: T, listener: (event: EarthEventMap[T] & { type: T; target: Earth }) => void): void {
    this.requireActive('addEventListener')
    const typed = listener as unknown as Parameters<Earth['addEventListener']>[1]
    this.earth.addEventListener(type, typed)
    this.undoSteps.push(() => this.earth.removeEventListener(type, typed))
  }

  onDispose(callback: () => void): void {
    this.requireActive('onDispose')
    this.undoSteps.push(callback)
  }

  registerStyleLayerType(definition: StyleLayerTypeDefinition): () => void {
    this.requireActive('registerStyleLayerType')
    const remove = this.earth.styleLayerTypes.register(definition)
    this.undoSteps.push(remove)
    return remove
  }

  registerRenderPass(definition: RenderPassDefinition): () => void {
    this.requireActive('registerRenderPass')
    const remove = this.earth.renderPasses.register(definition)
    this.undoSteps.push(remove)
    return remove
  }

  registerDrapedLayer(definition: DrapedLayerDefinition): DrapedLayerHandle {
    this.requireActive('registerDrapedLayer')
    const handle = this.earth.drapedLayers.register(definition)
    this.undoSteps.push(handle.remove)
    return handle
  }

  /** Runs the plugin's `onUpdate` callbacks. Returns true if one asked for another frame. */
  runUpdates(frame: PluginFrame): boolean {
    if (this.updateCallbacks.length === 0) {
      this.updateMilliseconds = 0
      return false
    }
    const start = performance.now()
    let needsFrame = false
    for (const callback of [...this.updateCallbacks]) {
      if (this.disposed) break // removed by an earlier callback of this frame
      try {
        if (callback(frame) === true) needsFrame = true
      } catch (error) {
        console.error(`Plugin "${this.plugin.name}": an onUpdate callback threw. Fix the plugin, or remove it with earth.removePlugin.`, error)
      }
    }
    this.updateMilliseconds = performance.now() - start
    this.trackSlowness()
    return needsFrame
  }

  /** Undoes every registration, last first, then calls the plugin's own `uninstall`. Errors are reported, not thrown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.undo()
    try {
      this.plugin.uninstall?.()
    } catch (error) {
      console.error(`Plugin "${this.plugin.name}": uninstall threw. Fix the plugin's uninstall.`, error)
    }
  }

  /** Undoes the registrations without calling `uninstall`, for a failed `install`. */
  undo(): void {
    this.disposed = true
    while (this.undoSteps.length > 0) {
      const step = this.undoSteps.pop()!
      try {
        step()
      } catch (error) {
        console.error(`Plugin "${this.plugin.name}": a clean-up step threw while it was removed.`, error)
      }
    }
    this.updateCallbacks.length = 0
    this.loading.clear()
  }

  inspect(): PluginInspection {
    let details: unknown
    try {
      details = this.plugin.inspect?.()
    } catch (error) {
      details = { error: String(error) }
    }
    return { apiVersion: this.plugin.apiVersion, ready: this.ready, updateMilliseconds: this.updateMilliseconds, ...(details === undefined ? {} : { details }) }
  }

  protected requireActive(method: string): void {
    if (this.disposed) {
      throw new Error(`Plugin "${this.plugin.name}" called context.${method} after it was removed. Keep registrations inside install(), or check that the plugin is still installed.`)
    }
  }

  protected trackSlowness(): void {
    if (this.warnedSlow) return
    this.slowFrames++
    this.slowMilliseconds += this.updateMilliseconds
    if (this.slowFrames < SLOW_UPDATE_FRAMES) return
    const average = this.slowMilliseconds / this.slowFrames
    this.slowFrames = 0
    this.slowMilliseconds = 0
    if (average > SLOW_UPDATE_MILLISECONDS) {
      this.warnedSlow = true
      console.warn(
        `Plugin "${this.plugin.name}": onUpdate takes ${average.toFixed(2)} ms per frame on average, over the ${SLOW_UPDATE_MILLISECONDS} ms a plugin should use. ` +
          'Move per-feature work to a worker or the GPU, or update less often.',
      )
    }
  }
}

/**
 * The plugins installed on one `Earth`, in install order. `Earth` owns one (`earth.plugins`); install and
 * remove plugins with `earth.addPlugin` and `earth.removePlugin`.
 */
export class PluginManager {
  protected readonly earth: Earth
  protected readonly installations = new Map<string, PluginInstallation>()

  constructor(earth: Earth) {
    this.earth = earth
  }

  get size(): number {
    return this.installations.size
  }

  has(nameOrPlugin: string | EarthPlugin): boolean {
    return this.find(nameOrPlugin) !== undefined
  }

  /** The installed plugin with this name, or undefined. */
  get<T extends EarthPlugin = EarthPlugin>(name: string): T | undefined {
    return this.installations.get(name)?.plugin as T | undefined
  }

  /** Installed plugins, in install order. */
  [Symbol.iterator](): IterableIterator<EarthPlugin> {
    return [...this.installations.values()].map(installation => installation.plugin)[Symbol.iterator]()
  }

  /** True while an asynchronous `install`, or a promise given to `trackLoading`, has not settled. */
  get loading(): boolean {
    for (const installation of this.installations.values()) if (installation.isLoading) return true
    return false
  }

  add(plugin: EarthPlugin): void {
    const name = typeof plugin?.name === 'string' ? plugin.name : ''
    if (name === '' || typeof plugin.install !== 'function') {
      throw new Error('earth.addPlugin: a plugin is an object with a non-empty `name`, an `apiVersion` and an `install(context)` method.')
    }
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(
        `Plugin "${name}" targets plugin API ${String(plugin.apiVersion)}, this react-three-earth implements ${PLUGIN_API_VERSION}: ` +
          `upgrade react-three-earth, or install a version of "${name}" built for plugin API ${PLUGIN_API_VERSION}.`,
      )
    }
    const existing = this.installations.get(name)
    if (existing !== undefined) {
      if (existing.plugin === plugin) return
      throw new Error(`Plugin "${name}" is already installed on this earth: remove it first with earth.removePlugin.`)
    }
    const installation = new PluginInstallation(plugin, this.earth)
    this.installations.set(name, installation)
    let result: void | Promise<void>
    try {
      result = plugin.install(installation)
    } catch (error) {
      this.installations.delete(name)
      installation.undo()
      throw new Error(`Plugin "${name}" failed to install: ${(error as Error)?.message ?? String(error)}`, { cause: error })
    }
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      installation.ready = false
      ;(result as Promise<void>).then(
        () => {
          installation.ready = true
          this.earth.requestFrame()
        },
        (error: unknown) => {
          installation.ready = true
          // Removed before it settled (StrictMode, a quick remove and add): its context refuses calls, which is no error.
          if (this.installations.get(name) !== installation) return
          this.installations.delete(name)
          installation.dispose()
          this.earth.dispatchEvent({ type: 'pluginerror', pluginName: name, error })
          console.error(`Plugin "${name}" failed to install and was removed. Fix the error below, then add it again.`, error)
        },
      )
    }
    this.earth.requestFrame()
  }

  /** Removes a plugin (or the plugin with this name). Does nothing if it is not installed. */
  remove(nameOrPlugin: string | EarthPlugin): void {
    const installation = this.find(nameOrPlugin)
    if (installation === undefined) return
    this.installations.delete(installation.plugin.name)
    installation.dispose()
    this.earth.requestFrame()
  }

  /** Removes every plugin, last installed first. */
  clear(): void {
    for (const installation of [...this.installations.values()].reverse()) this.remove(installation.plugin)
  }

  /** Runs every plugin's `onUpdate` callbacks. Returns true if one asked for another frame. */
  update(camera: Camera, deltaSeconds: number): boolean {
    if (this.installations.size === 0) return false
    const frame: PluginFrame = { earth: this.earth, camera, deltaSeconds, morph: this.earth.view.morph }
    let needsFrame = false
    for (const installation of [...this.installations.values()]) if (installation.runUpdates(frame)) needsFrame = true
    return needsFrame
  }

  inspect(): Record<string, PluginInspection> {
    const result: Record<string, PluginInspection> = {}
    for (const [name, installation] of this.installations) result[name] = installation.inspect()
    return result
  }

  protected find(nameOrPlugin: string | EarthPlugin): PluginInstallation | undefined {
    if (typeof nameOrPlugin === 'string') return this.installations.get(nameOrPlugin)
    const installation = this.installations.get(nameOrPlugin.name)
    return installation?.plugin === nameOrPlugin ? installation : undefined
  }
}
