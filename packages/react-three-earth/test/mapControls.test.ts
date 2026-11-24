// @vitest-environment happy-dom
import { EventDispatcher } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttributionControl, appendAttribution } from '../src/controls/AttributionControl.js'
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

function setup() {
  const container = document.createElement('div')
  document.body.append(container)
  return { container, ...createFakeEarth() }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('Controls', () => {
  it('adds an unstyled element that keeps presses from the map, and removes it', () => {
    const { container } = setup()
    const controls = new Controls({ container })
    expect(controls.element.className).toBe('react-three-earth-controls')
    expect(controls.element.getAttribute('style')).toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
    const button = document.createElement('button')
    controls.element.append(button)
    const onContainer = vi.fn()
    container.addEventListener('click', onContainer)
    container.addEventListener('pointerdown', onContainer)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(onContainer).not.toHaveBeenCalled()
    controls.dispose()
    expect(container.querySelector('.react-three-earth-controls')).toBeNull()
  })
})

describe('MapControl', () => {
  it('listens to the earth only while subscribed, and keeps the state object until it changes', () => {
    const { earth, state } = setup()
    const navigation = new NavigationControl({ earth })
    const first = navigation.getState()
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(navigation.getState()).toBe(first)
    const listener = vi.fn()
    const unsubscribe = navigation.subscribe(listener)
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(listener).not.toHaveBeenCalled()
    expect(navigation.getState()).toBe(first)
    state.headingDegrees = 40
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    state.headingDegrees = 50
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(listener).toHaveBeenCalledOnce()
    expect(navigation.getState().headingDegrees).toBe(40)
  })
})

describe('NavigationControl', () => {
  it('zooms by one level a call and adds calls made during the ease', async () => {
    const { earth, camera, state } = setup()
    const navigation = new NavigationControl({ earth })
    expect(navigation.getState().zoomInLabel).toBe('Zoom in')
    navigation.zoomIn()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(6, { durationSeconds: 0.3 })
    navigation.zoomIn()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(7, { durationSeconds: 0.3 })
    navigation.zoomOut()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(6, { durationSeconds: 0.3 })
    ;(camera.zoomTo as unknown as { finish: () => void }).finish()
    await Promise.resolve()
    state.animating = false
    navigation.zoomOut()
    expect(camera.zoomTo).toHaveBeenLastCalledWith(5, { durationSeconds: 0.3 })
  })

  it('turns the compass with the map and resets north', () => {
    const { earth, camera, state } = setup()
    const navigation = new NavigationControl({ earth })
    navigation.subscribe(() => {})
    state.headingDegrees = 40
    earth.dispatchEvent({ type: 'rotate' } as never)
    expect(navigation.getState()).toMatchObject({ compassTransform: 'rotate(-40deg)', compassRotateDegrees: -40, north: false })
    navigation.resetNorth()
    expect(camera.resetNorth).toHaveBeenCalledOnce()
    expect(camera.resetNorthPitch).not.toHaveBeenCalled()
  })

  it('also resets the pitch with visualizePitch, and takes translated labels', () => {
    const { earth, camera } = setup()
    const navigation = new NavigationControl({ earth, visualizePitch: true, locale: { zoomIn: 'Agrandir' } })
    navigation.resetNorth()
    expect(camera.resetNorthPitch).toHaveBeenCalledOnce()
    expect(navigation.getState()).toMatchObject({ zoomInLabel: 'Agrandir', compassLabel: 'Reset bearing to north and look straight down' })
  })
})

describe('ScaleControl', () => {
  it('gives a round scale for the centre of the screen and follows the camera', () => {
    const { earth } = setup()
    const scale = new ScaleControl({ earth, maximumWidthPixels: 100 })
    scale.subscribe(() => {})
    // 100 m a pixel, 100 pixels: 10 km exactly
    expect(scale.getState()).toMatchObject({ visible: true, label: '10 km', widthPixels: 100, accessibleLabel: 'Map scale: 10 km' })
    ;(earth.camera as unknown as { getGroundResolutionMetersPerPixel: () => number }).getGroundResolutionMetersPerPixel = () => 2.5
    earth.dispatchEvent({ type: 'zoom' } as never)
    expect(scale.getState().label).toBe('200 m')
    scale.setUnit('imperial')
    expect(scale.getState().label).toBe('500 ft')
  })
})

describe('ViewControl', () => {
  it('switches the view, says which one it switches to, and reports the call', () => {
    const { earth } = setup()
    const view = new ViewControl({ earth, transition: { durationSeconds: 1 } })
    view.subscribe(() => {})
    expect(view.getState()).toMatchObject({ mode: '3d', label: '2D', accessibleLabel: 'Switch to the flat map' })
    const changed = vi.fn()
    view.events.addEventListener('viewchange', event => changed(event.mode))
    view.toggle()
    expect(earth.setView).toHaveBeenCalledWith('2d', { durationSeconds: 1 })
    expect(changed).toHaveBeenCalledWith('2d')
    expect(view.getState()).toMatchObject({ mode: '2d', label: '3D', accessibleLabel: 'Switch to the globe' })
    // Other code changes the view: the state follows in the next update
    earth.view.mode = '3d'
    earth.dispatchEvent({ type: 'update' } as never)
    expect(view.getState().label).toBe('2D')
  })

  it('toggles from the view the earth shows, even without a listener', () => {
    const { earth } = setup()
    const view = new ViewControl({ earth })
    earth.view.mode = '2d'
    view.toggle()
    expect(earth.setView).toHaveBeenLastCalledWith('3d', undefined)
  })
})

describe('FullscreenControl', () => {
  it('covers the page with an inline style where the browser has no fullscreen for elements, and Escape leaves', () => {
    const { earth, container } = setup()
    container.style.width = '300px'
    const fullscreen = new FullscreenControl({ earth, container })
    fullscreen.subscribe(() => {})
    expect(fullscreen.getState()).toMatchObject({ active: false, available: true, label: 'Enter fullscreen' })
    fullscreen.toggle()
    expect(container.style.position).toBe('fixed')
    expect(fullscreen.getState()).toMatchObject({ active: true, label: 'Exit fullscreen' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(container.style.position).toBe('')
    expect(container.style.width).toBe('300px')
    expect(fullscreen.getState().active).toBe(false)
  })

  it('puts back only the properties it covered, keeping changes made meanwhile', () => {
    const { earth, container } = setup()
    container.style.top = '5px'
    const fullscreen = new FullscreenControl({ earth, container })
    fullscreen.toggle()
    container.style.setProperty('color', 'red')
    fullscreen.toggle()
    expect(container.style.top).toBe('5px')
    expect(container.style.color).toBe('red')
    expect(container.style.position).toBe('')
  })

  it('reports itself unavailable with unsupported: hide, and leaves fullscreen when the last listener goes', () => {
    const { earth, container } = setup()
    expect(new FullscreenControl({ earth, container, unsupported: 'hide' }).getState().available).toBe(false)
    const fullscreen = new FullscreenControl({ earth, container })
    const unsubscribe = fullscreen.subscribe(() => {})
    fullscreen.toggle()
    unsubscribe()
    expect(container.style.position).toBe('')
  })

  it('uses the Fullscreen API where it exists', async () => {
    const { earth, container } = setup()
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    const request = vi.fn(() => Promise.resolve())
    container.requestFullscreen = request
    const fullscreen = new FullscreenControl({ earth, container })
    fullscreen.toggle()
    await Promise.resolve()
    expect(request).toHaveBeenCalledOnce()
    expect(container.style.position).toBe('')
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

  function geolocateSetup(trackUser = false) {
    const fake = setup()
    const geolocate = new GeolocateControl({ earth: fake.earth, container: fake.container, trackUser })
    const unsubscribe = geolocate.subscribe(() => {})
    return { ...fake, geolocate, unsubscribe }
  }

  it('is unavailable where the browser has no geolocation', () => {
    vi.stubGlobal('navigator', {})
    const { geolocate } = geolocateSetup()
    expect(geolocate.getState()).toMatchObject({ available: false, disabled: true, label: 'This browser cannot tell where you are' })
  })

  it('asks only when triggered, flies to the first fix and gives the position', () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { geolocate, camera, unsubscribe } = geolocateSetup()
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled()
    const located = vi.fn()
    geolocate.events.addEventListener('geolocate', located)
    geolocate.trigger()
    expect(geolocate.getState()).toMatchObject({ status: 'waiting', busy: true, label: 'Finding your location' })
    watchers[0]!.success(position(2.35, 48.85))
    expect(camera.flyTo).toHaveBeenCalledWith(expect.objectContaining({ longitudeDegrees: 2.35, latitudeDegrees: 48.85 }), {})
    expect(located).toHaveBeenCalledOnce()
    // 20 m of accuracy at 100 m a pixel: under a pixel
    expect(geolocate.getState()).toMatchObject({ status: 'off', userLocation: { longitudeDegrees: 2.35, latitudeDegrees: 48.85, accuracyMeters: 20 }, accuracyDiameterPixels: 0 })
    unsubscribe()
    expect(geolocate.getState().userLocation).toBeNull()
  })

  it('ignores a one-off answer that arrives after it stopped', () => {
    const { watchers, position } = stubGeolocation()
    const { geolocate, camera, unsubscribe } = geolocateSetup()
    geolocate.trigger()
    unsubscribe()
    watchers[0]!.success(position(1, 1))
    expect(camera.flyTo).not.toHaveBeenCalled()
  })

  it('follows with trackUser, pauses when the user moves the map, and stops on a second trigger', () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { geolocate, container, camera } = geolocateSetup(true)
    const started = vi.fn()
    const ended = vi.fn()
    geolocate.events.addEventListener('trackuserlocationstart', started)
    geolocate.events.addEventListener('trackuserlocationend', ended)
    geolocate.trigger()
    expect(started).toHaveBeenCalledOnce()
    watchers[0]!.success(position(1, 1))
    expect(geolocate.getState()).toMatchObject({ status: 'tracking', pressed: true })
    watchers[0]!.success(position(1.1, 1.1))
    expect(camera.easeTo).toHaveBeenCalledWith({ longitudeDegrees: 1.1, latitudeDegrees: 1.1 }, expect.anything())
    // A press inside the controls is not the user taking the map
    const controls = new Controls({ container })
    const button = document.createElement('button')
    controls.element.append(button)
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(geolocate.getState().status).toBe('tracking')
    // The user touches the map
    container.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(geolocate.getState().status).toBe('background')
    camera.easeTo.mockClear()
    watchers[0]!.success(position(1.2, 1.2))
    expect(camera.easeTo).not.toHaveBeenCalled()
    geolocate.trigger()
    expect(geolocate.getState().status).toBe('tracking')
    geolocate.trigger()
    expect(geolocation.clearWatch).toHaveBeenCalled()
    expect(ended).toHaveBeenCalled()
    expect(geolocate.getState()).toMatchObject({ status: 'off', userLocation: null })
  })

  it('disables itself when access is denied and tells why', () => {
    const { watchers } = stubGeolocation()
    const { geolocate } = geolocateSetup()
    const failed = vi.fn()
    geolocate.events.addEventListener('error', failed)
    geolocate.trigger()
    watchers[0]!.error({ code: 1, message: 'denied' } as GeolocationPositionError)
    expect(failed).toHaveBeenCalledOnce()
    expect(geolocate.getState()).toMatchObject({ disabled: true, permissionDenied: true, label: 'Location access is turned off for this site' })
  })

  it("never leaves a watch running: a second trigger while waiting stops, and a lost fix keeps the user's choice", () => {
    const { watchers, geolocation, position } = stubGeolocation()
    const { geolocate, container, unsubscribe } = geolocateSetup(true)
    const ended = vi.fn()
    geolocate.events.addEventListener('trackuserlocationend', ended)
    geolocate.trigger()
    geolocate.trigger()
    expect(geolocation.watchPosition).toHaveBeenCalledOnce()
    expect(geolocation.clearWatch).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledOnce()
    // Follow, pan away, lose the fix, get it back: still panned away
    geolocate.trigger()
    watchers[1]!.success(position(1, 1))
    container.dispatchEvent(new Event('wheel', { bubbles: true }))
    expect(geolocate.getState().status).toBe('background')
    watchers[1]!.error({ code: 3, message: 'timeout' } as GeolocationPositionError)
    expect(geolocate.getState()).toMatchObject({ status: 'error', stale: true })
    watchers[1]!.success(position(1.1, 1.1))
    expect(geolocate.getState()).toMatchObject({ status: 'background', stale: false })
    unsubscribe()
    expect(geolocation.clearWatch).toHaveBeenCalledTimes(2)
  })

  it('lets the user try again after a timeout', () => {
    const { watchers } = stubGeolocation()
    const { geolocate } = geolocateSetup()
    geolocate.trigger()
    watchers[0]!.error({ code: 3, message: 'timeout' } as GeolocationPositionError)
    expect(geolocate.getState()).toMatchObject({ status: 'error', disabled: false, label: 'Your location could not be found, try again' })
  })
})

describe('AttributionControl', () => {
  function attributionSetup(credits: string[], widthPixels: number) {
    const fake = setup()
    Object.defineProperty(fake.container, 'clientWidth', { value: widthPixels, configurable: true })
    const earth = fake.earth as unknown as Earth & { getAttributions: () => string[] }
    earth.getAttributions = () => credits
    return { ...fake, earth, credits }
  }

  it('parses the credits into text and safe links, and follows the earth', () => {
    const { earth, container, credits } = attributionSetup(['© <a href="https://openstreetmap.org">OSM</a> <a href="javascript:alert(1)">x</a>'], 1000)
    const attribution = new AttributionControl({ earth, container, customAttribution: 'Mine' })
    attribution.subscribe(() => {})
    const state = attribution.getState()
    expect(state).toMatchObject({ visible: true, compact: false, textVisible: true, groupLabel: 'Map attribution' })
    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]!.filter(segment => segment.href !== undefined)).toEqual([{ text: 'OSM', href: expect.stringMatching(/^https:\/\/openstreetmap\.org/) }])
    credits.push('Terrain')
    earth.dispatchEvent({ type: 'attributionchange' } as never)
    expect(attribution.getState().entries).toHaveLength(3)
    const element = document.createElement('div')
    appendAttribution(element, attribution.getState().entries)
    expect(element.querySelectorAll('a')).toHaveLength(1)
    expect(element.querySelector('a')!.rel).toBe('noopener noreferrer')
    expect(element.textContent).toBe('© OSM x | Terrain | Mine')
  })

  it('is compact on narrow containers, and toggle expands it', () => {
    const { earth, container } = attributionSetup(['A'], 400)
    const attribution = new AttributionControl({ earth, container, locale: { showAttribution: 'Crédits' } })
    expect(attribution.getState()).toMatchObject({ compact: true, textVisible: false, toggleLabel: 'Crédits' })
    attribution.toggle()
    expect(attribution.getState()).toMatchObject({ expanded: true, textVisible: true, toggleLabel: 'Hide attribution' })
    attribution.setCompact(false)
    expect(attribution.getState().compact).toBe(false)
  })

  it('reports nothing to show without credits', () => {
    const { earth, container } = attributionSetup([], 1000)
    expect(new AttributionControl({ earth, container }).getState().visible).toBe(false)
  })
})
