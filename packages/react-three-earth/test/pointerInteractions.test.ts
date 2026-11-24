// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EarthCamera } from '../src/core/EarthCamera.js'
import { PointerInteractions, type PointerInteraction } from '../src/core/PointerInteractions.js'
import { TouchGestures } from '../src/core/TouchGestures.js'

function setup() {
  const element = document.createElement('div')
  const canvas = document.createElement('canvas')
  element.append(canvas)
  document.body.append(element)
  const camera = { ready: true, unproject: vi.fn(() => ({ longitudeDegrees: 1, latitudeDegrees: 2, heightMeters: 3 })) } as unknown as EarthCamera
  const interactions = new PointerInteractions(camera)
  interactions.attach(element, canvas)
  // What the camera controls see: listeners on the element.
  const controls = { down: 0, move: 0 }
  element.addEventListener('pointerdown', () => controls.down++)
  element.addEventListener('pointermove', () => controls.move++)
  const fire = (type: string, init: PointerEventInit & { target?: Element } = {}) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 20, ...init })
    ;(init.target ?? canvas).dispatchEvent(event)
    return event
  }
  return { element, canvas, interactions, controls, fire, camera }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PointerInteractions', () => {
  it('lets presses nobody takes reach the controls', () => {
    const { interactions, controls, fire } = setup()
    interactions.add({ pointerDown: () => false })
    fire('pointerdown')
    fire('pointermove')
    expect(controls).toEqual({ down: 1, move: 1 })
  })

  it('hides a taken press from the controls and hands its moves and release to the interaction', () => {
    const { interactions, controls, fire } = setup()
    const calls: string[] = []
    const interaction: PointerInteraction = {
      pointerDown: event => {
        calls.push(`down ${event.screen.xPixels},${event.screen.yPixels} ${event.geographic?.longitudeDegrees}`)
        return true
      },
      pointerMove: () => void calls.push('move'),
      pointerUp: () => void calls.push('up'),
    }
    interactions.add(interaction)
    fire('pointerdown')
    expect(interactions.active).toBe(true)
    fire('pointermove')
    fire('pointerup')
    expect(calls).toEqual(['down 10,20 1', 'move', 'up'])
    expect(controls).toEqual({ down: 0, move: 0 })
    expect(interactions.active).toBe(false)
  })

  it('swallows the click that follows a taken press', () => {
    const { interactions, canvas, fire } = setup()
    interactions.add({ pointerDown: () => true })
    const clicks = vi.fn()
    canvas.addEventListener('click', clicks)
    fire('pointerdown')
    fire('pointerup')
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).not.toHaveBeenCalled()
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('offers presses to the interaction added last first, and only on the map surface', () => {
    const { element, interactions, fire } = setup()
    const order: string[] = []
    interactions.add({ pointerDown: () => (order.push('first'), true) })
    interactions.add({ pointerDown: () => (order.push('second'), false) })
    const button = document.createElement('button')
    element.append(button)
    fire('pointerdown', { target: button })
    expect(order).toEqual([])
    fire('pointerdown')
    expect(order).toEqual(['second', 'first'])
  })

  it('cancels a taken touch press when a second finger lands', () => {
    const { interactions, fire } = setup()
    const cancel = vi.fn()
    interactions.add({ pointerDown: () => true, pointerCancel: cancel })
    fire('pointerdown', { pointerType: 'touch', pointerId: 1 })
    fire('pointerdown', { pointerType: 'touch', pointerId: 2 })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(interactions.active).toBe(false)
  })

  it('cancels a taken touch press when a pinch starts, with the touch gestures listening first', () => {
    const element = document.createElement('div')
    const canvas = document.createElement('canvas')
    element.append(canvas)
    document.body.append(element)
    const camera = { ready: true, unproject: () => null } as unknown as EarthCamera
    // The controls attach before the earth: their gestures see each touch first and hide the second finger.
    const gestures = new TouchGestures()
    gestures.attach(element)
    const interactions = new PointerInteractions(camera)
    interactions.attach(element, canvas)
    gestures.onStart = () => interactions.cancelTouch()
    const calls: string[] = []
    interactions.add({ pointerDown: () => (calls.push('down'), true), pointerUp: () => void calls.push('up'), pointerCancel: () => void calls.push('cancel') })
    const touch = (type: string, pointerId: number, isPrimary: boolean) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary, clientX: 10 * pointerId, clientY: 20 }))
    touch('pointerdown', 1, true)
    touch('pointerdown', 2, false)
    expect(calls).toEqual(['down', 'cancel'])
    // The first finger lifts first: the gestures hide that lift.
    touch('pointerup', 1, true)
    touch('pointerup', 2, false)
    // A new press is offered again: the hidden fingers no longer count.
    touch('pointerdown', 3, true)
    expect(calls).toEqual(['down', 'cancel', 'down'])
    gestures.detach()
    interactions.detach()
  })

  it('swallows the double click that follows a taken press', () => {
    const { interactions, canvas, fire } = setup()
    let take = true
    interactions.add({ pointerDown: () => take })
    const doubleClicks = vi.fn()
    canvas.addEventListener('dblclick', doubleClicks)
    fire('pointerdown')
    fire('pointerup')
    take = false
    fire('pointerdown')
    fire('pointerup')
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(doubleClicks).not.toHaveBeenCalled()
  })

  it('lets a click elsewhere through right after a taken release', () => {
    const { element, interactions, fire } = setup()
    interactions.add({ pointerDown: () => true })
    fire('pointerdown')
    fire('pointerup')
    const button = document.createElement('button')
    document.body.append(button)
    const clicks = vi.fn()
    button.addEventListener('click', clicks)
    fire('pointerdown', { target: button })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(element.contains(button)).toBe(false)
  })

  it('cancels the press when its interaction is removed', () => {
    const { interactions, fire } = setup()
    const cancel = vi.fn()
    const remove = interactions.add({ pointerDown: () => true, pointerCancel: cancel })
    fire('pointerdown')
    remove()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(interactions.size).toBe(0)
  })

  it('counts double-click zoom holds', () => {
    const { interactions } = setup()
    const first = interactions.holdDoubleClickZoom()
    const second = interactions.holdDoubleClickZoom()
    first()
    expect(interactions.doubleClickZoomAllowed).toBe(false)
    second()
    expect(interactions.doubleClickZoomAllowed).toBe(true)
  })
})
