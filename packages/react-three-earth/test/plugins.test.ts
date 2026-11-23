import { Mesh, PerspectiveCamera, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCameraView, toCartesian } from '../src/core/camera.js'
import { Earth } from '../src/core/Earth.js'
import { GeographicAnchor } from '../src/core/GeographicAnchor.js'
import { getLocalCameraPosition } from '../src/core/sceneNodes.js'
import { PLUGIN_API_VERSION, type EarthPlugin, type PluginContext } from '../src/plugins/plugin.js'
import { mercatorScaleFactor } from '../src/view/webMercator.js'

const renderer = { getSize: (target: { set(x: number, y: number): void }) => target.set(800, 600) } as unknown as WebGPURenderer

function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 800 / 600, 1, 1e8)
  camera.position.set(0, 0, 2e7)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

function plugin(name: string, install: (context: PluginContext) => void | Promise<void>, extra: Partial<EarthPlugin> = {}): EarthPlugin {
  return { name, apiVersion: PLUGIN_API_VERSION, install, ...extra }
}

afterEach(() => vi.restoreAllMocks())

describe('earth.addPlugin / removePlugin', () => {
  it('installs, lists and removes a plugin, undoing its registrations in reverse order', () => {
    const earth = new Earth()
    const order: string[] = []
    const object = new Mesh()
    const listener = vi.fn()
    const uninstall = vi.fn(() => order.push('uninstall'))
    const spinner = plugin(
      'spinner',
      context => {
        context.addObject(object)
        context.addEventListener('framerequest', listener)
        context.onDispose(() => order.push('first'))
        context.onDispose(() => order.push('second'))
      },
      { uninstall },
    )
    earth.addPlugin(spinner)
    expect(earth.plugins.has('spinner')).toBe(true)
    expect(earth.plugins.get('spinner')).toBe(spinner)
    expect([...earth.plugins]).toEqual([spinner])
    expect(object.parent).toBe(earth)
    listener.mockClear()
    earth.requestFrame()
    expect(listener).toHaveBeenCalledTimes(1)

    earth.removePlugin(spinner)
    expect(earth.plugins.has('spinner')).toBe(false)
    expect(object.parent).toBeNull()
    earth.requestFrame()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['second', 'first', 'uninstall'])
  })

  it('ignores adding the same plugin twice and refuses another plugin with the same name, stating the fix', () => {
    const earth = new Earth()
    const install = vi.fn()
    const first = plugin('same', install)
    earth.addPlugin(first)
    earth.addPlugin(first)
    expect(install).toHaveBeenCalledTimes(1)
    expect(() => earth.addPlugin(plugin('same', () => {}))).toThrow(/already installed on this earth: remove it first/)
  })

  it('refuses a plugin built for another API version, stating the fix', () => {
    const earth = new Earth()
    expect(() => earth.addPlugin({ name: 'future', apiVersion: PLUGIN_API_VERSION + 1, install() {} })).toThrow(
      /targets plugin API 2, this react-three-earth implements 1: upgrade react-three-earth/,
    )
    expect(() => earth.addPlugin({} as EarthPlugin)).toThrow(/non-empty `name`/)
  })

  it('undoes a partial install when install throws, and rethrows with the plugin name', () => {
    const earth = new Earth()
    const object = new Mesh()
    expect(() =>
      earth.addPlugin(
        plugin('broken', context => {
          context.addObject(object)
          throw new Error('no WebGPU device')
        }),
      ),
    ).toThrow('Plugin "broken" failed to install: no WebGPU device')
    expect(object.parent).toBeNull()
    expect(earth.plugins.has('broken')).toBe(false)
  })

  it('refuses context calls after removal', () => {
    const earth = new Earth()
    let saved: PluginContext | null = null
    const keeper = plugin('keeper', context => void (saved = context))
    earth.addPlugin(keeper)
    earth.removePlugin('keeper')
    expect(() => saved!.onUpdate(() => {})).toThrow(/called context.onUpdate after it was removed/)
  })

  it('removes an object early through the function addObject returns', () => {
    const earth = new Earth()
    const object = new Mesh()
    let remove = () => {}
    earth.addPlugin(plugin('early', context => void (remove = context.addObject(object))))
    remove()
    expect(object.parent).toBeNull()
    earth.removePlugin('early')
    expect(object.parent).toBeNull()
  })

  it('does not report an error when an asynchronous install settles after its plugin was removed and added again', async () => {
    const earth = new Earth()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const errors: string[] = []
    earth.addEventListener('pluginerror', event => errors.push(event.pluginName))
    const objects: Mesh[] = []
    const waiter = plugin('waiter', async context => {
      await Promise.resolve()
      const object = new Mesh()
      objects.push(object)
      context.addObject(object) // throws on the first, removed, installation
    })
    earth.addPlugin(waiter)
    earth.removePlugin(waiter)
    earth.addPlugin(waiter) // StrictMode's mount, unmount, mount
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toEqual([])
    expect(error).not.toHaveBeenCalled()
    expect(earth.plugins.has('waiter')).toBe(true)
    expect(earth.inspect().plugins.waiter?.ready).toBe(true)
    expect(objects.at(-1)?.parent).toBe(earth)
  })

  it("stops a plugin's other callbacks once one of them removed it", () => {
    const earth = new Earth()
    const second = vi.fn()
    earth.addPlugin(
      plugin('quitter', context => {
        context.onUpdate(() => void earth.removePlugin('quitter'))
        context.onUpdate(second)
      }),
    )
    earth.update(createCamera(), renderer, 0.016)
    expect(second).not.toHaveBeenCalled()
    expect(earth.plugins.has('quitter')).toBe(false)
  })

  it('lets a plugin install another plugin from its install', () => {
    const earth = new Earth()
    const inner = plugin('inner', () => {})
    earth.addPlugin(plugin('outer', () => earth.addPlugin(inner)))
    expect([...earth.plugins].map(installed => installed.name)).toEqual(['outer', 'inner'])
  })

  it('removes every plugin, last installed first, on dispose', () => {
    const earth = new Earth()
    const order: string[] = []
    earth.addPlugin(plugin('a', () => {}, { uninstall: () => order.push('a') }))
    earth.addPlugin(plugin('b', () => {}, { uninstall: () => order.push('b') }))
    earth.dispose()
    expect(order).toEqual(['b', 'a'])
    expect(earth.plugins.size).toBe(0)
  })
})

describe('plugin frames, loading and inspection', () => {
  it('runs onUpdate callbacks each frame and asks for another frame when one returns true', () => {
    const earth = new Earth()
    const camera = createCamera()
    const frames: number[] = []
    let animate = true
    earth.addPlugin(
      plugin('animator', context =>
        context.onUpdate(frame => {
          frames.push(frame.deltaSeconds)
          expect(frame.earth).toBe(earth)
          expect(frame.camera).toBe(camera)
          return animate
        }),
      ),
    )
    expect(earth.update(camera, renderer, 0.016)).toBe(true)
    animate = false
    earth.update(camera, renderer, 0.016)
    expect(earth.update(camera, renderer, 0.016)).toBe(false)
    expect(frames).toEqual([0.016, 0.016, 0.016])
  })

  it('reports an onUpdate error without breaking the frame', () => {
    const earth = new Earth()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    earth.addPlugin(plugin('thrower', context => context.onUpdate(() => { throw new Error('boom') })))
    expect(() => earth.update(createCamera(), renderer, 0.016)).not.toThrow()
    expect(error.mock.calls[0]?.[0]).toMatch(/Plugin "thrower": an onUpdate callback threw/)
  })

  it('holds idle while an asynchronous install or a tracked promise is pending', async () => {
    const earth = new Earth()
    let finishInstall = () => {}
    let finishLoad = () => {}
    earth.addPlugin(
      plugin('loader', async context => {
        context.trackLoading(new Promise<void>(resolve => (finishLoad = resolve)))
        await new Promise<void>(resolve => (finishInstall = resolve))
      }),
    )
    expect(earth.plugins.loading).toBe(true)
    expect(earth.inspect().plugins.loader?.ready).toBe(false)
    finishInstall()
    await Promise.resolve()
    await Promise.resolve()
    expect(earth.inspect().plugins.loader?.ready).toBe(true)
    expect(earth.plugins.loading).toBe(true)
    finishLoad()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(earth.plugins.loading).toBe(false)
  })

  it('removes a plugin whose asynchronous install rejects, and fires pluginerror', async () => {
    const earth = new Earth()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const object = new Mesh()
    const errors: string[] = []
    earth.addEventListener('pluginerror', event => errors.push(event.pluginName))
    earth.addPlugin(
      plugin('rejecter', async context => {
        context.addObject(object)
        throw new Error('module failed to load')
      }),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toEqual(['rejecter'])
    expect(earth.plugins.has('rejecter')).toBe(false)
    expect(object.parent).toBeNull()
  })

  it('reports each plugin in earth.inspect() as plain JSON', () => {
    const earth = new Earth()
    earth.addPlugin(plugin('reporter', () => {}, { inspect: () => ({ shapes: 3 }) }))
    const inspection = earth.inspect().plugins
    expect(inspection).toEqual({ reporter: { apiVersion: 1, ready: true, updateMilliseconds: 0, details: { shapes: 3 } } })
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })
})

describe('GeographicAnchor', () => {
  const position = { longitudeDegrees: 10, latitudeDegrees: 45, heightMeters: 1000 }

  it('sits at the position, east-north-up, on the globe', () => {
    const anchor = new GeographicAnchor(position)
    anchor.update(null)
    expect(anchor.position.distanceTo(toCartesian(position))).toBeLessThan(1e-6)
    const up = new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion)
    expect(up.dot(toCartesian(position).normalize())).toBeGreaterThan(0.99)
    const north = new Vector3(0, 1, 0).applyQuaternion(anchor.quaternion)
    expect(north.z).toBeGreaterThan(0) // north points towards the North Pole
  })

  it('turns clockwise with the heading', () => {
    const plain = new GeographicAnchor(position)
    const turned = new GeographicAnchor(position, { headingDegrees: 90 })
    plain.update(null)
    turned.update(null)
    // Heading 90°: the anchor's y axis points east.
    const east = new Vector3(1, 0, 0).applyQuaternion(plain.quaternion)
    const turnedY = new Vector3(0, 1, 0).applyQuaternion(turned.quaternion)
    expect(turnedY.dot(east)).toBeCloseTo(1, 6)
  })

  it('follows the flat map: same place as camera.toScenePosition, flat-frame axes, map scale', () => {
    const earth = new Earth({ view: '2d' })
    const camera = new PerspectiveCamera(60, 800 / 600, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 10, latitudeDegrees: 45, distanceMeters: 100_000, headingDegrees: 0, pitchDegrees: -90 })
    earth.update(camera, renderer, 0.016)
    const anchor = earth.createGeographicAnchor(position)
    earth.update(camera, renderer, 0.016)
    expect(earth.view.morph).toBe(1)
    expect(anchor.position.distanceTo(earth.camera.toScenePosition(position))).toBeLessThan(1e-3)
    const up = new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion)
    expect(up.dot(earth.view.anchorUp)).toBeCloseTo(1, 6)
    expect(anchor.scale.x).toBeCloseTo(earth.view.scale * mercatorScaleFactor((45 * Math.PI) / 180), 9)
  })

  it('is disposed with the plugin that added it, and stops updating', () => {
    const earth = new Earth()
    let anchor: GeographicAnchor | null = null
    earth.addPlugin(
      plugin('anchored', context => {
        anchor = context.earth.createGeographicAnchor(position)
        context.addObject(anchor)
      }),
    )
    expect(anchor!.parent).toBe(earth)
    earth.removePlugin('anchored')
    expect(anchor!.isDisposed).toBe(true)
    expect(anchor!.parent).toBeNull()
    anchor!.position.set(1, 2, 3)
    earth.update(createCamera(), renderer, 0.016)
    expect(anchor!.position.toArray()).toEqual([1, 2, 3])
  })

  it("keeps the flat map's distances away from the map's reference point", () => {
    const earth = new Earth({ view: '2d' })
    const camera = new PerspectiveCamera(60, 800 / 600, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 10, latitudeDegrees: 45, distanceMeters: 100_000, headingDegrees: 0, pitchDegrees: -90 })
    earth.update(camera, renderer, 0.016)
    // 2° north of the reference, and a point about 1 km further north (1 km of meridian is about 0.009°).
    const south = earth.createGeographicAnchor({ longitudeDegrees: 10.3, latitudeDegrees: 47, heightMeters: 0 })
    const north = earth.createGeographicAnchor({ longitudeDegrees: 10.3, latitudeDegrees: 47 + 1000 / 111_170, heightMeters: 0 })
    earth.update(camera, renderer, 0.016)
    expect(south.position.distanceTo(earth.camera.toScenePosition({ longitudeDegrees: 10.3, latitudeDegrees: 47 }))).toBeLessThan(1e-3)
    // 1 km of ground, times the anchor's scale, is what separates them on the map.
    expect(south.position.distanceTo(north.position) / (1000 * south.scale.x)).toBeCloseTo(1, 2)
    const up = new Vector3(0, 0, 1).applyQuaternion(south.quaternion)
    expect(up.dot(earth.view.anchorUp)).toBeCloseTo(1, 6)
  })

  it('stops updating once disposed', () => {
    const earth = new Earth()
    const anchor = earth.createGeographicAnchor(position)
    earth.add(anchor)
    anchor.dispose()
    expect(anchor.parent).toBeNull()
    anchor.position.set(1, 2, 3)
    earth.update(createCamera(), renderer, 0.016)
    expect(anchor.position.toArray()).toEqual([1, 2, 3])
  })
})

describe('getLocalCameraPosition', () => {
  it('is small and exact near an object placed at planet scale', () => {
    const anchor = new GeographicAnchor({ longitudeDegrees: 138.73, latitudeDegrees: 35.36, heightMeters: 3776 })
    anchor.update(null)
    anchor.updateMatrixWorld()
    const camera = new PerspectiveCamera()
    // 100 m above the anchor, along its up axis.
    camera.position.copy(new Vector3(0, 0, 100).applyMatrix4(anchor.matrixWorld))
    camera.updateMatrixWorld()
    const local = getLocalCameraPosition(anchor, camera)
    expect(local.x).toBeCloseTo(0, 6)
    expect(local.y).toBeCloseTo(0, 6)
    expect(local.z).toBeCloseTo(100, 6)
  })
})
