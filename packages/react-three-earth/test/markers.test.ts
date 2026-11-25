// @vitest-environment happy-dom
import { Group, PerspectiveCamera } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCameraView } from '../src/core/camera.js'
import { Earth } from '../src/core/Earth.js'
import { Marker } from '../src/core/Marker.js'
import {
  anchoredBox,
  anchoredTransform,
  anchorFraction,
  markerRotation,
  popupOffset,
  popupPointOnBox,
  resolvePopupAnchor,
  SCREEN_ANCHORS,
} from '../src/core/markerLayout.js'
import { Popup } from '../src/core/Popup.js'
import { ScreenOverlay } from '../src/core/ScreenOverlay.js'

const WIDTH_PIXELS = 800
const HEIGHT_PIXELS = 600
const renderer = { getSize: (target: { set(x: number, y: number): void }) => target.set(WIDTH_PIXELS, HEIGHT_PIXELS) } as unknown as WebGPURenderer

function createMap() {
  const earth = new Earth()
  const camera = new PerspectiveCamera(60, WIDTH_PIXELS / HEIGHT_PIXELS, 1, 1e8)
  const container = document.createElement('div')
  document.body.append(container)
  setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 2_000_000, pitchDegrees: -90 })
  earth.update(camera, renderer, 0)
  return { earth, camera, container }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** A terrain with no tiles: raycasts find nothing, but markers following it still spend their budget. */
function withEmptyTerrain(earth: Earth): void {
  ;(earth as unknown as { terrain: object }).terrain = { object: new Group(), loading: false, sampleElevation: () => null, update() {}, dispose() {} }
}

/** Runs earth.update with the clock moved on by a 60 fps frame each time. */
function frames(earth: Earth, camera: PerspectiveCamera, count: number, move: (frame: number) => void = () => {}) {
  let now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  for (let frame = 0; frame < count; frame++) {
    now += 1000 / 60
    move(frame)
    earth.update(camera, renderer, 1 / 60)
  }
  clock.mockRestore()
}

describe('anchors and offsets', () => {
  it('puts each anchor of the box on the point', () => {
    const point = { xPixels: 100, yPixels: 50 }
    for (const anchor of SCREEN_ANCHORS) {
      const box = anchoredBox(point, 40, 20, anchor)
      const { x, y } = anchorFraction(anchor)
      expect(box.leftPixels + x * 40).toBe(100)
      expect(box.topPixels + y * 20).toBe(50)
    }
    expect(anchoredBox(point, 40, 20, 'bottom')).toEqual({ leftPixels: 80, topPixels: 30, widthPixels: 40, heightPixels: 20 })
    expect(anchoredBox(point, 40, 20, 'top-left', { xPixels: 3, yPixels: -4 })).toEqual({ leftPixels: 103, topPixels: 46, widthPixels: 40, heightPixels: 20 })
  })

  it('writes a pixel-rounded transform that turns around the anchor', () => {
    expect(anchoredTransform({ xPixels: 10.4, yPixels: 20.6 }, 'bottom')).toBe('translate(10px, 21px) translate(-50%, -100%)')
    expect(anchoredTransform({ xPixels: 10, yPixels: 20 }, 'top-left', { xPixels: 5, yPixels: 5 }, 30, 40)).toBe(
      'translate(15px, 25px) translate(0%, 0%) rotateX(40deg) rotateZ(30deg)',
    )
  })

  it('moves a popup away from its point on its anchor side', () => {
    expect(popupOffset('bottom', 10)).toEqual({ xPixels: 0, yPixels: -10 })
    expect(popupOffset('top', 10)).toEqual({ xPixels: 0, yPixels: 10 })
    expect(popupOffset('left', 10)).toEqual({ xPixels: 10, yPixels: 0 })
    expect(popupOffset('right', 10)).toEqual({ xPixels: -10, yPixels: 0 })
    expect(popupOffset('top-left', 10)).toEqual({ xPixels: 7, yPixels: 7 })
    expect(popupOffset('center', 10)).toEqual({ xPixels: 0, yPixels: 0 })
    expect(popupOffset('bottom', { xPixels: 1, yPixels: 2 })).toEqual({ xPixels: 1, yPixels: 2 })
  })

  it('opens a popup beside the marker box, not over it', () => {
    const box = { leftPixels: 100, topPixels: 100, widthPixels: 20, heightPixels: 40 }
    expect(popupPointOnBox(box, 'bottom')).toEqual({ xPixels: 110, yPixels: 100 })
    expect(popupPointOnBox(box, 'top')).toEqual({ xPixels: 110, yPixels: 140 })
    expect(popupPointOnBox(box, 'left')).toEqual({ xPixels: 120, yPixels: 120 })
    expect(popupPointOnBox(box, 'bottom-right')).toEqual({ xPixels: 100, yPixels: 100 })
    expect(popupPointOnBox(box, 'center')).toEqual({ xPixels: 110, yPixels: 120 })
  })

  it('chooses the side a popup fits on', () => {
    const fit = (x: number, y: number) => resolvePopupAnchor({ xPixels: x, yPixels: y }, 200, 100, 800, 600)
    expect(fit(400, 300)).toBe('bottom')
    expect(fit(400, 50)).toBe('top')
    expect(fit(50, 300)).toBe('left')
    expect(fit(780, 300)).toBe('right')
    expect(fit(50, 50)).toBe('top-left')
    expect(fit(780, 50)).toBe('top-right')
    // The offset counts as room it needs above the point.
    expect(resolvePopupAnchor({ xPixels: 400, yPixels: 105 }, 200, 100, 800, 600, 10)).toBe('top')
  })

  it('turns with the map and lays on the ground only when aligned to the map', () => {
    expect(markerRotation(10, 'viewport', 'viewport', 30, -45)).toEqual({ rotationDegrees: 10, tiltDegrees: 0 })
    expect(markerRotation(10, 'map', 'viewport', 30, -45)).toEqual({ rotationDegrees: -20, tiltDegrees: 0 })
    expect(markerRotation(0, 'viewport', 'map', 30, -45)).toEqual({ rotationDegrees: 0, tiltDegrees: 45 })
    expect(markerRotation(0, 'map', 'auto', 0, -90)).toEqual({ rotationDegrees: 0, tiltDegrees: 0 })
    expect(markerRotation(0, 'viewport', 'auto', 0, -10)).toEqual({ rotationDegrees: 0, tiltDegrees: 0 })
    expect(markerRotation(0, 'viewport', 'map', 0, 0).tiltDegrees).toBe(85)
  })
})

describe('Marker', () => {
  it('lands on the point earth.camera.project gives, and follows the camera in the same update', () => {
    const { earth, camera, container } = createMap()
    const marker = new Marker({ longitudeDegrees: 2, latitudeDegrees: 1, heightMeters: 0 }).addTo(earth, container)
    const expected = earth.camera.project({ longitudeDegrees: 2, latitudeDegrees: 1 })
    expect(marker.visibility).toBe('visible')
    expect(marker.screenPosition.xPixels).toBeCloseTo(expected.xPixels, 6)
    expect(marker.screenPosition.yPixels).toBeCloseTo(expected.yPixels, 6)
    expect(marker.element.style.transform).toBe(`translate(${Math.round(expected.xPixels)}px, ${Math.round(expected.yPixels)}px) translate(-50%, -100%)`)

    setCameraView(camera, { longitudeDegrees: 1, latitudeDegrees: 0.5, distanceMeters: 1_000_000, pitchDegrees: -60, headingDegrees: 20 })
    earth.update(camera, renderer, 0)
    const moved = earth.camera.project({ longitudeDegrees: 2, latitudeDegrees: 1 })
    expect(Math.abs(marker.screenPosition.xPixels - moved.xPixels)).toBeLessThan(1e-6)
    expect(Math.abs(marker.screenPosition.yPixels - moved.yPixels)).toBeLessThan(1e-6)
  })

  it('hides behind the globe and behind the camera', () => {
    const { earth, camera, container } = createMap()
    const front = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0 }).addTo(earth, container)
    const back = new Marker({ longitudeDegrees: 180, latitudeDegrees: 0, heightMeters: 0 }).addTo(earth, container)
    // Just past the visible limb: inside the screen's direction but beyond the horizon.
    const limb = new Marker({ longitudeDegrees: 80, latitudeDegrees: 0, heightMeters: 0 }).addTo(earth, container)
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 20_000_000, pitchDegrees: -90 })
    earth.update(camera, renderer, 0)
    expect(front.visibility).toBe('visible')
    expect(back.visibility).toBe('hidden')
    expect(limb.visibility).toBe('hidden')
    expect(back.element.dataset.visibility).toBe('hidden')
    expect(earth.camera.project({ longitudeDegrees: 80, latitudeDegrees: 0 }).visible).toBe(false)

    // A point above the camera, behind it when the camera looks down.
    const above = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 30_000_000 }).addTo(earth, container)
    expect(above.visibility).toBe('hidden')
  })

  it('places a marker added between frames at once, and shares one layer per container', () => {
    const { earth, container } = createMap()
    const first = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0 }).addTo(earth, container)
    const second = new Marker({ longitudeDegrees: 1, latitudeDegrees: 0 }).addTo(earth, container)
    expect(container.querySelectorAll('[data-earthkit-markers]')).toHaveLength(1)
    expect(first.element.style.transform).not.toBe('')
    expect(container.style.position).toBe('relative')
    first.remove()
    expect(container.querySelectorAll('[data-earthkit-markers]')).toHaveLength(1)
    second.remove()
    expect(container.querySelector('[data-earthkit-markers]')).toBeNull()
    expect(container.style.position).toBe('')
  })

  it('finds its elements by data attribute, and leaves the built-in look off with defaultOverlayStyles: false', () => {
    const { earth, container } = createMap()
    const marker = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0 }).addTo(earth, container)
    const popup = new Popup({ longitudeDegrees: 0, latitudeDegrees: 0, content: 'Hi' }).addTo(earth, container)
    expect(marker.element.matches('.earthkit-marker[data-earthkit-marker]')).toBe(true)
    expect(popup.element.matches('.earthkit-popup[data-earthkit-popup]')).toBe(true)
    const layer = container.querySelector('[data-earthkit-markers]')!
    expect(layer.hasAttribute('data-earthkit-unstyled')).toBe(false)
    const style = document.head.querySelector('style[data-earthkit-styles]')!.textContent!
    // The look is scoped to styled layers; what places markers is not.
    expect(style).toMatch(/:where\(\[data-earthkit-markers\]:not\(\[data-earthkit-unstyled\]\)\) \.earthkit-popup-content \{/)
    expect(style).toMatch(/^\[data-earthkit-marker\] \{/m)
    popup.remove()
    marker.remove()

    const unstyled = createMap()
    const plain = new Earth({ defaultOverlayStyles: false })
    expect(plain.defaultOverlayStyles).toBe(false)
    new Marker({ longitudeDegrees: 0, latitudeDegrees: 0 }).addTo(plain, unstyled.container)
    expect(unstyled.container.querySelector('[data-earthkit-markers]')!.hasAttribute('data-earthkit-unstyled')).toBe(true)
  })

  it('is a focusable button with a label, also around an element of its own', () => {
    const pin = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, label: 'Paris' })
    expect(pin.element.tagName).toBe('BUTTON')
    expect(pin.element.getAttribute('aria-label')).toBe('Paris')
    const element = document.createElement('div')
    const custom = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, element })
    expect(custom.element).toBe(element)
    expect(element.getAttribute('role')).toBe('button')
    expect(element.tabIndex).toBe(0)
    expect(element.getAttribute('aria-label')).toBe('Map marker')
    expect(custom.getAnchor()).toBe('center')
    expect(pin.getAnchor()).toBe('bottom')
  })

  it('follows the map heading when aligned to the map', () => {
    const { earth, camera, container } = createMap()
    const marker = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, rotationAlignment: 'map', rotationDegrees: 10 }).addTo(earth, container)
    setCameraView(camera, { longitudeDegrees: 0, latitudeDegrees: 0, distanceMeters: 1_000_000, pitchDegrees: -90, headingDegrees: 40 })
    earth.update(camera, renderer, 0)
    // Pitch 'auto' follows the map alignment: looking straight down, no tilt.
    expect(marker.element.style.transform).toMatch(/rotateZ\(-30(\.\d+)?deg\)$/)
  })
})

describe('terrain checks', () => {
  it('serve every marker in turn, however many share the per-frame budget', () => {
    const { earth, camera, container } = createMap()
    withEmptyTerrain(earth)
    const markers = Array.from({ length: 100 }, (_, index) =>
      new Marker({ longitudeDegrees: (index % 10) * 0.5 - 2.5, latitudeDegrees: Math.floor(index / 10) * 0.5 - 2.5 }).addTo(earth, container),
    )
    const checked = () => markers.filter(marker => (marker as unknown as { occlusionCheck: { lastCheckSceneVersion: number } }).occlusionCheck.lastCheckSceneVersion !== -1).length
    // 100 markers, 2 raycasts each, 4 a frame: 50 frames while the camera keeps moving.
    frames(earth, camera, 60, frame => setCameraView(camera, { longitudeDegrees: frame * 1e-4, latitudeDegrees: 0, distanceMeters: 2_000_000, pitchDegrees: -90 }))
    expect(checked()).toBe(100)
  })

  it('ask for a later frame when a stale check had to wait, and stop once all are settled', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { earth, camera, container } = createMap()
    withEmptyTerrain(earth)
    for (let index = 0; index < 10; index++) new Marker({ longitudeDegrees: index * 0.1, latitudeDegrees: 0 }).addTo(earth, container)
    let requests = 0
    earth.addEventListener('framerequest', () => requests++)
    frames(earth, camera, 1)
    requests = 0
    vi.advanceTimersByTime(300)
    expect(requests).toBe(1)
    // Enough frames, spread over time, to check them all: no more requests after that.
    for (let round = 0; round < 10; round++) {
      frames(earth, camera, 16)
      vi.advanceTimersByTime(300)
    }
    requests = 0
    frames(earth, camera, 16)
    vi.advanceTimersByTime(300)
    expect(requests).toBe(0)
  })
})

describe('terrain checks while loading and hidden', () => {
  it('do not ask for frames while a download is pending and nothing changed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { earth, camera, container } = createMap()
    ;(earth as unknown as { terrain: object }).terrain = { object: new Group(), loading: true, sampleElevation: () => null, tiles: { stats: { loaded: 3 }, visibleTiles: new Set() }, update() {}, dispose() {} }
    for (let index = 0; index < 5; index++) new Marker({ longitudeDegrees: index * 0.1, latitudeDegrees: 0 }).addTo(earth, container)
    for (let round = 0; round < 5; round++) {
      frames(earth, camera, 16)
      vi.advanceTimersByTime(300)
    }
    let requests = 0
    earth.addEventListener('framerequest', () => requests++)
    frames(earth, camera, 16)
    vi.advanceTimersByTime(300)
    expect(requests).toBe(0)
  })

  it('keep reading the terrain under a hidden marker until a height is found', () => {
    const { earth, camera, container } = createMap()
    withEmptyTerrain(earth)
    const marker = new Marker({ longitudeDegrees: 180, latitudeDegrees: 0 }).addTo(earth, container)
    const reads = vi.spyOn(earth.camera, 'queryTerrainElevation')
    frames(earth, camera, 40, frame => setCameraView(camera, { longitudeDegrees: frame * 1e-4, latitudeDegrees: 0, distanceMeters: 2_000_000, pitchDegrees: -90 }))
    expect(marker.visibility).toBe('hidden')
    // No tile there: read again at the interval (40 frames ≈ 0.67 s ≈ 3 reads), not once and never again.
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Popup', () => {
  it('opens beside its marker on click, and closes with Escape, giving focus back', () => {
    const { earth, container } = createMap()
    const popup = new Popup({ content: 'Hello <b>not HTML</b>', anchor: 'bottom' })
    const marker = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, popup }).addTo(earth, container)
    const opened: string[] = []
    popup.addEventListener('open', () => opened.push('open'))
    popup.addEventListener('close', () => opened.push('close'))

    marker.element.focus()
    marker.element.click()
    expect(popup.isOpen()).toBe(true)
    expect(marker.element.getAttribute('aria-expanded')).toBe('true')
    expect(popup.contentElement.textContent).toBe('Hello <b>not HTML</b>')
    expect(popup.element.getAttribute('role')).toBe('dialog')
    expect(popup.element.contains(document.activeElement)).toBe(true)
    // Above the pin: its point is the top-centre of the marker's box.
    const box = marker.getScreenBox()!
    const expectedTop = Math.round(box.topPixels)
    expect(popup.element.style.transform).toBe(`translate(${Math.round(box.leftPixels + box.widthPixels / 2)}px, ${expectedTop}px) translate(-50%, -100%)`)

    popup.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(popup.isOpen()).toBe(false)
    expect(document.activeElement).toBe(marker.element)
    expect(marker.element.getAttribute('aria-expanded')).toBe('false')
    expect(opened).toEqual(['open', 'close'])

    // Enter toggles it again from the keyboard (a native button turns it into a click).
    marker.element.click()
    expect(popup.isOpen()).toBe(true)
    marker.element.click()
    expect(popup.isOpen()).toBe(false)
  })

  it('closes on a click on the map but not on the click that opened it, nor after a drag', () => {
    const { earth, container } = createMap()
    const canvas = document.createElement('canvas')
    container.append(canvas)
    const popup = new Popup({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, content: 'x' })
    const click = (fromX: number, toX: number) => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: fromX, clientY: 0 }))
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: toX, clientY: 0 }))
    }
    // An app opening the popup from a map click: that same click must not close it.
    canvas.addEventListener('click', () => {
      if (!popup.isOpen()) popup.addTo(earth, container)
    }, { once: true })
    click(10, 10)
    expect(popup.isOpen()).toBe(true)
    click(10, 60) // a drag of the map
    expect(popup.isOpen()).toBe(true)
    popup.contentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popup.isOpen()).toBe(true)
    // A control in the same container (the attribution button) is not the map.
    const control = document.createElement('button')
    container.append(control)
    control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popup.isOpen()).toBe(true)
    click(10, 11)
    expect(popup.isOpen()).toBe(false)
  })

  it('leaves keys typed in a marker\'s content to the content', () => {
    const { earth, container } = createMap()
    const element = document.createElement('div')
    const input = document.createElement('input')
    element.append(input)
    const marker = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0, element, popup: new Popup({ content: 'x' }) }).addTo(earth, container)
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    input.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(false)
    expect(marker.getPopup()!.isOpen()).toBe(false)
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(marker.getPopup()!.isOpen()).toBe(true)
  })

  it('moves focus to a control in content rendered after it opened, once', () => {
    const { earth, container } = createMap()
    const popup = new Popup({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0 }).addTo(earth, container)
    const button = document.createElement('button')
    popup.contentElement.append(button)
    popup.focusContentControl()
    expect(document.activeElement).toBe(button)
    button.blur()
    popup.focusContentControl()
    expect(document.activeElement).not.toBe(button)
  })

  it('does not take focus when the app opens it with nothing to focus, nor as a tooltip', () => {
    const { earth, container } = createMap()
    const search = document.createElement('input')
    document.body.append(search)
    search.focus()
    new Popup({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, content: 'text only' }).addTo(earth, container)
    expect(document.activeElement).toBe(search)
    new Popup({ content: 'tip' }).trackPointer().addTo(earth, container)
    expect(document.activeElement).toBe(search)
  })

  it('points at its own position, hides behind the globe, and closes on move when asked', () => {
    const { earth, camera, container } = createMap()
    const popup = new Popup({ longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, closeOnMove: true }).addTo(earth, container)
    expect(popup.element.dataset.visibility).toBe('visible')
    popup.setPosition({ longitudeDegrees: 180, latitudeDegrees: 0 })
    expect(popup.element.dataset.visibility).toBe('hidden')
    setCameraView(camera, { longitudeDegrees: 10, latitudeDegrees: 0, distanceMeters: 2_000_000, pitchDegrees: -90 })
    earth.update(camera, renderer, 0)
    expect(popup.isOpen()).toBe(false)
  })

  it('follows the pointer when tracking it', () => {
    const { earth, container } = createMap()
    const popup = new Popup({ anchor: 'top', focusAfterOpen: false }).trackPointer().addTo(earth, container)
    expect(popup.element.dataset.visibility).toBe('hidden')
    container.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 80 }))
    expect(popup.element.dataset.visibility).toBe('visible')
    expect(popup.element.style.transform).toBe('translate(120px, 80px) translate(-50%, 0%)')
    expect(popup.element.hasAttribute('data-tracking-pointer')).toBe(true)
    container.dispatchEvent(new PointerEvent('pointerleave'))
    expect(popup.element.dataset.visibility).toBe('hidden')
  })

  it('updates through ScreenOverlay only while something is on the earth', () => {
    const { earth, container } = createMap()
    const marker = new Marker({ longitudeDegrees: 0, latitudeDegrees: 0 }).addTo(earth, container)
    expect(earth.hasEventListener('update', (ScreenOverlay.of(earth) as unknown as { onUpdate: () => void }).onUpdate)).toBe(true)
    marker.remove()
    expect(earth.hasEventListener('update', (ScreenOverlay.of(earth) as unknown as { onUpdate: () => void }).onUpdate)).toBe(false)
  })
})
