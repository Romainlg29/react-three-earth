// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { boundsAroundPositions, BoxZoom, boxSamplePoints, boxZoomLevels } from '../src/core/BoxZoom.js'
import type { GeographicBounds } from '../src/core/camera.js'
import { CooperativeGestures, touchDecision, wheelDecision } from '../src/core/CooperativeGestures.js'
import type { Earth } from '../src/core/Earth.js'
import type { ScreenPosition } from '../src/core/projection.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('boundsAroundPositions', () => {
  it('is the box around the points', () => {
    const bounds = boundsAroundPositions([
      { longitudeDegrees: 10, latitudeDegrees: 45 },
      { longitudeDegrees: 12, latitudeDegrees: 44 },
      { longitudeDegrees: 11, latitudeDegrees: 46.5 },
    ])
    expect(bounds).toEqual({ westDegrees: 10, southDegrees: 44, eastDegrees: 12, northDegrees: 46.5 })
  })

  it('crosses the antimeridian with west greater than east', () => {
    const bounds = boundsAroundPositions([
      { longitudeDegrees: 179.5, latitudeDegrees: -17 },
      { longitudeDegrees: -179, latitudeDegrees: -16 },
      { longitudeDegrees: 178, latitudeDegrees: -18 },
    ])!
    expect(bounds.westDegrees).toBeCloseTo(178)
    expect(bounds.eastDegrees).toBeCloseTo(-179)
    expect(bounds.southDegrees).toBe(-18)
    expect(bounds.northDegrees).toBe(-16)
  })

  it('is null with fewer than two points', () => {
    expect(boundsAroundPositions([])).toBeNull()
    expect(boundsAroundPositions([{ longitudeDegrees: 0, latitudeDegrees: 0 }])).toBeNull()
  })
})

describe('boxZoomLevels', () => {
  it('zooms until the box fills the narrower side of the viewport', () => {
    expect(boxZoomLevels({ xPixels: 0, yPixels: 0 }, { xPixels: 250, yPixels: 100 }, 1000, 600)).toBeCloseTo(2)
    expect(boxZoomLevels({ xPixels: 300, yPixels: 400 }, { xPixels: 100, yPixels: 100 }, 800, 600)).toBeCloseTo(1)
  })
})

describe('boxSamplePoints', () => {
  it('gives the centre first, then the corners and edge middles', () => {
    const points = boxSamplePoints({ xPixels: 100, yPixels: 50 }, { xPixels: 0, yPixels: 150 })
    expect(points).toHaveLength(9)
    expect(points[0]).toEqual({ xPixels: 50, yPixels: 100 })
    expect(points).toContainEqual({ xPixels: 0, yPixels: 50 })
    expect(points).toContainEqual({ xPixels: 100, yPixels: 150 })
    expect(points).toContainEqual({ xPixels: 50, yPixels: 150 })
  })
})

/** An earth whose ground is a plane: one pixel is 0.01° (x eastward, y southward from 0, 0 at the top left). */
function createFakeEarth() {
  const fits: GeographicBounds[] = []
  const camera = {
    ready: true,
    unproject: (point: ScreenPosition) => ({ longitudeDegrees: point.xPixels * 0.01, latitudeDegrees: -point.yPixels * 0.01, heightMeters: 0 }),
    fitBounds: (bounds: GeographicBounds) => {
      fits.push(bounds)
      return Promise.resolve(true)
    },
    stop: vi.fn(),
  }
  const earth = { camera, view: { transitioning: false }, requestFrame: vi.fn() }
  return { earth: earth as unknown as Earth, raw: earth, fits }
}

function pointer(type: string, target: EventTarget, init: PointerEventInit): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, ...init })
  target.dispatchEvent(event)
  return event
}

describe('BoxZoom', () => {
  function setUp() {
    const fake = createFakeEarth()
    const element = document.createElement('div')
    const canvas = document.createElement('canvas')
    element.append(canvas)
    document.body.append(element)
    // The pointer controls' listener, on the element like 3DTilesRenderer's
    const controlsSaw = vi.fn()
    element.addEventListener('pointerdown', controlsSaw)
    const boxZoom = new BoxZoom(fake.earth)
    boxZoom.attach(element)
    return { ...fake, element, canvas, boxZoom, controlsSaw }
  }

  it('zooms to the ground inside a Shift + drag box, and keeps the drag from the pointer controls', () => {
    const { canvas, controlsSaw, fits, element } = setUp()
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    expect(controlsSaw).not.toHaveBeenCalled()
    pointer('pointermove', canvas, { shiftKey: true, clientX: 200, clientY: 150 })
    const box = element.querySelector<HTMLElement>('.react-three-earth-box-zoom')!
    expect(box.style.width).toBe('100px')
    expect(box.style.height).toBe('50px')
    pointer('pointerup', canvas, { clientX: 300, clientY: 200 })
    expect(fits).toHaveLength(1)
    expect(fits[0]!.westDegrees).toBeCloseTo(1)
    expect(fits[0]!.eastDegrees).toBeCloseTo(3)
    expect(fits[0]!.northDegrees).toBeCloseTo(-1)
    expect(fits[0]!.southDegrees).toBeCloseTo(-2)
    expect(element.querySelector('.react-three-earth-box-zoom')).toBeNull()
  })

  it('swallows the click that the release of a box fires, but not a plain Shift + click', async () => {
    const { canvas } = setUp()
    const clicks = vi.fn()
    canvas.addEventListener('click', clicks)
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    pointer('pointerup', canvas, { clientX: 300, clientY: 200 })
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    pointer('pointerup', canvas, { clientX: 100, clientY: 100 })
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).toHaveBeenCalledOnce()
  })

  it('leaves Shift + drag on a marker or control to it', () => {
    const { element, controlsSaw, boxZoom } = setUp()
    const marker = document.createElement('button')
    marker.className = 'react-three-earth-marker'
    element.append(marker)
    pointer('pointerdown', marker, { shiftKey: true })
    expect(boxZoom.active).toBe(false)
    expect(controlsSaw).toHaveBeenCalledOnce()
  })

  it('cancels when the window loses focus', () => {
    const { canvas, boxZoom } = setUp()
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    window.dispatchEvent(new Event('blur'))
    expect(boxZoom.active).toBe(false)
  })

  it('leaves drags without Shift, right drags and touches to the pointer controls', () => {
    const { canvas, controlsSaw, boxZoom } = setUp()
    pointer('pointerdown', canvas, { clientX: 0, clientY: 0 })
    pointer('pointerdown', canvas, { shiftKey: true, button: 2, pointerId: 2 })
    pointer('pointerdown', canvas, { shiftKey: true, pointerType: 'touch', pointerId: 3 })
    expect(controlsSaw).toHaveBeenCalledTimes(3)
    expect(boxZoom.active).toBe(false)
  })

  it('does nothing for a tiny box, on Escape, or while disabled', () => {
    const { canvas, fits, boxZoom, controlsSaw } = setUp()
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    pointer('pointerup', canvas, { clientX: 102, clientY: 101 })
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    pointer('pointermove', canvas, { clientX: 200, clientY: 200 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(boxZoom.active).toBe(false)
    pointer('pointerup', canvas, { clientX: 200, clientY: 200 })
    boxZoom.enabled = false
    pointer('pointerdown', canvas, { shiftKey: true, clientX: 100, clientY: 100 })
    expect(controlsSaw).toHaveBeenCalledOnce()
    expect(fits).toEqual([])
  })

  it('leaves the drag to the pointer controls during a morph', () => {
    const { canvas, raw, controlsSaw } = setUp()
    raw.view.transitioning = true
    pointer('pointerdown', canvas, { shiftKey: true })
    expect(controlsSaw).toHaveBeenCalledOnce()
  })
})

describe('cooperative gestures', () => {
  it('lets the wheel move the map only with Ctrl or Cmd, and touches only with two fingers', () => {
    expect(wheelDecision({ ctrlKey: false, metaKey: false })).toBe('page')
    expect(wheelDecision({ ctrlKey: true, metaKey: false })).toBe('map')
    expect(wheelDecision({ ctrlKey: false, metaKey: true })).toBe('map')
    expect(touchDecision(1)).toBe('page')
    expect(touchDecision(2)).toBe('map')
  })

  function setUp(enabled = true) {
    const element = document.createElement('div')
    const canvas = document.createElement('canvas')
    element.append(canvas)
    document.body.append(element)
    element.style.touchAction = 'none'
    const controlsSaw = { wheel: vi.fn(), pointerdown: vi.fn() }
    element.addEventListener('wheel', controlsSaw.wheel)
    element.addEventListener('pointerdown', controlsSaw.pointerdown)
    const cooperative = new CooperativeGestures({ locale: { touch: 'Deux doigts' } })
    cooperative.attach(element)
    cooperative.enabled = enabled
    return { element, canvas, controlsSaw, cooperative }
  }

  it('lets a plain wheel scroll the page with a hint, and Ctrl + wheel zoom the map', () => {
    vi.useFakeTimers()
    const { canvas, controlsSaw, element } = setUp()
    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
    canvas.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    expect(controlsSaw.wheel).not.toHaveBeenCalled()
    const hint = element.querySelector<HTMLElement>('.react-three-earth-cooperative-hint')!
    expect(hint.getAttribute('role')).toBe('status')
    expect(hint.textContent).toMatch(/scroll to zoom the map/)
    expect(hint.style.opacity).toBe('1')
    vi.advanceTimersByTime(1600)
    expect(hint.style.opacity).toBe('0')
    // Emptied, so it is not read stale and the next hint is announced
    expect(hint.textContent).toBe('')
    const withControl = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
    // happy-dom's WheelEvent drops the modifier keys of its init
    Object.defineProperty(withControl, 'ctrlKey', { value: true })
    canvas.dispatchEvent(withControl)
    expect(controlsSaw.wheel).toHaveBeenCalledOnce()
  })

  it('keeps touches from the pointer controls, lets one finger pan the page and keeps two fingers on the map', () => {
    const { canvas, controlsSaw, element } = setUp()
    expect(element.style.touchAction).toBe('pan-x pan-y')
    pointer('pointerdown', canvas, { pointerType: 'touch' })
    expect(controlsSaw.pointerdown).not.toHaveBeenCalled()
    pointer('pointerdown', canvas, { pointerType: 'mouse', pointerId: 2 })
    expect(controlsSaw.pointerdown).toHaveBeenCalledOnce()
    // A plain marker is stopped like the map; a draggable one keeps its touches
    const marker = document.createElement('div')
    marker.className = 'react-three-earth-marker'
    element.append(marker)
    pointer('pointerdown', marker, { pointerType: 'touch', pointerId: 3 })
    expect(controlsSaw.pointerdown).toHaveBeenCalledOnce()
    marker.toggleAttribute('data-draggable', true)
    pointer('pointerdown', marker, { pointerType: 'touch', pointerId: 4 })
    expect(controlsSaw.pointerdown).toHaveBeenCalledTimes(2)

    const touch = (count: number) => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true }) as TouchEvent
      Object.defineProperty(event, 'touches', { value: { length: count } })
      canvas.dispatchEvent(event)
      return event
    }
    expect(touch(1).defaultPrevented).toBe(false)
    expect(element.querySelector('.react-three-earth-cooperative-hint')!.textContent).toBe('Deux doigts')
    expect(touch(2).defaultPrevented).toBe(true)
  })

  it('changes nothing while off, and puts everything back when turned off', () => {
    const off = setUp(false)
    expect(off.element.style.touchAction).toBe('none')
    expect(off.element.querySelector('.react-three-earth-cooperative-hint')).toBeNull()
    off.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(off.controlsSaw.wheel).toHaveBeenCalledOnce()

    const on = setUp(true)
    on.cooperative.enabled = false
    expect(on.element.style.touchAction).toBe('none')
    expect(on.element.querySelector('.react-three-earth-cooperative-hint')).toBeNull()
    pointer('pointerdown', on.canvas, { pointerType: 'touch' })
    expect(on.controlsSaw.pointerdown).toHaveBeenCalledOnce()
    on.cooperative.enabled = true
    on.cooperative.detach()
    expect(on.element.style.touchAction).toBe('none')
  })
})
