// @vitest-environment happy-dom
import { EventDispatcher } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Controls } from '../src/controls/Controls.js'
import { FullscreenControl } from '../src/controls/FullscreenControl.js'
import { GeolocateControl } from '../src/controls/GeolocateControl.js'
import { DEFAULT_CONTROLS_LOCALE, resolveLocale } from '../src/controls/locale.js'
import { compassIsReset, compassRotation, compassTransform } from '../src/controls/navigation.js'
import { NavigationControl } from '../src/controls/NavigationControl.js'
import { computeScaleBar, formatScaleBar, roundScaleLength } from '../src/controls/scale.js'
import { ScaleControl } from '../src/controls/ScaleControl.js'
import { ViewControl } from '../src/controls/ViewControl.js'
import type { Earth } from '../src/core/Earth.js'

// Markers need a real camera and renderer to place themselves; the control only adds, moves and removes them
vi.mock('../src/core/Marker.js', () => ({
  Marker: class {
    element: HTMLElement
    constructor(options: { element: HTMLElement }) {
      this.element = options.element
    }
    addTo(_earth: unknown, container: HTMLElement) {
      container.append(this.element)
      return this
    }
    setPosition() {
      return this
    }
    remove() {
      this.element.remove()
      return this
    }
  },
}))

describe('roundScaleLength', () => {
  it('uses 1, 2, 3 and 5 times a power of ten, rounding down', () => {
    const cases: Array<[number, number]> = [
      [1, 1], [1.9, 1], [2, 2], [2.9, 2], [3, 3], [4.99, 3], [5, 5], [9.9, 5], [10, 10], [29, 20], [31, 30], [999, 500], [1000, 1000],
      [0.7, 0.5], [0.25, 0.2], [0.03, 0.03], [123456, 100000],
    ]
    for (const [value, expected] of cases) expect(roundScaleLength(value)).toBe(expected)
  })

  it('is 0 for values with no scale', () => {
    for (const value of [0, -4, NaN, Infinity]) expect(roundScaleLength(value)).toBe(0)
  })
})

describe('computeScaleBar', () => {
  it('fits the bar inside the maximum width and labels it', () => {
    const bar = computeScaleBar(10, 100, 'metric')
    // 1000 m at most: 1 km exactly, over the full width
    expect(bar).toEqual({ widthPixels: 100, length: 1, unitKey: 'unitKilometers' })
    const small = computeScaleBar(7, 100, 'metric')
    // 700 m at most: 500 m
    expect(small.length).toBe(500)
    expect(small.unitKey).toBe('unitMeters')
    expect(small.widthPixels).toBeCloseTo(500 / 7)
    expect(formatScaleBar(small, DEFAULT_CONTROLS_LOCALE)).toBe('500 m')
  })

  it('never exceeds the maximum width', () => {
    for (const unit of ['metric', 'imperial', 'nautical'] as const) {
      for (let metersPerPixel = 0.03; metersPerPixel < 1e6; metersPerPixel *= 1.7) {
        const bar = computeScaleBar(metersPerPixel, 120, unit)
        expect(bar.widthPixels).toBeLessThanOrEqual(120 + 1e-9)
        expect(bar.widthPixels).toBeGreaterThan(120 / 10 / 1.01)
      }
    }
  })

  it('switches to feet and miles for imperial, and to nautical miles', () => {
    expect(computeScaleBar(1, 100, 'imperial')).toMatchObject({ unitKey: 'unitFeet', length: 300 })
    expect(computeScaleBar(100, 100, 'imperial')).toMatchObject({ unitKey: 'unitMiles', length: 5 })
    expect(computeScaleBar(100, 100, 'nautical')).toMatchObject({ unitKey: 'unitNauticalMiles', length: 5 })
  })

  it('draws nothing without a scale', () => {
    expect(computeScaleBar(0, 100, 'metric').widthPixels).toBe(0)
    expect(computeScaleBar(NaN, 100, 'metric').widthPixels).toBe(0)
  })
})

describe('compass', () => {
  it('turns the needle against the heading and tilts it with the pitch only when asked', () => {
    expect(compassRotation(30, -90, false)).toEqual({ rotateDegrees: -30, tiltDegrees: 0 })
    expect(compassRotation(30, -45, true)).toEqual({ rotateDegrees: -30, tiltDegrees: 45 })
    expect(compassRotation(0, 10, true).tiltDegrees).toBe(90)
    expect(compassTransform(90, -90, false)).toBe('rotate(-90deg)')
    expect(compassTransform(0, -60, true)).toContain('rotateX(30deg)')
  })

  it('knows when there is nothing to reset', () => {
    expect(compassIsReset(0, -90, true)).toBe(true)
    expect(compassIsReset(360, -45, false)).toBe(true)
    expect(compassIsReset(-720, -90, true)).toBe(true)
    expect(compassIsReset(0, -45, true)).toBe(false)
    expect(compassIsReset(12, -90, false)).toBe(false)
  })
})

describe('resolveLocale', () => {
  it('lays a partial translation over the defaults', () => {
    expect(resolveLocale({ zoomIn: 'Agrandir' })).toEqual({ ...DEFAULT_CONTROLS_LOCALE, zoomIn: 'Agrandir' })
    expect(resolveLocale(undefined)).toBe(DEFAULT_CONTROLS_LOCALE)
  })
})

/** The parts of an Earth that controls read: events, a camera with a view, and the view mode. */
function createFakeEarth() {
  const earth = new EventDispatcher() as unknown as Record<string, unknown> & EventDispatcher<Record<string, unknown>>
  const state = { zoom: 5, headingDegrees: 0, pitchDegrees: -90, animating: false }
  const zoomTo = vi.fn((zoom: number) => {
    state.animating = true
    return new Promise<boolean>(resolve => {
      ;(zoomTo as unknown as { finish: () => void }).finish = () => {
        state.zoom = zoom
        state.animating = false
        resolve(true)
      }
    })
  })
  const camera = {
    ready: true,
    get animating() {
      return state.animating
    },
    getView: () => ({ zoom: state.zoom, headingDegrees: state.headingDegrees, pitchDegrees: state.pitchDegrees, latitudeDegrees: 0, longitudeDegrees: 0 }),
    getGroundResolutionMetersPerPixel: () => 100,
    zoomTo,
    resetNorth: vi.fn(() => Promise.resolve(true)),
    resetNorthPitch: vi.fn(() => Promise.resolve(true)),
    easeTo: vi.fn(() => Promise.resolve(true)),
    flyTo: vi.fn(() => Promise.resolve(true)),
  }
  Object.assign(earth, { camera, view: { mode: '3d' }, requestFrame: vi.fn(), setView: vi.fn((mode: string) => ((earth.view as { mode: string }).mode = mode)) })
  return { earth: earth as unknown as Earth & { view: { mode: string }; setView: ReturnType<typeof vi.fn> }, state, camera }
}

function setup(position: 'top-right' | 'bottom-left' = 'top-right') {
  const container = document.createElement('div')
  document.body.append(container)
  const fake = createFakeEarth()
  const controls = new Controls({ earth: fake.earth, container, position })
  return { container, controls, ...fake }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('Controls', () => {
  it('stacks controls in a corner and shares the corner between Controls', () => {
    const { container, controls, earth } = setup()
    const second = new Controls({ earth, container, position: 'top-right' })
    new NavigationControl().addTo(controls)
    new ViewControl().addTo(second)
    const corners = container.querySelectorAll('.react-three-earth-controls')
    expect(corners).toHaveLength(1)
    expect(corners[0]!.children).toHaveLength(2)
    expect((corners[0] as HTMLElement).dataset.position).toBe('top-right')
    controls.dispose()
    expect(corners[0]!.children).toHaveLength(1)
    second.dispose()
    expect(container.querySelector('.react-three-earth-controls')).toBeNull()
  })

  it('does not pass clicks and presses on to the map', () => {
    const { container, controls } = setup()
    const control = new NavigationControl()
    control.addTo(controls)
    const onContainer = vi.fn()
    container.addEventListener('click', onContainer)
    container.addEventListener('pointerdown', onContainer)
    control.element.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    control.element.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(onContainer).not.toHaveBeenCalled()
  })

  it('refuses controls after dispose, with the fix', () => {
    const { controls } = setup()
    controls.dispose()
    expect(() => new ViewControl().addTo(controls)).toThrow(/Create new Controls/)
  })
})

describe('NavigationControl', () => {
  it('zooms by one level a press and adds presses made during the ease', async () => {
    const { controls, camera, state } = setup()
    const navigation = new NavigationControl().addTo(controls)
    const [zoomIn, zoomOut] = navigation.element.querySelectorAll('button')
    expect(zoomIn!.getAttribute('aria-label')).toBe('Zoom in')
    zoomIn!.click()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(6, { durationSeconds: 0.3 })
    zoomIn!.click()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(7, { durationSeconds: 0.3 })
    zoomOut!.click()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(6, { durationSeconds: 0.3 })
    ;(camera.zoomTo as unknown as { finish: () => void }).finish()
    await Promise.resolve()
    state.animating = false
    zoomOut!.click()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(5, { durationSeconds: 0.3 })
  })

  it('turns the compass with the map and resets north on press', () => {
    const { earth, controls, camera, state } = setup()
    const navigation = new NavigationControl().addTo(controls)
    const compass = navigation.element.querySelectorAll('button')[2]!
    state.headingDegrees = 40
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(compass.querySelector('svg')!.style.transform).toBe('rotate(-40deg)')
    expect(compass.dataset.north).toBe('false')
    compass.click()
    expect(camera.resetNorth).toHaveBeenCalledOnce()
    expect(camera.resetNorthPitch).not.toHaveBeenCalled()
  })

  it('also resets the pitch with visualizePitch, and can leave buttons out', () => {
    const { controls, camera } = setup()
    const navigation = new NavigationControl({ visualizePitch: true, showZoom: false }).addTo(controls)
    const buttons = navigation.element.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    buttons[0]!.click()
    expect(camera.resetNorthPitch).toHaveBeenCalledOnce()
  })

  it('takes translated labels and stops listening once removed', () => {
    const { earth, controls, state } = setup()
    const navigation = new NavigationControl({ locale: { zoomIn: 'Agrandir' } }).addTo(controls)
    expect(navigation.element.querySelector('button')!.getAttribute('aria-label')).toBe('Agrandir')
    navigation.remove()
    expect(navigation.element.isConnected).toBe(false)
    state.headingDegrees = 90
    expect(() => earth.dispatchEvent({ type: 'rotate' } as never)).not.toThrow()
  })
})

describe('ScaleControl', () => {
  it('draws a round scale for the centre of the screen and follows the camera', () => {
    const { earth, controls } = setup('bottom-left')
    const scale = new ScaleControl({ maximumWidthPixels: 100 }).addTo(controls)
    // 100 m a pixel, 100 pixels: 10 km exactly
    expect(scale.element.textContent).toBe('10 km')
    expect(scale.element.style.width).toBe('100px')
    expect(scale.element.getAttribute('aria-label')).toBe('Map scale: 10 km')
    ;(earth.camera as unknown as { getGroundResolutionMetersPerPixel: () => number }).getGroundResolutionMetersPerPixel = () => 2.5
    earth.dispatchEvent({ type: 'zoom' } as never)
    expect(scale.element.textContent).toBe('200 m')
    scale.setUnit('imperial')
    expect(scale.element.textContent).toBe('500 ft')
  })
})

describe('ViewControl', () => {
  it('switches the view, says which one it switches to, and reports the press', () => {
    const { earth, controls } = setup()
    const view = new ViewControl({ transition: { durationSeconds: 1 } }).addTo(controls)
    const button = view.element.querySelector('button')!
    expect(button.textContent).toBe('2D')
    const changed = vi.fn()
    view.events.addEventListener('viewchange', event => changed(event.mode))
    button.click()
    expect(earth.setView).toHaveBeenCalledWith('2d', { durationSeconds: 1 })
    expect(changed).toHaveBeenCalledWith('2d')
    expect(button.textContent).toBe('3D')
    expect(button.getAttribute('aria-label')).toBe('Switch to the globe')
    // Other code changes the view: the button follows in the next update
    earth.view.mode = '3d'
    earth.dispatchEvent({ type: 'update' } as never)
    expect(button.textContent).toBe('2D')
  })
})

describe('FullscreenControl', () => {
  it('covers the page where the browser has no fullscreen for elements, and Escape leaves', () => {
    const { container, controls } = setup()
    const fullscreen = new FullscreenControl().addTo(controls)
    const button = fullscreen.element.querySelector('button')!
    expect(fullscreen.element.hidden).toBe(false)
    button.click()
    expect(container.classList.contains('react-three-earth-pseudo-fullscreen')).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Exit fullscreen')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(container.classList.contains('react-three-earth-pseudo-fullscreen')).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('can hide itself instead, and leaves fullscreen when removed', () => {
    const { container, controls } = setup()
    expect(new FullscreenControl({ unsupported: 'hide' }).addTo(controls).element.hidden).toBe(true)
    const fullscreen = new FullscreenControl().addTo(controls)
    fullscreen.element.querySelector('button')!.click()
    fullscreen.remove()
    expect(container.classList.contains('react-three-earth-pseudo-fullscreen')).toBe(false)
  })

  it('uses the Fullscreen API where it exists', async () => {
    const { container, controls } = setup()
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    const request = vi.fn(() => Promise.resolve())
    container.requestFullscreen = request
    const fullscreen = new FullscreenControl().addTo(controls)
    fullscreen.element.querySelector('button')!.click()
    await Promise.resolve()
    expect(request).toHaveBeenCalledOnce()
    expect(container.classList.contains('react-three-earth-pseudo-fullscreen')).toBe(false)
    Reflect.deleteProperty(document, 'fullscreenEnabled')
  })
})

describe('GeolocateControl', () => {
  function stubGeolocation() {
    const watchers: Array<{ success: PositionCallback; error: PositionErrorCallback }> = []
    const geolocation = {
      getCurrentPosition: vi.fn((success: PositionCallback, error: PositionErrorCallback) => watchers.push({ success, error })),
      watchPosition: vi.fn((success: PositionCallback, error: PositionErrorCallback) => {
        watchers.push({ success, error })
        return watchers.length
      }),
      clearWatch: vi.fn(),
    }
    vi.stubGlobal('navigator', { geolocation })
    const position = (longitude: number, latitude: number, accuracy = 20) =>
      ({ coords: { longitude, latitude, accuracy }, timestamp: 1 }) as unknown as GeolocationPosition
    return { geolocation, watchers, position }
  }

  it('is hidden where the browser has no geolocation', () => {
    vi.stubGlobal('navigator', {})
    const { controls } = setup()
    expect(new GeolocateControl().addTo(controls).element.hidden).toBe(true)
  })

  it('asks only when pressed, flies to the first fix and shows a dot', () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { container, controls, camera } = setup()
    const geolocate = new GeolocateControl().addTo(controls)
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled()
    const located = vi.fn()
    geolocate.events.addEventListener('geolocate', located)
    geolocate.element.querySelector('button')!.click()
    expect(geolocate.currentState).toBe('waiting')
    watchers[0]!.success(position(2.35, 48.85))
    expect(camera.flyTo).toHaveBeenCalledWith(expect.objectContaining({ longitudeDegrees: 2.35, latitudeDegrees: 48.85 }), {})
    expect(located).toHaveBeenCalledOnce()
    expect(container.querySelector('.react-three-earth-user-dot')).not.toBeNull()
    expect(geolocate.currentState).toBe('off')
    geolocate.remove()
    expect(container.querySelector('.react-three-earth-user-dot')).toBeNull()
  })

  it('follows with trackUser, pauses when the user moves the map, and stops on a press', () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { container, controls, camera } = setup()
    const geolocate = new GeolocateControl({ trackUser: true }).addTo(controls)
    const button = geolocate.element.querySelector('button')!
    const started = vi.fn()
    const ended = vi.fn()
    geolocate.events.addEventListener('trackuserlocationstart', started)
    geolocate.events.addEventListener('trackuserlocationend', ended)
    button.click()
    expect(started).toHaveBeenCalledOnce()
    watchers[0]!.success(position(1, 1))
    expect(geolocate.currentState).toBe('tracking')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    watchers[0]!.success(position(1.1, 1.1))
    expect(camera.easeTo).toHaveBeenCalledWith({ longitudeDegrees: 1.1, latitudeDegrees: 1.1 }, expect.anything())
    // The user touches the map (the corner stops events from the buttons themselves)
    container.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(geolocate.currentState).toBe('background')
    camera.easeTo.mockClear()
    watchers[0]!.success(position(1.2, 1.2))
    expect(camera.easeTo).not.toHaveBeenCalled()
    button.click()
    expect(geolocate.currentState).toBe('tracking')
    button.click()
    expect(geolocation.clearWatch).toHaveBeenCalled()
    expect(ended).toHaveBeenCalled()
    expect(geolocate.currentState).toBe('off')
  })

  it('disables the button when access is denied and tells why', () => {
    const { watchers } = stubGeolocation()
    const { controls } = setup()
    const geolocate = new GeolocateControl().addTo(controls)
    const button = geolocate.element.querySelector('button')!
    const failed = vi.fn()
    geolocate.events.addEventListener('error', failed)
    button.click()
    watchers[0]!.error({ code: 1, message: 'denied' } as GeolocationPositionError)
    expect(failed).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Location access is turned off for this site')
  })

  it('never leaves a watch running: a second press while waiting stops, and a lost fix keeps the user\'s choice', () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { container, controls } = setup()
    const geolocate = new GeolocateControl({ trackUser: true }).addTo(controls)
    const button = geolocate.element.querySelector('button')!
    const ended = vi.fn()
    geolocate.events.addEventListener('trackuserlocationend', ended)
    button.click()
    button.click()
    expect(geolocation.watchPosition).toHaveBeenCalledOnce()
    expect(geolocation.clearWatch).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledOnce()
    // Follow, pan away, lose the fix, get it back: still panned away
    button.click()
    watchers[1]!.success(position(1, 1))
    container.dispatchEvent(new Event('wheel', { bubbles: true }))
    expect(geolocate.currentState).toBe('background')
    watchers[1]!.error({ code: 3, message: 'timeout' } as GeolocationPositionError)
    expect(geolocate.currentState).toBe('error')
    watchers[1]!.success(position(1.1, 1.1))
    expect(geolocate.currentState).toBe('background')
    geolocate.remove()
    expect(geolocation.clearWatch).toHaveBeenCalledTimes(2)
  })

  it('lets the user try again after a timeout', () => {
    const { watchers } = stubGeolocation()
    const { controls } = setup()
    const geolocate = new GeolocateControl().addTo(controls)
    const button = geolocate.element.querySelector('button')!
    button.click()
    watchers[0]!.error({ code: 3, message: 'timeout' } as GeolocationPositionError)
    expect(button.disabled).toBe(false)
    expect(button.dataset.state).toBe('error')
  })
})
