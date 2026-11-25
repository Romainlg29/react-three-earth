import { Earth, Imagery, RasterTileSource } from '@earthkit/globe'
import { describe, expect, it, vi } from 'vitest'

import { Compare, type CompareState } from '../src/index.js'

function layer(): Imagery {
  return new Imagery({ sources: [new RasterTileSource({ url: 'https://tiles.test/{z}/{x}/{y}.png' })] })
}

function installed(compare: Compare): Earth {
  const earth = new Earth()
  earth.camera.setViewportSize(800, 600)
  earth.addPlugin(compare)
  return earth
}

describe('Compare', () => {
  it('clips before and after layers to opposite sides of the line while installed', () => {
    const before = layer()
    const after = layer()
    const shared = layer()
    const compare = new Compare({ before: [before], after: [after], positionFraction: 0.3 })
    expect(before.screenClip).toBeNull() // not installed yet
    const earth = installed(compare)
    expect(before.screenClip).toEqual({ side: 'left', positionFraction: 0.3 })
    expect(after.screenClip).toEqual({ side: 'right', positionFraction: 0.3 })
    expect(shared.screenClip).toBeNull()

    compare.orientation = 'horizontal'
    compare.setPosition(0.6)
    expect(before.screenClip).toEqual({ side: 'top', positionFraction: 0.6 })
    expect(after.screenClip).toEqual({ side: 'bottom', positionFraction: 0.6 })

    earth.removePlugin(compare)
    expect(before.screenClip).toBeNull()
    expect(after.screenClip).toBeNull()
  })

  it('moves a layer between sides, and shows a removed layer everywhere again', () => {
    const imagery = layer()
    const compare = new Compare()
    installed(compare)
    compare.addImagery(imagery, 'before')
    expect(imagery.screenClip?.side).toBe('left')
    compare.addImagery(imagery, 'after')
    expect(compare.getState().before).toEqual([])
    expect(compare.getState().after).toEqual([imagery])
    expect(imagery.screenClip?.side).toBe('right')
    compare.removeImagery(imagery)
    expect(imagery.screenClip).toBeNull()
  })

  it('clamps the position, notifies subscribers with a new snapshot and fires slide', () => {
    const compare = new Compare()
    const states: CompareState[] = []
    const unsubscribe = compare.subscribe(state => states.push(state))
    const slide = vi.fn()
    compare.addEventListener('slide', slide)
    const first = compare.getState()
    compare.setPosition(1.4)
    expect(compare.positionFraction).toBe(1)
    expect(compare.getState()).not.toBe(first)
    expect(states.at(-1)).toBe(compare.getState())
    expect(slide).toHaveBeenCalledWith(expect.objectContaining({ positionFraction: 1, input: 'code' }))
    compare.setPosition(1) // unchanged: nothing fires
    expect(slide).toHaveBeenCalledTimes(1)
    unsubscribe()
    compare.setPosition(0.2)
    expect(states).toHaveLength(1)
  })

  it('states the fix for invalid options', () => {
    expect(() => new Compare({ orientation: 'diagonal' as never })).toThrow(/orientation must be 'vertical' or 'horizontal'/)
    expect(() => new Compare({ positionFraction: Number.NaN })).toThrow(/positionFraction must be a number from 0 to 1/)
  })

  it('follows the pointer over the map when asked', () => {
    const compare = new Compare({ followPointer: true })
    const earth = installed(compare)
    earth.dispatchEvent({ type: 'pointermove', screen: { xPixels: 200, yPixels: 300 } } as never)
    expect(compare.positionFraction).toBe(0.25)
    compare.followPointer = false
    earth.dispatchEvent({ type: 'pointermove', screen: { xPixels: 600, yPixels: 300 } } as never)
    expect(compare.positionFraction).toBe(0.25)
  })

  it('reports itself in earth.inspect()', () => {
    const compare = new Compare({ before: [layer()], positionFraction: 0.4 })
    const earth = installed(compare)
    expect(earth.inspect().plugins.compare?.details).toMatchObject({ orientation: 'vertical', positionFraction: 0.4, beforeLayers: 1, afterLayers: 0 })
  })
})

describe('Compare.attachHandle', () => {
  function pointer(type: string, init: { clientX?: number; clientY?: number; pointerId?: number }) {
    return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', ...init })
  }

  it('makes an accessible slider placed by a CSS property', () => {
    const compare = new Compare({ positionFraction: 0.375 })
    const handle = document.createElement('div')
    const detach = compare.attachHandle(handle)
    expect(handle.getAttribute('role')).toBe('slider')
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute('aria-label')).toBe('Comparison position')
    expect(handle.getAttribute('aria-valuenow')).toBe('37.5')
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle.style.getPropertyValue('--compare-position')).toBe('37.5%')
    compare.setPosition(0.5)
    expect(handle.style.getPropertyValue('--compare-position')).toBe('50%')

    detach()
    expect(handle.hasAttribute('role')).toBe(false)
    expect(handle.hasAttribute('aria-valuenow')).toBe(false)
    expect(handle.style.getPropertyValue('--compare-position')).toBe('')
  })

  it('keeps a label the app gave', () => {
    const handle = document.createElement('div')
    handle.setAttribute('aria-label', 'Before and after')
    new Compare().attachHandle(handle)
    expect(handle.getAttribute('aria-label')).toBe('Before and after')
  })

  it('moves the line by the drag over the canvas, without letting the map see the pointer', () => {
    const compare = new Compare()
    installed(compare)
    const container = document.createElement('div')
    const handle = document.createElement('div')
    container.append(handle)
    const mapSawPointer = vi.fn()
    container.addEventListener('pointerdown', mapSawPointer)
    container.addEventListener('pointermove', mapSawPointer)
    compare.attachHandle(handle)
    const events: string[] = []
    compare.addEventListener('slidestart', () => events.push('start'))
    compare.addEventListener('slideend', () => events.push('end'))

    handle.dispatchEvent(pointer('pointerdown', { clientX: 400 }))
    expect(compare.getState().dragging).toBe(true)
    handle.dispatchEvent(pointer('pointermove', { clientX: 480 }))
    expect(compare.positionFraction).toBeCloseTo(0.6)
    handle.dispatchEvent(pointer('pointermove', { clientX: 2000 }))
    expect(compare.positionFraction).toBe(1)
    handle.dispatchEvent(pointer('pointerup', { clientX: 2000 }))
    expect(compare.getState().dragging).toBe(false)
    expect(events).toEqual(['start', 'end'])
    expect(mapSawPointer).not.toHaveBeenCalled()
  })

  it('moves with the keyboard', () => {
    const compare = new Compare({ keyboardStepFraction: 0.05 })
    const handle = document.createElement('div')
    compare.attachHandle(handle)
    const key = (name: string) => handle.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    key('ArrowRight')
    expect(compare.positionFraction).toBeCloseTo(0.55)
    key('PageDown')
    expect(compare.positionFraction).toBeCloseTo(0.05)
    key('End')
    expect(compare.positionFraction).toBe(1)
    key('Home')
    expect(compare.positionFraction).toBe(0)
  })

  it('refuses the same element twice', () => {
    const compare = new Compare()
    const handle = document.createElement('div')
    compare.attachHandle(handle)
    expect(() => compare.attachHandle(handle)).toThrow(/already a handle/)
  })
})
