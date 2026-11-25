// @vitest-environment happy-dom
import { PerspectiveCamera } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import type { Earth } from '../src/core/Earth.js'
import { EarthViewControls } from '../src/core/EarthControls.js'
import type { EarthCamera, MapView, MapViewChange } from '../src/core/EarthCamera.js'
import { PointerInteractions } from '../src/core/PointerInteractions.js'
import { DEFAULT_KEYBOARD_OPTIONS, isEditableTarget, keyboardAction, KeyboardControls, type KeyPress } from '../src/core/KeyboardControls.js'
import { ViewMorph } from '../src/view/ViewMorph.js'

const press = (key: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers })

describe('keyboardAction', () => {
  const steps = DEFAULT_KEYBOARD_OPTIONS

  it('pans with the arrows, towards the side pressed', () => {
    expect(keyboardAction(press('ArrowLeft'), steps)).toEqual({ type: 'pan', xPixels: -100, yPixels: 0 })
    expect(keyboardAction(press('ArrowRight'), steps)).toEqual({ type: 'pan', xPixels: 100, yPixels: 0 })
    expect(keyboardAction(press('ArrowUp'), steps)).toEqual({ type: 'pan', xPixels: 0, yPixels: -100 })
    expect(keyboardAction(press('ArrowDown'), steps)).toEqual({ type: 'pan', xPixels: 0, yPixels: 100 })
  })

  it('zooms with + and -, on either key of the pair, twice as far with Shift', () => {
    expect(keyboardAction(press('='), steps)).toEqual({ type: 'zoom', levels: 1 })
    expect(keyboardAction(press('+', { shiftKey: true }), steps)).toEqual({ type: 'zoom', levels: 2 })
    expect(keyboardAction(press('-'), steps)).toEqual({ type: 'zoom', levels: -1 })
    expect(keyboardAction(press('_', { shiftKey: true }), steps)).toEqual({ type: 'zoom', levels: -2 })
  })

  it('turns and tilts with Shift and the arrows', () => {
    expect(keyboardAction(press('ArrowLeft', { shiftKey: true }), steps)).toEqual({ type: 'rotate', degrees: -15 })
    expect(keyboardAction(press('ArrowRight', { shiftKey: true }), steps)).toEqual({ type: 'rotate', degrees: 15 })
    expect(keyboardAction(press('ArrowUp', { shiftKey: true }), steps)).toEqual({ type: 'pitch', degrees: 10 })
    expect(keyboardAction(press('ArrowDown', { shiftKey: true }), steps)).toEqual({ type: 'pitch', degrees: -10 })
  })

  it('leaves other keys and browser shortcuts to the page', () => {
    expect(keyboardAction(press('a'), steps)).toBeNull()
    expect(keyboardAction(press('Tab'), steps)).toBeNull()
    expect(keyboardAction(press('=', { ctrlKey: true }), steps)).toBeNull()
    expect(keyboardAction(press('-', { metaKey: true }), steps)).toBeNull()
    expect(keyboardAction(press('ArrowLeft', { altKey: true }), steps)).toBeNull()
  })

  it('uses the steps given', () => {
    const custom = { panStepPixels: 40, zoomStep: 0.5, rotateStepDegrees: 90, pitchStepDegrees: 5 }
    expect(keyboardAction(press('ArrowDown'), custom)).toEqual({ type: 'pan', xPixels: 0, yPixels: 40 })
    expect(keyboardAction(press('+', { shiftKey: true }), custom)).toEqual({ type: 'zoom', levels: 1 })
    expect(keyboardAction(press('ArrowRight', { shiftKey: true }), custom)).toEqual({ type: 'rotate', degrees: 90 })
  })
})

describe('isEditableTarget', () => {
  it('is true for form fields and editable text only', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('select'))).toBe(true)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isEditableTarget(editable)).toBe(editable.isContentEditable)
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

/** An Earth whose camera records what it is asked to do; an ease ends when `finish` is called. */
function createFakeEarth() {
  let view: MapView = { longitudeDegrees: 10, latitudeDegrees: 20, heightMeters: 0, zoom: 5, headingDegrees: 0, pitchDegrees: -60, distanceMeters: 1e5 }
  const eases: MapViewChange[] = []
  const pans: { xPixels: number; yPixels: number }[] = []
  let pending: ((completed: boolean) => void) | null = null
  const camera = {
    ready: true,
    animating: false,
    getView: () => view,
    easeTo: (change: MapViewChange) => {
      pending?.(false)
      eases.push(change)
      camera.animating = true
      return new Promise<boolean>(resolve => (pending = resolve))
    },
    panBy: (offset: { xPixels: number; yPixels: number }) => {
      pans.push(offset)
      return Promise.resolve(true)
    },
    stop: () => {},
    getLimits: () => ({}),
    viewportHeightPixels: 600,
  }
  const earth = { camera, view: { transitioning: false }, requestFrame: vi.fn(), interactions: new PointerInteractions(camera as unknown as EarthCamera) }
  return {
    earth: earth as unknown as Earth,
    raw: earth,
    eases,
    pans,
    /** Ends the running ease at its target. */
    async finish() {
      view = { ...view, ...eases.at(-1) }
      camera.animating = false
      pending?.(true)
      pending = null
      await Promise.resolve()
    },
  }
}

function keyDown(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('KeyboardControls', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function setUp() {
    const fake = createFakeEarth()
    const element = document.createElement('div')
    document.body.append(element)
    const keyboard = new KeyboardControls(fake.earth)
    keyboard.attach(element)
    return { ...fake, element, keyboard }
  }

  it('pans by the step and takes the key from the page', () => {
    const { element, pans, raw } = setUp()
    const event = keyDown(element, 'ArrowRight')
    expect(pans).toEqual([{ xPixels: 100, yPixels: 0 }])
    expect(event.defaultPrevented).toBe(true)
    expect(raw.requestFrame).toHaveBeenCalled()
  })

  it('adds up quick presses while the camera eases, and moves on from the camera when the key is held', async () => {
    const { element, eases, finish } = setUp()
    keyDown(element, '+')
    keyDown(element, '+')
    keyDown(element, 'ArrowRight', { shiftKey: true })
    expect(eases).toEqual([{ zoom: 6 }, { zoom: 7 }, { zoom: 7, headingDegrees: 15 }])
    keyDown(element, '+', { repeat: true })
    expect(eases.at(-1)).toEqual({ zoom: 6 })
    await finish()
    keyDown(element, '-')
    expect(eases.at(-1)).toEqual({ zoom: 5 })
  })

  it('tilts within the tilt allowed for the view', () => {
    const { element, eases, keyboard } = setUp()
    keyboard.maximumTiltDegrees = 35
    keyDown(element, 'ArrowUp', { shiftKey: true })
    expect(eases.at(-1)).toEqual({ pitchDegrees: -55 })
    keyDown(element, 'ArrowUp', { shiftKey: true, repeat: true })
    keyDown(element, 'ArrowUp', { shiftKey: true })
    expect(eases.at(-1)).toEqual({ pitchDegrees: -55 })
    for (let index = 0; index < 5; index++) keyDown(element, 'ArrowDown', { shiftKey: true })
    expect(eases.at(-1)).toEqual({ pitchDegrees: -90 })
  })

  it('ignores keys typed into a form field inside the map, other keys, and keys while disabled', () => {
    const { element, eases, pans, keyboard } = setUp()
    const input = document.createElement('input')
    element.append(input)
    expect(keyDown(input, 'ArrowLeft').defaultPrevented).toBe(false)
    expect(keyDown(element, 'Enter').defaultPrevented).toBe(false)
    keyboard.enabled = false
    expect(keyDown(element, '+').defaultPrevented).toBe(false)
    expect(eases).toEqual([])
    expect(pans).toEqual([])
  })

  it('keeps the key from scrolling the page during a morph, without moving the camera', () => {
    const { element, pans, raw } = setUp()
    raw.view.transitioning = true
    expect(keyDown(element, 'ArrowDown').defaultPrevented).toBe(true)
    expect(pans).toEqual([])
  })

  it('stops listening on detach', () => {
    const { element, pans, keyboard } = setUp()
    keyboard.detach()
    keyDown(element, 'ArrowDown')
    expect(pans).toEqual([])
  })

  it('calls onStart before moving the camera', () => {
    const { element, keyboard } = setUp()
    const onStart = vi.fn()
    keyboard.onStart = onStart
    keyDown(element, '-')
    expect(onStart).toHaveBeenCalledOnce()
  })
})

describe('EarthViewControls accessibility', () => {
  function createControls() {
    const fake = createFakeEarth()
    return new EarthViewControls(fake.earth)
  }

  it('makes the element a labelled region in the tab order, and puts the old attributes back on detach', () => {
    const controls = createControls()
    const element = document.createElement('div')
    element.setAttribute('role', 'application')
    controls.label = 'Map of the Alps'
    controls.attach(element)
    expect(element.getAttribute('tabindex')).toBe('0')
    expect(element.getAttribute('role')).toBe('region')
    expect(element.getAttribute('aria-label')).toBe('Map of the Alps')
    controls.detach()
    expect(element.getAttribute('role')).toBe('application')
    expect(element.hasAttribute('aria-label')).toBe(false)
    expect(element.hasAttribute('tabindex')).toBe(false)
    // Attaching again works the same
    controls.attach(element)
    expect(element.getAttribute('tabindex')).toBe('0')
    controls.dispose()
  })

  it('renames the map while attached without detaching', () => {
    const controls = createControls()
    const element = document.createElement('div')
    controls.attach(element)
    controls.label = 'Trail map'
    expect(element.getAttribute('aria-label')).toBe('Trail map')
    expect(element.getAttribute('tabindex')).toBe('0')
    controls.dispose()
  })

  it("keeps an app's own tabindex", () => {
    const controls = createControls()
    const element = document.createElement('div')
    element.tabIndex = -1
    controls.attach(element)
    expect(element.getAttribute('tabindex')).toBe('-1')
    controls.detach()
    expect(element.getAttribute('tabindex')).toBe('-1')
  })

  it('turns double-click zoom on and off for both views', () => {
    const controls = createControls()
    controls.doubleClickZoom = false
    expect(controls.globe.enableDoubleTapZoom).toBe(false)
    expect(controls.flatMap.enableDoubleTapZoom).toBe(false)
  })

  it('turns double-click zoom off while a tool holds it, and back on when released', () => {
    const controls = createControls()
    const earth = (controls as unknown as { earth: Earth }).earth
    const release = earth.interactions.holdDoubleClickZoom()
    controls.update(0)
    expect(controls.globe.enableDoubleTapZoom).toBe(false)
    release()
    release() // a second call does nothing
    controls.update(0)
    expect(controls.globe.enableDoubleTapZoom).toBe(true)
    expect(earth.interactions.doubleClickZoomAllowed).toBe(true)
  })
})

describe('the view morph and prefers-reduced-motion', () => {
  const original = globalThis.matchMedia
  afterEach(() => {
    globalThis.matchMedia = original
  })

  function morphFrames(options?: { essential?: boolean }): number {
    const view = new ViewMorph()
    const camera = new PerspectiveCamera(60, 1, 1, 1e8)
    setCameraView(camera, { longitudeDegrees: 138.7, latitudeDegrees: 35.4, distanceMeters: 60_000, headingDegrees: 0, pitchDegrees: -60 })
    view.setMode('2d', options)
    let frames = 0
    do {
      view.update(camera, 1 / 60)
      frames++
    } while (view.transitioning && frames < 1000)
    return frames
  }

  it('switches at once when the user asked to reduce motion, unless the morph is essential', () => {
    const fullLength = morphFrames()
    expect(fullLength).toBeGreaterThan(60)
    globalThis.matchMedia = ((query: string) => ({ matches: query.includes('reduce') })) as unknown as typeof matchMedia
    // One frame: the switch itself
    expect(morphFrames()).toBe(1)
    expect(morphFrames({ essential: true })).toBe(fullLength)
  })
})
